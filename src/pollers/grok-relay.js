import { oneLine } from "../adapters/common.js";
import { normalizeStatus, TERMINAL } from "../status.js";

const SOURCE = "grok-bot";
const CURSOR_AGENT_ID = /\bbc-[A-Za-z0-9-]{8,}\b/g;
// A bot id as hand-off notes write it: a full UUID, or its first 8 characters in brackets ("大总管（1a698906）").
const BOT_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|(?<=[（(])[0-9a-f]{8}(?=[）)])/gi;
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
      legacyKey: `${chat}:${thread}`, label: "Claude Code",
    };
  }
  return { key: `${chat}:${thread}`, kind: "chat", title: `${chat} · ${oneLine(thread, 40)}`, url: /^https:\/\//.test(thread) ? thread : undefined, label: chat };
}

const SUPERSEDES = /(?:取代|替代|代替|替换|supersedes?|replaces?)\s*(?:relay\s*)?(?:任务|task)?\s*([0-9a-f]{8})/gi;
const PR_REF = /^(.*?)\bPR\s*#\s*(\d+)/i;

// "部署 X（取代 375b898b）": the newer task replaces an older one the relay still shows as open.
// A failed task followed by a newer one with the same "<words> PR #n" title is a retry of it.
export function supersededEvents(tasks) {
  const events = [];
  const supersede = (older, newer) => events.push({
    key: `${SOURCE}:${older.relayTaskId}`,
    meta: { superseded_by: `${SOURCE}:${newer.relayTaskId}` },
    message: `Superseded by「${oneLine(newer.title, 80)}」`,
    event_id: `superseded:${newer.relayTaskId}`,
    type: "superseded",
  });
  for (const newer of tasks) {
    for (const m of String(newer.title || "").matchAll(SUPERSEDES)) {
      const older = tasks.find((t) => t.relayTaskId !== newer.relayTaskId && t.relayTaskId.startsWith(m[1].toLowerCase()));
      if (older) supersede(older, newer);
    }
  }
  for (const older of tasks) {
    if (normalizeStatus(older.status) !== "failed") continue;
    const ref = prRef(older.title);
    if (!ref) continue;
    const newer = tasks
      .filter((t) => t.relayTaskId !== older.relayTaskId && String(t.createdAt) > String(older.createdAt) && prRef(t.title) === ref)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
    if (newer && !events.some((e) => e.key === `${SOURCE}:${older.relayTaskId}`)) supersede(older, newer);
  }
  return events;
}

// "二审并部署 Agent Kanban PR #6（91210d3）" -> "二审并部署 agent kanban #6"
function prRef(title) {
  const m = String(title || "").match(PR_REF);
  return m ? `${m[1].replace(/\s+/g, " ").trim().toLowerCase()} #${m[2]}` : null;
}

// Grok often reports a wait as "executing". Read who it is waiting on from its latest words.
// Waiting on the code-review bot keeps the card running with a note; waiting on the user means 等您.
const REVIEW_WAIT = /(?:待|等|送)\s*(?:代码)?二审|等[^，,。；;]{0,12}allow|二审[^，,。；;]{0,8}(?:allow|批准)/i;
const USER_WAIT = /(?:等|待)\s*(?:乔总|您|你|老板|用户|人工)|点头|待提供|需要?(?:您|你)|等[^，,。；;]{0,12}(?:授权|确认|凭据)/;
const APPROVAL_DONE = new Set(["approved", "rejected", "denied", "expired", "cancelled", "canceled"]);

export function inferWait(detail, updates) {
  const approval = detail.approval;
  if (approval && typeof approval === "object" && !APPROVAL_DONE.has(String(approval.status || "").toLowerCase())) {
    return { status: "waiting", waitingOn: "审批" };
  }
  const latest = updates.length ? updates[updates.length - 1].summary : detail.summary;
  const text = typeof latest === "string" ? latest : "";
  if (REVIEW_WAIT.test(text)) return { status: "running", waitingOn: "代码二审" };
  if (USER_WAIT.test(text)) return { status: "waiting", waitingOn: "您" };
  return null;
}

// A task the relay still calls open but that has said nothing for this long goes to 等您:
// the user decides whether it finished, was dropped, or is still going. Nothing is written to the relay.
export const QUIET_MS = 24 * 3600 * 1000;

export function quietEvent(listed, now = Date.now()) {
  const status = normalizeStatus(listed.status, "running");
  if (TERMINAL.has(status) || status === "waiting" || !listed.updatedAt) return null;
  const last = Date.parse(listed.updatedAt);
  if (Number.isNaN(last) || now - last < QUIET_MS) return null;
  return {
    key: `${SOURCE}:${listed.relayTaskId}`,
    status: "waiting",
    message: "24 小时没有新进展：请判断是做完了、放弃了，还是还在等",
    meta: { quiet_since: listed.updatedAt, waiting_on: "您" },
    event_id: `${listed.relayTaskId}:quiet:${listed.updatedAt}`,
    at: new Date(last + QUIET_MS).toISOString(),
    type: "quiet",
  };
}

// Turns one relay task snapshot (GET /tasks/<id>) into board events: the task itself, its
// progress timeline, and the activities Grok Bot wraps inside it (bot hand-offs, Cursor cloud agents).
// existing(key): the board's current card, if any. A task keeps the parent it already has, and a
// conversation that already has a card under its legacy key keeps that card.
export function grokTaskEvents(detail, { listed = {}, closeCursorChildren = true, existing = () => null } = {}) {
  const id = detail.relayTaskId || listed.relayTaskId;
  if (!id) return [];
  const rootKey = `${SOURCE}:${id}`;
  const updates = Array.isArray(detail.updates) ? detail.updates : [];
  let status = normalizeStatus(detail.status || listed.status, "running");
  const wait = status === "running" ? inferWait(detail, updates) : null;
  if (wait) status = wait.status;
  const events = [];

  const root = {
    source: SOURCE,
    external_id: id,
    kind: "bot",
    title: listed.title || detail.title || detail.task?.title || `Grok Bot task ${id.slice(0, 8)}`,
    summary: oneLine(detail.summary, 2000) || undefined,
    links: [],
    meta: {
      relay_status: detail.status || listed.status, relay_kind: detail.kind || listed.kind, submitted_from: detail.source || null,
      waiting_on: wait?.waitingOn || null,
    },
    at: detail.createdAt || listed.createdAt,
  };
  const origin = threadCard(detail.source, detail.sourceThread);
  const currentParent = existing(rootKey)?.parentKey;
  if (currentParent) {
    root.parent = currentParent;
  } else if (origin?.legacyKey && existing(origin.legacyKey)) {
    root.parent = origin.legacyKey;
  } else if (origin) {
    const { legacyKey, label, ...card } = origin;
    root.parent = card.key;
    // Label the conversation card; it stays a placeholder that shows its tasks' combined status.
    events.push({ ...card, title_mode: "default" });
  }
  // A conversation card has no title of its own: name it after its latest task, never a raw thread id.
  // "default" never overrides a real title (e.g. a Claude Code session card from hooks).
  if (root.parent) events.push({ key: root.parent, title: `${origin?.label || "对话"} · ${oneLine(root.title, 60)}`, title_mode: "default" });
  events.push({ ...root, status: "queued", message: `Submitted${detail.source ? ` from ${detail.source}` : ""}`, event_id: `${id}:submitted`, type: "submit" });

  const children = new Map();
  for (const u of updates) {
    const text = typeof u.summary === "string" ? u.summary : "";
    events.push({ key: rootKey, status: normalizeStatus(u.status, undefined), message: text || u.status, event_id: u.event_id, at: u.at, type: "progress", meta: { relay_status: u.status } });
    // Hand-offs say who does the work; they are a label on the card, not cards of their own.
    if (u.status === "forwarded") {
      const name = handoffBot(text);
      if (name) root.agent_name = name;
    }
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
    const closeWithParent = TERMINAL.has(status) && closeCursorChildren;
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
  return out;
}

// The bot a "forwarded" update names: its display name, or the first 8 characters of its id.
function handoffBot(text) {
  for (const botId of (text.match(BOT_ID) || []).map((s) => s.toLowerCase())) {
    return handoffName(text, botId) || `bot ${botId.slice(0, 8)}`;
  }
  return "";
}

// "已转交日川驾驶舱大总管（1a69…）" / "forwarded to Ops Bot (1a69…)" -> the bot's display name.
function handoffName(text, botId) {
  const before = text.slice(0, text.toLowerCase().indexOf(botId)).replace(/[（(\s]+$/, "");
  const m = before.match(/(?:转交(?:给)?|转|交给|forwarded to|handed (?:off )?to)\s*([^，,。;；]+)$/i);
  return m ? oneLine(m[1], 40) : "";
}

export function createGrokRelayPoller({ store, baseUrl, keys, limit = 50, closeCursorChildren = true, fetchImpl = fetch, log = console, now = Date.now }) {
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
      // Dry runs (e.g. relay-ping) never reach an executor; keep them off the board.
      const tasks = (list.tasks || []).filter((t) => t.status !== "dry_run");
      for (const listed of tasks) {
        const stamp = `${listed.status}|${listed.updatedAt}`;
        if (lastSeen.get(listed.relayTaskId) === stamp) continue;
        const detail = await getJson(`/tasks/${listed.relayTaskId}`, key);
        for (const ev of grokTaskEvents(detail, { listed, closeCursorChildren, existing: (k) => store.get(k) })) store.apply(ev);
        lastSeen.set(listed.relayTaskId, stamp);
      }
      for (const ev of supersededEvents(tasks)) if (store.get(ev.key)) store.apply(ev);
      for (const listed of tasks) {
        const ev = quietEvent(listed, now());
        if (ev && store.get(ev.key)) store.apply(ev);
      }
    }
  }

  return { name: "grok-relay", poll, log };
}
