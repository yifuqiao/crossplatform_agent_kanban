import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { normalizeStatus, TERMINAL } from "./status.js";
import { junkTitle } from "./adapters/common.js";

const MAX_EVENTS = 200;
const MAX_SEEN_IDS = 500;
// A placeholder parent takes the most urgent status among its children.
const ROLLUP_ORDER = ["waiting", "running", "planning", "queued", "review", "failed", "done"];
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

// Needs-you option buttons: each needs a non-empty label and value.
function cleanOptions(options) {
  if (!Array.isArray(options)) return undefined;
  return options
    .map((o) => (o && typeof o === "object" ? { label: cleanString(o.label, 80), value: cleanString(o.value, 200) } : null))
    .filter((o) => o && o.label && o.value)
    .slice(0, 12);
}

// Same option values (order ignored) — reorder alone is not a new round.
function optionsSameValues(a, b) {
  if (!a && !b) return true;
  if (!a || !b || a.length !== b.length) return false;
  const av = a.map((o) => o.value).sort();
  const bv = b.map((o) => o.value).sort();
  return av.every((v, i) => v === bv[i]);
}

function optionLabel(options, value) {
  return options?.find((o) => o.value === value)?.label;
}

// Same validation for board clicks and chat choice_resolved (except source, which callers force).
function validateChoice(task, value) {
  if (!task || task.placeholder) return { error: "not found", status: 404 };
  if (task.status !== "waiting") return { error: `task is ${task.status}`, status: 409 };
  if (!task.options?.length) return { error: "no options on this card", status: 409 };
  if (typeof value !== "string") return { error: "value must be a string", status: 400 };
  const cleaned = cleanString(value, 200);
  if (!cleaned) return { error: "value required", status: 400 };
  if (!task.options.some((o) => o.value === cleaned)) return { error: "value not in options", status: 400 };
  if (task.choice) {
    if (task.choice.value === cleaned) return { ok: true, cleaned, idempotent: true };
    return { error: "already chosen", status: 409 };
  }
  return { ok: true, cleaned, idempotent: false };
}

export class Store extends EventEmitter {
  constructor({ dataDir } = {}) {
    super();
    this.tasks = new Map();
    this.file = dataDir ? path.join(dataDir, "state.json") : null;
    this.saveTimer = null;
    // Keys of cards this process created. Only these may ever be dropped automatically;
    // every card loaded from state.json stays until someone removes it.
    this.createdThisRun = new Set();
    if (this.file) {
      this.load();
      this.migrate();
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
      this.createdThisRun.add(key);
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
    // initial_status only applies when this event creates the task (e.g. a parent mentioning a child).
    // Validate before ensure() so a rejected event leaves no placeholder card behind.
    const rawStatus = input.status ?? (isNew || this.tasks.get(key).placeholder ? input.initial_status : undefined);
    let status = normalizeStatus(rawStatus);
    if (rawStatus != null && !status) throw new Error(`unknown status: ${rawStatus}`);
    const task = this.ensure(cleanString(ref.source, 60), cleanString(ref.externalId, 200), now);
    // awaiting_review: the agent opened a PR. idle: its turn is over and it waits for the person's next
    // word. An idle card stays in 进行中, except that one with an open PR goes back to 审核中.
    if (input.awaiting_review === true) task.awaitingReview = true;
    const idle = input.idle === true;
    // A waiting card whose turn has ended no longer waits on a permission prompt: back to 进行中.
    if (idle && !status && (task.status === "running" || task.status === "waiting")) status = task.awaitingReview ? "review" : "running";
    // Who created the card through MCP (e.g. "mcp:claude-code"); pollers and hooks leave it unset.
    if (isNew) {
      const createdBy = cleanString(input.created_by, 200);
      if (createdBy) task.createdBy = createdBy;
    }

    const eventId = cleanString(input.event_id, 200);
    if (eventId && task.seen.has(eventId)) return { task, changed: false };

    const changed = [];

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
    // Which bot/agent on that platform did the work, e.g. "ops-bot". Cards without it show the source only.
    const agentName = cleanString(input.agent_name, 60);
    if (agentName) task.agentName = agentName;
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
    // The agent's step list, replaced whole on each update.
    if (Array.isArray(input.checklist)) {
      task.checklist = input.checklist
        .map((c) => ({ text: cleanString(c?.text, 200), state: ["done", "doing", "todo"].includes(c?.state) ? c.state : "todo" }))
        .filter((c) => c.text)
        .slice(0, 30);
    }
    if (input.meta && typeof input.meta === "object" && !Array.isArray(input.meta)) {
      task.meta = { ...task.meta, ...input.meta };
    }

    // Optional needs-you prompt fields (all omitable; old cards stay unchanged).
    // A new question, a different set of option values, or a new label on the currently
    // chosen value clears the live choice (prior pick stays on the timeline).
    // Reordering the same values with unchanged labels does not.
    const options = cleanOptions(input.options);
    const question = cleanString(input.question, 500);
    let newRound = false;
    if (options) {
      if (!optionsSameValues(task.options, options)) {
        newRound = true;
      } else if (task.choice) {
        const prevLabel = optionLabel(task.options, task.choice.value);
        const nextLabel = optionLabel(options, task.choice.value);
        if (prevLabel && nextLabel && prevLabel !== nextLabel) newRound = true;
      }
      task.options = options;
    }
    if (question && question !== task.question) {
      task.question = question;
      newRound = true;
    }
    const background = cleanString(input.background, 4000);
    if (background) task.background = background;
    if (newRound && task.choice) {
      task.events.push({
        id: randomUUID(),
        at: now,
        status: null,
        message: `Cleared previous choice “${task.choice.value}” for a new question`,
        type: "choice_clear",
      });
      if (task.events.length > MAX_EVENTS) task.events.splice(0, task.events.length - MAX_EVENTS);
      task.choice = null;
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

    const pendingRequest = Boolean(task.updateRequest);
    // Ignore a status older than the one already shown (events can arrive out of order).
    // keep_terminal: a routine status (e.g. "turn finished") that must not reopen a done/failed card.
    const stale = Boolean(task.statusAt && now < task.statusAt) || Boolean(input.keep_terminal && TERMINAL.has(task.status));
    const statusChanged = Boolean(status && status !== task.status && !stale);
    if (status && !stale) task.statusAt = now;
    if (idle && !TERMINAL.has(task.status)) task.idleSince ||= now;
    else if (status && !stale) task.idleSince = null;
    if (statusChanged) {
      task.status = status;
      if (status === "running" && !task.startedAt) task.startedAt = now;
      task.endedAt = TERMINAL.has(status) ? now : null;
      if (TERMINAL.has(status)) task.updateRequest = null;
    } else if (status === "running" && !task.startedAt) {
      task.startedAt = now;
    }

    // Chat / /api/events resolution only — after status/options so running→waiting+choice works.
    // Source is always "chat"; never trust client source:"board".
    let choice_rejected;
    if (input.choice_resolved && typeof input.choice_resolved === "object") {
      const check = validateChoice(task, input.choice_resolved.value);
      if (check.ok && !check.idempotent) {
        const by = cleanString(input.choice_by, 80) || null;
        const label = optionLabel(task.options, check.cleaned) || check.cleaned;
        task.choice = { value: check.cleaned, label, at: now, source: "chat", by };
        task.events.push({
          id: randomUUID(),
          at: now,
          status: null,
          message: `Chose “${label}” (${check.cleaned}, chat${by ? ` · ${by}` : ""})`,
          type: "choice",
        });
        if (task.events.length > MAX_EVENTS) task.events.splice(0, task.events.length - MAX_EVENTS);
      } else if (!check.ok) {
        choice_rejected = { reason: check.error, status: check.status };
      }
      // Idempotent same value: success, no rejection.
    }

    // A brief with no note of its own still goes on the timeline.
    const message = cleanString(input.message, 2000) || (input.brief && pendingRequest && summary ? summary.slice(0, 2000) : undefined);
    if (message || statusChanged) {
      task.events.push({ id: eventId || randomUUID(), at: now, status: status || null, message: message || null, type: cleanString(input.type, 40) || null });
      if (task.events.length > MAX_EVENTS) task.events.splice(0, task.events.length - MAX_EVENTS);
    }
    // A brief written by the agent answers an open "Get update" request.
    if (input.brief && pendingRequest && summary) {
      task.updateRequest = null;
      task.briefAt = now;
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
    return { task, changed: true, choice_rejected };
  }

  // The board only records the ask; the agent picks it up through MCP (kanban_report /
  // kanban_update_requests) and answers with a brief. Nothing is sent to the agent or the relay.
  requestUpdate(key, { by } = {}) {
    const task = this.tasks.get(key);
    // A placeholder has no agent of its own to answer; its status only rolls up from children.
    if (!task || task.placeholder) return null;
    if (task.updateRequest) return task;
    const at = new Date().toISOString();
    task.updateRequest = { at, by: cleanString(by, 80) || null };
    task.events.push({ id: randomUUID(), at, status: null, message: "Update requested from the board", type: "update_request" });
    if (task.events.length > MAX_EVENTS) task.events.splice(0, task.events.length - MAX_EVENTS);
    this.scheduleSave();
    this.emit("change", task);
    return task;
  }

  // Board click only — always records source "board". Chat must use choice_resolved via apply.
  // Nothing is sent to the agent or the relay — bots poll via kanban_get_choice.
  recordChoice(key, { value, by } = {}) {
    const task = this.tasks.get(key);
    if (!task) return { error: "not found", status: 404 };
    if (task.placeholder) return { error: "this card only groups other tasks; choose on one of them", status: 409 };
    const check = validateChoice(task, value);
    if (!check.ok) return { error: check.error, status: check.status };
    if (check.idempotent) return { task, changed: false };
    const at = new Date().toISOString();
    const who = cleanString(by, 80) || null;
    const label = optionLabel(task.options, check.cleaned) || check.cleaned;
    task.choice = { value: check.cleaned, label, at, source: "board", by: who };
    task.events.push({
      id: randomUUID(),
      at,
      status: null,
      message: `Chose “${label}” (${check.cleaned}, board${who ? ` · ${who}` : ""})`,
      type: "choice",
    });
    if (task.events.length > MAX_EVENTS) task.events.splice(0, task.events.length - MAX_EVENTS);
    if (at > task.updatedAt) task.updatedAt = at;
    this.scheduleSave();
    this.emit("change", task);
    return { task, changed: true };
  }

  updateRequests({ source } = {}) {
    return this.list({ source }).filter((t) => t.updateRequest).sort((a, b) => a.updateRequest.at.localeCompare(b.updateRequest.at));
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

  // A placeholder this run created that lost its last child has nothing left to show, unless it has
  // its own history. Cards loaded from state.json are never dropped here.
  dropOrRollup(key) {
    const p = this.tasks.get(key);
    if (!p) return;
    if (p.placeholder && this.createdThisRun.has(key) && !this.children(key).length && !p.events?.length && !p.summary) {
      this.tasks.delete(key);
      this.emit("remove", [key]);
      if (p.parentKey) this.dropOrRollup(p.parentKey);
    } else {
      for (const t of this.rollup(key)) this.emit("change", t);
    }
  }

  // State saved by older versions: hook cards were moved to 审核中 at every turn end, and some were
  // titled with raw prompt XML. Put the first back in 进行中 as idle, and let the next prompt retitle the second.
  migrate() {
    let dirty = false;
    for (const t of this.tasks.values()) {
      if (t.source !== "claude-code" && t.source !== "claude-code-web") continue;
      const last = t.events?.findLast((e) => e.status);
      if (t.status === "review" && !t.awaitingReview && last?.type === "stop") {
        t.status = "running";
        t.idleSince = last.at;
        dirty = true;
      }
      if (t.titled && junkTitle(t.title)) {
        t.titled = false;
        dirty = true;
      }
    }
    if (dirty) this.scheduleSave();
  }

  // Fix up stale placeholder status in state saved by older versions. Deletes nothing at startup:
  // dropOrRollup only drops placeholders created in this run.
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
