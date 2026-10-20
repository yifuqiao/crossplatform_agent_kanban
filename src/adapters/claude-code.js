import { folder, oneLine, promptText } from "./common.js";

const SOURCE = "claude-code";
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

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
      const prompt = promptText(payload.prompt);
      events.push({ ...base, status: "running", title: oneLine(prompt, 100) || undefined, title_mode: "first", message: `Prompt: ${oneLine(prompt, 400)}`, type: "prompt" });
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
      } else if (/(^|__)set_thread_resolved$/.test(payload.tool_name || "") && typeof payload.tool_input?.resolved === "boolean") {
        // Resolving a Claude project thread is the only "I'm finished" signal a cloud session gives;
        // the session itself never ends, so without this the card sits in 审核中 forever.
        const resolved = payload.tool_input.resolved;
        events.push({ ...base, status: resolved ? "done" : "running", message: resolved ? "Thread resolved" : "Thread reopened", type: "resolve" });
      } else {
        events.push({ ...base, status: "running", message: `${payload.tool_name}${toolHint(payload.tool_input)}`, type: "tool" });
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
      }
      break;
    case "Notification":
      events.push({ ...base, status: "waiting", message: payload.message || "Claude Code needs your attention", type: "notification" });
      break;
    case "Stop":
      events.push({ ...base, status: "review", keep_terminal: true, message: "Turn finished, waiting for your next prompt", type: "stop" });
      break;
    case "SessionEnd":
      events.push({ ...base, status: "done", message: `Session ended${payload.reason ? ` (${payload.reason})` : ""}`, type: "session" });
      break;
    default:
      break;
  }
  return { rootKey, events };
}

function toolHint(input) {
  if (!input || typeof input !== "object") return "";
  const v = input.command || input.file_path || input.path || input.pattern || input.url || input.query;
  return v ? ` · ${oneLine(String(v), 140)}` : "";
}

function responseText(res) {
  if (typeof res === "string") return res;
  if (Array.isArray(res?.content)) return res.content.map((c) => c?.text || "").join(" ");
  if (typeof res?.result === "string") return res.result;
  return "";
}
