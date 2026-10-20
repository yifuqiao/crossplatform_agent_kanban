import { createHash } from "node:crypto";
import { oneLine } from "../adapters/common.js";
import { normalizeStatus, TERMINAL } from "../status.js";

const SOURCE = "grok-bot";
const CURSOR_AGENT_ID = /\bbc-[A-Za-z0-9-]{8,}\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const URLS = /https?:\/\/[^\s)（）"'<>，。]+/g;
const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

// Relay `source` names (the chat that submitted the task) -> board sources.
const CHAT_SOURCES = { claude: "claude-chat", chatgpt: "chatgpt", grok: "grok-chat", deepseek: "deepseek", wecom: "wecom" };

const CLAUDE_CODE_SESSION = /(?:^|claude\.ai\/code\/)(session_[A-Za-z0-9]+)/;

// The conversation a relay task was submitted from. Claude Code sessions report their session id
// (or its URL) as source_thread; anything else is a chat thread on that platform.
export function threadCard(source, thread) {
  if (!source || typeof thread !== "string" || !thread.trim()) return null;
  const session = thread.match(CLAUDE_CODE_SESSION);
  if (session) {
    return { key: `claude-code-web:${session[1]}`, kind: "cloud", title: `Claude Code · ${session[1]}`, url: `https://claude.ai/code/${session[1]}` };
  }
  const chat = CHAT_SOURCES[source] || source;
  return { key: `${chat}:${thread}`, kind: "chat", title: `${chat} · ${oneLine(thread, 40)}`, url: /^https:\/\//.test(thread) ? thread : undefined };
}

const SUPERSEDES = /(?:取代|替代|代替|替换|supersedes?|replaces?)\s*(?:relay\s*)?(?:任务|task)?\s*([0-9a-f]{8})/gi;

// "部署 X（取代 375b898b）": the newer task replaces an older one the relay still shows as open.
export function supersededEvents(tasks) {
  const events = [];
  for (const newer of tasks) {
    for (const m of String(newer.title || "").matchAll(SUPERSEDES)) {
      const older = tasks.find((t) => t.relayTaskId !== newer.relayTaskId && t.relayTaskId.startsWith(m[1].toLowerCase()));
      if (!older) continue;
      events.push({
        key: `${SOURCE}:${older.relayTaskId}`,
        meta: { superseded_by: `${SOURCE}:${newer.relayTaskId}` },
        message: `Superseded by「${oneLine(newer.title, 80)}」`,
        event_id: `superseded:${newer.relayTaskId}`,
        type: "superseded",
      });
    }
  }
  return events;
}

// Turns one relay task snapshot (GET /tasks/<id>) into board events: the task itself, its
// progress timeline, and the activities Grok Bot wraps inside it (bot hand-offs, Cursor cloud agents).
export function grokTaskEvents(detail, { listed = {}, closeCursorChildren = true } = {}) {
  const id = detail.relayTaskId || listed.relayTaskId;
  if (!id) return [];
  const rootKey = `${SOURCE}:${id}`;
  const status = normalizeStatus(detail.status || listed.status, "running");
  const updates = Array.isArray(detail.updates) ? detail.updates : [];
  const events = [];

  const root = {
    source: SOURCE,
    external_id: id,
    kind: "bot",
    title: listed.title || detail.title || detail.task?.title || `Grok Bot task ${id.slice(0, 8)}`,
    summary: oneLine(detail.summary, 2000) || undefined,
    links: [],
    meta: { relay_status: detail.status || listed.status, relay_kind: detail.kind || listed.kind, submitted_from: detail.source || null },
    at: detail.createdAt || listed.createdAt,
  };
  const origin = threadCard(detail.source, detail.sourceThread);
  if (origin) {
    root.parent = origin.key;
    // Label the conversation card; it stays a placeholder that shows its tasks' combined status.
    events.push({ ...origin, title_mode: "default" });
  }
  events.push({ ...root, status: "queued", message: `Submitted${detail.source ? ` from ${detail.source}` : ""}`, event_id: `${id}:submitted`, type: "submit" });

  const children = new Map();
  for (const u of updates) {
    const text = typeof u.summary === "string" ? u.summary : "";
    events.push({ key: rootKey, status: normalizeStatus(u.status, undefined), message: text || u.status, event_id: u.event_id, at: u.at, type: "progress", meta: { relay_status: u.status } });
    for (const child of wrappedActivities(rootKey, u, text)) {
      const prev = children.get(child.key);
      children.set(child.key, { ...prev, ...child, first: prev?.first || child.first });
    }
    for (const url of text.match(URLS) || []) root.links.push({ url, label: PR_URL.test(url) ? "PR" : undefined });
  }

  const completion = detail.completion;
  if (completion) {
    events.push({
      key: rootKey, status: normalizeStatus(completion.status, status), message: completion.summary, at: detail.updatedAt,
      event_id: completion.event_id ? `completion:${completion.event_id}` : `${id}:completion`, type: "completion",
      meta: completion.deployed_sha ? { deployed_sha: completion.deployed_sha } : undefined,
    });
    for (const a of completion.artifacts || []) if (a?.url) root.links.push({ url: a.url, label: a.name });
  }
  // Snapshot status last, so the card always matches the relay even if updates were truncated.
  events.push({ ...root, status, at: detail.updatedAt || listed.updatedAt });

  for (const child of children.values()) {
    const closeWithParent = TERMINAL.has(status) && (child.handoff || closeCursorChildren);
    events.push({
      source: child.source,
      external_id: child.externalId,
      parent: rootKey,
      kind: child.kind,
      title: child.title,
      title_mode: "default",
      agent_name: child.agentName,
      url: child.url,
      status: closeWithParent ? status : undefined,
      initial_status: "running",
      message: child.first,
      event_id: `${rootKey}:${child.key}:${closeWithParent ? status : "seen"}`,
      at: child.at,
      type: "wrapped",
    });
  }
  return events;
}

function wrappedActivities(rootKey, update, text) {
  const out = [];
  for (const agentId of new Set(text.match(CURSOR_AGENT_ID) || [])) {
    out.push({
      key: `cursor-cloud:${agentId}`, source: "cursor-cloud", externalId: agentId, kind: "cloud",
      title: `Cursor cloud agent ${agentId}`, url: `https://cursor.com/agents?id=${agentId}`,
      first: oneLine(text, 300), at: update.at,
    });
  }
  if (update.status === "forwarded") {
    for (const botId of new Set((text.match(UUID) || []).map((s) => s.toLowerCase()))) {
      const name = handoffName(text, botId);
      out.push({
        key: `handoff:${botId}`, source: SOURCE, externalId: `${rootKey.slice(SOURCE.length + 1)}/handoff/${botId}`, kind: "bot",
        title: name ? `Handed to ${name}` : `Handed to bot ${botId.slice(0, 8)}`, handoff: true, agentName: name || undefined,
        first: oneLine(text, 300), at: update.at,
      });
    }
  }
  return out;
}

// "已转交日川驾驶舱大总管（1a69…）" / "forwarded to Ops Bot (1a69…)" -> the bot's display name.
function handoffName(text, botId) {
  const before = text.slice(0, text.toLowerCase().indexOf(botId)).replace(/[（(\s]+$/, "");
  const m = before.match(/(?:转交(?:给)?|交给|forwarded to|handed (?:off )?to)\s*([^，,。;；]+)$/i);
  return m ? oneLine(m[1], 40) : "";
}

export const MAX_STATUS_CHECK = 10;

// A relay task asking Grok Bot to report the real state of tasks it went quiet on. Grok Bot answers
// on each original relay_task_id, so the relay record (not just the board) gets corrected.
// Same tasks on the same day -> same client_request_id, so the relay dedupes repeat clicks.
export function statusCheckRequest(tasks, now = new Date()) {
  const ids = tasks.map((t) => t.relayTaskId).sort();
  const digest = createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 12);
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const list = tasks.map((t) => `- ${t.relayTaskId} ${oneLine(t.title, 60)}`).join("\n");
  return {
    schema_version: "1",
    title: tasks.length === 1 ? `状态核对：${oneLine(tasks[0].title, 80)}` : `状态核对：${tasks.length} 个长时间无进展的任务`,
    objective:
      "以下 relay 任务在看板上长时间没有新进展。请逐个核对真实状态，并用执行端接口回报到各自原来的 relay_task_id：" +
      "已完成→finished；已放弃、失败或已被取代→failed（summary 写明原因）；仍在进行→progress（executing 或 waiting_approval，写明当前进度）。\n" + list,
    completion_criteria: ["每个列出的 relay_task_id 都有一条新的进度或终态报告", "没有重新执行任何原任务"],
    constraints: "只核对并回报状态；不要重新执行、部署、合并或修改任何服务。",
    source: "agent-kanban",
    client_request_id: `status-check-${day}-${digest}`,
    dry_run: false,
  };
}

export function createGrokRelayPoller({ store, baseUrl, keys, limit = 50, closeCursorChildren = true, fetchImpl = fetch, log = console }) {
  const origin = baseUrl.replace(/\/+$/, "");
  const lastSeen = new Map();
  const owners = new Map(); // relayTaskId -> caller key that can see it

  async function getJson(path, key) {
    const res = await fetchImpl(`${origin}${path}`, { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
    return res.json();
  }

  async function poll() {
    for (const key of keys) {
      const list = await getJson(`/tasks?limit=${limit}`, key);
      const tasks = list.tasks || [];
      for (const listed of tasks) {
        if (!owners.has(listed.relayTaskId)) owners.set(listed.relayTaskId, key);
        const stamp = `${listed.status}|${listed.updatedAt}`;
        if (lastSeen.get(listed.relayTaskId) === stamp) continue;
        const detail = await getJson(`/tasks/${listed.relayTaskId}`, key);
        for (const ev of grokTaskEvents(detail, { listed, closeCursorChildren })) store.apply(ev);
        lastSeen.set(listed.relayTaskId, stamp);
      }
      for (const ev of supersededEvents(tasks)) if (store.get(ev.key)) store.apply(ev);
    }
  }

  // keys: board keys "grok-bot:<relayTaskId>". Returns the new relay task id.
  async function askStatus(taskKeys) {
    const tasks = taskKeys.map((k) => ({ relayTaskId: k.slice(SOURCE.length + 1), title: store.get(k)?.title || k }));
    const key = owners.get(tasks[0].relayTaskId) || keys[0];
    const res = await fetchImpl(`${origin}/submit-task`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(statusCheckRequest(tasks)),
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({}));
    const relayTaskId = body.relayTaskId || body.receipt?.relayTaskId;
    if (!res.ok || !relayTaskId) throw new Error(`relay submit-task -> HTTP ${res.status}${body.error ? `: ${body.error}` : ""}`);
    owners.set(relayTaskId, key);
    const checkKey = `${SOURCE}:${relayTaskId}`;
    store.apply({
      key: checkKey, kind: "bot", title: statusCheckRequest(tasks).title, title_mode: "default",
      parent: taskKeys.length === 1 ? taskKeys[0] : undefined, initial_status: "queued",
      message: "Status check sent to Grok Bot", type: "status_check",
    });
    for (const k of taskKeys) {
      store.apply({ key: k, meta: { status_check: checkKey }, message: `Asked Grok Bot for the real status (${relayTaskId.slice(0, 8)})`, event_id: `status-check:${relayTaskId}`, type: "status_check" });
    }
    return { relayTaskId, key: checkKey, deduplicated: Boolean(body.deduplicated) };
  }

  return { name: "grok-relay", poll, askStatus, log };
}
