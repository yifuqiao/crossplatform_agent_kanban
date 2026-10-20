import { oneLine } from "../adapters/common.js";
import { normalizeStatus, TERMINAL } from "../status.js";

const SOURCE = "grok-bot";
const CURSOR_AGENT_ID = /\bbc-[A-Za-z0-9-]{8,}\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const URLS = /https?:\/\/[^\s)（）"'<>，。]+/g;
const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

// Relay `source` names (the chat that submitted the task) -> board sources.
const CHAT_SOURCES = { claude: "claude-chat", chatgpt: "chatgpt", grok: "grok-chat", deepseek: "deepseek", wecom: "wecom" };

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
  if (detail.source && detail.sourceThread) {
    root.parent = `${CHAT_SOURCES[detail.source] || detail.source}:${detail.sourceThread}`;
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
        title: name ? `Handed to ${name}` : `Handed to bot ${botId.slice(0, 8)}`, handoff: true,
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
      for (const listed of list.tasks || []) {
        const stamp = `${listed.status}|${listed.updatedAt}`;
        if (lastSeen.get(listed.relayTaskId) === stamp) continue;
        const detail = await getJson(`/tasks/${listed.relayTaskId}`, key);
        for (const ev of grokTaskEvents(detail, { listed, closeCursorChildren })) store.apply(ev);
        lastSeen.set(listed.relayTaskId, stamp);
      }
    }
  }

  return { name: "grok-relay", poll, log };
}
