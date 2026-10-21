import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { normalizeStatus } from "../src/status.js";
import { createSessionSweeper } from "../src/pollers/session-sweep.js";

test("creates, updates and dedupes by event_id", () => {
  const s = new Store();
  s.apply({ source: "codex", external_id: "t1", title: "Fix bug", status: "running", event_id: "e1" });
  const r = s.apply({ source: "codex", external_id: "t1", status: "done", event_id: "e1" });
  assert.equal(r.changed, false);
  assert.equal(s.get("codex:t1").status, "running");
  s.apply({ key: "codex:t1", status: "done", message: "ok" });
  const t = s.get("codex:t1");
  assert.equal(t.status, "done");
  assert.ok(t.endedAt);
  assert.equal(t.events.length, 2);
});

test("a child can arrive before its parent; parent becomes a placeholder then fills in", () => {
  const s = new Store();
  s.apply({ source: "cursor-cloud", external_id: "bc-1", status: "running", parent: "grok-bot:r1" });
  assert.equal(s.get("grok-bot:r1").placeholder, true);
  assert.equal(s.children("grok-bot:r1").length, 1);
  s.apply({ source: "grok-bot", external_id: "r1", title: "Deploy PR", status: "running" });
  assert.equal(s.get("grok-bot:r1").placeholder, false);
  assert.equal(s.get("grok-bot:r1").title, "Deploy PR");
});

test("refuses parent links that would form a cycle", () => {
  const s = new Store();
  s.apply({ key: "a:1", status: "running" });
  s.apply({ key: "b:1", status: "running", parent: "a:1" });
  s.apply({ key: "a:1", parent: "b:1" });
  assert.equal(s.get("a:1").parentKey, null);
});

test("title modes: default is a fallback, first sticks, replace always wins", () => {
  const s = new Store();
  s.apply({ key: "x:1", title: "Claude Code · repo", title_mode: "default", status: "review" });
  s.apply({ key: "x:1", title: "Add login page", title_mode: "first" });
  s.apply({ key: "x:1", title: "Second prompt", title_mode: "first" });
  s.apply({ key: "x:1", title: "Claude Code · repo", title_mode: "default" });
  assert.equal(s.get("x:1").title, "Add login page");
  s.apply({ key: "x:1", title: "Renamed" });
  assert.equal(s.get("x:1").title, "Renamed");
});

test("initial_status only applies when the event creates the task", () => {
  const s = new Store();
  s.apply({ key: "c:1", initial_status: "running" });
  assert.equal(s.get("c:1").status, "running");
  s.apply({ key: "c:1", status: "done" });
  s.apply({ key: "c:1", initial_status: "running" });
  assert.equal(s.get("c:1").status, "done");
});

test("rejects unknown statuses and events without identity", () => {
  const s = new Store();
  assert.throws(() => s.apply({ key: "a:1", status: "banana" }), /unknown status/);
  assert.throws(() => s.apply({ title: "x" }), /source and external_id/);
});

test("persists to disk and reloads", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akb-"));
  const s = new Store({ dataDir: dir });
  s.apply({ key: "a:1", title: "Persist me", status: "running", event_id: "e1" });
  s.flush();
  const again = new Store({ dataDir: dir });
  assert.equal(again.get("a:1").title, "Persist me");
  assert.equal(again.apply({ key: "a:1", status: "done", event_id: "e1" }).changed, false);
});

test("remove deletes nested descendants too", () => {
  const s = new Store();
  s.apply({ key: "a:1", status: "running" });
  s.apply({ key: "b:1", parent: "a:1", status: "running" });
  s.apply({ key: "c:1", parent: "b:1", status: "running" });
  s.remove("a:1");
  assert.equal(s.tasks.size, 0);
});

test("normalizes native statuses from each platform", () => {
  assert.equal(normalizeStatus("FINISHED"), "done");
  assert.equal(normalizeStatus("waiting_approval"), "waiting");
  assert.equal(normalizeStatus("forwarded"), "running");
  assert.equal(normalizeStatus("CREATING"), "queued");
  assert.equal(normalizeStatus("EXPIRED"), "failed");
  assert.equal(normalizeStatus("in progress"), "running");
});

test("task url accepts only http/https schemes", () => {
  const s = new Store();
  s.apply({ key: "u:1", status: "running", url: "javascript:alert(1)" });
  assert.equal(s.get("u:1").url, null);
  s.apply({ key: "u:1", url: "data:text/html,hi" });
  assert.equal(s.get("u:1").url, null);
  s.apply({ key: "u:1", url: "https://example.com/ok" });
  assert.equal(s.get("u:1").url, "https://example.com/ok");
  s.apply({ key: "u:1", url: "http://example.com/also" });
  assert.equal(s.get("u:1").url, "http://example.com/also");
});

test("a late-arriving older status does not overwrite a newer one", () => {
  const s = new Store();
  s.apply({ key: "claude-code:s", status: "review", at: "2026-10-20T09:00:02Z" });
  s.apply({ key: "claude-code:s", status: "running", at: "2026-10-20T09:00:01Z", message: "Bash · ls" });
  const t = s.get("claude-code:s");
  assert.equal(t.status, "review");
  assert.equal(t.events.at(-1).message, "Bash · ls");
  s.apply({ key: "claude-code:s", status: "running", at: "2026-10-20T09:00:03Z" });
  assert.equal(s.get("claude-code:s").status, "running");
});

test("startup never deletes a card loaded from state.json, even an empty placeholder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akb-"));
  const card = (key, extra) => ({ key, source: key.split(":")[0], externalId: key.split(":")[1], status: "done", placeholder: true, parentKey: null, links: [], meta: {}, events: [], seen: [], createdAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z", ...extra });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ version: 1, tasks: [
    card("claude-chat:empty"),
    card("claude-chat:with-events", { events: [{ id: "e1", at: "2026-10-19T00:00:00.000Z", status: null, message: "hello", type: null }] }),
    card("claude-chat:with-summary", { summary: "notes" }),
  ] }));
  const s = new Store({ dataDir: dir });
  assert.ok(s.get("claude-chat:empty"));
  assert.ok(s.get("claude-chat:with-events"));
  assert.ok(s.get("claude-chat:with-summary"));

  s.apply({ key: "grok-bot:t1", parent: "claude-chat:with-events", status: "done" });
  s.apply({ key: "grok-bot:t1", parent: "claude-chat:elsewhere" });
  assert.ok(s.get("claude-chat:with-events"), "moving its child away does not delete it");
});

test("update requests: polled summaries do not answer them, a brief or a terminal status does", () => {
  const s = new Store();
  s.apply({ key: "grok-bot:r1", status: "running", title: "Long job" });
  s.requestUpdate("grok-bot:r1", { by: "yifu" });
  assert.equal(s.get("grok-bot:r1").updateRequest.by, "yifu");
  s.apply({ key: "grok-bot:r1", summary: "relay snapshot" });
  assert.ok(s.get("grok-bot:r1").updateRequest);
  s.apply({ key: "grok-bot:r1", summary: "fresh brief", brief: true });
  assert.equal(s.get("grok-bot:r1").updateRequest, null);
  s.requestUpdate("grok-bot:r1");
  s.apply({ key: "grok-bot:r1", status: "failed" });
  assert.equal(s.get("grok-bot:r1").updateRequest, null);
  assert.equal(s.requestUpdate("grok-bot:missing"), null);

  // A brief that also closes the task still lands on the timeline.
  s.apply({ key: "grok-bot:r2", status: "running", title: "Other job" });
  s.requestUpdate("grok-bot:r2");
  s.apply({ key: "grok-bot:r2", status: "done", summary: "final brief", brief: true });
  assert.equal(s.get("grok-bot:r2").updateRequest, null);
  assert.ok(s.get("grok-bot:r2").briefAt);
  assert.equal(s.get("grok-bot:r2").events.at(-1).message, "final brief");

  // Placeholders (cards that only group children) cannot be asked.
  s.apply({ key: "cursor-cloud:bc-1", status: "running", parent: "claude-chat:thread" });
  assert.equal(s.requestUpdate("claude-chat:thread"), null);
});

test("loading old state puts turn-ended hook cards back in 进行中 and frees XML titles", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akb-migrate-"));
  const at = "2026-10-20T10:00:00.000Z";
  const card = (key, status, type, title) => ({
    key, source: key.split(":")[0], externalId: key.split(":")[1], title, titled: true, status, links: [], meta: {},
    createdAt: at, updatedAt: at, events: [{ id: key, at, status, message: "m", type }], seen: [],
  });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ version: 1, tasks: [
    card("claude-code-web:a", "review", "stop", '<wake reason="spawn" current-time="2026'),
    card("claude-code-web:b", "review", "pr", "Open PR"),
    card("cursor:c", "review", "stop", "cursor turn"),
    { ...card("claude-code-web:d", "review", "stop", '<wake reason="mention" current-time="2026'),
      events: [
        { id: "d1", at, status: "running", message: 'Prompt: <wake reason="mention"><project><thread><message trigger="true" from="human" author="Yifu">把卡片标题改好', type: "prompt" },
        ...Array.from({ length: 8 }, (_, i) => ({ id: `d${i + 2}`, at, status: "running", message: null, type: null })),
        { id: "d9", at, status: "review", message: "m", type: "stop" },
      ] },
  ] }));
  const s = new Store({ dataDir: dir });
  assert.equal(s.get("claude-code-web:a").status, "running");
  assert.equal(s.get("claude-code-web:a").idleSince, at);
  assert.equal(s.get("claude-code-web:a").titled, false);
  assert.equal(s.get("claude-code-web:b").status, "review");
  // Recovered on the server from an old prompt, not only in the browser from the last few events.
  assert.equal(s.get("claude-code-web:d").title, "把卡片标题改好");
  assert.equal(s.get("claude-code-web:d").status, "running");
  assert.equal(s.get("cursor:c").status, "review");
  s.apply({ key: "claude-code-web:a", title: "真正的标题", title_mode: "first" });
  assert.equal(s.get("claude-code-web:a").title, "真正的标题");
});

test("session sweep closes hook session cards quiet for hours, and the next prompt reopens them", async () => {
  const s = new Store();
  const old = "2026-10-20T00:00:00.000Z";
  s.apply({ key: "claude-code-web:idle", title: "idle", status: "running", idle: true, at: old });
  s.apply({ key: "claude-code-web:silent", title: "silent", status: "running", at: old });
  s.apply({ key: "claude-code-web:fresh", title: "fresh", status: "running" });
  s.apply({ key: "claude-code-web:asks", title: "asks", status: "waiting", at: old });
  s.apply({ key: "grok-bot:r1", title: "relay", status: "running", at: old });
  s.apply({ key: "claude-code-web:mcp", title: "mcp", status: "running", created_by: "mcp:claude-code-web", at: old });
  s.apply({ key: "claude-code-web:busy", title: "busy parent", status: "running", at: old });
  s.apply({ key: "claude-code-web:busy/sub", parent: "claude-code-web:busy", status: "running" });
  await createSessionSweeper({ store: s }).poll();
  assert.equal(s.get("claude-code-web:idle").status, "done");
  assert.equal(s.get("claude-code-web:silent").status, "done");
  assert.match(s.get("claude-code-web:silent").events.at(-1).message, /6 小时没有动静/);
  for (const k of ["claude-code-web:fresh", "claude-code-web:asks", "grok-bot:r1", "claude-code-web:mcp", "claude-code-web:busy"]) {
    assert.notEqual(s.get(k).status, "done", k);
  }
  s.apply({ key: "claude-code-web:idle", status: "running", new_turn: true, message: "Prompt: 继续", type: "prompt" });
  assert.equal(s.get("claude-code-web:idle").status, "running");
});

test("loading old state turns raw notification prompts into relay lines", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akb-migrate-"));
  const at = "2026-10-20T10:00:00.000Z";
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ version: 1, tasks: [{
    key: "claude-code-web:n", source: "claude-code-web", externalId: "n", title: "t", titled: true, status: "running", links: [], meta: {},
    createdAt: at, updatedAt: at, seen: [], events: [
      { id: "n1", at, status: "running", message: "Prompt: <task-notification> <task-type>queued-remote-notifica", type: "prompt" },
      { id: "n2", at, status: "running", message: 'Prompt: <wake reason="mention"><message trigger="true" from="human">改一下标题', type: "prompt" },
      { id: "n3", at, status: "running", message: "Prompt: 普通的一句话", type: "prompt" },
    ],
  }] }));
  const ev = new Store({ dataDir: dir }).get("claude-code-web:n").events;
  assert.deepEqual(ev.map((e) => [e.type, e.message]), [["relay", "转来: 系统消息"], ["prompt", "Prompt: 改一下标题"], ["prompt", "Prompt: 普通的一句话"]]);
});
