import { folder, oneLine, promptText } from "./common.js";

// Maps one Cursor hook payload (IDE agent and cursor-agent CLI share .cursor/hooks.json).
// Register with: akb hook cursor  (see examples/cursor-hooks.json)
export function cursorEvents(payload) {
  const conversationId = payload?.conversation_id;
  if (!conversationId) return { rootKey: null, events: [] };
  const source = process.env.AKB_CURSOR_SOURCE || "cursor";
  const rootKey = `${source}:${conversationId}`;
  const cwd = Array.isArray(payload.workspace_roots) ? payload.workspace_roots[0] : undefined;
  const base = { source, external_id: conversationId, cwd };
  const name = payload.hook_event_name;
  const events = [];

  switch (name) {
    case "beforeSubmitPrompt":
      events.push({ ...base, status: "running", title: oneLine(promptText(payload.prompt), 100) || `Cursor · ${folder(cwd)}`, title_mode: "first", message: `Prompt: ${oneLine(promptText(payload.prompt), 400)}`, type: "prompt" });
      break;
    case "afterShellExecution":
      events.push({ ...base, status: "running", message: `Shell · ${oneLine(payload.command, 160)}`, type: "tool" });
      break;
    case "afterMCPExecution":
      events.push({ ...base, status: "running", message: `MCP · ${payload.tool_name || "tool"}`, type: "tool" });
      break;
    case "afterFileEdit":
      events.push({ ...base, status: "running", message: `Edited ${payload.file_path || "a file"}`, type: "edit" });
      break;
    case "afterAgentResponse":
      events.push({ ...base, summary: oneLine(payload.text, 1000) || undefined, message: "Agent replied", type: "response" });
      break;
    case "stop": {
      const status = payload.status === "error" ? "failed" : payload.status === "aborted" ? "waiting" : "review";
      events.push({ ...base, status, message: `Agent stopped (${payload.status || "completed"})`, type: "stop" });
      break;
    }
    default:
      break;
  }
  return { rootKey, events };
}

// Cursor reads the hook's stdout. We only observe: beforeSubmitPrompt must say continue, and we
// deliberately never register permission hooks (beforeShellExecution etc.) so approvals stay Cursor's.
export function cursorHookResponse(payload) {
  return payload?.hook_event_name === "beforeSubmitPrompt" ? { continue: true } : {};
}
