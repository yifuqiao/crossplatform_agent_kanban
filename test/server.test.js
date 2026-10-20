import test from "node:test";
import assert from "node:assert/strict";
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

test("POST /api/events then GET /api/tasks", async () => {
  await withServer({ token: "" }, async (base) => {
    let res = await fetch(`${base}/api/events`, json([{ key: "grok-bot:r1", title: "Deploy", status: "running" }, { key: "cursor-cloud:bc-1", parent: "grok-bot:r1", status: "running" }, { title: "no id" }]));
    assert.equal(res.status, 207);
    res = await fetch(`${base}/api/tasks`);
    const { columns, tasks } = await res.json();
    assert.equal(columns.length, 6);
    assert.equal(tasks.length, 2);
    res = await fetch(`${base}/api/tasks/${encodeURIComponent("grok-bot:r1")}`);
    assert.equal((await res.json()).children[0].key, "cursor-cloud:bc-1");
  });
});

test("token protects the API and cross-origin writes are refused", async () => {
  await withServer({ token: "s3cret" }, async (base) => {
    assert.equal((await fetch(`${base}/api/tasks`)).status, 401);
    assert.equal((await fetch(`${base}/api/tasks?token=s3cret`)).status, 200);
    assert.equal((await fetch(`${base}/`)).status, 200);
    const evil = await fetch(`${base}/api/events`, json({ key: "a:1", status: "done" }, { authorization: "Bearer s3cret", origin: "https://evil.example" }));
    assert.equal(evil.status, 403);
  });
});

test("MCP: initialize, list tools, report and list a chat task", async () => {
  await withServer({ token: "" }, async (base, store) => {
    const rpc = async (method, params, id = 1) => (await fetch(`${base}/mcp`, json({ jsonrpc: "2.0", id, method, params }))).json();
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    assert.equal(init.result.serverInfo.name, "agent-kanban");
    assert.equal((await fetch(`${base}/mcp`, json({ jsonrpc: "2.0", method: "notifications/initialized" }))).status, 202);
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

test("SSE stream pushes task changes", async () => {
  await withServer({ token: "" }, async (base, store) => {
    const res = await fetch(`${base}/api/stream`);
    const reader = res.body.getReader();
    await reader.read();
    store.apply({ key: "codex:t1", title: "Live", status: "running" });
    let text = "";
    while (!text.includes("event: task")) text += new TextDecoder().decode((await reader.read()).value);
    assert.match(text, /"title":"Live"/);
    await reader.cancel();
  });
});
