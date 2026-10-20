// Board columns, in display order. Every adapter maps its native states onto these.
export const COLUMNS = [
  { id: "queued", label: "Queued" },
  { id: "planning", label: "规划中" },
  { id: "running", label: "Running" },
  { id: "waiting", label: "Needs you" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
  { id: "failed", label: "Failed" },
];

export const STATUSES = COLUMNS.map((c) => c.id);
export const TERMINAL = new Set(["done", "failed"]);

// Native status words from the platforms we know about, lower-cased.
const ALIASES = {
  // generic
  todo: "queued", pending: "queued", new: "queued", created: "queued", backlog: "queued",
  plan: "planning", planning: "planning", designing: "planning", "规划中": "planning",
  in_progress: "running", working: "running", active: "running", started: "running", busy: "running",
  blocked: "waiting", needs_input: "waiting", input_required: "waiting", paused: "waiting", idle: "review",
  completed: "done", complete: "done", success: "done", succeeded: "done", merged: "done",
  error: "failed", errored: "failed", cancelled: "failed", canceled: "failed", aborted: "failed",
  // grok-bot-task-relay
  submitting: "queued", submitted: "queued", received: "queued", accepted: "queued", claimed: "running",
  forwarded: "running", executing: "running",
  waiting_approval: "waiting", awaiting_approval: "waiting", unknown: "waiting",
  finished: "done", dry_run: "done", rejected: "failed",
  // Cursor cloud agents
  creating: "queued", expired: "failed",
};

export function normalizeStatus(value, fallback = null) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (STATUSES.includes(key)) return key;
  return ALIASES[key] ?? fallback;
}
