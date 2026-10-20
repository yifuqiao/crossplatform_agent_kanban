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
