import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { normalizeStatus } from "../src/status.js";

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
