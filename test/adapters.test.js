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
  // A finished turn is not finished work: back to 进行中, marked idle, not 审核中.
  feed(s, claudeCodeEvents, [{ ...base, hook_event_name: "Stop" }]);
  assert.equal(s.get("claude-code:s1").status, "running");
  assert.ok(s.get("claude-code:s1").idleSince);
  // Commands are not written on the card.
  assert.ok(!s.get("claude-code:s1").events.some((e) => /npm test/.test(e.message || "")));
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
  assert.equal(promptText('@"/tmp/image.png" Fix the board'), "Fix the board");
  assert.equal(promptText("@src/app.js fix the bug"), "@src/app.js fix the bug");
  assert.equal(promptText("Handle <message>hello</message> but keep Array<Foo>"), "Handle <message>hello</message> but keep Array<Foo>");

  const s = new Store();
  feed(s, claudeCodeEvents, [{ session_id: "w1", hook_event_name: "UserPromptSubmit", prompt: wake }]);
  assert.equal(s.get("claude-code:w1").title, "关掉吧");

  // A spawned thread: an attachment, then session-context, then the coordinator's note. The note names the
  // card only until the person's own message arrives.
  const spawn = `@"/root/.claude/uploads/x/image.png" <session-context nonce="n">rules</session-context nonce="n"> <wake reason="spawn"><thread><message trigger="true" from="system">You are a Thread Session</message></thread></wake> <relay from="coordinator"><note>Clean up the review lane</note></relay>`;
  assert.equal(promptText(spawn), "Clean up the review lane");
  feed(s, claudeCodeEvents, [
    { session_id: "w3", hook_event_name: "SessionStart", cwd: "/home/user/repo" },
    { session_id: "w3", hook_event_name: "UserPromptSubmit", prompt: spawn },
  ]);
  assert.equal(s.get("claude-code:w3").title, "Clean up the review lane");
  // The coordinator's note is relayed, not the person's prompt: the timeline tells them apart.
  assert.deepEqual(s.get("claude-code:w3").events.filter((e) => e.type === "relay" || e.type === "prompt").map((e) => [e.type, e.message]),
    [["relay", "转来: Clean up the review lane"]]);
  feed(s, claudeCodeEvents, [{ session_id: "w3", hook_event_name: "UserPromptSubmit", prompt: wake }]);
  assert.equal(s.get("claude-code:w3").events.at(-1).type, "prompt");
  assert.equal(s.get("claude-code:w3").title, "关掉吧");
  feed(s, claudeCodeEvents, [{ session_id: "w3", hook_event_name: "UserPromptSubmit", prompt: "later words" }]);
  assert.equal(s.get("claude-code:w3").title, "关掉吧");
});

test("resolving a project thread closes the card and the following Stop keeps it closed", () => {
  const s = new Store();
  const base = { session_id: "w2" };
  const env = { CLAUDE_CODE_REMOTE_SESSION_ID: "cse_abc" };
  feed(s, claudeCodeEvents, [
    { ...base, hook_event_name: "UserPromptSubmit", prompt: "close it" },
    { ...base, hook_event_name: "PreToolUse", tool_name: "mcp__hearthbot__set_thread_resolved", tool_input: { resolved: true } },
  ], env);
  // PreToolUse alone (the call might still be denied or fail) does not close the card.
  assert.equal(s.get("claude-code-web:session_abc").status, "running");
  feed(s, claudeCodeEvents, [
    { ...base, hook_event_name: "PostToolUse", tool_name: "mcp__hearthbot__set_thread_resolved", tool_input: { resolved: true } },
  ], env);
  const key = "claude-code-web:session_abc";
  assert.equal(s.get(key).status, "done");
  feed(s, claudeCodeEvents, [{ ...base, hook_event_name: "Stop" }], env);
  assert.equal(s.get(key).status, "done");
  feed(s, claudeCodeEvents, [{ ...base, hook_event_name: "PostToolUse", tool_name: "mcp__hearthbot__set_thread_resolved", tool_input: { resolved: false } }], env);
  assert.equal(s.get(key).status, "running");
  feed(s, claudeCodeEvents, [{ ...base, hook_event_name: "Stop" }], env);
  assert.equal(s.get(key).status, "running");
});

test("only an opened PR moves a session card to 审核中, and it returns there after each later turn", () => {
  const s = new Store();
  const base = { session_id: "p1" };
  const key = "claude-code:p1";
  feed(s, claudeCodeEvents, [
    { ...base, hook_event_name: "UserPromptSubmit", prompt: "fix the bug" },
    { ...base, hook_event_name: "Stop" },
  ]);
  assert.equal(s.get(key).status, "running");
  feed(s, claudeCodeEvents, [
    { ...base, hook_event_name: "PostToolUse", tool_name: "mcp__github__create_pull_request", tool_input: { title: "Fix" }, tool_response: { content: [{ type: "text", text: '{"url":"https://github.com/o/r/pull/14"}' }] } },
  ]);
  assert.equal(s.get(key).status, "review");
  assert.deepEqual(s.get(key).links, [{ url: "https://github.com/o/r/pull/14", label: "PR" }]);
  feed(s, claudeCodeEvents, [{ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } }]);
  assert.equal(s.get(key).status, "running");
  feed(s, claudeCodeEvents, [{ ...base, hook_event_name: "Stop" }]);
  assert.equal(s.get(key).status, "review");

  // gh pr create works too; other Bash calls do nothing.
  const t = new Store();
  feed(t, claudeCodeEvents, [
    { session_id: "p2", hook_event_name: "UserPromptSubmit", prompt: "go" },
    { session_id: "p2", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git push" }, tool_response: { stdout: "https://github.com/o/r/pull/1" } },
  ]);
  assert.equal(t.get("claude-code:p2").status, "running");
  feed(t, claudeCodeEvents, [{ session_id: "p2", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "gh pr create --fill" }, tool_response: { stdout: "https://github.com/o/r/pull/2\n" } }]);
  assert.equal(t.get("claude-code:p2").status, "review");
});

test("an idle-prompt notification is not 等您", () => {
  const s = new Store();
  feed(s, claudeCodeEvents, [
    { session_id: "n1", hook_event_name: "UserPromptSubmit", prompt: "go" },
    { session_id: "n1", hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" },
  ]);
  assert.equal(s.get("claude-code:n1").status, "running");
});

test("the agent's checklist becomes the card's subtasks", () => {
  const s = new Store();
  const key = "claude-code:c1";
  feed(s, claudeCodeEvents, [
    { session_id: "c1", hook_event_name: "UserPromptSubmit", prompt: "go" },
    { session_id: "c1", hook_event_name: "PostToolUse", tool_name: "mcp__hearthbot__update_progress_checklist", tool_input: { text: "审核中清理\n\n✓ 看代码\n✱ 改规则\n○ 开 PR" } },
  ]);
  assert.deepEqual(s.get(key).checklist, [{ text: "看代码", state: "done" }, { text: "改规则", state: "doing" }, { text: "开 PR", state: "todo" }]);
  assert.equal(s.get(key).status, "running");
  feed(s, claudeCodeEvents, [
    { session_id: "c1", hook_event_name: "PostToolUse", tool_name: "TodoWrite", tool_input: { todos: [{ content: "write tests", status: "completed" }, { content: "ship", status: "in_progress" }] } },
  ]);
  assert.deepEqual(s.get(key).checklist, [{ text: "write tests", state: "done" }, { text: "ship", state: "doing" }]);
  feed(s, claudeCodeEvents, [{ session_id: "c1", hook_event_name: "PostToolUse", tool_name: "TodoWrite", tool_input: { todos: [] } }]);
  assert.deepEqual(s.get(key).checklist, []);
});

test("renaming the thread retitles the card", () => {
  const s = new Store();
  feed(s, claudeCodeEvents, [
    { session_id: "r1", hook_event_name: "UserPromptSubmit", prompt: "怎么办？" },
    { session_id: "r1", hook_event_name: "PostToolUse", tool_name: "mcp__hearthbot__rename_thread", tool_input: { title: "清理审核中的旧卡" } },
  ]);
  assert.equal(s.get("claude-code:r1").title, "清理审核中的旧卡");
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

test("a turn that hands over a result or a decision ends in 等您 with the result linked on the card", () => {
  const s = new Store();
  const base = { session_id: "o1" };
  const key = "claude-code:o1";
  feed(s, claudeCodeEvents, [
    { ...base, hook_event_name: "UserPromptSubmit", prompt: "evaluate the plan" },
    { ...base, hook_event_name: "PostToolUse", tool_name: "mcp__hearthbot__post_message", tool_input: {
      text: "评估写好了：[可行性评估](https://claude.ai/code/artifact/abc)。PR 在 https://github.com/o/r/pull/3",
      attached_outputs: [{ kind: "frame", ref: "https://claude.ai/code/artifact/abc" }, { kind: "file", ref: "/mnt/project-files/x.md" }, { kind: "link", ref: "https://example.com/d", title: "Design" }],
    } },
    // Later tool calls in the same turn keep the card in 进行中 until the turn ends.
    { ...base, hook_event_name: "PreToolUse", tool_name: "mcp__hearthbot__update_progress_checklist", tool_input: {} },
  ]);
  assert.equal(s.get(key).status, "running");
  assert.deepEqual(s.get(key).links, [
    { url: "https://claude.ai/code/artifact/abc", label: "产出", output: true },
    { url: "https://example.com/d", label: "Design", output: true },
  ]);
  feed(s, claudeCodeEvents, [{ ...base, hook_event_name: "Stop" }]);
  assert.equal(s.get(key).status, "waiting");
  // The person answers: back to 进行中, and a plain turn end after that stays there.
  feed(s, claudeCodeEvents, [
    { ...base, hook_event_name: "UserPromptSubmit", prompt: "looks good, go" },
    { ...base, hook_event_name: "PostToolUse", tool_name: "mcp__hearthbot__post_message", tool_input: { text: "开工了" } },
  ]);
  assert.equal(s.get(key).status, "running");
  feed(s, claudeCodeEvents, [{ ...base, hook_event_name: "Stop" }]);
  assert.equal(s.get(key).status, "running");

  // A decision card waits on the person too.
  feed(s, claudeCodeEvents, [
    { ...base, hook_event_name: "UserPromptSubmit", prompt: "next" },
    { ...base, hook_event_name: "PostToolUse", tool_name: "mcp__hearthbot__request_decision", tool_input: { question: "先做哪一期？" } },
    { ...base, hook_event_name: "Stop" },
  ]);
  assert.equal(s.get(key).status, "waiting");
  assert.match(s.get(key).events.findLast((e) => e.type === "decision").message, /先做哪一期/);
});

test("a reply that only links a PR leaves the card to the PR rule", () => {
  const s = new Store();
  const base = { session_id: "o2" };
  feed(s, claudeCodeEvents, [
    { ...base, hook_event_name: "UserPromptSubmit", prompt: "fix" },
    { ...base, hook_event_name: "PostToolUse", tool_name: "mcp__github__create_pull_request", tool_input: {}, tool_response: "https://github.com/o/r/pull/9" },
    { ...base, hook_event_name: "PostToolUse", tool_name: "mcp__hearthbot__post_message", tool_input: { text: "PR 在 https://github.com/o/r/pull/9" } },
    { ...base, hook_event_name: "Stop" },
  ]);
  assert.equal(s.get("claude-code:o2").status, "review");
});

test("Codex lifecycle hooks: prompt, approval wait, subagent, PR, idle turn, session end", () => {
  const s = new Store();
  const base = { session_id: "th7", cwd: "/work/api", transcript_path: "/t.jsonl", model: "gpt-x" };
  feed(s, codexEvents, [
    { ...base, hook_event_name: "SessionStart", source: "startup" },
    { ...base, hook_event_name: "UserPromptSubmit", turn_id: "t1", prompt: "Fix the login bug" },
    { ...base, hook_event_name: "PreToolUse", turn_id: "t1", tool_name: "Bash", tool_input: { command: "npm test" } },
  ]);
  const card = () => s.get("codex:th7");
  assert.equal(card().title, "Fix the login bug");
  assert.equal(card().status, "running");
  assert.equal(card().kind, "cli");

  feed(s, codexEvents, [{ ...base, hook_event_name: "PermissionRequest", turn_id: "t1", tool_name: "Bash", tool_input: { command: "rm -rf build", description: "删除构建目录" } }]);
  assert.equal(card().status, "waiting");
  assert.ok(card().events.some((e) => /等你批准：删除构建目录/.test(e.message || "")));

  feed(s, codexEvents, [
    { ...base, hook_event_name: "PostToolUse", turn_id: "t1", tool_name: "Bash", tool_input: { command: "rm -rf build" }, tool_response: "" },
    { ...base, hook_event_name: "SubagentStart", turn_id: "t1", agent_id: "a1", agent_type: "explorer" },
  ]);
  assert.equal(card().status, "running");
  const [sub] = s.children("codex:th7");
  assert.equal(sub.title, "Subagent: explorer");
  assert.equal(sub.status, "running");
  feed(s, codexEvents, [{ ...base, hook_event_name: "SubagentStop", turn_id: "t1", agent_id: "a1", last_assistant_message: "found it" }]);
  assert.equal(s.get(sub.key).status, "done");
  assert.equal(s.get(sub.key).summary, "found it");

  feed(s, codexEvents, [{ ...base, hook_event_name: "PostToolUse", turn_id: "t1", tool_name: "Bash", tool_input: { command: ["bash", "-lc", "gh pr create --fill"] }, tool_response: "https://github.com/o/r/pull/12\n" }]);
  assert.equal(card().status, "review");
  assert.ok(card().links.some((l) => l.url === "https://github.com/o/r/pull/12"));

  feed(s, codexEvents, [{ ...base, hook_event_name: "Stop", turn_id: "t1", stop_hook_active: false, last_assistant_message: "Fixed and opened a PR" }]);
  assert.equal(card().summary, "Fixed and opened a PR");
  assert.ok(card().idleSince);

  feed(s, codexEvents, [{ ...base, hook_event_name: "SessionEnd", reason: "other" }]);
  assert.equal(card().status, "done");
});

test("AKB_CODEX_SOURCE puts Codex cloud sessions under their own source", () => {
  const s = new Store();
  feed(s, codexEvents, [{ session_id: "c1", cwd: "/workspace/repo", hook_event_name: "UserPromptSubmit", prompt: "Add tests" }], { AKB_CODEX_SOURCE: "codex-cloud" });
  assert.equal(s.get("codex:c1"), null);
  assert.equal(s.get("codex-cloud:c1").kind, "cloud");
  // A malformed override falls back to the default source.
  feed(s, codexEvents, [{ session_id: "c2", hook_event_name: "UserPromptSubmit", prompt: "x" }], { AKB_CODEX_SOURCE: "Bad Source!" });
  assert.ok(s.get("codex:c2"));
});

test("a background notification wakes a Claude card without a prompt line or answering 等您", () => {
  const s = new Store();
  const base = { session_id: "s5", cwd: "/w" };
  feed(s, claudeCodeEvents, [
    { ...base, hook_event_name: "UserPromptSubmit", prompt: "写个文档" },
    { ...base, hook_event_name: "PostToolUse", tool_name: "mcp__hearthbot__post_message", tool_input: { text: "好了", attached_outputs: [{ kind: "link", ref: "https://example.com/doc", title: "文档" }] } },
    { ...base, hook_event_name: "Stop" },
  ]);
  assert.equal(s.get("claude-code:s5").status, "waiting");
  feed(s, claudeCodeEvents, [{ ...base, hook_event_name: "UserPromptSubmit", prompt: "<task-notification>\n<task-type>queued-remote-notifications</task-type>\n</task-notification>" }]);
  const card = s.get("claude-code:s5");
  assert.equal(card.title, "写个文档");
  assert.ok(!card.events.some((e) => /task-notification/.test(e.message || "")));
  feed(s, claudeCodeEvents, [{ ...base, hook_event_name: "Stop" }]);
  assert.equal(s.get("claude-code:s5").status, "waiting");
});

test("Codex sessions with no prompt hang under one summary card until a prompt titles them", () => {
  const s = new Store();
  const base = { session_id: "idle1", cwd: "/w" };
  feed(s, codexEvents, [{ ...base, hook_event_name: "SessionEnd", reason: "other" }]);
  const card = s.get("codex:idle1");
  assert.equal(card.parentKey, "codex:_idle");
  assert.equal(s.get("codex:_idle").title, "Codex 无内容会话");
  assert.equal(s.list({ root: true }).length, 1);
  // the first real prompt (after the app's ambient block) gives it a title and takes it out of the group
  feed(s, codexEvents, [{ ...base, hook_event_name: "UserPromptSubmit", prompt: '<in-app-browser-context source="ambient-ui-state">\nnot the user\n</in-app-browser-context>\n修一下登录' }]);
  assert.equal(s.get("codex:idle1").title, "修一下登录");
  assert.equal(s.get("codex:idle1").parentKey, null);
  assert.equal(s.get("codex:_idle"), null);
});
