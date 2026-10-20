import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Store } from "../src/store.js";
import { createServer } from "../src/server.js";
import { hashToken } from "../src/source-tokens.js";
import { OAUTH_CSRF_COOKIE } from "../src/oauth.js";
import { SESSION_COOKIE, STATE_COOKIE, issueSession } from "../src/session.js";

const ADMIN = "test-admin-token-padded-to-32-chars-x";
const CLAUDE_KEY = "test-claude-key-0001-padded-to-32-chars";
const BOT_KEY = "test-bot-key-0002-padded-to-32-chars-x";
const SOURCE_TOKENS = `claude-code:${hashToken(CLAUDE_KEY)},grok-bot@示例机器人:${hashToken(BOT_KEY)}`;
const PUBLIC = "https://relay.onetopway.com/kanban";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const REDIRECT_COM = "https://claude.com/api/mcp/auth_callback";
const METADATA = `${PUBLIC}/.well-known/oauth-protected-resource`;
const CHALLENGE_HEADER = `Bearer resource_metadata="${METADATA}"`;

const WECOM_ENV = {
  AKB_PUBLIC_URL: PUBLIC,
  AKB_WECOM_CORP_ID: "wwTESTCORP",
  AKB_WECOM_AGENT_ID: "1000030",
  AKB_WECOM_SECRET: "wecom-secret-VALUE",
  AKB_WECOM_USERS: "QiaoYiFu",
  AKB_SESSION_SECRET: "0123456789abcdef0123456789abcdef",
};

function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function setCookies(res) {
  return res.headers.getSetCookie?.() || [];
}

function cookiePair(res, name) {
  for (const line of setCookies(res)) {
    if (line.startsWith(`${name}=`)) return line.split(";")[0];
  }
  return "";
}

async function listen(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}

async function withOauth(opts, fn) {
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), "akb-oauth-"));
  const store = opts.store || new Store({ dataDir: dir });
  const server = createServer({
    store,
    token: ADMIN,
    sourceTokens: opts.sourceTokens === undefined ? SOURCE_TOKENS : opts.sourceTokens,
    basePath: "/kanban",
    dataDir: dir,
    env: { ...WECOM_ENV, ...(opts.env || {}) },
    fetchImpl: opts.fetchImpl,
    oauthNow: opts.oauthNow,
  });
  const base = await listen(server);
  try {
    await fn({ base, store, dir, server });
  } finally {
    await close(server);
  }
}

async function withPlain(fn) {
  const store = new Store();
  const server = createServer({ store, token: ADMIN, sourceTokens: SOURCE_TOKENS, basePath: "/kanban" });
  const base = await listen(server);
  try {
    await fn({ base, store });
  } finally {
    await close(server);
  }
}

async function mcp(base, token, method, params, id = 1) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/kanban/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  return { status: res.status, text, www: res.headers.get("www-authenticate"), body: text ? JSON.parse(text) : null };
}

async function registerClient(base, redirectUris = [REDIRECT], envBody = {}) {
  const res = await fetch(`${base}/kanban/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...envBody,
    }),
  });
  const text = await res.text();
  return { status: res.status, text, body: text ? JSON.parse(text) : null };
}

async function authorizePage(base, clientId, { challenge, redirect = REDIRECT, method = "S256", responseType = "code", state = "st-1", sessionCookie = "", resource = "" } = {}) {
  const q = new URLSearchParams({
    response_type: responseType,
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: method,
    state,
  });
  if (resource) q.set("resource", resource);
  const res = await fetch(`${base}/kanban/oauth/authorize?${q}`, {
    redirect: "manual",
    headers: sessionCookie ? { cookie: sessionCookie } : {},
  });
  const html = await res.text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/);
  return {
    status: res.status,
    html,
    location: res.headers.get("location"),
    resume: csrf ? csrf[1] : "",
    csrfCookie: cookiePair(res, OAUTH_CSRF_COOKIE),
    setCookie: setCookies(res).find((l) => l.startsWith(`${OAUTH_CSRF_COOKIE}=`)) || "",
  };
}

async function postConsent(base, { resume, csrfCookie, sessionCookie = "", source = "", sourceKey = "", deny = false }) {
  const body = new URLSearchParams({ csrf: resume, resume });
  if (source) body.set("source", source);
  if (sourceKey) body.set("source_key", sourceKey);
  if (deny) body.set("deny", "1");
  const cookie = [sessionCookie, csrfCookie].filter(Boolean).join("; ");
  const res = await fetch(`${base}/kanban/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body,
  });
  const location = res.headers.get("location");
  let code = null;
  let error = null;
  let state = null;
  if (location) {
    const u = new URL(location);
    code = u.searchParams.get("code");
    error = u.searchParams.get("error");
    state = u.searchParams.get("state");
  }
  const text = location ? "" : await res.text();
  return { status: res.status, location, code, error, state, text };
}

async function exchange(base, { clientId, code, verifier, redirect = REDIRECT, resource = "" }) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirect,
    client_id: clientId,
    code_verifier: verifier,
  });
  if (resource) body.set("resource", resource);
  const res = await fetch(`${base}/kanban/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
}

async function refresh(base, clientId, refreshToken) {
  const res = await fetch(`${base}/kanban/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
  });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) };
}

async function codeFor(base, clientId, { verifier, challenge, sourceKey = "", source = "", sessionCookie = "", redirect = REDIRECT }) {
  const page = await authorizePage(base, clientId, { challenge, redirect, sessionCookie });
  assert.equal(page.status, 200, page.html.slice(0, 200));
  assert.match(page.setCookie, /HttpOnly/i);
  assert.match(page.setCookie, /Secure/i);
  assert.match(page.setCookie, /SameSite=Lax/i);
  const post = await postConsent(base, {
    resume: page.resume,
    csrfCookie: page.csrfCookie,
    sessionCookie,
    sourceKey,
    source,
  });
  assert.equal(post.status, 302, post.text.slice(0, 300));
  assert.equal(post.state, "st-1");
  assert.ok(post.code);
  return post.code;
}

test("discovery documents and the /mcp 401 challenge point under /kanban", async () => {
  await withOauth({}, async ({ base }) => {
    const prm = await fetch(`${base}/kanban/.well-known/oauth-protected-resource`);
    assert.equal(prm.status, 200);
    const prmBody = await prm.json();
    assert.equal(prmBody.resource, `${PUBLIC}/mcp`);
    assert.deepEqual(prmBody.authorization_servers, [PUBLIC]);
    assert.deepEqual(prmBody.bearer_methods_supported, ["header"]);
    assert.equal(prm.headers.get("access-control-allow-origin"), "*");

    const suffixed = await (await fetch(`${base}/kanban/.well-known/oauth-protected-resource/mcp`)).json();
    assert.deepEqual(suffixed, prmBody);

    const as = await fetch(`${base}/kanban/.well-known/oauth-authorization-server`);
    const asBody = await as.json();
    const oidc = await (await fetch(`${base}/kanban/.well-known/openid-configuration`)).json();
    assert.deepEqual(oidc, asBody);
    assert.equal(asBody.issuer, PUBLIC);
    assert.equal(asBody.authorization_endpoint, `${PUBLIC}/oauth/authorize`);
    assert.equal(asBody.token_endpoint, `${PUBLIC}/oauth/token`);
    assert.equal(asBody.registration_endpoint, `${PUBLIC}/oauth/register`);
    assert.equal(asBody.revocation_endpoint, `${PUBLIC}/oauth/revoke`);
    assert.deepEqual(asBody.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(asBody.token_endpoint_auth_methods_supported, ["none"]);
    assert.ok(asBody.grant_types_supported.includes("authorization_code"));
    assert.ok(asBody.grant_types_supported.includes("refresh_token"));
    assert.ok(asBody.scopes_supported.includes("offline_access"));

    const denied = await fetch(`${base}/kanban/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(denied.status, 401);
    assert.equal(await denied.text(), '{"error":"unauthorized"}');
    assert.equal(denied.headers.get("www-authenticate"), CHALLENGE_HEADER);
    const getDenied = await fetch(`${base}/kanban/mcp`);
    assert.equal(getDenied.status, 401);
    assert.equal(getDenied.headers.get("www-authenticate"), CHALLENGE_HEADER);

    const api = await fetch(`${base}/kanban/api/tasks`);
    assert.equal(api.status, 401);
    assert.equal(api.headers.get("www-authenticate"), null);
    assert.equal(await api.text(), '{"error":"unauthorized"}');
  });
});

test("dynamic client registration accepts only allow-listed exact redirect URIs", async () => {
  await withOauth({}, async ({ base }) => {
    const ok = await registerClient(base, [REDIRECT, REDIRECT_COM]);
    assert.equal(ok.status, 201);
    assert.equal(ok.body.token_endpoint_auth_method, "none");
    assert.equal(ok.body.client_secret, undefined);
    assert.deepEqual(ok.body.redirect_uris, [REDIRECT, REDIRECT_COM]);
    assert.match(ok.body.client_id, /^[A-Za-z0-9_-]{40,}$/);

    const evil = await registerClient(base, ["https://evil.example/steal"]);
    assert.equal(evil.status, 400);
    assert.equal(evil.body.error, "invalid_redirect_uri");
    assert.equal(evil.text.includes("evil.example"), false);

    const secret = await registerClient(base, [REDIRECT], { token_endpoint_auth_method: "client_secret_basic" });
    assert.equal(secret.status, 400);
    assert.equal(secret.body.error, "invalid_client_metadata");
  });

  await withOauth({
    env: { AKB_OAUTH_REDIRECT_ALLOW: "https://example.com/cb, http://insecure.example/cb" },
  }, async ({ base }) => {
    assert.equal((await registerClient(base, ["https://example.com/cb"])).status, 201);
    assert.equal((await registerClient(base, [REDIRECT])).status, 201);
    assert.equal((await registerClient(base, ["http://insecure.example/cb"])).status, 400);
  });
});

test("authorization code + PKCE S256, then the access token acts as that source", async () => {
  const logs = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...a) => logs.push(a.join(" "));
  console.log = (...a) => logs.push(a.join(" "));
  try {
    await withOauth({}, async ({ base, store, dir }) => {
      const reg = await registerClient(base);
      const { verifier, challenge } = pkcePair();
      const code = await codeFor(base, reg.body.client_id, { verifier, challenge, sourceKey: CLAUDE_KEY });
      const tok = await exchange(base, { clientId: reg.body.client_id, code, verifier, resource: `${PUBLIC}/mcp` });
      assert.equal(tok.status, 200);
      assert.equal(tok.body.token_type, "Bearer");
      assert.equal(tok.body.expires_in, 3600);
      assert.equal(tok.body.scope, "claude-code offline_access");
      assert.ok(tok.body.refresh_token);

      const created = await mcp(base, tok.body.access_token, "tools/call", {
        name: "kanban_report",
        arguments: { title: "From Claude", status: "running" },
      });
      assert.equal(created.body.result.isError, false);
      const key = created.body.result.structuredContent.task_key;
      assert.match(key, /^claude-code:/);
      assert.equal(store.get(key).createdBy, "mcp:claude-code");
      assert.equal(created.www, null);

      const impersonate = await mcp(base, tok.body.access_token, "tools/call", {
        name: "kanban_report",
        arguments: { title: "Pretend", status: "done", source: "grok-bot" },
      });
      assert.equal(impersonate.body.result.isError, true);
      assert.match(impersonate.body.result.content[0].text, /cannot report as "grok-bot"/);

      const grok = await mcp(base, ADMIN, "tools/call", {
        name: "kanban_report",
        arguments: { title: "Grok card", status: "running", source: "grok-bot" },
      });
      const grokKey = grok.body.result.structuredContent.task_key;
      const hidden = await mcp(base, tok.body.access_token, "tools/call", { name: "kanban_get", arguments: { task_key: grokKey } });
      assert.equal(hidden.body.result.isError, true);
      const list = await mcp(base, tok.body.access_token, "tools/call", { name: "kanban_list", arguments: {} });
      const keys = list.body.result.structuredContent.tasks.map((t) => t.task_key);
      assert.ok(keys.includes(key));
      assert.equal(keys.includes(grokKey), false);

      const adminCard = await mcp(base, ADMIN, "tools/call", {
        name: "kanban_report",
        arguments: { title: "Admin claude card", status: "running", source: "claude-code" },
      });
      const adminKey = adminCard.body.result.structuredContent.task_key;
      const touch = await mcp(base, tok.body.access_token, "tools/call", {
        name: "kanban_report",
        arguments: { task_key: adminKey, status: "done" },
      });
      assert.equal(touch.body.result.isError, true);
      assert.match(touch.body.result.content[0].text, /not created by this key/);

      assert.equal((await fetch(`${base}/kanban/api/tasks`, { headers: { authorization: `Bearer ${tok.body.access_token}` } })).status, 401);
      assert.equal((await fetch(`${base}/kanban/api/tasks?token=${encodeURIComponent(tok.body.access_token)}`)).status, 401);
      assert.equal((await mcp(base, "", "initialize", {})).status, 401);

      const saved = fs.readFileSync(path.join(dir, "oauth.json"), "utf8");
      for (const secret of [tok.body.access_token, tok.body.refresh_token, code, verifier, CLAUDE_KEY, WECOM_ENV.AKB_WECOM_SECRET]) {
        assert.equal(saved.includes(secret), false);
      }
      assert.equal(fs.statSync(path.join(dir, "oauth.json")).mode & 0o777, 0o600);

      const blob = logs.join("\n");
      for (const secret of [tok.body.access_token, tok.body.refresh_token, code, verifier, CLAUDE_KEY, BOT_KEY, WECOM_ENV.AKB_WECOM_SECRET, WECOM_ENV.AKB_SESSION_SECRET]) {
        assert.equal(blob.includes(secret), false);
      }
    });
  } finally {
    console.error = origErr;
    console.log = origLog;
  }
});

test("wrong verifier burns the code; a reused code revokes the tokens it issued", async () => {
  await withOauth({}, async ({ base }) => {
    const reg = await registerClient(base);
    const clientId = reg.body.client_id;
    const pair = pkcePair();
    const code = await codeFor(base, clientId, { verifier: pair.verifier, challenge: pair.challenge, sourceKey: CLAUDE_KEY });
    const wrong = await exchange(base, { clientId, code, verifier: "a".repeat(50) });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, "invalid_grant");
    const again = await exchange(base, { clientId, code, verifier: pair.verifier });
    assert.equal(again.body.error, "invalid_grant");

    const pair2 = pkcePair();
    const code2 = await codeFor(base, clientId, { verifier: pair2.verifier, challenge: pair2.challenge, sourceKey: CLAUDE_KEY });
    const tok = await exchange(base, { clientId, code: code2, verifier: pair2.verifier });
    assert.equal(tok.status, 200);
    const replay = await exchange(base, { clientId, code: code2, verifier: pair2.verifier });
    assert.equal(replay.body.error, "invalid_grant");
    assert.equal((await mcp(base, tok.body.access_token, "tools/list", {})).status, 401);
    assert.equal((await refresh(base, clientId, tok.body.refresh_token)).body.error, "invalid_grant");
  });
});

test("bad redirect is not followed; plain PKCE and a mismatched redirect_uri are rejected", async () => {
  await withOauth({}, async ({ base }) => {
    const reg = await registerClient(base);
    const clientId = reg.body.client_id;
    const { challenge } = pkcePair();
    const evil = await authorizePage(base, clientId, { challenge, redirect: "https://evil.example/steal" });
    assert.notEqual(evil.status, 302);
    assert.equal(evil.location, null);
    assert.equal(evil.html.includes("evil.example"), false);

    const plain = await authorizePage(base, clientId, { challenge, method: "plain" });
    assert.equal(plain.status, 302);
    const u = new URL(plain.location);
    assert.equal(u.origin + u.pathname, REDIRECT);
    assert.equal(u.searchParams.get("error"), "invalid_request");
    assert.equal(u.searchParams.get("code"), null);

    const pair = pkcePair();
    const code = await codeFor(base, clientId, { verifier: pair.verifier, challenge: pair.challenge, sourceKey: CLAUDE_KEY });
    const swapped = await exchange(base, { clientId, code, verifier: pair.verifier, redirect: REDIRECT_COM });
    assert.equal(swapped.body.error, "invalid_grant");
  });
});

test("refresh tokens rotate and reuse of the old one revokes the new one; revoke kills the family", async () => {
  await withOauth({}, async ({ base }) => {
    const reg = await registerClient(base);
    const clientId = reg.body.client_id;
    const pair = pkcePair();
    const code = await codeFor(base, clientId, { verifier: pair.verifier, challenge: pair.challenge, sourceKey: CLAUDE_KEY });
    const tok = await exchange(base, { clientId, code, verifier: pair.verifier });
    const next = await refresh(base, clientId, tok.body.refresh_token);
    assert.equal(next.status, 200);
    assert.notEqual(next.body.refresh_token, tok.body.refresh_token);
    assert.equal((await mcp(base, next.body.access_token, "tools/list", {})).status, 200);
    assert.equal((await mcp(base, tok.body.access_token, "tools/list", {})).status, 401);

    const replay = await refresh(base, clientId, tok.body.refresh_token);
    assert.equal(replay.body.error, "invalid_grant");
    const killed = await refresh(base, clientId, next.body.refresh_token);
    assert.equal(killed.body.error, "invalid_grant");
    assert.equal((await mcp(base, next.body.access_token, "tools/list", {})).status, 401);

    const pair2 = pkcePair();
    const code2 = await codeFor(base, clientId, { verifier: pair2.verifier, challenge: pair2.challenge, sourceKey: CLAUDE_KEY });
    const tok2 = await exchange(base, { clientId, code: code2, verifier: pair2.verifier });
    const rev = await fetch(`${base}/kanban/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tok2.body.access_token, client_id: clientId }),
    });
    assert.equal(rev.status, 200);
    assert.equal((await mcp(base, tok2.body.access_token, "tools/list", {})).status, 401);
    assert.equal((await refresh(base, clientId, tok2.body.refresh_token)).body.error, "invalid_grant");
    const unknown = await fetch(`${base}/kanban/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "not-a-token", client_id: clientId }),
    });
    assert.equal(unknown.status, 200);
  });
});

test("a pasted agent-bound key cannot impersonate another bot; an owner session picks a source and never admin", async () => {
  await withOauth({}, async ({ base, store }) => {
    const reg = await registerClient(base);
    const clientId = reg.body.client_id;
    const pair = pkcePair();
    const code = await codeFor(base, clientId, { verifier: pair.verifier, challenge: pair.challenge, sourceKey: BOT_KEY });
    const tok = await exchange(base, { clientId, code, verifier: pair.verifier });
    const created = await mcp(base, tok.body.access_token, "tools/call", {
      name: "kanban_report",
      arguments: { title: "Bot work", status: "running", agent_name: "示例机器人" },
    });
    const key = created.body.result.structuredContent.task_key;
    assert.match(key, /^grok-bot:/);
    assert.equal(store.get(key).createdBy, "mcp:grok-bot@示例机器人");
    assert.equal(store.get(key).agentName, "示例机器人");
    const other = await mcp(base, tok.body.access_token, "tools/call", {
      name: "kanban_report",
      arguments: { title: "Other bot", status: "running", agent_name: "someone-else" },
    });
    assert.equal(other.body.result.isError, true);

    const session = `${SESSION_COOKIE}=${issueSession(WECOM_ENV.AKB_SESSION_SECRET, "QiaoYiFu")}`;
    const page = await authorizePage(base, clientId, { challenge: pkcePair().challenge, sessionCookie: session });
    assert.match(page.html, /QiaoYiFu/);
    assert.match(page.html, /value="claude-code"/);
    assert.match(page.html, /value="grok-bot"/);
    assert.equal(page.html.includes('value="admin"'), false);
    const denied = await postConsent(base, { resume: page.resume, csrfCookie: page.csrfCookie, sessionCookie: session, source: "admin" });
    assert.equal(denied.code, null);
    assert.equal(denied.status, 400);

    const pair2 = pkcePair();
    const page2 = await authorizePage(base, clientId, { challenge: pair2.challenge, sessionCookie: session });
    const noCookie = await postConsent(base, { resume: page2.resume, csrfCookie: "", sessionCookie: session, source: "claude-code" });
    assert.equal(noCookie.status, 403);
    const post = await postConsent(base, { resume: page2.resume, csrfCookie: page2.csrfCookie, sessionCookie: session, source: "claude-code" });
    const tok2 = await exchange(base, { clientId, code: post.code, verifier: pair2.verifier });
    const card = await mcp(base, tok2.body.access_token, "tools/call", {
      name: "kanban_report",
      arguments: { title: "Owner picked claude-code", status: "planning" },
    });
    const ownerKey = card.body.result.structuredContent.task_key;
    assert.match(ownerKey, /^claude-code:/);
    assert.equal(store.get(ownerKey).createdBy, "mcp:claude-code");
    const asGrok = await mcp(base, tok2.body.access_token, "tools/call", {
      name: "kanban_report",
      arguments: { title: "Nope", status: "done", source: "grok-bot" },
    });
    assert.equal(asGrok.body.result.isError, true);
    assert.equal((await fetch(`${base}/kanban/api/tasks`, { headers: { authorization: `Bearer ${tok2.body.access_token}` } })).status, 401);
  });
});

test("code, access, and refresh TTLs are enforced", async () => {
  let clock = Date.now();
  await withOauth({ oauthNow: () => clock }, async ({ base }) => {
    const reg = await registerClient(base);
    const clientId = reg.body.client_id;
    const pair = pkcePair();
    const code = await codeFor(base, clientId, { verifier: pair.verifier, challenge: pair.challenge, sourceKey: CLAUDE_KEY });
    clock += 61_000;
    const late = await exchange(base, { clientId, code, verifier: pair.verifier });
    assert.equal(late.body.error, "invalid_grant");

    clock = Date.now();
    const pair2 = pkcePair();
    const code2 = await codeFor(base, clientId, { verifier: pair2.verifier, challenge: pair2.challenge, sourceKey: CLAUDE_KEY });
    const tok = await exchange(base, { clientId, code: code2, verifier: pair2.verifier });
    clock += 60 * 60 * 1000 + 1000;
    assert.equal((await mcp(base, tok.body.access_token, "tools/list", {})).status, 401);
    const still = await refresh(base, clientId, tok.body.refresh_token);
    assert.equal(still.status, 200);
    clock += 30 * 24 * 60 * 60 * 1000 + 1000;
    assert.equal((await refresh(base, clientId, still.body.refresh_token)).body.error, "invalid_grant");
  });
});

test("key paste and the token endpoint are rate limited", async () => {
  await withOauth({}, async ({ base }) => {
    const reg = await registerClient(base);
    const clientId = reg.body.client_id;
    const { challenge } = pkcePair();
    const page = await authorizePage(base, clientId, { challenge });
    for (let i = 0; i < 5; i++) {
      const res = await postConsent(base, { resume: page.resume, csrfCookie: page.csrfCookie, sourceKey: `not-a-real-key-${i}-padding-to-32-chars` });
      assert.equal(res.status, 401);
      assert.equal(res.text.includes(`not-a-real-key-${i}`), false);
    }
    const blocked = await postConsent(base, { resume: page.resume, csrfCookie: page.csrfCookie, sourceKey: CLAUDE_KEY });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.text.includes(CLAUDE_KEY), false);

    let saw429 = false;
    for (let i = 0; i < 40; i++) {
      const res = await fetch(`${base}/kanban/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code",
      });
      if (res.status === 429) {
        saw429 = true;
        assert.equal((await res.json()).error, "slow_down");
        break;
      }
    }
    assert.equal(saw429, true);
  });
});

test("static Bearer responses stay the same whether or not OAuth state is loaded", async () => {
  await withPlain(async (plain) => {
    await withOauth({}, async (oauth) => {
      for (const token of [ADMIN, CLAUDE_KEY]) {
        const a = await mcp(plain.base, token, "initialize", { protocolVersion: "2025-06-18" });
        const b = await mcp(oauth.base, token, "initialize", { protocolVersion: "2025-06-18" });
        assert.equal(a.status, 200);
        assert.equal(b.status, 200);
        assert.equal(a.text, b.text);
        assert.equal(a.www, null);
        assert.equal(b.www, null);
        const listA = await mcp(plain.base, token, "tools/call", { name: "kanban_list", arguments: {} }, 2);
        const listB = await mcp(oauth.base, token, "tools/call", { name: "kanban_list", arguments: {} }, 2);
        assert.equal(listA.text, listB.text);
      }
      const missingA = await mcp(plain.base, "", "initialize", {});
      const missingB = await mcp(oauth.base, "", "initialize", {});
      assert.equal(missingA.status, 401);
      assert.equal(missingB.status, 401);
      assert.equal(missingA.text, missingB.text);
      assert.equal(missingA.text, '{"error":"unauthorized"}');
      assert.equal(missingA.www, null);
      assert.equal(missingB.www, CHALLENGE_HEADER);

      const report = await mcp(oauth.base, CLAUDE_KEY, "tools/call", {
        name: "kanban_report",
        arguments: { title: "CLI still works", status: "running", source: "grok-bot" },
      });
      assert.equal(report.body.result.isError, true);
      const ok = await mcp(oauth.base, CLAUDE_KEY, "tools/call", {
        name: "kanban_report",
        arguments: { title: "CLI still works", status: "running" },
      });
      assert.match(ok.body.result.structuredContent.task_key, /^claude-code:/);
      assert.equal((await fetch(`${oauth.base}/kanban/api/tasks`, { headers: { authorization: `Bearer ${CLAUDE_KEY}` } })).status, 401);
      assert.equal((await fetch(`${oauth.base}/kanban/api/tasks`, { headers: { authorization: `Bearer ${ADMIN}` } })).status, 200);
    });
  });
});

test("a corrupt oauth state fails closed and does not touch legacy cards or static keys", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akb-oauth-corrupt-"));
  const fixture = '{"version":1,"tasks":[{"key":"legacy:card","source":"claude-code","title":"keep-me","status":"running","updatedAt":"2020-01-01T00:00:00.000Z","events":[],"seen":[]}]}\n';
  fs.writeFileSync(path.join(dir, "state.json"), fixture);
  fs.writeFileSync(path.join(dir, "oauth.json"), "{");
  const logs = [];
  const orig = console.error;
  console.error = (...a) => logs.push(a.join(" "));
  try {
    await withOauth({ dir }, async ({ base, store }) => {
      assert.equal(store.get("legacy:card").title, "keep-me");
      assert.equal((await fetch(`${base}/kanban/.well-known/oauth-protected-resource`)).status, 503);
      assert.equal((await fetch(`${base}/kanban/oauth/token`, { method: "POST" })).status, 503);
      const denied = await mcp(base, "", "initialize", {});
      assert.equal(denied.status, 401);
      assert.equal(denied.www, null);
      assert.equal(denied.text, '{"error":"unauthorized"}');
      const ok = await mcp(base, CLAUDE_KEY, "tools/call", { name: "kanban_list", arguments: {} });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.result.isError, false);
      assert.equal(fs.readFileSync(path.join(dir, "oauth.json"), "utf8"), "{");
    });
  } finally {
    console.error = orig;
  }
  assert.equal(fs.readFileSync(path.join(dir, "state.json"), "utf8"), fixture);
  const blob = logs.join("\n");
  assert.match(blob, /oauth disabled/);
  assert.equal(blob.includes(CLAUDE_KEY), false);
  assert.equal(blob.includes(WECOM_ENV.AKB_WECOM_SECRET), false);
});

test("oauth writes do not rewrite legacy state, and tokens still work after a reload", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akb-oauth-legacy-"));
  const fixture = '{"version":1,"tasks":[{"key":"legacy:card","source":"claude-code","title":"keep-me","status":"running","updatedAt":"2020-01-01T00:00:00.000Z","events":[],"seen":[]}]}\n';
  fs.writeFileSync(path.join(dir, "state.json"), fixture);
  let access = "";
  await withOauth({ dir }, async ({ base }) => {
    const reg = await registerClient(base);
    const pair = pkcePair();
    const code = await codeFor(base, reg.body.client_id, { verifier: pair.verifier, challenge: pair.challenge, sourceKey: CLAUDE_KEY });
    const tok = await exchange(base, { clientId: reg.body.client_id, code, verifier: pair.verifier });
    access = tok.body.access_token;
    assert.equal(fs.readFileSync(path.join(dir, "state.json"), "utf8"), fixture);
    const listed = await mcp(base, access, "tools/call", { name: "kanban_list", arguments: {} });
    assert.equal(listed.body.result.structuredContent.tasks[0].task_key, "legacy:card");
  });
  assert.equal(fs.readFileSync(path.join(dir, "state.json"), "utf8"), fixture);
  await withOauth({ dir }, async ({ base, store }) => {
    assert.equal(store.get("legacy:card").title, "keep-me");
    assert.equal(store.get("legacy:card").status, "running");
    const listed = await mcp(base, access, "tools/call", { name: "kanban_list", arguments: {} });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.result.structuredContent.tasks[0].title, "keep-me");
    assert.equal(fs.readFileSync(path.join(dir, "state.json"), "utf8"), fixture);
  });
});

test("WeCom login returns to the consent page and the chosen source is not admin", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/gettoken")) return { json: async () => ({ errcode: 0, access_token: "access-TOKEN-xyz", expires_in: 7200 }) };
    if (u.includes("/auth/getuserinfo")) return { json: async () => ({ errcode: 0, userid: "QiaoYiFu" }) };
    throw new Error("unexpected");
  };
  await withOauth({ fetchImpl }, async ({ base, store }) => {
    const reg = await registerClient(base);
    const clientId = reg.body.client_id;
    const pair = pkcePair();
    const page = await authorizePage(base, clientId, { challenge: pair.challenge });
    const next = `/kanban/oauth/authorize?resume=${page.resume}`;
    const start = await fetch(`${base}/kanban/auth/wecom/start?next=${encodeURIComponent(next)}`, { redirect: "manual" });
    assert.equal(start.status, 302);
    const stateCookie = cookiePair(start, STATE_COOKIE);
    const state = new URL(start.headers.get("location").replace(/#wechat_redirect$/, "")).searchParams.get("state");
    const cb = await fetch(`${base}/kanban/auth/wecom/callback?code=c1&state=${state}`, {
      redirect: "manual",
      headers: { cookie: stateCookie },
    });
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get("location"), next);
    const session = cookiePair(cb, SESSION_COOKIE);
    const back = await fetch(`${base}${next}`, { headers: { cookie: session } });
    const html = await back.text();
    assert.match(html, /QiaoYiFu/);
    assert.match(html, /value="claude-code"/);
    const post = await postConsent(base, {
      resume: page.resume,
      csrfCookie: cookiePair(back, OAUTH_CSRF_COOKIE),
      sessionCookie: session,
      source: "claude-code",
    });
    assert.equal(new URL(post.location).searchParams.get("state"), "st-1");
    const tok = await exchange(base, { clientId, code: post.code, verifier: pair.verifier });
    const card = await mcp(base, tok.body.access_token, "tools/call", {
      name: "kanban_report",
      arguments: { title: "After WeCom", status: "running" },
    });
    assert.equal(store.get(card.body.result.structuredContent.task_key).createdBy, "mcp:claude-code");
    assert.ok(calls.some((u) => u.includes("/auth/getuserinfo")));
  });
});
