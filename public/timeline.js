// Condenses a card's timeline: the person's prompts stand out, and everything the agent did
// between two prompts folds into one short summary line ("跑命令 3 · 改文件 2 · 回复 1").
// Shared by the board (public/app.js) and the tests.

// Routine hook lines: folded into the summary, never shown on their own.
const ROUTINE = new Set(["tool", "edit", "stop", "checklist", "response", "session", "notification"]);
// Tool calls that are bookkeeping, not work: not counted at all.
const SILENT_TOOLS = /(^|__)(no_reply_needed|react|unreact|ScheduleWakeup|ToolSearch|TodoWrite)$/;

// Tool name (or an older hook's "Tool · hint" line) → what the person would call it.
const KINDS = [
  [/(^|__)(post_message|edit_message|send_message|reply|message_coordinator|message_thread|post_widget|request_decision)\b/i, "回复"],
  [/(^|__)update_progress_checklist\b/, "更新进度"],
  [/(^|__)(read|update|write|search)_memory\b|memory/i, "记忆"],
  [/^(Read|Grep|Glob|LS|NotebookRead)\b|(^|__)(read_file|list_dir|get_file_contents|search_code)/, "看代码"],
  [/^(Edit|Write|MultiEdit|NotebookEdit)\b|^Edited\b|(^|__)(write_file|edit_file|edit_block)/, "改文件"],
  [/^(Bash|Shell|PowerShell)\b|(^|__)(device_bash|start_process)/, "跑命令"],
  [/^(WebFetch|WebSearch)\b/, "查资料"],
  [/^mcp__github__|(^|__)(pull_request|issue_|create_branch|push_files)/, "GitHub"],
  [/(^|__)(kanban_|Grok_Bot)/i, "看板/Grok"],
];

function toolName(message) {
  return String(message || "").split(/\s*[·(:]/, 1)[0].trim();
}

// The kind label of a routine event, or null when it does not count as a step.
export function actionKind(e) {
  if (e.type === "checklist" || e.type === "stop" || e.type === "session" || e.type === "notification") return null;
  if (e.type === "response") return "回复";
  if (e.type === "edit") return "改文件";
  if (e.type !== "tool") return null;
  const name = toolName(e.message);
  if (!name || SILENT_TOOLS.test(name)) return null;
  for (const [re, label] of KINDS) if (re.test(name) || re.test(e.message)) return label;
  return "其他";
}

// Lines that keep a row of their own even between prompts: a PR, a resolved thread, a choice, a
// question for the person, a bot's progress report, a card's end.
function isRoutine(e) {
  if (e.type === "notification" && e.status === "waiting") return false;
  if (e.type === "session" && (e.status === "done" || e.status === "failed")) return false;
  if (ROUTINE.has(e.type)) return true;
  // A bare status flip with no words (e.g. "running" from a tool call) says nothing new.
  return !e.message && e.status === "running";
}

// events (oldest first) → rows (oldest first):
//   { kind: "prompt", event }               the person's own words
//   { kind: "relay", event }                a coordinator's / another thread's note
//   { kind: "event", event }                a line worth its own row
//   { kind: "summary", events, text, at, until, status }   folded agent actions
export function condenseTimeline(events) {
  const rows = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const counts = new Map();
    let progress = null;
    for (const e of run) {
      const k = actionKind(e);
      if (k) counts.set(k, (counts.get(k) || 0) + 1);
      if (e.type === "checklist" && e.message) progress = e.message;
    }
    const parts = [...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => (n > 1 ? `${k} ${n}` : k));
    if (progress) parts.push(progress);
    const last = run[run.length - 1];
    if (parts.length) {
      rows.push({ kind: "summary", events: run, text: parts.join(" · "), at: run[0].at, until: last.at, status: run.findLast((e) => e.status)?.status || null });
    }
    run = [];
  };
  for (const e of events || []) {
    if (isRoutine(e)) {
      run.push(e);
      continue;
    }
    flush();
    rows.push({ kind: e.type === "prompt" ? "prompt" : e.type === "relay" ? "relay" : "event", event: e });
  }
  flush();
  return rows;
}
