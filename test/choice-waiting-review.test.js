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

test("board choice requires auth; same value is idempotent 200; different value is 409", async () => {
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
    assert.equal(body.choice.by, "admin-token");
    assert.equal(body.changed, true);

    const same = await choose("a");
    assert.equal(same.status, 200);
    assert.equal((await same.json()).changed, false);

    const again = await choose("b");
    assert.equal(again.status, 409);
    assert.equal(store.get(key).choice.value, "a");
  });
});

test("choice_resolved from chat marks 已选; board click with other value is 409", async () => {
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
    assert.equal(resolved.result.structuredContent.choice.by, "admin-token");
    assert.equal(store.get(key).choice.source, "chat");

    const overwrite = await rpc("kanban_report", {
      task_key: key,
      status: "waiting",
      choice_resolved: { value: "no", source: "chat" },
    });
    assert.equal(overwrite.result.isError, true);
    assert.equal(overwrite.result.structuredContent.choice.value, "yes");
    assert.deepEqual(overwrite.result.structuredContent.choice_rejected, { reason: "already chosen", status: 409 });

    const click = await fetch(`${base}/api/tasks/${encodeURIComponent(key)}/choice`, json({ value: "no" }, bearer()));
    assert.equal(click.status, 409);
    assert.equal(store.get(key).choice.value, "yes");
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

test("store.recordChoice validates waiting/options/value and is idempotent", () => {
  const s = new Store();
  s.apply({ key: "a:1", status: "running", title: "not waiting" });
  assert.equal(s.recordChoice("a:1", { value: "yes" }).status, 409);

  s.apply({ key: "a:1", status: "waiting" });
  assert.equal(s.recordChoice("a:1", { value: "yes" }).status, 409); // no options

  s.apply({ key: "a:1", status: "waiting", options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }] });
  assert.equal(s.recordChoice("a:1", { value: 1 }).status, 400);
  assert.equal(s.recordChoice("a:1", { value: "maybe" }).status, 400);
  const first = s.recordChoice("a:1", { value: "yes", by: "u1" });
  assert.equal(first.changed, true);
  assert.equal(s.get("a:1").choice.by, "u1");
  assert.equal(s.get("a:1").choice.source, "board");
  assert.equal(s.recordChoice("a:1", { value: "yes" }).changed, false);
  assert.equal(s.recordChoice("a:1", { value: "no" }).status, 409);
});

test("MCP/events choice_resolved always stores source chat even if client sends board", async () => {
  const { hashToken } = await import("../src/source-tokens.js");
  const CLAUDE_KEY = "test-claude-key-0001-padded-to-32-chars";
  const sourceTokens = `claude-code:${hashToken(CLAUDE_KEY)}`;
  await withServer({ sourceTokens }, async ({ base, store, rpc }) => {
    const created = await rpc("kanban_report", {
      title: "Forge attempt",
      status: "waiting",
      options: [{ label: "Go", value: "go" }, { label: "Stop", value: "stop" }],
    }, CLAUDE_KEY);
    assert.equal(created.result.isError, false);
    const key = created.result.structuredContent.task_key;

    const forged = await rpc("kanban_report", {
      task_key: key,
      status: "waiting",
      choice_resolved: { value: "go", source: "board" },
    }, CLAUDE_KEY);
    assert.equal(forged.result.isError, false);
    const choice = forged.result.structuredContent.choice;
    assert.equal(choice.source, "chat");
    assert.equal(choice.by, "claude-code");
    assert.equal(store.get(key).choice.source, "chat");
    assert.notEqual(store.get(key).choice.source, "board");

    // Fresh card via /api/events with forged source:"board"; choice_by is server-set "events".
    store.apply({
      key: "events:1",
      title: "Via events",
      status: "waiting",
      options: [{ label: "X", value: "x" }],
    });
    const ev = await fetch(`${base}/api/events`, json({
      key: "events:1",
      status: "waiting",
      choice_resolved: { value: "x", source: "board" },
      choice_by: "forged-caller",
      agent_name: "hook",
    }, bearer()));
    assert.equal(ev.status, 200);
    assert.equal(store.get("events:1").choice.source, "chat");
    assert.equal(store.get("events:1").choice.by, "events");
  });
});

test("POST /choice rejects non-waiting, missing options, bad value types, unknown values", async () => {
  await withServer({}, async ({ base, store }) => {
    const choose = (key, body) =>
      fetch(`${base}/api/tasks/${encodeURIComponent(key)}/choice`, json(body, bearer()));

    store.apply({ key: "r:1", title: "running", status: "running", options: [{ label: "A", value: "a" }] });
    assert.equal((await choose("r:1", { value: "a" })).status, 409);

    store.apply({ key: "w:1", title: "no opts", status: "waiting" });
    assert.equal((await choose("w:1", { value: "a" })).status, 409);

    store.apply({
      key: "w:2", title: "opts", status: "waiting",
      options: [{ label: "A", value: "a" }, { label: "B", value: "b" }],
    });
    assert.equal((await choose("w:2", { value: 3 })).status, 400);
    assert.equal((await choose("w:2", { value: "c" })).status, 400);
    assert.equal((await choose("missing", { value: "a" })).status, 404);

    assert.equal((await choose("w:2", { value: "a" })).status, 200);
    assert.equal((await choose("w:2", { value: "a" })).status, 200); // idempotent
    assert.equal((await choose("w:2", { value: "b" })).status, 409);
  });
});

test("new question/options round clears the live choice so the user can choose again", async () => {
  await withServer({}, async ({ base, store, rpc }) => {
    const created = await rpc("kanban_report", {
      title: "Round 1",
      status: "waiting",
      question: "First question?",
      options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }],
    });
    const key = created.result.structuredContent.task_key;
    await fetch(`${base}/api/tasks/${encodeURIComponent(key)}/choice`, json({ value: "yes" }, bearer()));
    assert.equal(store.get(key).choice.value, "yes");

    const round2 = await rpc("kanban_report", {
      task_key: key,
      status: "waiting",
      question: "Second question after revision?",
      options: [{ label: "Allow", value: "allow" }, { label: "Revise", value: "revise" }],
    });
    assert.equal(round2.result.structuredContent.choice, null);
    assert.equal(store.get(key).choice, null);
    assert.ok(store.get(key).events.some((e) => e.type === "choice_clear"));
    assert.ok(store.get(key).events.some((e) => e.type === "choice" && /yes/.test(e.message)));

    const again = await fetch(`${base}/api/tasks/${encodeURIComponent(key)}/choice`, json({ value: "revise" }, bearer()));
    assert.equal(again.status, 200);
    assert.equal(store.get(key).choice.value, "revise");
    assert.equal(store.get(key).choice.source, "board");
  });
});

test("MCP and /api/events surface choice_rejected (isError / HTTP 409|400) instead of silent OK", async () => {
  await withServer({}, async ({ base, store, rpc }) => {
    const created = await rpc("kanban_report", {
      title: "Reject me",
      status: "waiting",
      options: [{ label: "A", value: "a" }, { label: "B", value: "b" }],
    });
    const key = created.result.structuredContent.task_key;
    await fetch(`${base}/api/tasks/${encodeURIComponent(key)}/choice`, json({ value: "a" }, bearer()));

    const conflict = await rpc("kanban_report", {
      task_key: key,
      status: "waiting",
      choice_resolved: { value: "b" },
    });
    assert.equal(conflict.result.isError, true);
    assert.equal(conflict.result.content[0].text, "already chosen");
    assert.deepEqual(conflict.result.structuredContent.choice_rejected, { reason: "already chosen", status: 409 });
    assert.equal(store.get(key).choice.value, "a");

    const badVal = await rpc("kanban_report", {
      task_key: key,
      status: "waiting",
      question: "New round?",
      options: [{ label: "X", value: "x" }],
      choice_resolved: { value: "not-x" },
    });
    assert.equal(badVal.result.isError, true);
    assert.equal(badVal.result.structuredContent.choice_rejected.status, 400);
    assert.match(badVal.result.structuredContent.choice_rejected.reason, /not in options/);

    store.apply({ key: "ev:no-opts", title: "bare", status: "waiting" });
    const noOpts = await fetch(`${base}/api/events`, json({
      key: "ev:no-opts",
      status: "waiting",
      choice_resolved: { value: "z" },
    }, bearer()));
    assert.equal(noOpts.status, 409);
    const noOptsBody = await noOpts.json();
    assert.equal(noOptsBody.ok, false);
    assert.equal(noOptsBody.choice_rejected.reason, "no options on this card");

    store.apply({
      key: "ev:opts", title: "opts", status: "waiting",
      options: [{ label: "A", value: "a" }],
    });
    store.recordChoice("ev:opts", { value: "a", by: "admin-token" });
    const evConflict = await fetch(`${base}/api/events`, json({
      key: "ev:opts",
      status: "waiting",
      choice_resolved: { value: "a" }, // same value → idempotent OK
    }, bearer()));
    assert.equal(evConflict.status, 200);

    const evOther = await fetch(`${base}/api/events`, json({
      key: "ev:opts",
      status: "waiting",
      choice_resolved: { value: "nope" },
    }, bearer()));
    assert.equal(evOther.status, 400);
    assert.equal((await evOther.json()).choice_rejected.status, 400);
  });
});

test("running→waiting with choice_resolved in one call validates against post-update status", async () => {
  await withServer({}, async ({ store, rpc }) => {
    const created = await rpc("kanban_report", {
      title: "Will wait",
      status: "running",
      options: [{ label: "Go", value: "go" }, { label: "Stop", value: "stop" }],
    });
    const key = created.result.structuredContent.task_key;
    assert.equal(store.get(key).status, "running");

    const resolved = await rpc("kanban_report", {
      task_key: key,
      status: "waiting",
      choice_resolved: { value: "go" },
    });
    assert.equal(resolved.result.isError, false);
    assert.equal(store.get(key).status, "waiting");
    assert.equal(store.get(key).choice.value, "go");
    assert.equal(store.get(key).choice.source, "chat");
  });
});

test("reordering the same option values does not clear the live choice", async () => {
  await withServer({}, async ({ base, store, rpc }) => {
    const created = await rpc("kanban_report", {
      title: "Reorder",
      status: "waiting",
      question: "Pick?",
      options: [{ label: "A", value: "a" }, { label: "B", value: "b" }],
    });
    const key = created.result.structuredContent.task_key;
    await fetch(`${base}/api/tasks/${encodeURIComponent(key)}/choice`, json({ value: "a" }, bearer()));

    const reorder = await rpc("kanban_report", {
      task_key: key,
      status: "waiting",
      question: "Pick?",
      options: [{ label: "Bee", value: "b" }, { label: "Aye", value: "a" }],
    });
    assert.equal(reorder.result.isError, false);
    assert.equal(store.get(key).choice.value, "a");
    assert.equal(store.get(key).events.some((e) => e.type === "choice_clear"), false);
    assert.deepEqual(store.get(key).options.map((o) => o.value), ["b", "a"]);
  });
});

test("source key cannot see or resolve another source's card (No task)", async () => {
  const { hashToken } = await import("../src/source-tokens.js");
  const CLAUDE_KEY = "test-claude-key-0001-padded-to-32-chars";
  const BOT_KEY = "test-bot-key-0002-padded-to-32-chars-x";
  const sourceTokens = `claude-code:${hashToken(CLAUDE_KEY)},grok-bot:${hashToken(BOT_KEY)}`;
  await withServer({ sourceTokens }, async ({ rpc }) => {
    const created = await rpc("kanban_report", {
      title: "Claude only",
      status: "waiting",
      options: [{ label: "Y", value: "y" }],
    }, CLAUDE_KEY);
    const key = created.result.structuredContent.task_key;

    const get = await rpc("kanban_get_choice", { task_key: key }, BOT_KEY);
    assert.equal(get.result.isError, true);
    assert.match(get.result.content[0].text, /No task/);

    const resolve = await rpc("kanban_report", {
      task_key: key,
      status: "waiting",
      choice_resolved: { value: "y" },
    }, BOT_KEY);
    assert.equal(resolve.result.isError, true);
    assert.match(resolve.result.content[0].text, /No task/);

    const missing = await rpc("kanban_get_choice", { task_key: "nobody:missing" }, CLAUDE_KEY);
    assert.equal(missing.result.isError, true);
    assert.match(missing.result.content[0].text, /No task/);
  });
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
