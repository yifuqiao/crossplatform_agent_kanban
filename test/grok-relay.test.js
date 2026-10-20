import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { grokTaskEvents, createGrokRelayPoller } from "../src/pollers/grok-relay.js";
import { cursorAgentEvent } from "../src/pollers/cursor-cloud.js";

const ID = "15ee3b55-0ce7-4244-bed4-0d386611c815";
// Shape of a real GET /tasks/<id> snapshot from grok-bot-task-relay 1.2.0 (trimmed).
const detail = {
  relayTaskId: ID,
  status: "executing",
  source: "claude",
  sourceThread: null,
  kind: "task",
  createdAt: "2026-10-19T08:00:47.124Z",
  updatedAt: "2026-10-19T08:11:00.591Z",
  completion: null,
  summary: "fail-closed b4d7162 CI绿；已送二审复审",
  updates: [
    { event_id: "u1", status: "received", summary: "收件分拣已收：合并并上线 PR #23（图纸）", at: "2026-10-19T08:01:22.602Z" },
    { event_id: "u2", status: "forwarded", summary: "已转交日川驾驶舱大总管（1a698906-4fe2-418c-8e6b-e52f17548df1）；合并/部署须先经代码二审批准", at: "2026-10-19T08:01:29.312Z" },
    { event_id: "u3", status: "waiting_approval", summary: "已送代码二审 PR#23（CI绿）；阻塞：待提供 FTP 凭据", at: "2026-10-19T08:03:55.562Z" },
    { event_id: "u4", status: "executing", summary: "二审要改：Cloud 修 fail-closed 中 bc-7f3a9e21-aaaa-4bbb 见 https://github.com/acme/portal/pull/23", at: "2026-10-19T08:07:57.815Z" },
  ],
};
const listed = { relayTaskId: ID, title: "合并并上线 PR #23（图纸）", status: "executing", updatedAt: detail.updatedAt };

test("relay snapshot becomes a card with timeline and wrapped activities", () => {
  const s = new Store();
  for (const ev of grokTaskEvents(detail, { listed })) s.apply(ev);
  const root = s.get(`grok-bot:${ID}`);
  assert.equal(root.title, "合并并上线 PR #23（图纸）");
  assert.equal(root.status, "running");
  assert.ok(root.events.some((e) => e.status === "waiting"));
  assert.ok(root.links.some((l) => l.url === "https://github.com/acme/portal/pull/23" && l.label === "PR"));

  const kids = s.children(root.key);
  const handoff = kids.find((k) => k.title.startsWith("Handed to"));
  assert.equal(handoff.title, "Handed to 日川驾驶舱大总管");
  assert.equal(handoff.status, "running");
  const cursor = s.get("cursor-cloud:bc-7f3a9e21-aaaa-4bbb");
  assert.equal(cursor.parentKey, root.key);
  assert.equal(cursor.kind, "cloud");
  assert.equal(cursor.status, "running");
});

test("finishing the relay task closes hand-offs; Cursor poller data is not overwritten", () => {
  const s = new Store();
  for (const ev of grokTaskEvents(detail, { listed })) s.apply(ev);
  // The Cursor poller reports the real agent state.
  s.apply(cursorAgentEvent({ id: "bc-7f3a9e21-aaaa-4bbb", name: "Fix fail-closed", status: "FINISHED", target: { prUrl: "https://github.com/acme/portal/pull/24" } }));
  const done = { ...detail, status: "finished", updatedAt: "2026-10-19T08:21:28.356Z", completion: { event_id: "c1", status: "finished", summary: "PR#23 deployed", artifacts: [] } };
  for (const ev of grokTaskEvents(done, { listed: { ...listed, status: "finished" }, closeCursorChildren: false })) s.apply(ev);

  assert.equal(s.get(`grok-bot:${ID}`).status, "done");
  const kids = s.children(`grok-bot:${ID}`);
  assert.ok(kids.every((k) => k.status === "done"));
  const cursor = s.get("cursor-cloud:bc-7f3a9e21-aaaa-4bbb");
  assert.equal(cursor.title, "Fix fail-closed");
  assert.equal(cursor.parentKey, `grok-bot:${ID}`);
});

test("a relay task submitted from a known chat thread nests under that chat card", () => {
  const s = new Store();
  for (const ev of grokTaskEvents({ ...detail, sourceThread: "conv-42" }, { listed })) s.apply(ev);
  assert.equal(s.get(`grok-bot:${ID}`).parentKey, "claude-chat:conv-42");
});

test("poller only refetches tasks whose status or updatedAt changed", async () => {
  const s = new Store();
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    assert.equal(opts.headers.authorization, "Bearer k1");
    const body = url.endsWith("/tasks?limit=50") ? { tasks: [listed] } : detail;
    return { ok: true, status: 200, json: async () => body };
  };
  const poller = createGrokRelayPoller({ store: s, baseUrl: "https://relay.example.com/", keys: ["k1"], fetchImpl });
  await poller.poll();
  await poller.poll();
  assert.equal(calls.filter((u) => u.includes(`/tasks/${ID}`)).length, 1);
  assert.equal(s.get(`grok-bot:${ID}`).status, "running");
});

test("Claude Code session threads become a placeholder card that rolls up its tasks", async () => {
  const { threadCard } = await import("../src/pollers/grok-relay.js");
  assert.equal(threadCard("claude", "https://claude.ai/code/session_01BPER2M4UidTDfYdHw8ji51").key, "claude-code-web:session_01BPER2M4UidTDfYdHw8ji51");
  assert.equal(threadCard("claude", "session_018LiRxJRaWVn6hXRmgeyKD7").key, "claude-code-web:session_018LiRxJRaWVn6hXRmgeyKD7");
  assert.equal(threadCard("chatgpt", "conv-1").key, "chatgpt:conv-1");

  const s = new Store();
  const thread = "https://claude.ai/code/session_01BPER2M4UidTDfYdHw8ji51";
  const done = { ...detail, status: "finished", sourceThread: thread, completion: { event_id: "c1", status: "finished", summary: "ok" } };
  for (const ev of grokTaskEvents(done, { listed: { ...listed, status: "finished" } })) s.apply(ev);
  const card = s.get("claude-code-web:session_01BPER2M4UidTDfYdHw8ji51");
  assert.equal(card.placeholder, true);
  assert.equal(card.status, "done");
  assert.equal(card.url, "https://claude.ai/code/session_01BPER2M4UidTDfYdHw8ji51");

  s.apply({ key: "grok-bot:other", parent: card.key, title: "Second task", status: "executing" });
  assert.equal(s.get(card.key).status, "running");
});

test("moving a child away drops an empty placeholder parent", () => {
  const s = new Store();
  s.apply({ key: "grok-bot:t1", parent: "claude-chat:old-thread", status: "done" });
  assert.equal(s.get("claude-chat:old-thread").status, "done");
  s.apply({ key: "grok-bot:t1", parent: "claude-code-web:session_x" });
  assert.equal(s.get("claude-chat:old-thread"), null);
});

test("a task titled 取代 <id> marks the older relay task superseded", async () => {
  const { supersededEvents } = await import("../src/pollers/grok-relay.js");
  const tasks = [
    { relayTaskId: "ad60c649-c58e-4cc5-9ca7-e9061d76e4a1", title: "部署 agent kanban（取代 375b898b）" },
    { relayTaskId: "375b898b-6074-4e6e-82c9-a132d7e99eee", title: "部署 agent kanban 到 relay 服务器" },
  ];
  const [ev] = supersededEvents(tasks);
  assert.equal(ev.key, "grok-bot:375b898b-6074-4e6e-82c9-a132d7e99eee");
  assert.equal(ev.meta.superseded_by, "grok-bot:ad60c649-c58e-4cc5-9ca7-e9061d76e4a1");
  assert.equal(supersededEvents(tasks.slice(1)).length, 0);
});

test("the board only reads from the relay: every request is a GET, nothing is submitted", async () => {
  const s = new Store();
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET" });
    return { ok: true, status: 200, json: async () => (url.includes("/tasks?") ? { tasks: [listed] } : detail) };
  };
  const poller = createGrokRelayPoller({ store: s, baseUrl: "https://relay.example.com", keys: ["k1"], fetchImpl });
  await poller.poll();
  assert.ok(calls.length > 0);
  assert.ok(calls.every((c) => c.method === "GET"), "relay must only be read");
  assert.ok(calls.every((c) => !/submit-task|executor/.test(c.url)));
  assert.deepEqual(Object.keys(poller).sort(), ["log", "name", "poll"]);
});

const LEGACY_A = "claude-chat:https://claude.ai/code/session_01BPER2M4UidTDfYdHw8ji51";
const LEGACY_B = "claude-chat:session_018LiRxJRaWVn6hXRmgeyKD7";

// Restart on a state.json saved before Claude Code session cards were keyed claude-code-web:*.
async function restartAndPoll(relayTasks) {
  const { default: fs } = await import("node:fs");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akb-"));
  fs.copyFileSync(new URL("./fixtures/state-legacy-parents.json", import.meta.url), path.join(dir, "state.json"));
  const s = new Store({ dataDir: dir });
  const before = new Map([...s.tasks.values()].map((t) => [t.key, t.parentKey]));
  const fetchImpl = async (url) => {
    const id = url.split("/tasks/")[1];
    const body = id ? relayTasks.find((t) => t.relayTaskId === id) : { tasks: relayTasks.map(({ updates, ...t }) => t) };
    return { ok: true, status: 200, json: async () => body };
  };
  await createGrokRelayPoller({ store: s, baseUrl: "https://relay.example.com", keys: ["k1"], fetchImpl }).poll();
  return { s, before };
}

const relayTask = (relayTaskId, title, status, sourceThread, updatedAt) => ({
  relayTaskId, title, status, source: "claude", sourceThread, kind: "task", createdAt: updatedAt, updatedAt, completion: null, updates: [],
});

test("restart + first poll on an old state.json keeps every card and key", async () => {
  const { s, before } = await restartAndPoll([
    relayTask("15ee3b55-0ce7-4244-bed4-0d386611c815", "合并并上线 PR #23（图纸）", "executing", "https://claude.ai/code/session_01BPER2M4UidTDfYdHw8ji51", "2026-10-20T08:00:00.000Z"),
    relayTask("375b898b-6074-4e6e-82c9-a132d7e99eee", "部署 agent kanban 到 relay 服务器", "finished", "session_018LiRxJRaWVn6hXRmgeyKD7", "2026-10-19T09:00:00.000Z"),
    relayTask("ad60c649-c58e-4cc5-9ca7-e9061d76e4a1", "部署 agent kanban（取代 375b898b）", "finished", "session_018LiRxJRaWVn6hXRmgeyKD7", "2026-10-19T09:30:00.000Z"),
  ]);
  const after = new Map([...s.tasks.values()].map((t) => [t.key, t.parentKey]));
  assert.equal(after.size, before.size);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  assert.deepEqual(after, before, "every card keeps its parent");
  assert.ok(![...after.keys()].some((k) => k.startsWith("claude-code-web:")));
  assert.equal(s.children(LEGACY_B).length, 2);
});

test("a new task from a conversation that has a legacy card joins that card", async () => {
  const { s } = await restartAndPoll([
    relayTask("0b1c2d3e-0000-4000-8000-000000000001", "新任务", "executing", "https://claude.ai/code/session_01BPER2M4UidTDfYdHw8ji51", "2026-10-20T08:00:00.000Z"),
  ]);
  assert.equal(s.get("grok-bot:0b1c2d3e-0000-4000-8000-000000000001").parentKey, LEGACY_A);
  assert.equal(s.get("claude-code-web:session_01BPER2M4UidTDfYdHw8ji51"), null);
  assert.equal(s.get(LEGACY_A).status, "running");
});

test("two restarts with polls on the live state.json shape keep every card and key", async () => {
  const { default: fs } = await import("node:fs");
  const { default: os } = await import("node:os");
  const { default: path } = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akb-"));
  const state = JSON.parse(fs.readFileSync(new URL("./fixtures/state-legacy-parents.json", import.meta.url), "utf8"));
  // Cards an older version would have dropped on startup: childless, eventless placeholders.
  const empty = (key) => ({ ...state.tasks[0], key, externalId: key.slice(key.indexOf(":") + 1), source: key.split(":")[0], events: [], seen: [], summary: null });
  state.tasks.push(empty("claude-chat:session_01EmptyLegacyParent"), empty("grok-bot:00000000-0000-4000-8000-0000000000aa"));
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
  const keys = state.tasks.map((t) => t.key).sort();

  const relayTasks = [
    relayTask("15ee3b55-0ce7-4244-bed4-0d386611c815", "合并并上线 PR #23（图纸）", "executing", "https://claude.ai/code/session_01BPER2M4UidTDfYdHw8ji51", "2026-10-20T08:00:00.000Z"),
    relayTask("375b898b-6074-4e6e-82c9-a132d7e99eee", "部署 agent kanban 到 relay 服务器", "finished", "session_018LiRxJRaWVn6hXRmgeyKD7", "2026-10-19T09:00:00.000Z"),
  ];
  const fetchImpl = async (url) => {
    const id = url.split("/tasks/")[1];
    const body = id ? relayTasks.find((t) => t.relayTaskId === id) : { tasks: relayTasks.map(({ updates, ...t }) => t) };
    return { ok: true, status: 200, json: async () => body };
  };
  for (let run = 1; run <= 2; run++) {
    const s = new Store({ dataDir: dir });
    assert.deepEqual([...s.tasks.keys()].sort(), keys, `run ${run}: startup keeps every card`);
    await createGrokRelayPoller({ store: s, baseUrl: "https://relay.example.com", keys: ["k1"], fetchImpl }).poll();
    assert.deepEqual([...s.tasks.keys()].sort(), keys, `run ${run}: polling keeps every card`);
    s.flush();
  }
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
  assert.equal(saved.tasks.length, keys.length);
  assert.deepEqual(saved.tasks.map((t) => t.key).sort(), keys);
});
