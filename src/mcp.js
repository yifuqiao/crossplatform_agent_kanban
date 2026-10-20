import { randomUUID } from "node:crypto";
import { publicTask } from "./store.js";
import { STATUSES, normalizeStatus } from "./status.js";

// MCP tools so chat agents (claude.ai, ChatGPT, Grok, Claude Desktop, Cursor...) can put their
// own work on the board. Served at POST /mcp (Streamable HTTP, JSON responses) and via `akb mcp` (stdio).
const TOOLS = [
  {
    name: "kanban_report",
    title: "Report a task to the agent kanban",
    description:
      "Create or update a card on the user's cross-platform agent kanban. Call it when you start a task the user asked for (status running), when you are blocked on the user (waiting), when you hand back a result to check (review), and when it is done or failed. Omit task_key to create a new card; pass the returned task_key on later calls. Pass parent_key when this work was spun up by another task on the board.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {
        task_key: { type: "string", description: "Key returned by an earlier kanban_report call. Omit to create a card." },
        title: { type: "string", maxLength: 300 },
        status: { type: "string", enum: STATUSES },
        note: { type: "string", maxLength: 2000, description: "One timeline line describing what just happened." },
        summary: { type: "string", maxLength: 4000, description: "Current overall state or final result." },
        source: { type: "string", maxLength: 60, description: "Your platform, e.g. claude-code, claude-chat, chatgpt, grok-bot. Used when creating. A per-source key fixes this to its own source." },
        agent_name: { type: "string", maxLength: 60, description: "Which bot or agent on that platform is doing the work, e.g. ops-bot. Shown on the card next to the source." },
        parent_key: { type: "string", description: "task_key of the card that spun this work up." },
        links: { type: "array", maxItems: 20, items: { type: "object", required: ["url"], properties: { url: { type: "string" }, label: { type: "string" } } } },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "kanban_list",
    title: "List tasks on the agent kanban",
    description: "List recent cards on the board (top-level tasks with their nested children counted).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { status: { type: "string", enum: STATUSES }, limit: { type: "integer", minimum: 1, maximum: 100 } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "kanban_get",
    title: "Read one kanban task",
    description: "Read one card with its timeline and nested sub-tasks.",
    inputSchema: { type: "object", additionalProperties: false, required: ["task_key"], properties: { task_key: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
];

// Errors whose message is safe to show the caller; anything else is reported as an internal error.
class ToolError extends Error {}

const ADMIN = { admin: true };
const STRING_ARGS = ["task_key", "title", "status", "note", "summary", "source", "agent_name", "parent_key"];

// principal: ADMIN (AKB_TOKEN or a board login) or { source, agentName } from a per-source key.
// A per-source key only sees its own source's cards (and only its bot's, when bound).
function canSee(principal, t) {
  if (principal.admin) return true;
  return t.source === principal.source && (!principal.agentName || t.agentName === principal.agentName);
}

// Who created a card through MCP. Cards from pollers and hooks have no createdBy.
function ownerOf(principal) {
  if (principal.admin) return "mcp:admin";
  return principal.agentName ? `mcp:${principal.source}@${principal.agentName}` : `mcp:${principal.source}`;
}

function brief(t, store, principal) {
  const children = store.children(t.key).filter((c) => canSee(principal, c)).length;
  return { task_key: t.key, title: t.title, status: t.status, source: t.source, agent_name: t.agentName || null, summary: t.summary, updatedAt: t.updatedAt, children };
}

// A per-source key can only create and update cards as its own source (and bot, when bound),
// and only update cards it created through MCP: cards from pollers and hooks are admin-only.
function reportAs(store, principal, args, existing) {
  if (principal.admin) {
    return { source: (args.source || "chat").replace(/[^a-z0-9._-]/gi, "").toLowerCase() || "chat", agentName: args.agent_name };
  }
  if (args.source && args.source.toLowerCase() !== principal.source) {
    throw new ToolError(`This key reports as source "${principal.source}"; it cannot report as "${args.source}".`);
  }
  if (principal.agentName && args.agent_name && args.agent_name !== principal.agentName) {
    throw new ToolError(`This key reports as agent "${principal.agentName}"; it cannot report as "${args.agent_name}".`);
  }
  if (existing && existing.createdBy !== ownerOf(principal)) {
    throw new ToolError(`Card ${existing.key} was not created by this key; it can only update cards it created.`);
  }
  if (args.parent_key) {
    const parent = store.get(args.parent_key);
    if (!parent || !canSee(principal, parent)) {
      throw new ToolError(`No task ${args.parent_key} to nest under; parent_key must be an existing "${principal.source}" card.`);
    }
  }
  return { source: principal.source, agentName: principal.agentName || args.agent_name };
}

function callTool(store, name, args = {}, principal = ADMIN) {
  for (const k of STRING_ARGS) {
    if (args[k] != null && typeof args[k] !== "string") throw new ToolError(`${k} must be a string.`);
  }
  if (name === "kanban_report") {
    // Check status before anything touches the store, so a bad call leaves no placeholder card behind.
    if (!normalizeStatus(args.status)) throw new ToolError(`status must be one of ${STATUSES.join(", ")}.`);
    let key = args.task_key;
    const existing = key ? store.get(key) : null;
    if (key && (!existing || !canSee(principal, existing))) throw new ToolError(`No task ${key}. Omit task_key to create one.`);
    const as = reportAs(store, principal, args, existing);
    if (!key) {
      if (!args.title) throw new ToolError("title is required when creating a card.");
      key = `${as.source}:${randomUUID()}`;
    }
    const { task } = store.apply({
      key, title: args.title, status: args.status, message: args.note, summary: args.summary,
      parent: args.parent_key, links: args.links, kind: existing || !principal.admin ? undefined : "chat", agent_name: as.agentName,
      created_by: existing ? undefined : ownerOf(principal),
    });
    return { task_key: task.key, status: task.status, title: task.title, source: task.source, agent_name: task.agentName || null };
  }
  if (name === "kanban_list") {
    const tasks = store.list({ status: args.status, root: true }).filter((t) => canSee(principal, t)).slice(0, args.limit || 25);
    return { tasks: tasks.map((t) => brief(t, store, principal)) };
  }
  if (name === "kanban_get") {
    const task = store.get(args.task_key);
    if (!task || !canSee(principal, task)) throw new ToolError(`No task ${args.task_key}.`);
    const children = store.children(task.key).filter((t) => canSee(principal, t));
    return { task: { ...publicTask(task), events: task.events.slice(-30) }, children: children.map((t) => brief(t, store, principal)) };
  }
  throw new ToolError(`Unknown tool ${name}`);
}

// Returns the JSON-RPC response object, or null for notifications.
export function handleMcp(store, msg, principal = ADMIN) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid request" } };
  }
  if (msg.id === undefined) return null;
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: msg.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agent-kanban", version: "0.1.0" },
        instructions: "Report every task you start for the user with kanban_report, and update it when its status changes, so the user can follow all agent work on one board.",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call":
      try {
        const result = callTool(store, msg.params?.name, msg.params?.arguments || {}, principal);
        return reply({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false });
      } catch (err) {
        if (!(err instanceof ToolError)) console.error(`[akb] mcp ${msg.params?.name}: ${err.stack || err}`);
        return reply({ content: [{ type: "text", text: err instanceof ToolError ? err.message : "Internal error" }], isError: true });
      }
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}
