import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { normalizeStatus, TERMINAL } from "./status.js";

const MAX_EVENTS = 200;
const MAX_SEEN_IDS = 500;
// A placeholder parent takes the most urgent status among its children.
const ROLLUP_ORDER = ["waiting", "running", "queued", "review", "failed", "done"];
const KNOWN_KINDS = new Set(["cli", "ide", "cloud", "chat", "bot", "other"]);

// Default kind per source, so senders can omit it.
const SOURCE_KINDS = {
  "claude-code": "cli", codex: "cli", "cursor-cli": "cli", "gemini-cli": "cli", aider: "cli",
  cursor: "ide", "cursor-ide": "ide",
  "cursor-cloud": "cloud", "claude-code-web": "cloud", "codex-cloud": "cloud",
  "claude-chat": "chat", chatgpt: "chat", "grok-chat": "chat", deepseek: "chat",
  "grok-bot": "bot",
};

export function taskKey(source, externalId) {
  return `${source}:${externalId}`;
}

// Accepts "source:id", {source, external_id} or {key}.
export function parseRef(ref) {
  if (!ref) return null;
  if (typeof ref === "string") {
    const i = ref.indexOf(":");
    if (i <= 0 || i === ref.length - 1) return null;
    return { source: ref.slice(0, i), externalId: ref.slice(i + 1) };
  }
  if (typeof ref === "object") {
    if (typeof ref.key === "string") return parseRef(ref.key);
    const source = ref.source;
    const externalId = ref.external_id ?? ref.externalId ?? ref.id;
    if (typeof source === "string" && source && externalId != null && String(externalId)) {
      return { source, externalId: String(externalId) };
    }
  }
  return null;
}

function cleanString(value, max) {
  if (value == null) return undefined;
  const s = String(value).trim();
  return s ? s.slice(0, max) : undefined;
}

function cleanLinks(links) {
  if (!Array.isArray(links)) return [];
  return links
    .map((l) => (typeof l === "string" ? { url: l } : l))
    .filter((l) => l && typeof l.url === "string" && /^https?:\/\//.test(l.url))
    .slice(0, 20)
    .map((l) => ({ url: l.url.slice(0, 1000), label: cleanString(l.label, 80) || undefined }));
}

export class Store extends EventEmitter {
  constructor({ dataDir } = {}) {
    super();
    this.tasks = new Map();
    this.file = dataDir ? path.join(dataDir, "state.json") : null;
    this.saveTimer = null;
    if (this.file) {
      this.load();
      this.tidy();
    }
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const t of raw.tasks || []) this.tasks.set(t.key, { ...t, seen: new Set(t.seen || []) });
    } catch (err) {
      if (err.code !== "ENOENT") console.error(`[akb] could not read ${this.file}: ${err.message}`);
    }
  }

  scheduleSave() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 250);
    this.saveTimer.unref?.();
  }

  flush() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tasks = [...this.tasks.values()].map((t) => ({ ...t, seen: [...t.seen] }));
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks }), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[akb] could not write ${this.file}: ${err.message}`);
    }
  }

  get(key) {
    return this.tasks.get(key) || null;
  }

  ensure(source, externalId, now) {
    const key = taskKey(source, externalId);
    let task = this.tasks.get(key);
    if (!task) {
      task = {
        key, source, externalId, kind: SOURCE_KINDS[source] || "other",
        title: externalId, status: "queued", summary: null, parentKey: null,
        cwd: null, url: null, links: [], meta: {},
        placeholder: true, createdAt: now, updatedAt: now, startedAt: null, endedAt: null,
        events: [], seen: new Set(),
      };
      this.tasks.set(key, task);
    }
    return task;
  }

  wouldCycle(childKey, parentKey) {
    for (let k = parentKey, guard = 0; k && guard < 100; guard++) {
      if (k === childKey) return true;
      k = this.tasks.get(k)?.parentKey;
    }
    return false;
  }

  // Apply one event from any adapter. Creates the task (and a placeholder parent) when needed.
  apply(input) {
    if (!input || typeof input !== "object") throw new Error("event must be an object");
    const ref = parseRef(input.key) || parseRef({ source: input.source, external_id: input.external_id ?? input.externalId });
    if (!ref) throw new Error("event needs source and external_id (or key)");
    const now = cleanString(input.at, 40) && !Number.isNaN(Date.parse(input.at)) ? new Date(input.at).toISOString() : new Date().toISOString();
    const key = taskKey(cleanString(ref.source, 60), cleanString(ref.externalId, 200));
    const isNew = !this.tasks.has(key);
    const task = this.ensure(cleanString(ref.source, 60), cleanString(ref.externalId, 200), now);

    const eventId = cleanString(input.event_id, 200);
    if (eventId && task.seen.has(eventId)) return { task, changed: false };

    const changed = [];
    // initial_status only applies when this event creates the task (e.g. a parent mentioning a child).
    const rawStatus = input.status ?? (isNew || task.placeholder ? input.initial_status : undefined);
    const status = normalizeStatus(rawStatus);
    if (rawStatus != null && !status) throw new Error(`unknown status: ${rawStatus}`);

    // title_mode: "replace" (default) always sets it; "first" sets it only until a real title exists;
    // "default" is a fallback label that any later title overrides.
    const title = cleanString(input.title, 300);
    const mode = input.title_mode || "replace";
    if (title) {
      if (mode === "replace" || (mode === "first" && !task.titled)) {
        task.title = title;
        task.titled = true;
      } else if (mode === "default" && !task.titled) {
        task.title = title;
      }
    }
    // A placeholder (a parent only known because a child named it) shows its children's status
    // until it reports a status or a real title of its own.
    if (status || (title && mode !== "default")) task.placeholder = false;
    const kind = cleanString(input.kind, 20);
    if (kind && KNOWN_KINDS.has(kind)) task.kind = kind;
    const summary = cleanString(input.summary, 4000);
    if (summary) task.summary = summary;
    const cwd = cleanString(input.cwd, 1000);
    if (cwd) task.cwd = cwd;
    // Task url: http(s) only — reject javascript:, data:, etc.
    const url = cleanString(input.url, 1000);
    if (url && /^https?:\/\//i.test(url)) task.url = url;
    for (const link of cleanLinks(input.links)) {
      if (!task.links.some((l) => l.url === link.url)) task.links.push(link);
    }
    if (input.meta && typeof input.meta === "object" && !Array.isArray(input.meta)) {
      task.meta = { ...task.meta, ...input.meta };
    }

    const parent = parseRef(input.parent);
    let oldParentKey = null;
    if (parent) {
      const parentTask = this.ensure(parent.source, parent.externalId, now);
      if (parentTask.key !== task.key && !this.wouldCycle(task.key, parentTask.key)) {
        if (task.parentKey && task.parentKey !== parentTask.key) oldParentKey = task.parentKey;
        task.parentKey = parentTask.key;
        changed.push(parentTask);
      }
    }

    // Ignore a status older than the one already shown (events can arrive out of order).
    const stale = Boolean(task.statusAt && now < task.statusAt);
    const statusChanged = Boolean(status && status !== task.status && !stale);
    if (status && !stale) task.statusAt = now;
    if (statusChanged) {
      task.status = status;
      if (status === "running" && !task.startedAt) task.startedAt = now;
      task.endedAt = TERMINAL.has(status) ? now : null;
    } else if (status === "running" && !task.startedAt) {
      task.startedAt = now;
    }

    const message = cleanString(input.message, 2000);
    if (message || statusChanged) {
      task.events.push({ id: eventId || randomUUID(), at: now, status: status || null, message: message || null, type: cleanString(input.type, 40) || null });
      if (task.events.length > MAX_EVENTS) task.events.splice(0, task.events.length - MAX_EVENTS);
    }
    if (eventId) {
      task.seen.add(eventId);
      if (task.seen.size > MAX_SEEN_IDS) task.seen.delete(task.seen.values().next().value);
    }
    if (now > task.updatedAt) task.updatedAt = now;

    for (const t of this.rollup(task.parentKey)) changed.push(t);
    if (oldParentKey) this.dropOrRollup(oldParentKey);

    this.scheduleSave();
    for (const t of new Set([task, ...changed])) this.emit("change", t);
    return { task, changed: true };
  }

  // Recompute placeholder ancestors from their children. Returns the tasks that changed.
  rollup(key) {
    const out = [];
    for (let k = key, guard = 0; k && guard < 100; guard++) {
      const p = this.tasks.get(k);
      if (!p || !p.placeholder) break;
      const kids = this.children(k);
      if (!kids.length) break;
      const status = ROLLUP_ORDER.find((s) => kids.some((c) => c.status === s)) || "done";
      const updatedAt = kids.reduce((m, c) => (c.updatedAt > m ? c.updatedAt : m), p.updatedAt);
      if (status !== p.status || updatedAt !== p.updatedAt) {
        p.status = status;
        p.updatedAt = updatedAt;
        p.endedAt = TERMINAL.has(status) ? updatedAt : null;
        out.push(p);
      }
      k = p.parentKey;
    }
    return out;
  }

  // A placeholder that lost its last child has nothing left to show.
  dropOrRollup(key) {
    const p = this.tasks.get(key);
    if (!p) return;
    if (p.placeholder && !this.children(key).length) {
      this.tasks.delete(key);
      this.emit("remove", [key]);
      if (p.parentKey) this.dropOrRollup(p.parentKey);
    } else {
      for (const t of this.rollup(key)) this.emit("change", t);
    }
  }

  // Fix up state saved by older versions: childless placeholders, stale placeholder status.
  tidy() {
    for (const t of [...this.tasks.values()]) if (t.placeholder) this.dropOrRollup(t.key);
  }

  remove(key) {
    const task = this.tasks.get(key);
    if (!task) return false;
    const removed = [key];
    for (let i = 0; i < removed.length; i++) {
      for (const t of this.tasks.values()) if (t.parentKey === removed[i]) removed.push(t.key);
    }
    for (const k of removed) this.tasks.delete(k);
    this.scheduleSave();
    this.emit("remove", removed);
    return true;
  }

  list({ status, source, root } = {}) {
    let out = [...this.tasks.values()];
    if (status) out = out.filter((t) => t.status === status);
    if (source) out = out.filter((t) => t.source === source);
    if (root) out = out.filter((t) => !t.parentKey);
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  children(key) {
    return this.list().filter((t) => t.parentKey === key);
  }
}

export function publicTask(task, { events = true } = {}) {
  const { seen, ...rest } = task;
  return events ? rest : { ...rest, events: undefined, eventCount: task.events.length };
}
