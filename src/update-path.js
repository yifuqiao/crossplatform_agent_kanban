import { TERMINAL } from "./status.js";

// Who can answer "请求更新" on a card, and how soon. The board never contacts an agent or the relay,
// so a request is only as good as the path that brings it to someone:
//   mcp    the card was made through the board's MCP; its agent sees the ask the next time it calls
//          kanban_report / kanban_update_requests, which only happens while that chat is in use.
//   hook   a Claude Code session reporting through hooks; the hook hands the ask to the session on its
//          next tool call or at the end of its turn, and the session writes a brief with `akb report --brief`.
//   board  a card the board pulls from the Grok relay or Cursor; those bots cannot be asked anything,
//          so the board answers at once with the latest state it pulled.
//   none   nothing can carry the ask (other hooks, `akb run`, manual reports): no button.
export const SLA_MINUTES = { mcp: 30, hook: 10 };
const HOOK_SOURCES = new Set(["claude-code", "claude-code-web"]);
const POLLED_SOURCES = new Set(["grok-bot", "cursor-cloud"]);

export function updatePath(task) {
  if (!task || task.placeholder || TERMINAL.has(task.status)) return null;
  if (task.createdBy?.startsWith("mcp:")) return "mcp";
  if (HOOK_SOURCES.has(task.source)) return "hook";
  if (POLLED_SOURCES.has(task.source)) return "board";
  return "none";
}

export function dueAt(at, path) {
  const min = SLA_MINUTES[path];
  return min ? new Date(Date.parse(at) + min * 60_000).toISOString() : null;
}
