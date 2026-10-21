import test from "node:test";
import assert from "node:assert/strict";
import { condenseTimeline } from "../public/timeline.js";

let n = 0;
const ev = (type, message, status = null) => ({ id: `e${++n}`, at: `2026-10-21T02:${String(n).padStart(2, "0")}:00Z`, type, message, status });

test("an older hook's one line per tool call folds into one summary between prompts", () => {
  const rows = condenseTimeline([
    ev("session", "Session resume"),
    ev("prompt", "Prompt: 部署 63047d2", "running"),
    ev("tool", "mcp__hearthbot__read_memory", "running"),
    ev("tool", "Bash · ssh grok-relay", "running"),
    ev("tool", "Bash · curl /kanban/health", "running"),
    ev("tool", "mcp__hearthbot__edit_message", "running"),
    ev("tool", "mcp__hearthbot__post_message", "running"),
    ev("tool", "mcp__hearthbot__no_reply_needed", "running"),
    ev("stop", "Turn finished, waiting for your next prompt"),
    ev("prompt", "Prompt: 好", "running"),
    ev("tool", "mcp__hearthbot__no_reply_needed", "running"),
    ev("stop", "Turn finished, waiting for your next prompt"),
  ]);
  assert.deepEqual(rows.map((r) => [r.kind, r.text || r.event.message]), [
    ["prompt", "Prompt: 部署 63047d2"],
    ["summary", "跑命令 2 · 回复 2 · 记忆"],
    ["prompt", "Prompt: 好"],
  ]);
  assert.equal(rows[1].events.length, 7);
});

test("a PR, a waiting question, relayed notes and bot reports keep their own rows", () => {
  const rows = condenseTimeline([
    ev("relay", "转来: Clean up the review lane", "running"),
    ev(null, null, "running"),
    ev("checklist", "进度 1/3"),
    ev("pr", "Opened https://github.com/o/r/pull/9", "review"),
    ev("checklist", "进度 3/3"),
    ev("notification", "Claude needs your permission", "waiting"),
    ev("progress", "CI green", "running"),
  ]);
  assert.deepEqual(rows.map((r) => [r.kind, r.text || r.event.message]), [
    ["relay", "转来: Clean up the review lane"],
    ["summary", "进度 1/3"],
    ["event", "Opened https://github.com/o/r/pull/9"],
    ["summary", "进度 3/3"],
    ["event", "Claude needs your permission"],
    ["event", "CI green"],
  ]);
});
