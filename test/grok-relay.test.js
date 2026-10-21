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

  assert.equal(root.agentName, "日川驾驶舱大总管");
  assert.ok(!s.children(root.key).some((k) => k.title.startsWith("Handed to")), "hand-offs are a label, not cards");
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
  const poller = createGrokRelayPoller({ store: s, baseUrl: "https://relay.example.com/", keys: ["k1"], fetchImpl, now: () => Date.parse(detail.updatedAt) + 60000 });
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
  // Poll as of the fixture's time, so the 24-hour quiet rule does not touch its cards.
  await createGrokRelayPoller({ store: s, baseUrl: "https://relay.example.com", keys: ["k1"], fetchImpl, now: () => Date.parse("2026-10-20T08:01:00.000Z") }).poll();
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

// --- inferred waits, quiet tasks, retries, titles (2026-10-21) ---

const at = (min) => new Date(Date.parse("2026-10-20T09:00:00.000Z") + min * 60000).toISOString();
const executing = (summary, extra = {}) => ({
  relayTaskId: "b282293b-2c10-4fda-8e93-df2c0b0f6ea3", status: "executing", source: "claude", sourceThread: null, kind: "task",
  createdAt: at(0), updatedAt: at(5), completion: null, summary,
  updates: [
    { event_id: "s1", status: "forwarded", summary: "已转日川驾驶舱大总管（1a698906）执行", at: at(1) },
    { event_id: "p1", status: "executing", summary, at: at(5) },
  ],
  ...extra,
});

test("a task waiting on the code-review bot stays running with a 等代码二审 note", () => {
  const s = new Store();
  for (const ev of grokTaskEvents(executing("B 完成 7/7；A 待二审 allow"), { listed: { title: "更新 kanban" } })) s.apply(ev);
  const t = s.get("grok-bot:b282293b-2c10-4fda-8e93-df2c0b0f6ea3");
  assert.equal(t.status, "running");
  assert.equal(t.meta.waiting_on, "代码二审");
  assert.equal(t.agentName, "日川驾驶舱大总管", "a short bracketed bot id still names the bot");
  assert.equal(s.children(t.key).length, 0);
});

test("a task waiting on the user goes to 等您, and leaves it when work resumes", () => {
  const s = new Store();
  const key = "grok-bot:b282293b-2c10-4fda-8e93-df2c0b0f6ea3";
  for (const ev of grokTaskEvents(executing("部署前等乔总对来源钥匙点头"), { listed: { title: "t" } })) s.apply(ev);
  assert.equal(s.get(key).status, "waiting");
  assert.equal(s.get(key).meta.waiting_on, "您");

  const resumed = executing("开始部署");
  resumed.updates = [...executing("部署前等乔总对来源钥匙点头").updates, { event_id: "p2", status: "executing", summary: "开始部署", at: at(30) }];
  resumed.updatedAt = at(30);
  for (const ev of grokTaskEvents(resumed, { listed: { title: "t" } })) s.apply(ev);
  assert.equal(s.get(key).status, "running");
  assert.equal(s.get(key).meta.waiting_on, null);
});

test("a pending relay approval means 等您", async () => {
  const { inferWait } = await import("../src/pollers/grok-relay.js");
  assert.deepEqual(inferWait({ approval: { status: "pending" } }, []), { status: "waiting", waitingOn: "审批" });
  assert.equal(inferWait({ approval: { status: "approved" } }, []), null);
  assert.equal(inferWait({ summary: "二审要改：Cloud 修 fail-closed" }, []), null);
});

test("an open relay task quiet for 24 hours moves to 等您 once; a newer relay update takes it back", async () => {
  const s = new Store();
  let detailNow = executing("核对中");
  let listedNow = { relayTaskId: detailNow.relayTaskId, title: "更新 kanban", status: "executing", updatedAt: detailNow.updatedAt };
  const fetchImpl = async (url) => ({ ok: true, status: 200, json: async () => (url.includes("/tasks?") ? { tasks: [listedNow] } : detailNow) });
  let clock = Date.parse(at(60));
  const poller = createGrokRelayPoller({ store: s, baseUrl: "https://relay.example.com", keys: ["k1"], fetchImpl, now: () => clock });
  const key = `grok-bot:${detailNow.relayTaskId}`;

  await poller.poll();
  assert.equal(s.get(key).status, "running");

  clock = Date.parse(at(5)) + 25 * 3600 * 1000;
  await poller.poll();
  await poller.poll();
  assert.equal(s.get(key).status, "waiting");
  assert.equal(s.get(key).meta.quiet_since, at(5));
  assert.equal(s.get(key).events.filter((e) => e.type === "quiet").length, 1);

  detailNow = { ...executing("又开始了"), updatedAt: at(26 * 60) };
  detailNow.updates = [...detailNow.updates, { event_id: "p9", status: "executing", summary: "又开始了", at: at(26 * 60) }];
  listedNow = { ...listedNow, updatedAt: at(26 * 60) };
  clock = Date.parse(at(26 * 60)) + 60000;
  await poller.poll();
  assert.equal(s.get(key).status, "running");
});

test("dry runs stay off the board", async () => {
  const s = new Store();
  const ping = { relayTaskId: "ac4bb7eb-7bd9-4233-a6e6-36113f5ba3df", title: "relay-ping", status: "dry_run", updatedAt: at(0) };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ tasks: [ping] }) });
  await createGrokRelayPoller({ store: s, baseUrl: "https://relay.example.com", keys: ["k1"], fetchImpl }).poll();
  assert.equal(s.list().length, 0);
});

test("a failed task retried with the same PR title is folded into the retry", async () => {
  const { supersededEvents } = await import("../src/pollers/grok-relay.js");
  const tasks = [
    { relayTaskId: "c629197f-bd0f-4985-a567-0eca4e8b9eda", title: "二审并部署 Agent Kanban PR #6 新 head daf07ae 到 relay.onetopway.com/kanban", status: "finished", createdAt: at(20) },
    { relayTaskId: "87597768-6ff8-4948-aada-64aa76f52424", title: "二审并部署 Agent Kanban PR #6（91210d3）到 relay.onetopway.com/kanban", status: "failed", createdAt: at(0) },
    { relayTaskId: "11111111-0000-4000-8000-000000000000", title: "部署 supplier-management PR #6", status: "failed", createdAt: at(1) },
  ];
  const events = supersededEvents(tasks);
  assert.equal(events.length, 1);
  assert.equal(events[0].key, "grok-bot:87597768-6ff8-4948-aada-64aa76f52424");
  assert.equal(events[0].meta.superseded_by, "grok-bot:c629197f-bd0f-4985-a567-0eca4e8b9eda");
});

test("a conversation card is named after its task, not its raw thread id", () => {
  const s = new Store();
  for (const ev of grokTaskEvents({ ...detail, sourceThread: "cmsg_01BTANmoK6wNuUQuMaY7ep6R6EWq9VsfaWXL6danotWJhJ" }, { listed })) s.apply(ev);
  const parent = s.get("claude-chat:cmsg_01BTANmoK6wNuUQuMaY7ep6R6EWq9VsfaWXL6danotWJhJ");
  assert.equal(parent.title, "claude-chat · 合并并上线 PR #23（图纸）");
  assert.equal(parent.placeholder, true);

  // A real card (e.g. a Claude Code session from hooks) keeps its own title.
  s.apply({ key: "claude-code-web:session_01BPER2M4UidTDfYdHw8ji51", title: "Grok Bot 状态上报设计", status: "running" });
  for (const ev of grokTaskEvents({ ...detail, sourceThread: "session_01BPER2M4UidTDfYdHw8ji51" }, { listed, existing: () => null })) s.apply(ev);
  assert.equal(s.get("claude-code-web:session_01BPER2M4UidTDfYdHw8ji51").title, "Grok Bot 状态上报设计");
});

test("an open relay task that fell off the first /tasks page still goes quiet; other grok-bot cards do not", async () => {
  const s = new Store();
  s.apply({ key: "grok-bot:old-relay", title: "Old", status: "executing", meta: { relay_status: "executing" }, at: at(0) });
  s.apply({ key: "grok-bot:from-mcp", title: "Reported over MCP", status: "running", at: at(0) });
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ tasks: [] }) });
  const poller = createGrokRelayPoller({ store: s, baseUrl: "https://relay.example.com", keys: ["k1"], fetchImpl, now: () => Date.parse(at(0)) + 25 * 3600 * 1000 });
  await poller.poll();
  await poller.poll();
  assert.equal(s.get("grok-bot:old-relay").status, "waiting");
  assert.equal(s.get("grok-bot:old-relay").events.filter((e) => e.type === "quiet").length, 1);
  assert.equal(s.get("grok-bot:from-mcp").status, "running");
});
