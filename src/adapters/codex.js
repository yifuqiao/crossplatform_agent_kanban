import { folder, oneLine, promptParts, stripAmbient } from "./common.js";

const SOURCE = "codex";
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

// Maps what Codex hands the board to board events. Two ways in, both via `akb hook codex`:
//   - lifecycle hooks (stdin JSON with hook_event_name), see examples/codex-hooks.toml: the card follows
//     the session (运行中 / 等您批准 / 一轮结束 / subagents), like Claude Code.
//   - the older `notify` program (JSON as the last argv item): only "a turn finished".
// AKB_CODEX_SOURCE renames the source, e.g. codex-cloud for Codex cloud tasks, so their cards (and the
// per-source key that may write them) stay apart from the CLI's.
export function codexEvents(payload, env = process.env) {
  if (payload?.hook_event_name) return codexHookEvents(payload, env);
  const source = sourceName(env);
  const threadId = payload?.["thread-id"] || payload?.thread_id;
  if (!threadId) return { rootKey: null, events: [] };
  const rootKey = `${source}:${threadId}`;
  const inputs = payload["input-messages"] || payload.input_messages || [];
  const firstPrompt = Array.isArray(inputs) ? inputs.find((m) => typeof m === "string" && m.trim()) : undefined;
  const events = [];

  if (payload.type === "agent-turn-complete") {
    events.push({
      source,
      external_id: threadId,
      cwd: payload.cwd,
      title: oneLine(firstPrompt, 100) || `Codex · ${folder(payload.cwd)}`,
      title_mode: "first",
      status: "review",
      summary: oneLine(payload["last-assistant-message"] || payload.last_assistant_message, 1000) || undefined,
      message: "Turn complete",
      type: "turn",
      event_id: payload["turn-id"] ? `turn:${payload["turn-id"]}` : undefined,
    });
  }
  return { rootKey, events };
}

function sourceName(env) {
  const s = String(env.AKB_CODEX_SOURCE || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,59}$/.test(s) ? s : SOURCE;
}

// only_if_exists: Codex Desktop opens empty threads ahead of time and closes them unused. Their start/end
// events must not create a card; the first real prompt does.
function codexHookEvents(payload, env) {
  // session_id is the Codex thread id, the same one notify sends, so both land on one card.
  const sessionId = payload.session_id;
  if (!sessionId) return { rootKey: null, events: [] };
  const source = sourceName(env);
  const rootKey = `${source}:${sessionId}`;
  const base = {
    source,
    external_id: sessionId,
    cwd: payload.cwd,
    kind: source === SOURCE ? "cli" : "cloud",
    meta: { transcript_path: payload.transcript_path, permission_mode: payload.permission_mode, model: payload.model },
  };
  const events = [];

  switch (payload.hook_event_name) {
    case "SessionStart":
      // resume / compact / fork fire SessionStart mid-task too: initial_status leaves an existing card alone.
      events.push({ ...base, only_if_exists: true, initial_status: "queued", title: `Codex · ${folder(payload.cwd)}`, title_mode: "default", message: `Session ${payload.source || "started"}`, type: "session" });
      break;
    case "UserPromptSubmit": {
      const { text } = promptParts(stripAmbient(payload.prompt));
      events.push({ ...base, status: "running", new_turn: true, title: oneLine(text, 100) || undefined, title_mode: "first", message: `Prompt: ${oneLine(text || payload.prompt, 400)}`, type: "prompt" });
      break;
    }
    case "PreToolUse":
      // Only the status: individual commands are noise on a card.
      events.push({ ...base, status: "running" });
      break;
    case "PermissionRequest": {
      const what = oneLine(payload.tool_input?.description || commandText(payload.tool_input) || payload.tool_name, 200);
      events.push({ ...base, status: "waiting", message: what ? `等你批准：${what}` : "Codex 等你批准", type: "notification" });
      break;
    }
    case "PostToolUse": {
      // An approved request runs the tool: the card is no longer waiting on the person.
      const url = openedPr(payload);
      if (url) events.push({ ...base, status: "review", awaiting_review: true, links: [{ url, label: "PR" }], message: `Opened ${url}`, type: "pr" });
      else events.push({ ...base, status: "running" });
      break;
    }
    case "SubagentStart":
      if (payload.agent_id) {
        events.push({
          source,
          external_id: `${sessionId}/${payload.agent_id}`,
          parent: rootKey,
          kind: base.kind,
          status: "running",
          title: payload.agent_type ? `Subagent: ${oneLine(payload.agent_type, 80)}` : "Subagent",
          type: "subagent",
        });
      }
      break;
    case "SubagentStop":
      if (payload.agent_id) {
        events.push({
          source,
          external_id: `${sessionId}/${payload.agent_id}`,
          parent: rootKey,
          status: "done",
          summary: oneLine(payload.last_assistant_message, 1000) || undefined,
          message: "Subagent finished",
          type: "subagent",
        });
      }
      break;
    case "Stop":
      // A finished turn is not finished work: the card stays in its column, marked idle, with the reply as summary.
      events.push({ ...base, only_if_exists: true, idle: true, summary: oneLine(payload.last_assistant_message, 1000) || undefined, message: "这一轮做完了，等你下一句", type: "stop", event_id: payload.turn_id ? `stop:${payload.turn_id}` : undefined });
      break;
    case "Interrupt":
      events.push({ ...base, only_if_exists: true, idle: true, message: "这一轮被打断了", type: "stop" });
      break;
    case "SessionEnd":
      events.push({ ...base, only_if_exists: true, status: "done", message: `Session ended${payload.reason && payload.reason !== "other" ? ` (${payload.reason})` : ""}`, type: "session" });
      break;
    default:
      break;
  }
  return { rootKey, events };
}

function commandText(input) {
  const c = input?.command ?? input?.cmd;
  return Array.isArray(c) ? c.join(" ") : typeof c === "string" ? c : "";
}

// The PR url when this tool call ran `gh pr create`.
function openedPr(payload) {
  if (!/\bgh\s+pr\s+create\b/.test(commandText(payload.tool_input))) return null;
  const res = payload.tool_response;
  const text = typeof res === "string" ? res : res && typeof res === "object" ? JSON.stringify(res) : "";
  return PR_URL.exec(text)?.[0] || null;
}
