import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Store } from "../src/store.js";
import { createServer } from "../src/server.js";
import { COLUMNS, normalizeStatus } from "../src/status.js";
import { createGrokRelayPoller } from "../src/pollers/grok-relay.js";

const TOKEN = "test-choice-token-padded-to-32-chars";
const bearer = (token = TOKEN) => ({ authorization: `Bearer ${token}` });
const json = (body, headers = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

async function withServer(opts, fn) {
  const store = opts.store || new Store();
  const server = createServer({ store, token: TOKEN, ...opts });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let id = 0;
  const rpc = async (name, args, token = TOKEN) => {
    const res = await fetch(`${base}/mcp`, json(
      { jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } },
      bearer(token),
    ));
    const body = res.status === 200 ? await res.json() : null;
    return { status: res.status, body, result: body?.result };
  };
  try {
    await fn({ base, store, rpc });
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

// --- columns / review / planning ---

test("waiting and review columns are labelled 等您 and 审核中; review sits after running", () => {
  const ids = COLUMNS.map((c) => c.id);
  assert.equal(COLUMNS.find((c) => c.id === "waiting").label, "等您");
  assert.equal(COLUMNS.find((c) => c.id === "review").label, "审核中");
  assert.ok(ids.indexOf("review") > ids.indexOf("running"));
  assert.equal(normalizeStatus("review"), "review");
  assert.equal(normalizeStatus("审核中"), "review");
  assert.equal(normalizeStatus("等您"), "waiting");
  assert.equal(normalizeStatus("planning"), "planning");
});

test("kanban_report accepts status=review and status=planning", async () => {
  await withServer({}, async ({ rpc, store }) => {
    const rev = await rpc("kanban_report", { title: "送审 PR#23", status: "review", source: "grok-bot" });
    assert.equal(rev.result.isError, false);
    assert.equal(store.get(rev.result.structuredContent.task_key).status, "review");
    const plan = await rpc("kanban_report", { title: "想方案", status: "planning", source: "claude-chat" });
    assert.equal(store.get(plan.result.structuredContent.task_key).status, "planning");
  });
});

test("placeholder parent rollup keeps repo order (waiting > running > planning > queued > review > failed > done)", () => {
  // Requested urgency was waiting > failed > running > review > planning/queued > done.
  // This repo already ranks failed just before done and review after queued; keep that.
  const s = new Store();
  const parent = "claude-chat:thread";
  s.apply({ key: "c:done", parent, status: "done" });
  assert.equal(s.get(parent).status, "done");
  s.apply({ key: "c:failed", parent, status: "failed" });
  assert.equal(s.get(parent).status, "failed");
  s.apply({ key: "c:review", parent, status: "review" });
  assert.equal(s.get(parent).status, "review");
  s.apply({ key: "c:queued", parent, status: "queued" });
  assert.equal(s.get(parent).status, "queued");
  s.apply({ key: "c:planning", parent, status: "planning" });
  assert.equal(s.get(parent).status, "planning");
  s.apply({ key: "c:running", parent, status: "running" });
  assert.equal(s.get(parent).status, "running");
  s.apply({ key: "c:waiting", parent, status: "waiting" });
  assert.equal(s.get(parent).status, "waiting");
});

// --- options / choice ---

test("kanban_report stores optional question, background, options; omitted fields stay compatible", async () => {
  await withServer({}, async ({ rpc, store }) => {
    const plain = await rpc("kanban_report", { title: "plain", status: "waiting", source: "grok-bot" });
    const plainKey = plain.result.structuredContent.task_key;
    const p = store.get(plainKey);
    assert.equal(p.options, undefined);
    assert.equal(p.question, undefined);
    assert.equal(p.background, undefined);
    assert.equal(p.choice, undefined);

    const withOpts = await rpc("kanban_report", {
      title: "要不要上线？",
      status: "waiting",
      source: "grok-bot",
      question: "是否合并并上线 PR#23？",
      background: "CI 已绿。选 allow 会合并并部署；选 revise 会交回改。",
      options: [
        { label: "允许上线", value: "allow" },
        { label: "要改", value: "revise" },
      ],
    });
    assert.equal(withOpts.result.isError, false);
    const t = store.get(withOpts.result.structuredContent.task_key);
    assert.equal(t.question, "是否合并并上线 PR#23？");
    assert.match(t.background, /CI 已绿/);
    assert.deepEqual(t.options, [
      { label: "允许上线", value: "allow" },
      { label: "要改", value: "revise" },
    ]);
  });
});

test("board choice requires auth, first wins, repeat does not overwrite", async () => {
  await withServer({}, async ({ base, store, rpc }) => {
    const { result } = await rpc("kanban_report", {
      title: "审批",
      status: "waiting",
      source: "grok-bot",
      question: "走哪条？",
      options: [{ label: "A", value: "a" }, { label: "B", value: "b" }],
    });
    const key = result.structuredContent.task_key;
    const choose = (value, headers = bearer()) =>
      fetch(`${base}/api/tasks/${encodeURIComponent(key)}/choice`, json({ value }, headers));

    assert.equal((await choose("a", {})).status, 401);
    const first = await choose("a");
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.equal(body.choice.value, "a");
    assert.equal(body.choice.source, "board");
    assert.equal(body.changed, true);

    const again = await choose("b");
    assert.equal(again.status, 200);
    const againBody = await again.json();
    assert.equal(againBody.choice.value, "a");
    assert.equal(againBody.changed, false);
    assert.equal(store.get(key).choice.value, "a");

    assert.equal((await choose("not-an-option")).status, 200); // still first-wins no-op
    assert.equal(store.get(key).choice.value, "a");
  });
});

test("choice_resolved from chat marks 已选; board click afterward does not overwrite", async () => {
  await withServer({}, async ({ base, store, rpc }) => {
    const created = await rpc("kanban_report", {
      title: "聊天里先选",
      status: "waiting",
      source: "claude-chat",
      options: [{ label: "同意", value: "yes" }, { label: "拒绝", value: "no" }],
    });
    const key = created.result.structuredContent.task_key;
    const resolved = await rpc("kanban_report", {
      task_key: key,
      status: "waiting",
      choice_resolved: { value: "yes", source: "chat" },
    });
    assert.equal(resolved.result.isError, false);
    assert.equal(resolved.result.structuredContent.choice.value, "yes");
    assert.equal(resolved.result.structuredContent.choice.source, "chat");
    assert.equal(store.get(key).choice.source, "chat");

    const overwrite = await rpc("kanban_report", {
      task_key: key,
      status: "waiting",
      choice_resolved: { value: "no", source: "chat" },
    });
    assert.equal(overwrite.result.structuredContent.choice.value, "yes");

    const click = await fetch(`${base}/api/tasks/${encodeURIComponent(key)}/choice`, json({ value: "no" }, bearer()));
    assert.equal(click.status, 200);
    assert.equal((await click.json()).choice.value, "yes");
  });
});

test("kanban_get_choice returns null then the recorded pick for opening bots to poll", async () => {
  await withServer({}, async ({ base, rpc, store }) => {
    const created = await rpc("kanban_report", {
      title: "等您选",
      status: "waiting",
      source: "grok-bot",
      question: "部署吗？",
      background: "今晚窗口",
      options: [{ label: "部署", value: "deploy" }, { label: "暂缓", value: "hold" }],
    });
    const key = created.result.structuredContent.task_key;
    const before = await rpc("kanban_get_choice", { task_key: key });
    assert.equal(before.result.isError, false);
    assert.equal(before.result.structuredContent.choice, null);
    assert.equal(before.result.structuredContent.question, "部署吗？");
    assert.deepEqual(before.result.structuredContent.options.map((o) => o.value), ["deploy", "hold"]);

    await fetch(`${base}/api/tasks/${encodeURIComponent(key)}/choice`, json({ value: "hold" }, bearer()));
    const after = await rpc("kanban_get_choice", { task_key: key });
    assert.equal(after.result.structuredContent.choice.value, "hold");
    assert.equal(after.result.structuredContent.choice.source, "board");
    assert.ok(after.result.structuredContent.choice.at);
    assert.equal(store.get(key).events.some((e) => e.type === "choice"), true);
  });
});

test("tools/list exposes kanban_get_choice", async () => {
  await withServer({}, async ({ base }) => {
    const res = await fetch(`${base}/mcp`, json(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      bearer(),
    ));
    const tools = (await res.json()).result.tools.map((t) => t.name);
    assert.ok(tools.includes("kanban_get_choice"));
    assert.ok(tools.includes("kanban_report"));
  });
});

test("POST /choice sends no outbound network (not to relay or anywhere else)", async () => {
  const { default: https } = await import("node:https");
  const outbound = [];
  const realFetch = globalThis.fetch;
  const realHttp = http.request, realHttpGet = http.get, realHttps = https.request, realHttpsGet = https.get;
  const record = (via) => (...args) => { outbound.push(via); throw new Error("no network in this test"); };
  const fetchImpl = async (url) => { outbound.push(`fetchImpl ${url}`); throw new Error("no network"); };
  await withServer({ fetchImpl }, async ({ base, store }) => {
    store.apply({
      key: "grok-bot:r1",
      status: "waiting",
      title: "Pick",
      options: [{ label: "Go", value: "go" }],
    });
    globalThis.fetch = async (url, opts) => {
      if (!String(url).startsWith(base)) outbound.push(`fetch ${url}`);
      return realFetch(url, opts);
    };
    Object.assign(https, { request: record("https.request"), get: record("https.get") });
    Object.assign(http, { request: record("http.request"), get: record("http.get") });
    try {
      const res = await realFetch(`${base}/api/tasks/${encodeURIComponent("grok-bot:r1")}/choice`, json({ value: "go" }, bearer()));
      assert.equal(res.status, 200);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      globalThis.fetch = realFetch;
      Object.assign(https, { request: realHttps, get: realHttpsGet });
      Object.assign(http, { request: realHttp, get: realHttpGet });
    }
    assert.deepEqual(outbound, []);
    assert.equal(store.get("grok-bot:r1").choice.value, "go");
  });
});

test("store.recordChoice first-wins and rejects unknown option values", () => {
  const s = new Store();
  s.apply({
    key: "a:1",
    status: "waiting",
    options: [{ label: "Yes", value: "yes" }],
  });
  assert.equal(s.recordChoice("a:1", { value: "no" }), null);
  const first = s.recordChoice("a:1", { value: "yes", source: "board", by: "u1" });
  assert.equal(first.changed, true);
  assert.equal(s.get("a:1").choice.by, "u1");
  assert.equal(s.recordChoice("a:1", { value: "yes" }).changed, false);
});

// --- waiting aggregation (data shape the board uses) ---

test("waiting children stay under their parent and are listable as waiting alongside roots", () => {
  const s = new Store();
  s.apply({ key: "parent:1", title: "大任务", status: "running" });
  s.apply({ key: "child:1", title: "等审批", status: "waiting", parent: "parent:1" });
  s.apply({ key: "root-wait:1", title: "根上等您", status: "waiting" });
  assert.equal(s.get("parent:1").status, "running");
  assert.equal(s.get("child:1").parentKey, "parent:1");
  const waiting = s.list({ status: "waiting" });
  assert.deepEqual(waiting.map((t) => t.key).sort(), ["child:1", "root-wait:1"]);
  assert.equal(s.get(waiting.find((t) => t.key === "child:1").parentKey).title, "大任务");
});

// --- compat hard gate ---

test("legacy state.json fixture: two restarts keep every card and parentKey (zero delete, zero reparent)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akb-"));
  const fixture = new URL("./fixtures/state-legacy-parents.json", import.meta.url);
  fs.copyFileSync(fixture, path.join(dir, "state.json"));
  const original = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  const keys = original.tasks.map((t) => t.key).sort();
  const parents = Object.fromEntries(original.tasks.map((t) => [t.key, t.parentKey]));

  const relayTasks = original.tasks
    .filter((t) => t.source === "grok-bot")
    .map((t) => ({
      relayTaskId: t.externalId,
      title: t.title,
      status: t.status === "done" ? "finished" : "executing",
      source: "claude",
      sourceThread: null,
      kind: "task",
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      completion: null,
      updates: [],
    }));
  const fetchImpl = async (url) => {
    const id = String(url).split("/tasks/")[1];
    const body = id
      ? relayTasks.find((t) => t.relayTaskId === id) || { relayTaskId: id, title: id, status: "finished", updates: [], updatedAt: new Date().toISOString() }
      : { tasks: relayTasks.map(({ updates, ...t }) => t) };
    return { ok: true, status: 200, json: async () => body };
  };

  for (let run = 1; run <= 2; run++) {
    const s = new Store({ dataDir: dir });
    assert.deepEqual([...s.tasks.keys()].sort(), keys, `run ${run}: startup keeps every card`);
    for (const [key, parentKey] of Object.entries(parents)) {
      assert.equal(s.get(key).parentKey, parentKey, `run ${run}: ${key} parent unchanged`);
    }
    await createGrokRelayPoller({ store: s, baseUrl: "https://relay.example.com", keys: ["k1"], fetchImpl }).poll();
    assert.deepEqual([...s.tasks.keys()].sort(), keys, `run ${run}: poll keeps every card`);
    for (const [key, parentKey] of Object.entries(parents)) {
      assert.equal(s.get(key).parentKey, parentKey, `run ${run}: after poll ${key} parent unchanged`);
    }
    s.flush();
  }
});

test("old state without choice fields reloads with cards intact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akb-"));
  const old = new Store({ dataDir: dir });
  old.apply({ key: "x:1", title: "legacy", status: "waiting" });
  old.apply({ key: "x:2", title: "child", status: "running", parent: "x:1" });
  // Force parent off placeholder so status sticks as waiting (not rolled up).
  old.apply({ key: "x:1", status: "waiting", title: "legacy" });
  old.flush();
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.equal(raw.tasks.find((t) => t.key === "x:1").choice, undefined);
  const again = new Store({ dataDir: dir });
  assert.equal(again.tasks.size, 2);
  assert.equal(again.get("x:1").parentKey, null);
  assert.equal(again.get("x:2").parentKey, "x:1");
  assert.equal(again.get("x:1").choice, undefined);
  assert.equal(again.get("x:1").options, undefined);
});
