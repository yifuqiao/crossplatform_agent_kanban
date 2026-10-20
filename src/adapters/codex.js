import { folder, oneLine } from "./common.js";

const SOURCE = "codex";

// Maps the JSON Codex CLI passes to its `notify` program (last argv item).
// Register with: notify = ["akb", "hook", "codex"] in ~/.codex/config.toml
export function codexEvents(payload) {
  const threadId = payload?.["thread-id"] || payload?.thread_id;
  if (!threadId) return { rootKey: null, events: [] };
  const rootKey = `${SOURCE}:${threadId}`;
  const inputs = payload["input-messages"] || payload.input_messages || [];
  const firstPrompt = Array.isArray(inputs) ? inputs.find((m) => typeof m === "string" && m.trim()) : undefined;
  const events = [];

  if (payload.type === "agent-turn-complete") {
    events.push({
      source: SOURCE,
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
