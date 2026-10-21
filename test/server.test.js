import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { Store } from "../src/store.js";
import { createServer, safeNextPath } from "../src/server.js";
import { SESSION_COOKIE, STATE_COOKIE, issueSession, signPayload } from "../src/session.js";

async function withServer(opts, fn) {
  const store = new Store();
  const server = createServer({ store, ...opts });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, store);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

const json = (body, headers = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const bearer = (token) => ({ authorization: `Bearer ${token}` });

test("POST /api/events then GET /api/tasks", async () => {
  await withServer({ token: "test-token" }, async (base) => {
    let res = await fetch(`${base}/api/events`, json([{ key: "grok-bot:r1", title: "Deploy", status: "running" }, { key: "cursor-cloud:bc-1", parent: "grok-bot:r1", status: "running" }, { title: "no id" }], bearer("test-token")));
    assert.equal(res.status, 207);
    res = await fetch(`${base}/api/tasks`, { headers: bearer("test-token") });
    const { columns, tasks } = await res.json();
    assert.deepEqual(columns.map((c) => c.id), ["queued", "planning", "running", "waiting", "review", "done", "failed"]);
    assert.equal(tasks.length, 2);
    res = await fetch(`${base}/api/tasks/${encodeURIComponent("grok-bot:r1")}`, { headers: bearer("test-token") });
    assert.equal((await res.json()).children[0].key, "cursor-cloud:bc-1");
  });
});

test("empty token is rejected (fail closed)", async () => {
  await withServer({ token: "" }, async (base) => {
    assert.equal((await fetch(`${base}/api/tasks`)).status, 401);
    assert.equal((await fetch(`${base}/api/tasks?token=`)).status, 401);
    assert.equal((await fetch(`${base}/api/events`, json({ key: "a:1", status: "done" }))).status, 401);
  });
});

test("no token configured rejects /api/tasks", async () => {
  await withServer({ token: null }, async (base) => {
    assert.equal((await fetch(`${base}/api/tasks`)).status, 401);
  });
});

test("token protects the API and cross-origin writes are refused", async () => {
  await withServer({ token: "s3cret" }, async (base) => {
    assert.equal((await fetch(`${base}/api/tasks`)).status, 401);
    assert.equal((await fetch(`${base}/api/tasks`, { headers: bearer("wrong") })).status, 401);
    assert.equal((await fetch(`${base}/api/tasks?token=s3cret`)).status, 200);
    assert.equal((await fetch(`${base}/`)).status, 200);
    const evil = await fetch(`${base}/api/events`, json({ key: "a:1", status: "done" }, { authorization: "Bearer s3cret", origin: "https://evil.example" }));
    assert.equal(evil.status, 403);
  });
});

test("DELETE without token is 401", async () => {
  await withServer({ token: "s3cret" }, async (base) => {
    assert.equal((await fetch(`${base}/api/tasks/${encodeURIComponent("a:1")}`, { method: "DELETE" })).status, 401);
  });
});

test("/api/stream and /mcp without token are 401", async () => {
  await withServer({ token: "s3cret" }, async (base) => {
    assert.equal((await fetch(`${base}/api/stream`)).status, 401);
    assert.equal((await fetch(`${base}/mcp`, json({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }))).status, 401);
  });
});

test("MCP: initialize, list tools, report and list a chat task", async () => {
  await withServer({ token: "test-token" }, async (base, store) => {
    const rpc = async (method, params, id = 1) => (await fetch(`${base}/mcp`, json({ jsonrpc: "2.0", id, method, params }, bearer("test-token")))).json();
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    assert.equal(init.result.serverInfo.name, "agent-kanban");
    assert.equal((await fetch(`${base}/mcp`, json({ jsonrpc: "2.0", method: "notifications/initialized" }, bearer("test-token")))).status, 202);
    const tools = await rpc("tools/list", {});
    assert.deepEqual(tools.result.tools.map((t) => t.name), ["kanban_report", "kanban_list", "kanban_update_requests", "kanban_get", "kanban_get_choice"]);

    const created = await rpc("tools/call", { name: "kanban_report", arguments: { title: "Plan Q4 launch", status: "running", source: "claude-chat" } });
    const key = created.result.structuredContent.task_key;
    assert.match(key, /^claude-chat:/);
    await rpc("tools/call", { name: "kanban_report", arguments: { task_key: key, status: "review", note: "Draft ready" } });
    assert.equal(store.get(key).status, "review");
    assert.equal(store.get(key).kind, "chat");
    const missing = await rpc("tools/call", { name: "kanban_report", arguments: { status: "running" } });
    assert.equal(missing.result.isError, true);
    const list = await rpc("tools/call", { name: "kanban_list", arguments: {} });
    assert.equal(list.result.structuredContent.tasks[0].task_key, key);
  });
});

test("Cursor webhook with HMAC signature", async () => {
  await withServer({ token: "t", cursorWebhookSecret: "whsec" }, async (base, store) => {
    const body = JSON.stringify({ event: "statusChange", id: "bc-12345678", status: "RUNNING", name: "Add tests" });
    const sig = `sha256=${createHmac("sha256", "whsec").update(body).digest("hex")}`;
    assert.equal((await fetch(`${base}/webhooks/cursor`, { method: "POST", body, headers: { "x-webhook-signature": "sha256=bad" } })).status, 401);
    assert.equal((await fetch(`${base}/webhooks/cursor`, { method: "POST", body, headers: { "x-webhook-signature": sig } })).status, 200);
    assert.equal(store.get("cursor-cloud:bc-12345678").status, "running");
  });
});

test("webhook without signature and without token is 401", async () => {
  await withServer({ token: "", cursorWebhookSecret: "" }, async (base) => {
    const body = JSON.stringify({ event: "statusChange", id: "bc-noauth", status: "RUNNING" });
    assert.equal((await fetch(`${base}/webhooks/cursor`, { method: "POST", body })).status, 401);
  });
  await withServer({ token: "t", cursorWebhookSecret: "" }, async (base, store) => {
    const body = JSON.stringify({ event: "statusChange", id: "bc-token-ok", status: "RUNNING", name: "Via token" });
    assert.equal((await fetch(`${base}/webhooks/cursor`, { method: "POST", body })).status, 401);
    assert.equal((await fetch(`${base}/webhooks/cursor`, { method: "POST", body, headers: bearer("t") })).status, 200);
    assert.equal(store.get("cursor-cloud:bc-token-ok").status, "running");
  });
});

test("SSE stream pushes task changes", async () => {
  await withServer({ token: "test-token" }, async (base, store) => {
    const res = await fetch(`${base}/api/stream?token=test-token`);
    const reader = res.body.getReader();
    await reader.read();
    store.apply({ key: "codex:t1", title: "Live", status: "running" });
    let text = "";
    while (!text.includes("event: task")) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /"title":"Live"/);
    await reader.cancel();
  });
});

test("serves under a base path and redirects the bare path", async () => {
  await withServer({ token: "test-token", basePath: "/kanban/" }, async (base) => {
    const bare = await fetch(`${base}/kanban?token=x`, { redirect: "manual" });
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.get("location"), "/kanban/?token=x");
    assert.equal((await fetch(`${base}/kanban/`)).status, 200);
    assert.equal((await fetch(`${base}/kanban/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/kanban/api/events`, json({ key: "a:1", status: "running" }, bearer("test-token")))).status, 200);
    assert.equal((await (await fetch(`${base}/kanban/api/tasks`, { headers: bearer("test-token") })).json()).tasks.length, 1);
    assert.equal((await fetch(`${base}/api/tasks`, { headers: bearer("test-token") })).status, 404);
  });
});

test("serve without AKB_TOKEN refuses to start", async () => {
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
  const env = { ...process.env };
  delete env.AKB_TOKEN;
  const child = spawn(process.execPath, [cli, "serve", "--host", "127.0.0.1", "--port", "7399"], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(-1);
    }, 3000);
    child.on("close", (c) => {
      clearTimeout(t);
      resolve(c);
    });
  });
  assert.notEqual(code, 0);
  assert.match(stderr, /AKB_TOKEN/);
});

function setCookies(res) {
  const raw = res.headers.getSetCookie?.() || [];
  if (raw.length) return raw;
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function cookieValue(setCookieHeaders, name) {
  for (const line of setCookieHeaders) {
    if (line.startsWith(`${name}=`)) {
      const v = line.split(";")[0].slice(name.length + 1);
      return decodeURIComponent(v);
    }
  }
  return null;
}

function assertCookieFlags(line, { path = "/kanban" } = {}) {
  assert.match(line, /HttpOnly/i);
  assert.match(line, /Secure/i);
  assert.match(line, /SameSite=Lax/i);
  assert.match(line, new RegExp(`Path=${path.replace(/\//g, "\\/")}`, "i"));
}

const WECOM_ENV = {
  AKB_PUBLIC_URL: "https://relay.onetopway.com/kanban",
  AKB_WECOM_CORP_ID: "wwTESTCORP",
  AKB_WECOM_AGENT_ID: "1000030",
  AKB_WECOM_SECRET: "wecom-secret-VALUE",
  AKB_WECOM_USERS: "QiaoYiFu",
  // ≥32 UTF-8 bytes required
  AKB_SESSION_SECRET: "0123456789abcdef0123456789abcdef",
};

function wecomFetchStub({ userid = "QiaoYiFu", errcode = 0, noUserid = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/gettoken")) {
      return { json: async () => ({ errcode: 0, access_token: "access-TOKEN-xyz", expires_in: 7200 }) };
    }
    if (u.includes("/auth/getuserinfo")) {
      if (errcode) return { json: async () => ({ errcode, errmsg: "fail" }) };
      if (noUserid) return { json: async () => ({ errcode: 0 }) };
      return { json: async () => ({ errcode: 0, userid }) };
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return { fetchImpl, calls };
}

async function startOAuth(base) {
  const start = await fetch(`${base}/kanban/auth/wecom/start`, { redirect: "manual" });
  assert.equal(start.status, 302);
  const cookies = setCookies(start);
  const stateCookie = cookieValue(cookies, STATE_COOKIE);
  const loc = start.headers.get("location");
  const state = new URL(loc.replace(/#wechat_redirect$/, "")).searchParams.get("state");
  return { state, stateCookie, loc, cookies };
}

test("unwired wecom: start 503, health has no wecom_wired, token still works", async () => {
  await withServer({ token: "t", basePath: "/kanban", env: {} }, async (base) => {
    assert.equal((await fetch(`${base}/kanban/auth/wecom/start`)).status, 503);
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal("wecom_wired" in health, false);
    const tasks = await (await fetch(`${base}/kanban/api/tasks`, { headers: bearer("t") })).json();
    assert.equal(tasks.wecom_wired, false);
  });
});

test("wecom OAuth: state missing/mismatch → 400; bad code → 502 without session cookie", async () => {
  const { fetchImpl } = wecomFetchStub({ errcode: 40029 });
  await withServer({
    token: "t",
    basePath: "/kanban",
    env: WECOM_ENV,
    fetchImpl,
  }, async (base) => {
    assert.equal((await (await fetch(`${base}/kanban/api/tasks`, { headers: bearer("t") })).json()).wecom_wired, true);
    const { state, stateCookie } = await startOAuth(base);

    const noState = await fetch(`${base}/kanban/auth/wecom/callback?code=c`, { redirect: "manual" });
    assert.equal(noState.status, 400);

    const badState = await fetch(`${base}/kanban/auth/wecom/callback?code=c&state=wrong`, {
      redirect: "manual",
      headers: { cookie: `${STATE_COOKIE}=${encodeURIComponent(stateCookie)}` },
    });
    assert.equal(badState.status, 400);

    const badCode = await fetch(`${base}/kanban/auth/wecom/callback?code=bad&state=${state}`, {
      redirect: "manual",
      headers: { cookie: `${STATE_COOKIE}=${encodeURIComponent(stateCookie)}` },
    });
    assert.equal(badCode.status, 502);
    assert.equal(cookieValue(setCookies(badCode), SESSION_COOKIE), null);
  });
});

test("wecom OAuth: allowlist 403 vs success Set-Cookie + 302 /kanban/", async () => {
  const denied = wecomFetchStub({ userid: "Stranger" });
  await withServer({
    token: "t",
    basePath: "/kanban",
    env: WECOM_ENV,
    fetchImpl: denied.fetchImpl,
  }, async (base) => {
    const { state, stateCookie } = await startOAuth(base);
    const res = await fetch(`${base}/kanban/auth/wecom/callback?code=c1&state=${state}`, {
      redirect: "manual",
      headers: { cookie: `${STATE_COOKIE}=${encodeURIComponent(stateCookie)}` },
    });
    assert.equal(res.status, 403);
    assert.equal(cookieValue(setCookies(res), SESSION_COOKIE), null);
  });

  const ok = wecomFetchStub({ userid: "QiaoYiFu" });
  await withServer({
    token: "t",
    basePath: "/kanban",
    env: WECOM_ENV,
    fetchImpl: ok.fetchImpl,
  }, async (base) => {
    const { state, stateCookie } = await startOAuth(base);
    const res = await fetch(`${base}/kanban/auth/wecom/callback?code=c2&state=${state}`, {
      redirect: "manual",
      headers: { cookie: `${STATE_COOKIE}=${encodeURIComponent(stateCookie)}` },
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/kanban/");
    const lines = setCookies(res);
    const sessionLine = lines.find((l) => l.startsWith(`${SESSION_COOKIE}=`));
    assert.ok(sessionLine);
    assertCookieFlags(sessionLine, { path: "/kanban" });
    const session = cookieValue(lines, SESSION_COOKIE);
    assert.ok(session);

    const tasks = await fetch(`${base}/kanban/api/tasks`, { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}` } });
    assert.equal(tasks.status, 200);

    const stream = await fetch(`${base}/kanban/api/stream`, { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}` } });
    assert.equal(stream.status, 200);
    await stream.body.cancel();

    // Same-origin write (no Origin) ok; cross-site Origin refused.
    assert.equal((await fetch(`${base}/kanban/api/events`, json({ key: "a:1", status: "running" }, { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}` }))).status, 200);
    const host = new URL(base).host;
    assert.equal((await fetch(`${base}/kanban/api/events`, json({ key: "a:2", status: "done" }, {
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}`,
      origin: "https://evil.example",
    }))).status, 403);
    assert.equal((await fetch(`${base}/kanban/api/events`, json({ key: "a:3", status: "done" }, {
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}`,
      origin: `http://${host}`,
    }))).status, 200);
  });
});

test("forged / expired / tampered session cookie → 401", async () => {
  await withServer({
    token: "t",
    basePath: "/kanban",
    env: WECOM_ENV,
    fetchImpl: wecomFetchStub().fetchImpl,
  }, async (base) => {
    const secret = WECOM_ENV.AKB_SESSION_SECRET;
    const good = issueSession(secret, "QiaoYiFu");
    const expired = signPayload(secret, { uid: "QiaoYiFu", exp: Date.now() - 5000 });
    const forged = issueSession("other-secret", "QiaoYiFu");
    const tampered = good.slice(0, -4) + "dead";
    for (const c of [expired, forged, tampered, "not-a-cookie"]) {
      assert.equal((await fetch(`${base}/kanban/api/tasks`, { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(c)}` } })).status, 401);
    }
    assert.equal((await fetch(`${base}/kanban/api/tasks`, { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(good)}` } })).status, 200);
  });
});

test("Bearer / ?token= /mcp unchanged; wrong token 401", async () => {
  await withServer({
    token: "s3cret",
    basePath: "/kanban",
    env: WECOM_ENV,
    fetchImpl: wecomFetchStub().fetchImpl,
  }, async (base) => {
    assert.equal((await fetch(`${base}/kanban/api/tasks`)).status, 401);
    assert.equal((await fetch(`${base}/kanban/api/tasks`, { headers: bearer("wrong") })).status, 401);
    assert.equal((await fetch(`${base}/kanban/api/tasks?token=s3cret`)).status, 200);
    assert.equal((await fetch(`${base}/kanban/api/tasks`, { headers: bearer("s3cret") })).status, 200);
    assert.equal((await fetch(`${base}/kanban/mcp`, json({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, bearer("s3cret")))).status, 200);
    assert.equal((await fetch(`${base}/kanban/mcp`, json({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }))).status, 401);
  });
});

test("next open-redirect protection", () => {
  assert.equal(safeNextPath("https://evil.com/", "/kanban"), "/kanban/");
  assert.equal(safeNextPath("//evil.com", "/kanban"), "/kanban/");
  assert.equal(safeNextPath("/evil", "/kanban"), "/kanban/");
  assert.equal(safeNextPath("/kanban/../admin", "/kanban"), "/kanban/");
  assert.equal(safeNextPath("/kanban/ok", "/kanban"), "/kanban/ok");
  assert.equal(safeNextPath(null, "/kanban"), "/kanban/");
});

test("wecom callback rejects open redirect next", async () => {
  const { fetchImpl } = wecomFetchStub({ userid: "QiaoYiFu" });
  await withServer({
    token: "t",
    basePath: "/kanban",
    env: WECOM_ENV,
    fetchImpl,
  }, async (base) => {
    const { state, stateCookie } = await startOAuth(base);
    const res = await fetch(`${base}/kanban/auth/wecom/callback?code=c&state=${state}&next=${encodeURIComponent("https://evil.example/")}`, {
      redirect: "manual",
      headers: { cookie: `${STATE_COOKIE}=${encodeURIComponent(stateCookie)}` },
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/kanban/");
  });
});

test("wxwork UA on / redirects to OAuth start when wired and anonymous", async () => {
  await withServer({
    token: "t",
    basePath: "/kanban",
    env: WECOM_ENV,
    fetchImpl: wecomFetchStub().fetchImpl,
  }, async (base) => {
    const res = await fetch(`${base}/kanban/`, {
      redirect: "manual",
      headers: { "user-agent": "Mozilla/5.0 wxwork" },
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/kanban/auth/wecom/start");
    const browser = await fetch(`${base}/kanban/`, { redirect: "manual" });
    assert.equal(browser.status, 200);
  });
});

test("setup/wecom: public GET, form token POST, locks after write, never echoes secret", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akb-setup-"));
  const secret = "PASTE_SECRET_do_not_log";
  const code = "oauth-CODE-hidden";
  const accessToken = "access-TOKEN-hidden";
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));
  const { fetchImpl } = stubGettokenOk(accessToken);
  try {
    await withServer({
      token: "setup-token",
      basePath: "/kanban",
      env: {
        ...WECOM_ENV,
        AKB_WECOM_SECRET: "", // force file secret after setup
      },
      fetchImpl,
      dataDir: dir,
    }, async (base) => {
      const get = await fetch(`${base}/kanban/setup/wecom`);
      assert.equal(get.status, 200);
      const getHtml = await get.text();
      assert.match(getHtml, /name="token"/);
      assert.equal(getHtml.includes(secret), false);

      assert.equal((await fetch(`${base}/kanban/setup/wecom`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=wrong&secret=${encodeURIComponent(secret)}`,
      })).status, 401);

      const post = await fetch(`${base}/kanban/setup/wecom`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=setup-token&secret=${encodeURIComponent(secret)}`,
      });
      assert.equal(post.status, 200);
      const postHtml = await post.text();
      assert.equal(postHtml.includes(secret), false);
      assert.match(postHtml, /errcode/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "wecom.json"), "utf8")).secret, secret);
      assert.equal(fs.statSync(path.join(dir, "wecom.json")).mode & 0o777, 0o600);

      const again = await fetch(`${base}/kanban/setup/wecom`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "token=setup-token&secret=other",
      });
      assert.equal(again.status, 409);
      assert.equal((await (await fetch(`${base}/kanban/api/tasks`, { headers: bearer("setup-token") })).json()).wecom_wired, true);
    });
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  const blob = logs.join("\n");
  for (const needle of [secret, accessToken, code, "wecom-secret-VALUE", WECOM_ENV.AKB_SESSION_SECRET]) {
    assert.equal(blob.includes(needle), false, `logs must not contain ${needle.slice(0, 8)}…`);
  }
});

function stubGettokenOk(accessToken) {
  const fetchImpl = async (url) => {
    if (String(url).includes("/gettoken")) {
      return { json: async () => ({ errcode: 0, access_token: accessToken, expires_in: 7200 }) };
    }
    if (String(url).includes("/auth/getuserinfo")) {
      return { json: async () => ({ errcode: 50001, errmsg: "redirect_uri not match" }) };
    }
    return { json: async () => ({ errcode: 0, access_token: accessToken, expires_in: 7200 }) };
  };
  return { fetchImpl };
}

test("OAuth error pages and thrown messages scrub secret/token/code", async () => {
  const secret = WECOM_ENV.AKB_WECOM_SECRET;
  const accessToken = "ACCESS_should_not_appear";
  const code = "CODE_should_not_appear";
  const fetchImpl = async (url) => {
    if (String(url).includes("/gettoken")) {
      return { json: async () => ({ errcode: 0, access_token: accessToken, expires_in: 7200 }) };
    }
    return { json: async () => ({ errcode: 40029, errmsg: "invalid code" }) };
  };
  await withServer({
    token: "t",
    basePath: "/kanban",
    env: WECOM_ENV,
    fetchImpl,
  }, async (base) => {
    const { state, stateCookie } = await startOAuth(base);
    const res = await fetch(`${base}/kanban/auth/wecom/callback?code=${code}&state=${state}`, {
      redirect: "manual",
      headers: { cookie: `${STATE_COOKIE}=${encodeURIComponent(stateCookie)}` },
    });
    const html = await res.text();
    assert.equal(res.status, 502);
    for (const needle of [secret, accessToken, code, WECOM_ENV.AKB_SESSION_SECRET]) {
      assert.equal(html.includes(needle), false);
    }
  });
});

test("POST auth/logout clears session cookie", async () => {
  await withServer({
    token: "t",
    basePath: "/kanban",
    env: WECOM_ENV,
    fetchImpl: wecomFetchStub().fetchImpl,
  }, async (base) => {
    const session = issueSession(WECOM_ENV.AKB_SESSION_SECRET, "QiaoYiFu");
    const res = await fetch(`${base}/kanban/auth/logout`, { method: "POST" });
    assert.equal(res.status, 204);
    const line = setCookies(res).find((l) => l.startsWith(`${SESSION_COOKIE}=`));
    assert.ok(line);
    assert.match(line, /Max-Age=0/i);
    assert.equal((await fetch(`${base}/kanban/api/tasks`, { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}` } })).status, 200);
  });
});

test("session cookie rechecked every request: off-allowlist / empty users / unwired CorpID → 401", async () => {
  const secret = WECOM_ENV.AKB_SESSION_SECRET;
  const cookieFor = (uid) => ({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(issueSession(secret, uid))}` });

  // Signed cookie for uid not on allowlist
  await withServer({
    token: "t",
    basePath: "/kanban",
    env: WECOM_ENV,
    fetchImpl: wecomFetchStub().fetchImpl,
  }, async (base) => {
    assert.equal((await fetch(`${base}/kanban/api/tasks`, { headers: cookieFor("Stranger") })).status, 401);
    assert.equal((await fetch(`${base}/kanban/api/tasks`, { headers: cookieFor("QiaoYiFu") })).status, 200);
  });

  // Empty allowlist
  await withServer({
    token: "t",
    basePath: "/kanban",
    env: { ...WECOM_ENV, AKB_WECOM_USERS: "" },
    fetchImpl: wecomFetchStub().fetchImpl,
  }, async (base) => {
    assert.equal((await fetch(`${base}/kanban/api/tasks`, { headers: cookieFor("QiaoYiFu") })).status, 401);
  });

  // WeCom unwired (CorpID removed) — cookie signature still valid
  await withServer({
    token: "t",
    basePath: "/kanban",
    env: { ...WECOM_ENV, AKB_WECOM_CORP_ID: "" },
    fetchImpl: wecomFetchStub().fetchImpl,
  }, async (base) => {
    assert.equal((await fetch(`${base}/kanban/auth/wecom/start`)).status, 503);
    assert.equal((await fetch(`${base}/kanban/api/tasks`, { headers: cookieFor("QiaoYiFu") })).status, 401);
    assert.equal((await fetch(`${base}/kanban/api/tasks`, { headers: bearer("t") })).status, 200);
  });
});

test("short AKB_SESSION_SECRET (<32 bytes) keeps wecom unwired", async () => {
  await withServer({
    token: "t",
    basePath: "/kanban",
    env: { ...WECOM_ENV, AKB_SESSION_SECRET: "too-short" },
    fetchImpl: wecomFetchStub().fetchImpl,
  }, async (base) => {
    assert.equal((await fetch(`${base}/kanban/auth/wecom/start`)).status, 503);
    const forged = issueSession("too-short", "QiaoYiFu");
    assert.equal((await fetch(`${base}/kanban/api/tasks`, { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(forged)}` } })).status, 401);
  });
});

test("there is no endpoint that dispatches tasks to the relay", async () => {
  await withServer({ token: "t" }, async (base) => {
    const res = await fetch(`${base}/api/grok/status-check`, json({ keys: ["grok-bot:15ee3b55-0ce7-4244-bed4-0d386611c815"] }, { authorization: "Bearer t" }));
    assert.equal(res.status, 404);
  });
});

test("Get update: the board records the ask, the agent reads it over MCP and answers with a brief", async () => {
  await withServer({ token: "test-token" }, async (base, store) => {
    const rpc = async (name, args) => (await (await fetch(`${base}/mcp`, json({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, bearer("test-token")))).json()).result.structuredContent;
    const ask = (key, headers = bearer("test-token")) => fetch(`${base}/api/tasks/${encodeURIComponent(key)}/update-request`, { method: "POST", headers });
    const { task_key: key } = await rpc("kanban_report", { title: "富创 WAIT 抢救", status: "running", source: "grok-bot" });

    assert.equal((await ask(key, {})).status, 401);
    assert.equal((await ask("grok-bot:nope")).status, 404);
    const res = await ask(key);
    assert.equal(res.status, 200);
    assert.ok((await res.json()).updateRequest.at);
    assert.equal((await ask(key)).status, 200, "asking twice is harmless");
    assert.equal(store.get(key).events.filter((e) => e.type === "update_request").length, 1);

    assert.deepEqual((await rpc("kanban_update_requests", { source: "claude-chat" })).update_requests, []);
    assert.equal((await rpc("kanban_update_requests", { source: "grok-bot" })).update_requests[0].task_key, key);
    // A status-only report does not answer it, and the result tells the agent it is still owed.
    const ping = await rpc("kanban_report", { task_key: key, status: "running", note: "第5波" });
    assert.equal(ping.update_requests[0].task_key, key);

    const done = await rpc("kanban_report", { task_key: key, status: "running", summary: "released 140 / failed 190 / pending 1780" });
    assert.deepEqual(done.update_requests, []);
    const task = store.get(key);
    assert.equal(task.updateRequest, null);
    assert.equal(task.summary, "released 140 / failed 190 / pending 1780");
    assert.equal(task.events.at(-1).message, "released 140 / failed 190 / pending 1780");

    store.apply({ key, status: "done" });
    assert.equal((await ask(key)).status, 409);
  });
});

test("Get update sends no network request: not to the agent, the relay or anywhere else", async () => {
  const { default: https } = await import("node:https");
  const outbound = [];
  const realFetch = globalThis.fetch;
  const realHttp = http.request, realHttpGet = http.get, realHttps = https.request, realHttpsGet = https.get;
  const record = (via) => (...args) => { outbound.push(via); throw new Error("no network in this test"); };
  const fetchImpl = async (url) => { outbound.push(`fetchImpl ${url}`); throw new Error("no network in this test"); };
  await withServer({ token: "test-token", fetchImpl }, async (base, store) => {
    store.apply({ key: "grok-bot:r1", status: "running", title: "Long job" });
    store.apply({ key: "cursor-cloud:bc-1", status: "running", title: "Cursor job" });
    globalThis.fetch = async (url, opts) => {
      if (!String(url).startsWith(base)) outbound.push(`fetch ${url}`);
      return realFetch(url, opts);
    };
    Object.assign(https, { request: record("https.request"), get: record("https.get") });
    Object.assign(http, { request: record("http.request"), get: record("http.get") });
    try {
      for (const key of ["grok-bot:r1", "cursor-cloud:bc-1"]) {
        const res = await realFetch(`${base}/api/tasks/${encodeURIComponent(key)}/update-request`, { method: "POST", headers: bearer("test-token") });
        assert.equal(res.status, 200);
      }
      store.requestUpdate("grok-bot:r1", { by: "direct" });
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      globalThis.fetch = realFetch;
      Object.assign(https, { request: realHttps, get: realHttpsGet });
      Object.assign(http, { request: realHttp, get: realHttpGet });
    }
    assert.deepEqual(outbound, []);
    // Polled cards are answered by the board from what it already pulled, still without any request.
    assert.equal(store.get("grok-bot:r1").updateRequest, null);
    assert.equal(store.get("cursor-cloud:bc-1").events.at(-1).type, "brief");
  });
});

test("我确认已完成 / 已放弃 closes a card on the board only; a newer agent report still wins", async () => {
  await withServer({ token: "test-token" }, async (base, store) => {
    const close = (key, status, headers = bearer("test-token")) => fetch(`${base}/api/tasks/${encodeURIComponent(key)}/close`, json({ status }, headers));
    store.apply({ key: "grok-bot:r1", title: "Deploy", status: "executing", at: "2026-10-20T09:00:00.000Z" });

    assert.equal((await close("grok-bot:r1", "done", {})).status, 401);
    assert.equal((await close("grok-bot:nope", "done")).status, 404);
    assert.equal((await close("grok-bot:r1", "running")).status, 400);
    const res = await close("grok-bot:r1", "done");
    assert.equal(res.status, 200);
    const task = store.get("grok-bot:r1");
    assert.equal(task.status, "done");
    assert.equal(task.meta.closed_on_board, "done");
    assert.ok(task.events.some((e) => e.type === "board_close"));
    assert.equal((await close("grok-bot:r1", "failed")).status, 409);

    // A replay of the old relay snapshot does not reopen it; a genuinely newer report does.
    store.apply({ key: "grok-bot:r1", status: "executing", at: "2026-10-20T09:00:00.000Z" });
    assert.equal(store.get("grok-bot:r1").status, "done");
    store.apply({ key: "grok-bot:r1", status: "executing", at: new Date(Date.now() + 60000).toISOString() });
    assert.equal(store.get("grok-bot:r1").status, "running");
  });
});
