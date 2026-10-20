const SOURCE_COLORS = {
  "claude-code": "#d97757", "claude-chat": "#c96442", codex: "#10a37f", chatgpt: "#0f8f6f",
  cursor: "#3b3b3b", "cursor-cli": "#555", "cursor-cloud": "#6b5bd6", "grok-bot": "#111827", "grok-chat": "#374151",
};
const STATUS_LABEL = { queued: "Queued", running: "Running", waiting: "Needs you", review: "Review", done: "Done", failed: "Failed" };

const params = new URLSearchParams(location.search);
let token = params.get("token");
try {
  if (token) localStorage.setItem("akb-token", token);
  else token = localStorage.getItem("akb-token");
} catch {}
const withToken = (u) => (token ? `${u}${u.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : u);

const state = { tasks: new Map(), columns: [], hidden: new Set(), query: "", flat: false, open: null };
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
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
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

function matches(t) {
  if (state.hidden.has(t.source)) return false;
  if (!state.query) return true;
  const hay = `${t.title} ${t.summary || ""} ${t.source} ${t.cwd || ""}`.toLowerCase();
  return hay.includes(state.query);
}

function badge(source) {
  return el("span", { class: "badge", style: `--b:${SOURCE_COLORS[source] || "#64748b"}` }, source);
}

function tree(key, depth = 0) {
  const kids = childrenOf(key);
  if (!kids.length || depth > 6) return null;
  return el("ul", { class: "tree" }, kids.map((c) =>
    el("li", {},
      el("div", { class: "row", title: c.summary || c.title, onclick: (e) => { e.stopPropagation(); openTask(c.key); } },
        el("span", { class: `sdot ${c.status}`, style: `--c:var(--${c.status})` }),
        el("span", { class: "name" }, c.title),
        el("span", { class: "src", title: STATUS_LABEL[c.status] }, c.source)),
      tree(c.key, depth + 1))));
}

function card(t) {
  const desc = descendants(t.key);
  const counts = {};
  for (const d of desc) counts[d.status] = (counts[d.status] || 0) + 1;
  const attention = t.status !== "waiting" && desc.some((d) => d.status === "waiting");
  const last = t.events?.at(-1)?.message;
  const parent = state.flat && t.parentKey ? state.tasks.get(t.parentKey) : null;
  return el("article", { class: `card${attention ? " attention" : ""}`, style: `--c:var(--${t.status})`, onclick: () => openTask(t.key) },
    el("div", { class: "top" }, badge(t.source), t.kind && el("span", {}, t.kind), el("span", { class: "time", title: t.updatedAt }, ago(t.updatedAt))),
    parent && el("div", { class: "last" }, `↳ ${parent.title}`),
    el("div", { class: "title" }, t.title),
    t.summary && el("div", { class: "summary" }, t.summary),
    last && last !== t.summary && el("div", { class: "last", title: last }, last),
    desc.length > 0 && el("div", { class: "rollup" }, Object.entries(counts).map(([s, n]) => el("span", { class: "pill", style: `--c:var(--${s})` }, `${n} ${STATUS_LABEL[s]}`))),
    !state.flat && tree(t.key));
}

function renderSources() {
  const sources = [...new Set([...state.tasks.values()].map((t) => t.source))].sort();
  $("sources").replaceChildren(...sources.map((s) =>
    el("button", { class: "chip", "aria-pressed": String(!state.hidden.has(s)), onclick: () => { state.hidden.has(s) ? state.hidden.delete(s) : state.hidden.add(s); render(); } }, s)));
}

function render() {
  renderSources();
  const visible = [...state.tasks.values()].filter((t) => (state.flat || isRoot(t)) && matches(t));
  visible.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  $("board").replaceChildren(...state.columns.map((col) => {
    const cards = visible.filter((t) => t.status === col.id);
    return el("section", { class: "column" },
      el("h2", {}, el("span", {}, el("span", { class: "dot", style: `background:var(--${col.id})` }), col.label), el("span", {}, cards.length)),
      cards.length ? cards.map(card) : el("div", { class: "empty" }, "—"));
  }));
  if (state.open) renderDetail();
}

async function api(path, opts) {
  const res = await fetch(withToken(path), opts);
  if (res.status === 401) {
    const t = prompt("Board token (AKB_TOKEN):");
    if (t) {
      token = t;
      try { localStorage.setItem("akb-token", t); } catch {}
      return api(path, opts);
    }
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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
  const meta = [["Status", STATUS_LABEL[t.status]], ["Source", t.source], ["Kind", t.kind], ["Key", t.key], ["Folder", t.cwd],
    ["Started", t.startedAt && new Date(t.startedAt).toLocaleString()], ["Updated", new Date(t.updatedAt).toLocaleString()],
    ...Object.entries(t.meta || {}).filter(([, v]) => v != null && typeof v !== "object").map(([k, v]) => [k, String(v)])].filter(([, v]) => v);
  const links = [...(t.url ? [{ url: t.url, label: "Open" }] : []), ...(t.links || [])];
  $("detail").replaceChildren(...[
    el("div", {}, badge(t.source)),
    el("h3", {}, t.title),
    parent && el("div", { class: "last" }, "Part of ", el("a", { href: "#", onclick: (e) => { e.preventDefault(); openTask(parent.key); } }, parent.title)),
    t.summary && el("p", {}, t.summary),
    links.length > 0 && el("div", { class: "links" }, links.map((l) => el("a", { href: l.url, target: "_blank", rel: "noopener noreferrer" }, l.label || l.url))),
    el("div", { class: "meta" }, meta.flatMap(([k, v]) => [el("span", {}, k), el("span", {}, v)])),
    childrenOf(t.key).length > 0 && el("section", {}, el("h4", {}, "Nested activity"), tree(t.key)),
    el("section", {}, el("h4", {}, "Timeline"),
      el("ul", { class: "timeline" }, [...(t.events || [])].reverse().map((e) =>
        el("li", {}, el("span", { class: "sdot", style: `--c:var(--${e.status || "queued"})`, title: e.status || "" }),
          el("time", { title: e.at }, new Date(e.at).toLocaleTimeString()),
          el("span", {}, e.message || STATUS_LABEL[e.status] || ""))))),
    el("button", { class: "danger", onclick: async () => {
      if (!confirm("Remove this card and its nested activity from the board?")) return;
      await api(`api/tasks/${encodeURIComponent(t.key)}`, { method: "DELETE" });
    } }, "Remove from board"),
  ].filter((n) => n instanceof Node));
}

function connect() {
  const es = new EventSource(withToken("api/stream"));
  es.onopen = () => $("conn").classList.add("live");
  es.onerror = () => $("conn").classList.remove("live");
  es.addEventListener("task", (e) => {
    const t = JSON.parse(e.data);
    const prev = state.tasks.get(t.key);
    // Stream frames carry recent events only; keep the full timeline if the drawer loaded it.
    if (prev?.events?.length > t.events.length && state.open === t.key) t.events = mergeEvents(prev.events, t.events);
    state.tasks.set(t.key, t);
    scheduleRender();
  });
  es.addEventListener("remove", (e) => {
    for (const k of JSON.parse(e.data)) state.tasks.delete(k);
    scheduleRender();
  });
}

function mergeEvents(a, b) {
  const seen = new Set(a.map((e) => e.id));
  return [...a, ...b.filter((e) => !seen.has(e.id))];
}

let pending = false;
function scheduleRender() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; render(); });
}

$("search").addEventListener("input", (e) => { state.query = e.target.value.trim().toLowerCase(); render(); });
$("flat").addEventListener("change", (e) => { state.flat = e.target.checked; render(); });
$("close").addEventListener("click", () => { state.open = null; $("drawer").hidden = true; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("close").click(); });
setInterval(render, 30000);

const { columns, tasks } = await api("api/tasks");
state.columns = columns;
for (const t of tasks) state.tasks.set(t.key, t);
render();
connect();
