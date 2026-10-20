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
// legacyKey: the key older versions gave a Claude Code session card ("claude-chat:<thread>").
export function threadCard(source, thread) {
  if (!source || typeof thread !== "string" || !thread.trim()) return null;
  const chat = CHAT_SOURCES[source] || source;
  const session = thread.match(CLAUDE_CODE_SESSION);
  if (session) {
    return {
      key: `claude-code-web:${session[1]}`, kind: "cloud", title: `Claude Code · ${session[1]}`, url: `https://claude.ai/code/${session[1]}`,
      legacyKey: `${chat}:${thread}`,
    };
  }
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
// existing(key): the board's current card, if any. A task keeps the parent it already has, and a
// conversation that already has a card under its legacy key keeps that card.
export function grokTaskEvents(detail, { listed = {}, closeCursorChildren = true, existing = () => null } = {}) {
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
  const currentParent = existing(rootKey)?.parentKey;
  if (currentParent) {
    root.parent = currentParent;
  } else if (origin?.legacyKey && existing(origin.legacyKey)) {
    root.parent = origin.legacyKey;
  } else if (origin) {
    const { legacyKey, ...card } = origin;
    root.parent = card.key;
    // Label the conversation card; it stays a placeholder that shows its tasks' combined status.
    events.push({ ...card, title_mode: "default" });
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

export function createGrokRelayPoller({ store, baseUrl, keys, limit = 50, closeCursorChildren = true, fetchImpl = fetch, log = console }) {
  const origin = baseUrl.replace(/\/+$/, "");
  const lastSeen = new Map();

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
        const stamp = `${listed.status}|${listed.updatedAt}`;
        if (lastSeen.get(listed.relayTaskId) === stamp) continue;
        const detail = await getJson(`/tasks/${listed.relayTaskId}`, key);
        for (const ev of grokTaskEvents(detail, { listed, closeCursorChildren, existing: (k) => store.get(k) })) store.apply(ev);
        lastSeen.set(listed.relayTaskId, stamp);
      }
      for (const ev of supersededEvents(tasks)) if (store.get(ev.key)) store.apply(ev);
    }
  }

  return { name: "grok-relay", poll, log };
}
