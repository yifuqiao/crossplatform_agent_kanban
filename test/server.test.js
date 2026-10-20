import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { Store } from "../src/store.js";
import { createServer } from "../src/server.js";

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
    assert.equal(columns.length, 6);
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
    assert.deepEqual(tools.result.tools.map((t) => t.name), ["kanban_report", "kanban_list", "kanban_get"]);

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
