import { folder, oneLine, promptParts } from "./common.js";

const SOURCE = "claude-code";
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);
// Tools whose result moves the card: PostToolUse only fires for these (see the hook matcher).
const RESOLVE_TOOL = /(^|__)set_thread_resolved$/;
const RENAME_TOOL = /(^|__)(rename_thread|set_session_title)$/;
const PR_TOOL = /(^|__)create_pull_request$/;
const CHECKLIST_TOOL = /(^|__)update_progress_checklist$/;
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

// Maps one Claude Code hook payload (stdin JSON) to board events.
// Register with: akb hook claude-code  (see examples/claude-code-settings.json)
export function claudeCodeEvents(payload, env = process.env) {
  if (!payload?.session_id) return { rootKey: null, events: [] };
  // Claude Code on the web runs with CLAUDE_CODE_REMOTE_SESSION_ID=cse_X; its page is
  // claude.ai/code/session_X. Keying the card by that id also merges it with relay tasks
  // submitted from the same session (their source_thread is the session id or URL).
  const remote = /^cse_([A-Za-z0-9]+)$/.exec(env.CLAUDE_CODE_REMOTE_SESSION_ID || "");
  const sessionId = remote ? `session_${remote[1]}` : payload.session_id;
  const source = remote ? "claude-code-web" : SOURCE;
  const rootKey = `${source}:${sessionId}`;
  const base = {
    source,
    external_id: sessionId,
    cwd: payload.cwd,
    kind: remote ? "cloud" : undefined,
    url: remote ? `https://claude.ai/code/${sessionId}` : undefined,
    meta: { transcript_path: payload.transcript_path, permission_mode: payload.permission_mode },
  };
  const name = payload.hook_event_name;
  const events = [];

  switch (name) {
    case "SessionStart":
      // A fresh session has no work yet: it starts in Queued. initial_status leaves an existing card
      // alone (resume / compact / clear fire SessionStart mid-task too).
      events.push({ ...base, initial_status: "queued", title: `Claude Code${remote ? " (web)" : ""} · ${folder(payload.cwd)}`, title_mode: "default", message: `Session ${payload.source || "started"}`, type: "session" });
      break;
    case "UserPromptSubmit": {
      // The person's own words name the card; a coordinator's note only until those arrive.
      const { text, human } = promptParts(payload.prompt);
      events.push({ ...base, status: "running", title: oneLine(text, 100) || undefined, title_mode: human ? "first" : "default", message: `Prompt: ${oneLine(text || payload.prompt, 400)}`, type: "prompt" });
      break;
    }
    case "PreToolUse":
      if (SUBAGENT_TOOLS.has(payload.tool_name)) {
        const input = payload.tool_input || {};
        events.push({ ...base, status: "running" });
        events.push({
          source,
          external_id: `${sessionId}/${payload.tool_use_id || oneLine(input.description, 60)}`,
          parent: rootKey,
          kind: "cli",
          status: "running",
          title: oneLine(input.description || input.prompt, 100) || "Subagent",
          summary: input.subagent_type ? `Subagent: ${input.subagent_type}` : undefined,
          message: oneLine(input.prompt, 600),
          type: "subagent",
        });
      } else {
        // Only the status: individual commands are noise on a card. Progress shows as the checklist.
        events.push({ ...base, status: "running" });
      }
      break;
    case "PostToolUse":
      if (SUBAGENT_TOOLS.has(payload.tool_name) && payload.tool_use_id) {
        events.push({
          source,
          external_id: `${sessionId}/${payload.tool_use_id}`,
          parent: rootKey,
          status: "done",
          summary: oneLine(responseText(payload.tool_response), 1000) || undefined,
          message: "Subagent finished",
          type: "subagent",
        });
      } else if (RESOLVE_TOOL.test(payload.tool_name || "") && typeof payload.tool_input?.resolved === "boolean") {
        // Resolving a Claude project thread is the only "I'm finished" signal a cloud session gives;
        // the session itself never ends, so without this the card would never close.
        // PostToolUse, not PreToolUse: it only fires once the call succeeded.
        const resolved = payload.tool_input.resolved;
        events.push({ ...base, status: resolved ? "done" : "running", message: resolved ? "Thread resolved" : "Thread reopened", type: "resolve" });
      } else if (CHECKLIST_TOOL.test(payload.tool_name || "") || payload.tool_name === "TodoWrite") {
        // The agent's own step list (project-thread checklist or Claude Code's todo list) is the card's subtasks.
        const checklist = checklistItems(payload.tool_input);
        // An empty list is an update too: it clears the card's list.
        if (checklist) {
          const done = checklist.filter((c) => c.state === "done").length;
          events.push({ ...base, checklist, message: `进度 ${done}/${checklist.length}`, type: "checklist" });
        }
      } else if (RENAME_TOOL.test(payload.tool_name || "") && payload.tool_input?.title) {
        // The thread's own title says what the work is better than any prompt.
        events.push({ ...base, title: oneLine(payload.tool_input.title, 100), title_mode: "replace" });
      } else {
        // An opened pull request is what 审核中 means: work waiting on the person's review.
        const url = openedPr(payload);
        if (url) events.push({ ...base, status: "review", awaiting_review: true, links: [{ url, label: "PR" }], message: `Opened ${url}`, type: "pr" });
      }
      break;
    case "Notification":
      // "Claude is waiting for your input" only means the turn is over, not that it needs the person.
      if (payload.notification_type === "idle_prompt" || /waiting for your input/i.test(payload.message || "")) {
        events.push({ ...base, idle: true, message: payload.message || "Waiting for your next prompt", type: "notification" });
      } else {
        events.push({ ...base, status: "waiting", message: payload.message || "Claude Code needs your attention", type: "notification" });
      }
      break;
    case "Stop":
      // A finished turn is not finished work: the card stays where it is (进行中, marked idle).
      // Only an opened PR, a resolved thread or the end of the session moves it on.
      events.push({ ...base, idle: true, message: "这一轮做完了，等你下一句", type: "stop" });
      break;
    case "SessionEnd":
      events.push({ ...base, status: "done", message: `Session ended${payload.reason ? ` (${payload.reason})` : ""}`, type: "session" });
      break;
    default:
      break;
  }
  return { rootKey, events };
}

// The PR url when this tool call opened one: the GitHub MCP create_pull_request tool or `gh pr create`.
function openedPr(payload) {
  const name = payload.tool_name || "";
  const isGh = name === "Bash" && /\bgh\s+pr\s+create\b/.test(payload.tool_input?.command || "");
  if (!isGh && !PR_TOOL.test(name)) return null;
  const res = payload.tool_response;
  const text = typeof res === "string" ? res : responseText(res) || (res && typeof res === "object" ? JSON.stringify(res) : "");
  return PR_URL.exec(text)?.[0] || null;
}

// update_progress_checklist text ("header\n\n✓ step\n✱ step\n○ step") or TodoWrite todos → [{ text, state }].
const MARKS = { "✓": "done", "✔": "done", "✱": "doing", "○": "todo" };
const TODO_STATES = { completed: "done", in_progress: "doing", pending: "todo" };
export function checklistItems(input) {
  let items = [];
  if (Array.isArray(input?.todos)) {
    items = input.todos.map((t) => ({ text: oneLine(t?.content, 200), state: TODO_STATES[t?.status] || "todo" }));
  } else if (typeof input?.text === "string") {
    for (const line of input.text.split("\n")) {
      const m = /^\s*([✓✔✱○])\s*(.+)$/.exec(line);
      if (m) items.push({ text: oneLine(m[2], 200), state: MARKS[m[1]] });
    }
  } else {
    return null;
  }
  return items.filter((i) => i.text);
}

function responseText(res) {
  if (typeof res === "string") return res;
  if (Array.isArray(res?.content)) return res.content.map((c) => c?.text || "").join(" ");
  if (typeof res?.result === "string") return res.result;
  return "";
}
