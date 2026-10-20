import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { applyEnvLinks, promptText } from "../src/adapters/common.js";
import { claudeCodeEvents } from "../src/adapters/claude-code.js";
import { cursorEvents, cursorHookResponse } from "../src/adapters/cursor.js";
import { codexEvents } from "../src/adapters/codex.js";

function feed(store, adapter, payloads, env = {}) {
  for (const p of payloads) {
    const { rootKey, events } = adapter(p, env);
    for (const ev of applyEnvLinks(events, rootKey, env)) store.apply(ev);
  }
}

test("Claude Code session lifecycle with a nested subagent", () => {
  const s = new Store();
  const base = { session_id: "s1", cwd: "/work/shop", transcript_path: "/t.jsonl" };
  feed(s, claudeCodeEvents, [
    { ...base, hook_event_name: "SessionStart", source: "startup" },
    { ...base, hook_event_name: "UserPromptSubmit", prompt: "Add a checkout page" },
    { ...base, hook_event_name: "PreToolUse", tool_name: "Task", tool_use_id: "tu1", tool_input: { description: "Explore payment code", prompt: "find stripe usage", subagent_type: "Explore" } },
    { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } },
  ]);
  const session = s.get("claude-code:s1");
  assert.equal(session.title, "Add a checkout page");
  assert.equal(session.status, "running");
  const [sub] = s.children("claude-code:s1");
  assert.equal(sub.title, "Explore payment code");
  assert.equal(sub.status, "running");

  feed(s, claudeCodeEvents, [
    { ...base, hook_event_name: "PostToolUse", tool_name: "Task", tool_use_id: "tu1", tool_response: { content: [{ type: "text", text: "found 3 files" }] } },
    { ...base, hook_event_name: "Notification", message: "Claude needs your permission to use Bash" },
  ]);
  assert.equal(s.get(sub.key).status, "done");
  assert.equal(s.get(sub.key).summary, "found 3 files");
  assert.equal(s.get("claude-code:s1").status, "waiting");
  feed(s, claudeCodeEvents, [{ ...base, hook_event_name: "Stop" }]);
  assert.equal(s.get("claude-code:s1").status, "review");
});

test("AKB_PARENT_KEY nests a session; AKB_TASK_KEY reports into an existing card", () => {
  const s = new Store();
  s.apply({ key: "grok-bot:r1", title: "Grok task", status: "running" });
  feed(s, codexEvents, [{ type: "agent-turn-complete", "thread-id": "th1", "turn-id": "u1", cwd: "/w", "input-messages": ["refactor"], "last-assistant-message": "done refactor" }], { AKB_PARENT_KEY: "grok-bot:r1" });
  assert.equal(s.get("codex:th1").parentKey, "grok-bot:r1");

  s.apply({ key: "claude-code:wrapped", title: "claude", title_mode: "default", status: "running" });
  feed(s, claudeCodeEvents, [{ session_id: "s9", cwd: "/w", hook_event_name: "UserPromptSubmit", prompt: "write docs" }], { AKB_TASK_KEY: "claude-code:wrapped" });
  assert.equal(s.get("claude-code:s9"), null);
  assert.equal(s.get("claude-code:wrapped").title, "write docs");
});

test("Cursor hooks map to a conversation card and answer beforeSubmitPrompt", () => {
  const s = new Store();
  const base = { conversation_id: "c1", generation_id: "g1", workspace_roots: ["/w/app"] };
  feed(s, cursorEvents, [
    { ...base, hook_event_name: "beforeSubmitPrompt", prompt: "Make the navbar sticky" },
    { ...base, hook_event_name: "afterFileEdit", file_path: "/w/app/nav.tsx" },
    { ...base, hook_event_name: "stop", status: "completed" },
  ]);
  const t = s.get("cursor:c1");
  assert.equal(t.title, "Make the navbar sticky");
  assert.equal(t.status, "review");
  assert.deepEqual(cursorHookResponse({ hook_event_name: "beforeSubmitPrompt" }), { continue: true });
  assert.deepEqual(cursorHookResponse({ hook_event_name: "stop" }), {});
});

test("Claude Code on the web keys the card by the claude.ai session and links to it", () => {
  const s = new Store();
  const env = { CLAUDE_CODE_REMOTE_SESSION_ID: "cse_01V1RqqeQoEuMwq6Brf3XUMC" };
  feed(s, claudeCodeEvents, [
    { session_id: "8bc88d66", cwd: "/home/user/repo", hook_event_name: "UserPromptSubmit", prompt: "Fix the board data" },
    { session_id: "8bc88d66", cwd: "/home/user/repo", hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "tu9", tool_input: { description: "Search code" } },
  ], env);
  const card = s.get("claude-code-web:session_01V1RqqeQoEuMwq6Brf3XUMC");
  assert.equal(card.title, "Fix the board data");
  assert.equal(card.kind, "cloud");
  assert.equal(card.url, "https://claude.ai/code/session_01V1RqqeQoEuMwq6Brf3XUMC");
  assert.equal(s.children(card.key)[0].title, "Search code");
});

test("project-thread prompts are titled with the person's words, not the wake XML", () => {
  const wake = `<wake reason="mention" current-time="2026-10-20T16:51:44Z"> <project id="chan_1" type="project"> <thread ts="cmsg_1"> <message trigger="true" from="human" trust="principal" author="Yifu" id="cmsg_2">关掉吧</message> </thread> </project> <system-note>Thread state: …</system-note> </wake>`;
  assert.equal(promptText(wake), "关掉吧");
  const relay = `<coordinator-relay>&lt;session-context nonce="n"&gt;secret rules&lt;/session-context nonce="n"&gt; <relay from="coordinator"> <cited id="c1" author="user" name="Yifu">我觉得UI整体来看都很糟糕。</cited> <note>fix the UI</note> </relay></coordinator-relay>`;
  assert.equal(promptText(relay), "我觉得UI整体来看都很糟糕。");
  assert.equal(promptText(`<coordinator-relay><relay><note>Add a close signal</note></relay></coordinator-relay>`), "Add a close signal");
  assert.equal(promptText("Fix the a < b comparison"), "Fix the a < b comparison");

  const s = new Store();
  feed(s, claudeCodeEvents, [{ session_id: "w1", hook_event_name: "UserPromptSubmit", prompt: wake }]);
  assert.equal(s.get("claude-code:w1").title, "关掉吧");
});

test("resolving a project thread closes the card and the following Stop keeps it closed", () => {
  const s = new Store();
  const base = { session_id: "w2" };
  const env = { CLAUDE_CODE_REMOTE_SESSION_ID: "cse_abc" };
  feed(s, claudeCodeEvents, [
    { ...base, hook_event_name: "UserPromptSubmit", prompt: "close it" },
    { ...base, hook_event_name: "PreToolUse", tool_name: "mcp__hearthbot__set_thread_resolved", tool_input: { resolved: true } },
  ], env);
  const key = "claude-code-web:session_abc";
  assert.equal(s.get(key).status, "done");
  feed(s, claudeCodeEvents, [{ ...base, hook_event_name: "Stop" }], env);
  assert.equal(s.get(key).status, "done");
  feed(s, claudeCodeEvents, [{ ...base, hook_event_name: "PreToolUse", tool_name: "mcp__hearthbot__set_thread_resolved", tool_input: { resolved: false } }], env);
  assert.equal(s.get(key).status, "running");
  feed(s, claudeCodeEvents, [{ ...base, hook_event_name: "Stop" }], env);
  assert.equal(s.get(key).status, "review");
});

test("a new Claude Code session starts in Queued, and a mid-task SessionStart does not move it", () => {
  const s = new Store();
  const base = { session_id: "q1", cwd: "/w" };
  feed(s, claudeCodeEvents, [{ ...base, hook_event_name: "SessionStart", source: "startup" }]);
  assert.equal(s.get("claude-code:q1").status, "queued");
  feed(s, claudeCodeEvents, [
    { ...base, hook_event_name: "UserPromptSubmit", prompt: "go" },
    { ...base, hook_event_name: "SessionStart", source: "compact" },
  ]);
  assert.equal(s.get("claude-code:q1").status, "running");
});
