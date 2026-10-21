const SOURCE_COLORS = {
  "claude-code": "#d97757", "claude-code-web": "#b8613f", "claude-chat": "#c96442", codex: "#10a37f", chatgpt: "#0f8f6f",
  cursor: "#3b3b3b", "cursor-cli": "#555", "cursor-cloud": "#6b5bd6", "grok-bot": "#5b6b82", "grok-chat": "#8391a7",
};
const STATUS_LABEL = { queued: "排队", planning: "规划中", running: "进行中", waiting: "等您", review: "审核中", done: "完成", failed: "失败" };
// Finished columns show the newest few; the rest stay one click away.
const FINISHED_LIMIT = 8;

const params = new URLSearchParams(location.search);
let token = params.get("token");
try {
  if (token) localStorage.setItem("akb-token", token);
  else token = localStorage.getItem("akb-token");
} catch {}
// Drop ?token= from the address bar after stashing it (keeps shares/history cleaner).
if (params.has("token")) {
  params.delete("token");
  const q = params.toString();
  history.replaceState(null, "", `${location.pathname}${q ? `?${q}` : ""}${location.hash}`);
}
const withToken = (u) => (token ? `${u}${u.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : u);
const inWxWork = /wxwork/i.test(navigator.userAgent || "");

// expanded: "col|group" day groups whose finished-card limit was lifted. toggled: "col|group" groups whose fold differs from the default (今天 open, 昨天/历史 folded).
const state = { tasks: new Map(), columns: [], hidden: new Set(), query: "", flat: false, showStale: false, open: null, expanded: new Set(), toggled: new Set() };
const STALE_MS = 24 * 3600 * 1000;
// A running/planning card with no event for this long is flagged on the board (still shown).
const SILENT_MS = 30 * 60 * 1000;
// Grok Bot tasks often wait on CI or review between notes; flag them as lost contact only after 2 hours.
const GROK_SILENT_MS = 2 * 3600 * 1000;
const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "style") n.style.cssText = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : String(k));
  return n;
}

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时`;
  return `${Math.floor(s / 86400)} 天`;
}
// Day key in the viewer's local time zone (YYYY-MM-DD), so "today" matches the clock the person sees.
function dayKey(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const since = (iso) => (Date.now() - Date.parse(iso) < 60000 ? "刚刚" : `${ago(iso)}前`);

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', "#39": "'", apos: "'" };
const ENVELOPE = /^\s*(<|&lt;)(wake|coordinator-relay|relay|system-reminder|session-context)\b/i;
const ATTACHMENTS = /^(\s*@(?:"[^"]*"|\S+))+\s*/;
// The person's words in a (possibly cut-off) prompt envelope; same rules as promptParts in src/adapters/common.js.
function envelopeWords(raw) {
  const body = raw.replace(ATTACHMENTS, "");
  if (!ENVELOPE.test(body)) return body.trim();
  const s = body.replace(/&(lt|gt|amp|quot|#39|apos);/g, (_, e) => ENTITIES[e])
    .replace(/<(system-reminder|system-note|session-context|untrusted-uploads)\b[^>]*>[\s\S]*?<\/\1\b[^>]*>/gi, " ");
  const m = /<cited\b[^>]*author="user"[^>]*>([^<]+)/i.exec(s) || /<message\b[^>]*from="human"[^>]*>([^<]+)/i.exec(s) || /<note>([^<]+)/i.exec(s);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}
// Older cloud-session cards were titled with the raw <wake>/<session-context> XML of the first prompt,
// cut off before the person's words. Show those words, from the title or a later prompt on the timeline.
function displayTitle(t) {
  const raw = t.title || "";
  if (raw.trim() && !ENVELOPE.test(raw.replace(ATTACHMENTS, ""))) return raw;
  const prompts = (t.events || []).filter((e) => e.type === "prompt" && e.message).map((e) => e.message.replace(/^Prompt: /, ""));
  for (const p of [raw, ...prompts]) {
    const w = envelopeWords(p);
    if (w) return w.length > 100 ? `${w.slice(0, 99)}…` : w;
  }
  return `${t.source} · ${t.cwd ? t.cwd.split("/").pop() : t.externalId}`;
}

const childrenOf = (key) => [...state.tasks.values()].filter((t) => t.parentKey === key).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const isRoot = (t) => !t.parentKey || !state.tasks.has(t.parentKey);

function descendants(key, out = []) {
  for (const c of childrenOf(key)) {
    out.push(c);
    descendants(c.key, out);
  }
  return out;
}

// Why a card is hidden by default: replaced by a newer task, or "in progress" with no word for a day
// (e.g. a relay task Grok Bot never reported on). The relay still calls them open; we flag them.
function staleReason(t) {
  if (t.meta?.superseded_by) return "已被取代";
  // review included: a session that just stopped talking (never resolved) should not sit in 审核中 forever.
  if (!["queued", "planning", "running", "review"].includes(t.status)) return null;
  const last = lastHeard(t);
  return Date.now() - Date.parse(last) > STALE_MS ? `${ago(last)}无更新` : null;
}

// Newest update on the card or anything nested under it.
function lastHeard(t) {
  return [t, ...descendants(t.key)].reduce((m, d) => (d.updatedAt > m ? d.updatedAt : m), t.updatedAt);
}

// Says "in progress" but nothing has reported for a while: the agent may have stopped without saying so.
function silentReason(t) {
  if (t.status !== "planning" && t.status !== "running") return null;
  if (t.idleSince) return null;
  const last = lastHeard(t);
  const grok = t.source === "grok-bot";
  if (Date.now() - Date.parse(last) <= (grok ? GROK_SILENT_MS : SILENT_MS)) return null;
  return grok ? `失联 ${ago(last)}` : `静默 ${ago(last)}`;
}

// Cards an agent opened itself through MCP move only when it remembers to report;
// hook and poller cards follow the agent's real lifecycle.
const selfReported = (t) => typeof t.createdBy === "string" && t.createdBy.startsWith("mcp:");

function matches(t) {
  if (state.hidden.has(t.source)) return false;
  if (!state.query) return true;
  const hay = `${displayTitle(t)} ${t.summary || ""} ${t.source} ${t.agentName || ""} ${t.cwd || ""} ${t.question || ""} ${t.background || ""}`.toLowerCase();
  return hay.includes(state.query);
}

// "grok-bot · ops-bot" when the card names its bot; just the source otherwise.
const who = (t) => (t.agentName ? `${t.source} · ${t.agentName}` : t.source);

const swatch = (source) => el("span", { class: "sw", style: `--s:${SOURCE_COLORS[source] || "#64748b"}` });

function badge(source, agentName, kind) {
  return el("span", { class: "who", title: [source, agentName, kind].filter(Boolean).join(" · ") },
    swatch(source), source, agentName && el("span", { class: "agent" }, `· ${agentName}`), kind && el("span", { class: "agent" }, `· ${kind}`));
}

function tree(key, depth = 0) {
  const kids = childrenOf(key);
  if (!kids.length || depth > 6) return null;
  return el("ul", { class: "tree" }, kids.map((c) =>
    el("li", {},
      el("div", { class: "row", title: c.summary || c.title, onclick: (e) => { e.stopPropagation(); openTask(c.key); } },
        el("span", { class: `sdot ${c.status}`, style: `--c:var(--${c.status})` }),
        el("span", { class: "name" }, displayTitle(c)),
        el("span", { class: "src", title: STATUS_LABEL[c.status] }, who(c))),
      tree(c.key, depth + 1))));
}

async function pickChoice(t, value, btn) {
  if (t.choice) return;
  if (btn) btn.disabled = true;
  try {
    const res = await api(`api/tasks/${encodeURIComponent(t.key)}/choice`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    });
    if (res.choice) {
      const cur = state.tasks.get(t.key) || t;
      state.tasks.set(t.key, { ...cur, choice: res.choice });
      scheduleRender();
    }
  } catch (err) {
    if (btn) btn.disabled = false;
    alert(`没能记录选择：${err.message}`);
  }
}

// The agent's own steps, checked off as it reports them.
const CHECK_MARK = { done: "✓", doing: "▸", todo: "○" };
function checklistBlock(t) {
  if (!t.checklist?.length) return null;
  return el("ul", { class: "checklist" }, t.checklist.map((c) => el("li", { class: c.state }, el("span", { class: "mark" }, CHECK_MARK[c.state]), c.text)));
}

function choiceBlock(t, { compact = false } = {}) {
  const hasPrompt = t.question || t.background || (t.options && t.options.length);
  if (!hasPrompt && !t.choice) return null;
  const chosen = t.choice;
  return el("div", { class: `choice-block${compact ? " compact" : ""}`, onclick: (e) => e.stopPropagation() },
    t.question && el("div", { class: "choice-q" }, t.question),
    t.background && el("div", { class: "choice-bg", title: t.background }, t.background),
    chosen && el("span", { class: "flag chosen", title: `${chosen.value} · ${chosen.source} · ${chosen.at}` }, "已选"),
    t.options?.length && el("div", { class: "choice-opts" }, t.options.map((o) => {
      const selected = chosen && chosen.value === o.value;
      return el("button", {
        class: `choice-btn${selected ? " selected" : ""}`,
        type: "button",
        disabled: Boolean(chosen),
        title: o.value,
        onclick: (e) => { e.stopPropagation(); pickChoice(t, o.value, e.currentTarget); },
      }, o.label);
    })));
}

function card(t, { showParent = false, hideTree = false } = {}) {
  const desc = descendants(t.key);
  const counts = {};
  for (const d of desc) counts[d.status] = (counts[d.status] || 0) + 1;
  const attention = t.status !== "waiting" && desc.some((d) => d.status === "waiting");
  const last = t.events?.findLast((e) => e.type !== "update_request" && e.type !== "choice" && e.type !== "choice_clear" && e.type !== "checklist")?.message;
  const same = (a, b) => a.slice(0, 60) === b.slice(0, 60);
  const parent = (showParent || state.flat) && t.parentKey ? state.tasks.get(t.parentKey) : null;
  const stale = staleReason(t);
  const silent = !stale && silentReason(t);
  const idle = !stale && t.status === "running" && t.idleSince;
  const heard = lastHeard(t);
  const flags = [
    stale && el("span", { class: "flag" }, stale),
    silent && el("span", { class: "flag silent", title: "还标着进行中，但之后再没有任何上报。agent 可能已经停了却没说。" }, silent),
    idle && el("span", { class: "flag idle", title: "这一轮做完了，在等你的下一句话。开了 PR 才进审核中。" }, `空闲 ${ago(t.idleSince)}`),
    attention && el("span", { class: "flag" }, "子任务等您"),
    t.meta?.waiting_on && el("span", { class: "flag", title: "从 agent 最近的进展里推断" }, `等${t.meta.waiting_on}`),
    selfReported(t) && el("span", { class: "flag self", title: "只在 agent 通过 MCP 主动上报时更新，不走 hook 或轮询" }, "自报"),
    t.updateRequest && el("span", { class: "flag asked", title: "等 agent 写一段进展" }, "已请求更新"),
    t.choice && el("span", { class: "flag chosen" }, "已选"),
  ].filter(Boolean);
  // In the needs-you lane every waiting card is listed once; hide the nested tree so a waiting child is not shown twice.
  const showTree = !hideTree && !state.flat;
  return el("article", { class: `card${attention ? " attention-child" : ""}${stale ? " stale" : ""}`, "data-key": t.key, style: `--c:var(--${t.status})`, onclick: () => openTask(t.key) },
    el("div", { class: "top" }, badge(t.source, t.agentName),
      el("span", { class: "time", title: `最后上报 ${new Date(heard).toLocaleString()}` }, since(heard))),
    parent && el("div", { class: "parent-line" }, `↳ ${displayTitle(parent)}`),
    el("div", { class: "title" }, displayTitle(t)),
    t.summary && el("div", { class: "summary" }, t.summary),
    last && !t.checklist?.length && !(t.summary && same(last, t.summary)) && el("div", { class: "last", title: last }, last),
    flags.length > 0 && el("div", { class: "flags" }, flags),
    checklistBlock(t),
    choiceBlock(t, { compact: true }),
    desc.length > 0 && !hideTree && el("div", { class: "rollup" }, Object.entries(counts).map(([st, n]) => el("span", { class: "pill", style: `--c:var(--${st})` }, `${n} ${STATUS_LABEL[st]}`))),
    showTree && tree(t.key));
}

function renderSources() {
  const sources = [...new Set([...state.tasks.values()].map((t) => t.source))].sort();
  $("sources").replaceChildren(...sources.map((s) =>
    el("button", { class: "chip", "aria-pressed": String(!state.hidden.has(s)), title: state.hidden.has(s) ? "点击显示" : "点击隐藏", onclick: () => { state.hidden.has(s) ? state.hidden.delete(s) : state.hidden.add(s); render(); } }, swatch(s), s)));
}

// The needs-you lane (等您) aggregates every waiting card (including nested children); other columns keep roots only
// (or all cards when "Sub-tasks as cards" is on). Parent cards stay in their own status column.
function cardsForColumn(colId, rootVisible) {
  if (colId !== "waiting") {
    return rootVisible.filter((t) => t.status === colId);
  }
  // One card per waiting key (dedupe if flat mode also lists the same child).
  const seen = new Set();
  const out = [];
  for (const t of state.tasks.values()) {
    if (t.status !== "waiting" || !matches(t) || seen.has(t.key)) continue;
    if (!state.showStale && staleReason(t)) continue;
    seen.add(t.key);
    out.push(t);
  }
  out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return out;
}

// Cards split by when they were last heard from (the time shown on the card): 今天, 昨天, 历史.
// Which groups start open depends on the column: 进行中 opens all; 排队/规划中/审核中 open all while the column
// holds at most FEW_CARDS, otherwise only 今天; 完成/失败 open only 今天. A click flips one group. Finished
// columns still show the newest few per open group, with the rest one click away.
const DAY_GROUPS = [{ id: "today", label: "今天", open: true }, { id: "yesterday", label: "昨天" }, { id: "older", label: "历史" }];
const FEW_CARDS = 6;
function openByDefault(colId, group, total) {
  if (group.open || colId === "running") return true;
  if (colId === "queued" || colId === "planning" || colId === "review") return total <= FEW_CARDS;
  return false;
}
function dayGroups(colId, cards) {
  const now = new Date();
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const groupOf = (t) => {
    const day = dayKey(lastHeard(t));
    return day >= today ? "today" : day === yesterday ? "yesterday" : "older";
  };
  const finished = colId === "done" || colId === "failed";
  return DAY_GROUPS.map((g) => {
    const list = cards.filter((t) => groupOf(t) === g.id);
    if (!list.length) return null;
    const id = `${colId}|${g.id}`;
    const open = openByDefault(colId, g, cards.length) !== state.toggled.has(id);
    const shown = finished && !state.expanded.has(id) ? list.slice(0, FINISHED_LIMIT) : list;
    return el("div", { class: `day${open ? " open" : ""}`, "data-keys": list.map((t) => t.key).join(" ") },
      el("button", { class: "day-head", "aria-expanded": String(open), title: open ? "点击折叠" : "点击展开",
        onclick: () => { state.toggled.has(id) ? state.toggled.delete(id) : state.toggled.add(id); render(); } },
        el("span", { class: "caret" }, open ? "▾" : "▸"), g.label, el("span", { class: "n" }, list.length)),
      open && shown.map((t) => card(t)),
      open && list.length > shown.length && el("button", { class: "more", onclick: () => { state.expanded.add(id); render(); } }, `再显示 ${list.length - shown.length} 张`));
  });
}

function draw() {
  renderSources();
  const candidates = [...state.tasks.values()].filter((t) => (state.flat || isRoot(t)) && matches(t));
  const staleCount = candidates.filter(staleReason).length;
  $("stale-count").textContent = staleCount;
  const visible = state.showStale ? candidates : candidates.filter((t) => !staleReason(t));
  const heard = new Map(visible.map((t) => [t.key, lastHeard(t)]));
  visible.sort((a, b) => heard.get(b.key).localeCompare(heard.get(a.key)));

  const waiting = cardsForColumn("waiting", visible);
  $("attention").hidden = waiting.length === 0;
  $("attention").replaceChildren(
    el("h2", {}, `等您处理 · ${waiting.length}`),
    el("div", { class: "cards" }, waiting.map((t) => card(t, { showParent: Boolean(t.parentKey), hideTree: true }))));

  const byStatus = {};
  $("board").replaceChildren(...state.columns.filter((col) => col.id !== "waiting").map((col) => {
    const cards = cardsForColumn(col.id, visible);
    byStatus[col.id] = cards.length;
    const label = STATUS_LABEL[col.id] || col.label;
    return el("section", { class: `column${cards.length ? "" : " empty"}`, "data-col": col.id, style: `--c:var(--${col.id})`, title: cards.length ? null : `${label}：暂无` },
      el("h2", {}, el("span", { class: "dot" }), label, el("span", { class: "n" }, cards.length)),
      dayGroups(col.id, cards));
  }));

  const stat = (n, label, hot) => n > 0 && el("span", { class: hot ? "hot" : null }, el("b", {}, n), label);
  $("stats").replaceChildren(...[
    stat(waiting.length, "等您", true),
    stat((byStatus.running || 0) + (byStatus.planning || 0) + (byStatus.queued || 0), "进行中"),
    stat(byStatus.review || 0, "审核中"),
    stat(byStatus.failed || 0, "失败"),
  ].filter(Boolean));
  if (state.open) renderDetail();
  seen = new Map([...state.tasks.values()].map((t) => [t.key, version(t)]));
}

async function api(path, opts) {
  const res = await fetch(withToken(path), opts);
  if (res.status === 401) {
    if (inWxWork) {
      location.href = "auth/wecom/start";
      return new Promise(() => {});
    }
    const t = prompt("看板口令（AKB_TOKEN）：");
    if (t) {
      token = t;
      try { localStorage.setItem("akb-token", t); } catch {}
      return api(path, opts);
    }
    throw new Error("HTTP 401");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : null;
}

async function openTask(key) {
  state.open = key;
  $("drawer").hidden = false;
  try {
    const { task } = await api(`api/tasks/${encodeURIComponent(key)}`);
    state.tasks.set(task.key, task);
  } catch {}
  renderDetail();
}

function renderDetail() {
  const t = state.tasks.get(state.open);
  if (!t) return void ($("drawer").hidden = true);
  const parent = t.parentKey && state.tasks.get(t.parentKey);
  const meta = [["来源", t.source], ["Agent", t.agentName], ["类型", t.kind], ["Key", t.key], ["目录", t.cwd],
    ["开始", t.startedAt && new Date(t.startedAt).toLocaleString()], ["更新", new Date(t.updatedAt).toLocaleString()],
    ...(t.choice ? [["选择", `${t.choice.value}（${t.choice.source}，${new Date(t.choice.at).toLocaleString()}）`]] : []),
    ...Object.entries(t.meta || {}).filter(([, v]) => v != null && typeof v !== "object").map(([k, v]) => [k, String(v)])].filter(([, v]) => v);
  const links = [...(t.url ? [{ url: t.url, label: "打开会话" }] : []), ...(t.links || [])];
  const title = displayTitle(t);
  $("detail").replaceChildren(...[
    el("div", { class: "head" },
      el("span", { class: "status-pill", style: `--c:var(--${t.status})` }, el("span", { class: "dot" }), STATUS_LABEL[t.status]),
      badge(t.source, t.agentName, t.kind),
      el("span", { title: new Date(lastHeard(t)).toLocaleString() }, `最后上报 ${since(lastHeard(t))}`)),
    el("h3", { title: title !== t.title ? t.title : null }, title),
    parent && el("div", { class: "parent-line" }, "属于 ", el("a", { href: "#", onclick: (e) => { e.preventDefault(); openTask(parent.key); } }, displayTitle(parent))),
    t.summary && el("p", {}, t.summary),
    checklistBlock(t),
    choiceBlock(t),
    links.length > 0 && el("div", { class: "links" }, links.map((l) => el("a", { href: l.url, target: "_blank", rel: "noopener noreferrer" }, l.label || l.url))),
    el("div", { class: "meta" }, meta.flatMap(([k, v]) => [el("span", {}, k), el("span", {}, v)])),
    childrenOf(t.key).length > 0 && el("section", {}, el("h4", {}, "子任务"), tree(t.key)),
    el("section", {}, el("h4", {}, "时间线"),
      el("ul", { class: "timeline" }, [...(t.events || [])].reverse().map((e) =>
        el("li", {}, el("span", { class: "sdot", style: `--c:var(--${e.status || "queued"})`, title: STATUS_LABEL[e.status] || "" }),
          el("time", { title: new Date(e.at).toLocaleString() }, new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
          el("span", {}, e.message || STATUS_LABEL[e.status] || ""))))),
    el("div", { class: "actions" },
      updateControl(t),
      closeControl(t),
      el("button", { class: "danger", onclick: async () => {
        if (!confirm("把这张卡和它的子任务从看板上移除？")) return;
        await api(`api/tasks/${encodeURIComponent(t.key)}`, { method: "DELETE" });
      } }, "从看板移除")),
  ].filter((n) => n instanceof Node));
}

// Grok Bot sometimes never closes a relay task. Let the user close the card; the relay is not touched.
function closeControl(t) {
  if (t.source !== "grok-bot" || t.status === "done" || t.status === "failed" || t.placeholder) return null;
  const close = (status, ask) => async (e) => {
    if (!confirm(ask)) return;
    e.target.disabled = true;
    try {
      await api(`api/tasks/${encodeURIComponent(t.key)}/close`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }),
      });
    } catch (err) {
      e.target.disabled = false;
      alert(`没能关闭：${err.message}`);
    }
  };
  return [
    el("button", { class: "action", title: "只改看板上的卡，不通知 Grok Bot", onclick: close("done", "确认这件事已经做完了？只改看板上的卡。") }, "我确认已完成"),
    el("button", { class: "action", title: "只改看板上的卡，不通知 Grok Bot", onclick: close("failed", "标记为已放弃？只改看板上的卡。") }, "已放弃"),
  ];
}

// Get update only records the ask on the card; the agent sees it the next time it talks to the
// board over MCP and writes a brief back into the card.
function updateControl(t) {
  if (t.status === "done" || t.status === "failed" || t.placeholder) return null;
  if (t.updateRequest) {
    return el("div", { class: "asked-note" }, `${since(t.updateRequest.at)}请求了更新。${t.source} 下次连上看板时会在这里写一段进展。`);
  }
  return el("button", { class: "action", title: "请 agent 把最新进展写进这张卡", onclick: async (e) => {
    e.target.disabled = true;
    try {
      await api(`api/tasks/${encodeURIComponent(t.key)}/update-request`, { method: "POST" });
    } catch (err) {
      e.target.disabled = false;
      alert(`没能请求更新：${err.message}`);
    }
  } }, "请求更新");
}

function connect() {
  const es = new EventSource(withToken("api/stream"));
  es.onopen = () => { $("conn").classList.add("live"); $("conn").textContent = "实时"; };
  es.onerror = () => { $("conn").classList.remove("live"); $("conn").textContent = "已断开，重连中…"; };
  es.addEventListener("task", (e) => {
    const t = JSON.parse(e.data);
    enqueue(t.key, t);
  });
  es.addEventListener("remove", (e) => {
    for (const k of JSON.parse(e.data)) enqueue(k, null);
  });
}

function mergeEvents(a, b) {
  const seen = new Set(a.map((e) => e.id));
  return [...a, ...b.filter((e) => !seen.has(e.id))];
}

// Stream updates are queued and applied one card at a time: each card glides to its new place
// (FLIP: measure, redraw, play from where it was) and lands before the next one moves.
// While the window is in the background nothing is applied, so the board stays as the person left
// it; when they come back the queue plays out card by card, so they can see what happened.
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const away = () => document.hidden || !document.hasFocus();
const EASE = "cubic-bezier(.22, 1, .36, 1)";
// Exponential ease-out: covers most of the way early, then creeps the last pixels in, like braking.
const BRAKE = "cubic-bezier(.16, 1, .3, 1)";
// What the person last saw, per card: status and update time.
const version = (t) => `${t.status}|${t.updatedAt}`;
let seen = new Map();
// key -> latest stream frame, or null when removed; a key keeps its place in line when it updates again.
const queue = new Map();
let playing = false;
let pending = false;

function enqueue(key, t) {
  queue.set(key, t);
  showQueue();
  if (!away()) play();
}

function showQueue() {
  const n = $("paused");
  n.hidden = queue.size === 0;
  n.textContent = playing ? `回放中 · 还有 ${queue.size} 张` : `${queue.size} 张卡有变化，回到窗口时播放`;
}

function apply(key, t) {
  if (!t) return void state.tasks.delete(key);
  const prev = state.tasks.get(key);
  // Stream frames carry recent events only; keep the full timeline if the drawer loaded it.
  if (prev?.events?.length > t.events.length && state.open === key) t.events = mergeEvents(prev.events, t.events);
  state.tasks.set(key, t);
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function play() {
  if (playing) return;
  playing = true;
  try {
    while (queue.size && !away()) {
      const [key, t] = queue.entries().next().value;
      queue.delete(key);
      apply(key, t);
      showQueue();
      // A long backlog plays faster, so coming back after a night does not mean a minute of waiting.
      const ms = Math.round(Math.max(900, Math.min(1600, 16000 / (queue.size + 1))));
      const { moved, flashed } = render({ duration: ms, focus: key });
      if (moved) await moved;
      else if (flashed) await pause(Math.min(ms, 700));
      // A short breath between cards so each move reads on its own.
      if (queue.size) await pause(220);
    }
  } finally {
    playing = false;
    showQueue();
  }
}

// Redraws that are not stream updates (the 30 s clock, a choice being recorded) wait while the window is away.
function scheduleRender() {
  if (away()) return void (pending = true);
  if (!playing) render();
}

// Back in front of the person: play what was queued, after a beat so their eyes have arrived.
function resume() {
  if (away()) return;
  setTimeout(() => {
    if (away()) return;
    if (pending && !playing) {
      pending = false;
      render();
    }
    play();
  }, queue.size ? 250 : 0);
}
window.addEventListener("focus", resume);
document.addEventListener("visibilitychange", resume);

function cardRects() {
  const m = new Map();
  for (const n of document.querySelectorAll(".card[data-key]")) {
    if (!m.has(n.dataset.key)) m.set(n.dataset.key, { node: n, rect: n.getBoundingClientRect(), lane: n.closest("#attention") ? "attention" : "board" });
  }
  return m;
}

// A fixed-position copy of a card, for moves the real card cannot make inside its own container
// (between the needs-you lane and the board, or off the board into a folded spot).
function ghost(layer, node, rect) {
  const g = node.cloneNode(true);
  g.removeAttribute("data-key");
  Object.assign(g.style, { position: "absolute", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, margin: "0" });
  layer.append(g);
  return g;
}

// Where a card that is no longer drawn went: the header of its day group (folded, or past the
// finished-card limit), else its new column (or the needs-you lane).
function landingSpot(key) {
  const t = state.tasks.get(key);
  if (!t) return null;
  const spot = t.status === "waiting" ? $("attention") : document.querySelector(`.column[data-col="${t.status}"]`);
  if (!spot || spot.hidden) return null;
  const day = [...spot.querySelectorAll(".day[data-keys]")].find((d) => d.dataset.keys.split(" ").includes(key));
  return day ? day.querySelector(".day-head") : spot.querySelector("h2");
}

// Pick up (lift, tilt, turn half see-through), travel braking to a stop, set down.
// Every keyframe lists the same transform functions so each step interpolates smoothly.
function dragFrames(dx, dy) {
  const at = (x, y, s, r) => `translate(${x}px, ${y}px) scale(${s}) rotate(${r}deg)`;
  return [
    { offset: 0, transform: at(dx, dy, 1, 0), opacity: 1, easing: "ease-out" },
    { offset: 0.12, transform: at(dx, dy - 6, 1.04, -1.2), opacity: 0.55, easing: BRAKE },
    { offset: 0.86, transform: at(0, -2, 1.04, 0), opacity: 0.6, easing: "ease-in-out" },
    { offset: 1, transform: at(0, 0, 1, 0), opacity: 1 },
  ];
}

// Redraw and animate every card from its old place. Returns `moved` (a promise for the end of the
// motion, or null when nothing moved) and whether any card was ringed as changed.
function render({ duration = 1000, focus = null } = {}) {
  const before = cardRects();
  const was = seen;
  const first = was.size === 0;
  draw();
  if (first) return { moved: null, flashed: false };
  const after = cardRects();
  const still = reducedMotion.matches;
  const layer = el("div", { class: "flip-layer", "aria-hidden": "true" });
  const runs = [];
  let flashed = false;
  let i = 0;
  const order = [...after].sort(([, a], [, b]) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  for (const [key, cur] of order) {
    const old = before.get(key);
    const changed = !old || was.get(key) !== seen.get(key);
    if (changed) {
      cur.node.classList.add("flash");
      flashed = true;
    }
    if (still) continue;
    if (!old) {
      runs.push(cur.node.animate([{ opacity: 0, transform: "translateY(10px) scale(.97)" }, { opacity: 1, transform: "none" }],
        { duration: duration * 0.6, delay: duration * 0.35, easing: EASE, fill: "backwards" }));
      continue;
    }
    const dx = old.rect.left - cur.rect.left;
    const dy = old.rect.top - cur.rect.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    // The card that changed is dragged: lifted, half see-through, braking into its new place, then set down.
    // The ones making room slide once it is on its way.
    const dragged = changed || key === focus;
    const frames = dragged ? dragFrames(dx, dy) : [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }];
    const opts = dragged
      ? { duration, fill: "backwards" }
      : { duration: duration * 0.7, delay: duration * 0.12 + Math.min(++i * 25, 150), easing: EASE, fill: "backwards" };
    if (dragged) cur.node.classList.add("dragging");
    if (old.lane === cur.lane) {
      // Lift a moving card over the ones it passes; the dragged card rides above the ones making room.
      cur.node.style.zIndex = dragged ? "2" : "1";
      const a = cur.node.animate(frames, opts);
      a.finished.finally(() => { cur.node.style.zIndex = ""; cur.node.classList.remove("dragging"); });
      runs.push(a);
    } else {
      const g = ghost(layer, cur.node, cur.rect);
      cur.node.style.visibility = "hidden";
      const a = g.animate(frames, opts);
      a.finished.finally(() => { cur.node.style.visibility = ""; cur.node.classList.remove("dragging"); g.remove(); });
      runs.push(a);
    }
  }
  if (!still) {
    for (const [key, old] of before) {
      if (after.has(key)) continue;
      const g = ghost(layer, old.node, old.rect);
      const spot = landingSpot(key)?.getBoundingClientRect();
      const to = spot
        ? `translate(${spot.left + spot.width / 2 - (old.rect.left + old.rect.width / 2)}px, ${spot.top + spot.height / 2 - (old.rect.top + old.rect.height / 2)}px) scale(.3)`
        : "scale(.94)";
      const a = g.animate([{ opacity: 1, transform: "none" }, { opacity: 0.55, transform: "translateY(-4px) scale(1.03)", offset: 0.15 }, { opacity: 0, transform: to }],
        { duration, easing: BRAKE, fill: "forwards" });
      a.finished.finally(() => g.remove());
      runs.push(a);
    }
  }
  if (!runs.length) return { moved: null, flashed };
  document.body.append(layer);
  return { moved: Promise.allSettled(runs.map((a) => a.finished)).then(() => layer.remove()), flashed };
}

$("search").addEventListener("input", (e) => { state.query = e.target.value.trim().toLowerCase(); render(); });
$("stale").addEventListener("change", (e) => { state.showStale = e.target.checked; render(); });
$("flat").addEventListener("change", (e) => { state.flat = e.target.checked; render(); });
$("close").addEventListener("click", () => { state.open = null; $("drawer").hidden = true; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("close").click(); });
setInterval(scheduleRender, 30000);

const { columns, tasks } = await api("api/tasks");
state.columns = columns;
for (const t of tasks) state.tasks.set(t.key, t);
render();
connect();
