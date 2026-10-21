import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

// "请求更新" for Claude Code hook cards. The board's answer to each hook send lists the open requests
// on the cards it wrote; the background sender keeps them as files here, and the next hook (which must
// not wait on the network) reads the file and hands the ask to the session once.

export function asksDir(env = process.env) {
  return path.join(env.AKB_HOME || path.join(os.homedir(), ".agent-kanban"), "asks");
}

const file = (dir, key) => path.join(dir, `${createHash("sha1").update(key).digest("hex").slice(0, 20)}.json`);

// Called with the board's reply to POST /api/events. Senders run in parallel, so replies can arrive
// out of order: an answered ask stays as a tombstone (done), and a reply only closes an ask it was
// made after (its `at` is later than the request).
export function recordAsks(reply, dir = asksDir()) {
  if (!reply || typeof reply !== "object") return;
  const written = (reply.results || [reply]).filter((r) => r?.ok && r.key).map((r) => r.key);
  const open = new Map((reply.update_requests || []).map((u) => [u.task_key, u]));
  for (const key of new Set([...written, ...open.keys()])) {
    const ask = open.get(key);
    const prev = readAsk(dir, key);
    if (!ask) {
      if (prev && !prev.done && (!reply.at || reply.at > prev.requested_at)) writeAsk(dir, key, { ...prev, done: true });
      continue;
    }
    if (prev && prev.requested_at >= ask.requested_at) continue;
    writeAsk(dir, key, { task_key: key, requested_at: ask.requested_at, due_at: ask.due_at || null, notified_at: null, done: false });
  }
}

function writeAsk(dir, key, ask) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file(dir, key), JSON.stringify(ask));
}

export function readAsk(dir, key) {
  try {
    return JSON.parse(fs.readFileSync(file(dir, key), "utf8"));
  } catch {
    return null;
  }
}

// The session answered: keep the ask as done, so a late reply that still lists it cannot bring it back.
export function clearAsk(dir, key) {
  const ask = readAsk(dir, key);
  if (ask && !ask.done) writeAsk(dir, key, { ...ask, done: true });
}

// The hook's stdout for this Claude Code event when the card has an ask the session was not told
// about yet; null otherwise. UserPromptSubmit / PostToolUse add it to the context, Stop keeps the turn
// going (once) so the session answers before it goes idle.
export function askHookOutput(payload, key, { dir = asksDir(), cli } = {}) {
  const event = payload?.hook_event_name;
  if (!key || !["UserPromptSubmit", "PostToolUse", "Stop"].includes(event)) return null;
  if (event === "Stop" && payload.stop_hook_active) return null;
  const ask = readAsk(dir, key);
  if (!ask || ask.done || ask.notified_at) return null;
  writeAsk(dir, key, { ...ask, notified_at: new Date().toISOString() });
  const text = `看板上有人对这个会话的卡点了「请求更新」（${ask.requested_at}）。请用两三句话归纳现在的进展：做到哪、卡在哪、下一步。`
    + `需要用户做什么（批准、回答、提供东西）就用 --needs-you 写一句，没有就省掉。用下面的命令写回卡上，然后继续原来的工作：\n`
    + `NODE_USE_ENV_PROXY=1 node "${cli}" report --key "${key}" --brief --summary "<进展>" [--needs-you "<需要用户做的事>"]`;
  if (event === "Stop") return { decision: "block", reason: text };
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}
