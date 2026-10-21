import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { Store, parseRef, publicTask } from "./store.js";
import { COLUMNS, TERMINAL } from "./status.js";
import { handleMcp } from "./mcp.js";
import { matchSourceToken, parseSourceTokens } from "./source-tokens.js";
import { cursorAgentEvent, verifyCursorWebhook, createCursorCloudPoller } from "./pollers/cursor-cloud.js";
import { createGrokRelayPoller } from "./pollers/grok-relay.js";
import { createSessionSweeper } from "./pollers/session-sweep.js";
import {
  createWecomClient,
  isWecomWired,
  loadWecomConfig,
  wecomSecretPath,
  writeWecomSecret,
} from "./wecom.js";
import { createOauth } from "./oauth.js";
import {
  SESSION_COOKIE,
  STATE_COOKIE,
  SESSION_TTL_MS,
  STATE_TTL_MS,
  clearCookieHeader,
  cookieHeader,
  issueSession,
  issueState,
  parseCookies,
  verifyPayload,
  verifySession,
  verifyState,
} from "./session.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const STATIC = { "/": "index.html", "/app.js": "app.js", "/timeline.js": "timeline.js", "/style.css": "style.css" };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const MAX_BODY = 1024 * 1024;

function send(res, status, body, headers = {}) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(text);
}

function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(buf) {
  try {
    return JSON.parse(buf.toString("utf8") || "null");
  } catch {
    throw Object.assign(new Error("invalid JSON"), { status: 400 });
  }
}

function tokenOk(req, url, token) {
  if (!token) return false;
  const header = req.headers.authorization || "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token") || "";
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Browsers attach Origin; refuse cross-site writes so a random web page cannot edit the board.
function originOk(req) {
  const origin = req.headers.origin;
  if (!origin || origin === "null") return !origin;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function keyLabel(principal) {
  return principal.agentName ? `${principal.source}@${principal.agentName}` : principal.source;
}

// A per-source key on /api/events (hooks in cloud sessions, where AKB_TOKEN must not live).
// It may only write its own source's cards (and its bot's, when bound), never a card created
// through MCP, and cannot set created_by. Returns the event to apply, or throws with the reason.
export function scopeEventToKey(ev, principal, store) {
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) throw new Error("event must be an object");
  const ref = parseRef(ev.key) || parseRef({ source: ev.source, external_id: ev.external_id ?? ev.externalId });
  if (!ref) throw new Error("event needs source and external_id (or key)");
  const allowed = (r) => r.source === principal.source;
  if (!allowed(ref)) throw new Error(`this key reports as source "${principal.source}"`);
  if (principal.agentName && ev.agent_name != null && ev.agent_name !== principal.agentName) {
    throw new Error(`this key reports as agent "${principal.agentName}"`);
  }
  // A bot-bound key writes only cards already carrying its bot name; it may nest under its
  // source's unassigned cards (e.g. a relay task) without changing them.
  const ownBot = (t) => !principal.agentName || t.agentName === principal.agentName;
  const nestable = (t) => !principal.agentName || !t.agentName || t.agentName === principal.agentName;
  // Same trimming as store.apply, so the card checked here is the card that gets written.
  const key = `${ref.source}:${String(ref.externalId).trim().slice(0, 200)}`;
  const card = store.get(key);
  if (card && (card.createdBy || !ownBot(card))) throw new Error(`card ${key} is not writable with this key`);
  if (ev.parent != null) {
    const parent = parseRef(ev.parent);
    const parentCard = parent && store.get(`${parent.source}:${parent.externalId}`);
    if (!parent || !allowed(parent) || (parentCard && !nestable(parentCard))) {
      throw new Error(`parent must be a "${principal.source}" card`);
    }
  }
  const out = { ...ev };
  delete out.created_by;
  if (principal.agentName) out.agent_name = principal.agentName;
  return out;
}

/** next must be a path under base (e.g. /kanban/...); reject open redirects. */
export function safeNextPath(next, base) {
  const fallback = base ? `${base}/` : "/";
  if (next == null || next === "") return fallback;
  const n = String(next);
  if (!n.startsWith("/") || n.startsWith("//") || n.includes("://") || n.includes("\\") || n.includes("..")) {
    return fallback;
  }
  if (!base) return n;
  if (n === base || n === `${base}/` || n.startsWith(`${base}/`)) return n;
  return fallback;
}

function dataDirFromStore(store) {
  if (store?.file) return path.dirname(store.file);
  return null;
}

function setupWecomFormHtml({ locked, result } = {}) {
  const notice = locked
    ? `<p class="warn">Already configured (locked). Delete wecom.json on the server to re-enter.</p>`
    : `<p>Open this page without putting the board token in the URL. Enter <code>AKB_TOKEN</code> and the Agent Kanban (1000030) Secret below. The secret is written once and never shown again.</p>`;
  const form = locked
    ? ""
    : `<form method="POST" action="">
        <label>Board token (AKB_TOKEN) <input type="password" name="token" autocomplete="off" required></label>
        <label>WeCom Secret <input type="password" name="secret" autocomplete="off" required></label>
        <button type="submit">Save &amp; verify</button>
      </form>`;
  const resultBlock = result
    ? `<pre class="result">errcode: ${escapeHtml(String(result.errcode))}\nerrmsg: ${escapeHtml(String(result.errmsg ?? ""))}</pre>`
    : "";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WeCom setup</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:28rem;margin:2rem auto;padding:0 1rem;line-height:1.5}
  input{display:block;width:100%;margin:.5rem 0 1rem;padding:.5rem}
  .warn{color:#b45309}.result{background:#f1f5f9;padding:.75rem;overflow:auto}
</style></head><body>
<h1>WeCom secret setup</h1>
${notice}
${form}
${resultBlock}
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// basePath serves the board under a sub-path, e.g. "/kanban" behind relay.example.com/kanban.
export function createServer({
  store = new Store(),
  token = process.env.AKB_TOKEN,
  sourceTokens = process.env.AKB_SOURCE_TOKENS,
  cursorWebhookSecret = process.env.CURSOR_WEBHOOK_SECRET,
  basePath = process.env.AKB_BASE_PATH,
  env = process.env,
  fetchImpl = globalThis.fetch,
  dataDir = dataDirFromStore(store) || env.AKB_DATA_DIR || null,
  oauthNow,
} = {}) {
  const base = (basePath || "").replace(/\/+$/, "");
  // Per-source keys: hashes only, MCP only. Bad config fails at startup rather than silently.
  const sourceEntries = parseSourceTokens(sourceTokens);
  // OAuth for clients that cannot send a static Bearer (claude.ai / Claude iOS). Fail closed:
  // a missing public URL or unreadable oauth state disables these routes (503) and leaves
  // static Bearer keys on the path below unchanged.
  const oauth = createOauth({
    dataDir,
    publicUrl: env.AKB_PUBLIC_URL,
    sourceEntries,
    env,
    now: oauthNow,
  });
  const clients = new Set();
  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  };
  store.on("change", (task) => broadcast("task", { ...publicTask(task), events: task.events.slice(-5) }));
  store.on("remove", (keys) => broadcast("remove", keys));
  const heartbeat = setInterval(() => broadcast("ping", Date.now()), 25000);
  heartbeat.unref();

  let wecomClient = null;
  let wecomClientKey = "";

  function currentConfig() {
    return loadWecomConfig({ env, dataDir });
  }

  function wired() {
    return isWecomWired(currentConfig());
  }

  function getWecom() {
    const cfg = currentConfig();
    if (!isWecomWired(cfg)) return null;
    const key = `${cfg.corpId}\0${cfg.agentId}\0${cfg.secret}\0${cfg.publicUrl}`;
    if (!wecomClient || wecomClientKey !== key) {
      wecomClient = createWecomClient({
        corpId: cfg.corpId,
        agentId: cfg.agentId,
        secret: cfg.secret,
        publicUrl: cfg.publicUrl,
        fetchImpl,
      });
      wecomClientKey = key;
    }
    return wecomClient;
  }

  /**
   * Session auth: valid HMAC cookie AND WeCom still wired AND uid still allowlisted.
   * Re-checked on every request (revokes cookies if CorpID/users/secret wiring changes).
   */
  function sessionOk(req) {
    const cfg = currentConfig();
    if (!isWecomWired(cfg) || !cfg.users.length) return null;
    const cookies = parseCookies(req.headers.cookie);
    const payload = verifySession(cfg.sessionSecret, cookies[SESSION_COOKIE]);
    if (!payload || !cfg.users.includes(payload.uid)) return null;
    return payload;
  }

  function authOk(req, url) {
    return tokenOk(req, url, token) || Boolean(sessionOk(req));
  }

  function cookiePathOpts() {
    return { basePath: base || "/" };
  }

  // principal: null for AKB_TOKEN / board login, or { source, agentName } for a per-source key.
  async function applyEvents(req, res, principal) {
    const body = parseJson(await readBody(req));
    const events = Array.isArray(body) ? body : [body];
    const results = [];
    for (const ev of events) {
      try {
        const scoped = principal ? scopeEventToKey(ev, principal, store) : ev;
        // choice_resolved via events is always chat; never honor a forged source:"board".
        // choice_by is server-set — ignore any caller-provided value.
        const event = scoped && typeof scoped === "object" && scoped.choice_resolved && typeof scoped.choice_resolved === "object"
          ? {
              ...scoped,
              choice_resolved: { value: scoped.choice_resolved.value },
              choice_by: principal ? keyLabel(principal) : "events",
            }
          : scoped;
        const { task, choice_rejected, skipped, key: skippedKey } = store.apply(event);
        if (skipped) {
          results.push({ ok: true, key: skippedKey, skipped: true });
        } else if (choice_rejected) {
          results.push({
            ok: false,
            key: task.key,
            status: task.status,
            error: choice_rejected.reason,
            choice_rejected,
          });
        } else {
          results.push({ ok: true, key: task.key, status: task.status });
        }
      } catch (err) {
        results.push({ ok: false, error: err.message });
      }
    }
    if (!Array.isArray(body) && results[0]?.choice_rejected) {
      return send(res, results[0].choice_rejected.status, results[0]);
    }
    const status = results.every((r) => r.ok) ? 200 : results.some((r) => r.ok) ? 207 : 400;
    return send(res, status, Array.isArray(body) ? { results } : results[0]);
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url || "/", "http://localhost");
    } catch {
      return send(res, 400, { error: "bad request" });
    }
    if (base) {
      // The page uses relative URLs, so it must be loaded with the trailing slash.
      if (url.pathname === base) {
        res.writeHead(301, { location: `${base}/${url.search}` });
        return res.end();
      }
      if (url.pathname.startsWith(`${base}/`)) url.pathname = url.pathname.slice(base.length);
      else if (url.pathname !== "/health") return send(res, 404, { error: "not found" });
    }
    try {
      if (url.pathname === "/health") {
        return send(res, 200, { ok: true, tasks: store.tasks.size });
      }

      if (await oauth.handle(req, res, url, {
        base,
        send,
        sendHtml,
        readBody,
        session: () => sessionOk(req),
        wecomWired: wired(),
      })) return;

      // --- WeCom OAuth (no board auth required) ---
      if (url.pathname === "/auth/wecom/start" && req.method === "GET") {
        const cfg = currentConfig();
        const client = getWecom();
        if (!client || !cfg.sessionSecret) return send(res, 503, { error: "wecom not configured" });
        const rawNext = url.searchParams.get("next");
        const safe = rawNext ? safeNextPath(rawNext, base) : "";
        const keep = rawNext && safe === rawNext ? rawNext : "";
        const { state, cookie } = issueState(cfg.sessionSecret, keep || undefined);
        const location = client.authorizeUrl(state, { inWecom: /\bwxwork\//i.test(req.headers["user-agent"] || "") });
        res.writeHead(302, {
          location,
          "set-cookie": cookieHeader(STATE_COOKIE, cookie, { ...cookiePathOpts(), maxAge: STATE_TTL_MS / 1000 }),
          "cache-control": "no-store",
        });
        return res.end();
      }

      if (url.pathname === "/auth/wecom/callback" && req.method === "GET") {
        const cfg = currentConfig();
        const client = getWecom();
        if (!client || !cfg.sessionSecret) return send(res, 503, { error: "wecom not configured" });
        const state = url.searchParams.get("state") || "";
        const code = url.searchParams.get("code") || "";
        const cookies = parseCookies(req.headers.cookie);
        if (!state || !verifyState(cfg.sessionSecret, cookies[STATE_COOKIE], state)) {
          return sendHtml(res, 400, "<!doctype html><title>Bad state</title><p>Invalid or expired OAuth state.</p>");
        }
        const statePayload = verifyPayload(cfg.sessionSecret, cookies[STATE_COOKIE]);
        const next = url.searchParams.has("next")
          ? safeNextPath(url.searchParams.get("next"), base)
          : safeNextPath(statePayload?.n, base);
        let userid;
        try {
          userid = await client.getuserinfo(code);
        } catch (err) {
          const errcode = err.errcode != null ? ` errcode=${err.errcode}` : "";
          return sendHtml(
            res,
            502,
            `<!doctype html><title>WeCom error</title><p>Could not resolve userid.${escapeHtml(errcode)}</p>`,
            { "set-cookie": clearCookieHeader(STATE_COOKIE, cookiePathOpts()) },
          );
        }
        if (!cfg.users.includes(userid)) {
          return sendHtml(res, 403, "<!doctype html><title>Forbidden</title><p>User not allowlisted.</p>", {
            "set-cookie": clearCookieHeader(STATE_COOKIE, cookiePathOpts()),
          });
        }
        const session = issueSession(cfg.sessionSecret, userid);
        // Default home is {base}/; `next` is honored only when it stays under the base prefix.
        // `next` comes from the query string or, when WeCom dropped it, from the signed state cookie.
        const location = url.searchParams.has("next") || statePayload?.n ? next : (base ? `${base}/` : "/");
        res.writeHead(302, {
          location,
          "set-cookie": [
            cookieHeader(SESSION_COOKIE, session, { ...cookiePathOpts(), maxAge: SESSION_TTL_MS / 1000 }),
            clearCookieHeader(STATE_COOKIE, cookiePathOpts()),
          ],
          "cache-control": "no-store",
        });
        return res.end();
      }

      if (url.pathname === "/auth/logout" && req.method === "POST") {
        if (!originOk(req)) return send(res, 403, { error: "cross-origin write refused" });
        res.writeHead(204, {
          "set-cookie": clearCookieHeader(SESSION_COOKIE, cookiePathOpts()),
          "cache-control": "no-store",
        });
        return res.end();
      }

      // Setup page: GET is public (enter token in the form). POST accepts token via form/JSON/Bearer/?token=.
      if (url.pathname === "/setup/wecom" && (req.method === "GET" || req.method === "POST")) {
        if (!dataDir) return send(res, 500, { error: "AKB_DATA_DIR not configured" });
        const locked = fs.existsSync(wecomSecretPath(dataDir));
        if (req.method === "GET") {
          return sendHtml(res, 200, setupWecomFormHtml({ locked }));
        }
        const raw = await readBody(req);
        const ct = req.headers["content-type"] || "";
        let secret = "";
        let formToken = "";
        if (ct.includes("application/json")) {
          const body = parseJson(raw);
          secret = body?.secret != null ? String(body.secret) : "";
          formToken = body?.token != null ? String(body.token) : "";
        } else {
          const params = new URLSearchParams(raw.toString("utf8"));
          secret = params.get("secret") || "";
          formToken = params.get("token") || "";
        }
        // Prefer form/JSON token so the URL never needs ?token=.
        const authed = formToken
          ? (() => {
              if (!token) return false;
              const a = Buffer.from(formToken);
              const b = Buffer.from(token);
              return a.length === b.length && timingSafeEqual(a, b);
            })()
          : tokenOk(req, url, token);
        if (!authed) {
          return sendHtml(res, 401, setupWecomFormHtml({ locked, result: { errcode: "unauthorized", errmsg: "bad or missing board token" } }));
        }
        if (locked) {
          return sendHtml(res, 409, setupWecomFormHtml({ locked: true, result: { errcode: "locked", errmsg: "wecom.json already exists" } }));
        }
        if (!secret.trim()) {
          return sendHtml(res, 400, setupWecomFormHtml({ locked: false, result: { errcode: "missing", errmsg: "secret required" } }));
        }
        try {
          writeWecomSecret(dataDir, secret.trim());
        } catch (err) {
          if (err.code === "EEXIST") {
            return sendHtml(res, 409, setupWecomFormHtml({ locked: true, result: { errcode: "locked", errmsg: "wecom.json already exists" } }));
          }
          throw err;
        }
        wecomClient = null;
        wecomClientKey = "";
        // Self-check gettoken with the just-written secret (env still wins if set).
        const cfg = currentConfig();
        let result = { errcode: 0, errmsg: "ok" };
        if (cfg.corpId && cfg.secret) {
          const probe = createWecomClient({
            corpId: cfg.corpId,
            agentId: cfg.agentId || "0",
            secret: cfg.secret,
            publicUrl: cfg.publicUrl || "https://example.invalid",
            fetchImpl,
          });
          try {
            await probe.gettoken();
            result = { errcode: 0, errmsg: "ok" };
          } catch (err) {
            result = { errcode: err.errcode ?? "error", errmsg: err.errmsg || "gettoken failed" };
          }
        } else {
          result = { errcode: "incomplete", errmsg: "saved; set AKB_WECOM_CORP_ID / AGENT_ID to verify" };
        }
        return sendHtml(res, 200, setupWecomFormHtml({ locked: true, result }));
      }

      if (req.method === "GET" && STATIC[url.pathname]) {
        // In WeCom, unauthenticated board root → silent OAuth.
        if (url.pathname === "/" && wired() && !sessionOk(req) && !tokenOk(req, url, token)) {
          const ua = String(req.headers["user-agent"] || "");
          if (/wxwork/i.test(ua)) {
            res.writeHead(302, { location: `${base}/auth/wecom/start`, "cache-control": "no-store" });
            return res.end();
          }
        }
        const file = path.join(PUBLIC_DIR, STATIC[url.pathname]);
        res.writeHead(200, { "content-type": TYPES[path.extname(file)], "cache-control": "no-cache" });
        return fs.createReadStream(file).pipe(res);
      }

      if (url.pathname === "/webhooks/cursor" && req.method === "POST") {
        const raw = await readBody(req);
        // With a webhook secret, require a valid HMAC. Without one, require AKB_TOKEN (fail closed if that is also empty).
        if (cursorWebhookSecret) {
          if (!verifyCursorWebhook(raw, req.headers["x-webhook-signature"], cursorWebhookSecret)) return send(res, 401, { error: "bad signature" });
        } else if (!tokenOk(req, url, token)) {
          return send(res, 401, { error: "unauthorized" });
        }
        const ev = cursorAgentEvent(parseJson(raw));
        if (ev) store.apply(ev);
        return send(res, 200, { ok: true });
      }

      // MCP also accepts per-source keys (Authorization header only); they report as their bound source.
      // Static AKB_TOKEN / session / AKB_SOURCE_TOKENS are checked first and keep their old principal.
      // An OAuth access token is a third Bearer, equivalent to the source key it was consented as.
      if (url.pathname === "/mcp") {
        let principal = authOk(req, url) ? undefined : null;
        if (principal === null) {
          const header = req.headers.authorization || "";
          const given = header.startsWith("Bearer ") ? header.slice(7) : "";
          const entry = given ? matchSourceToken(given, sourceEntries) : null;
          if (entry) principal = { source: entry.source, agentName: entry.agentName };
          else {
            const viaOauth = given ? oauth.principalForBearer(given) : null;
            if (viaOauth) principal = viaOauth;
            else return send(res, 401, { error: "unauthorized" }, oauth.unauthorizedHeaders());
          }
        }
        if (req.method !== "GET" && !originOk(req)) return send(res, 403, { error: "cross-origin write refused" });
        if (req.method !== "POST") return send(res, 405, { error: "POST JSON-RPC messages to /mcp" }, { allow: "POST" });
        const msg = parseJson(await readBody(req));
        if (Array.isArray(msg)) {
          const out = msg.map((m) => handleMcp(store, m, principal)).filter(Boolean);
          return out.length ? send(res, 200, out) : send(res, 202);
        }
        const out = handleMcp(store, msg, principal);
        return out ? send(res, 200, out) : send(res, 202);
      }

      // Hooks may also post events with a per-source key (Authorization header only), scoped to
      // that source. Every other /api route still needs AKB_TOKEN or a board login.
      if (url.pathname === "/api/events" && req.method === "POST" && !authOk(req, url)) {
        const header = req.headers.authorization || "";
        const entry = header.startsWith("Bearer ") ? matchSourceToken(header.slice(7), sourceEntries) : null;
        if (!entry) return send(res, 401, { error: "unauthorized" });
        if (!originOk(req)) return send(res, 403, { error: "cross-origin write refused" });
        return applyEvents(req, res, { source: entry.source, agentName: entry.agentName });
      }

      if (!authOk(req, url)) return send(res, 401, { error: "unauthorized" });
      if (req.method !== "GET" && !originOk(req)) return send(res, 403, { error: "cross-origin write refused" });

      if (url.pathname === "/api/stream" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": connected\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }

      if (url.pathname === "/api/tasks" && req.method === "GET") {
        const tasks = store.list({ status: url.searchParams.get("status") || undefined, source: url.searchParams.get("source") || undefined });
        return send(res, 200, {
          columns: COLUMNS,
          tasks: tasks.map((t) => ({ ...publicTask(t), events: t.events.slice(-5) })),
          wecom_wired: wired(),
        });
      }

      // Get update: record the ask on the card. Agents read it through MCP and answer with a brief;
      // the board itself never contacts the agent or the relay.
      const ask = url.pathname.match(/^\/api\/tasks\/([^/]+)\/update-request$/);
      if (ask) {
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }, { allow: "POST" });
        const key = decodeURIComponent(ask[1]);
        const task = store.get(key);
        if (!task) return send(res, 404, { error: "not found" });
        if (TERMINAL.has(task.status)) return send(res, 409, { error: `task is ${task.status}` });
        if (task.placeholder) return send(res, 409, { error: "this card only groups other tasks; ask one of them" });
        store.requestUpdate(key, { by: sessionOk(req)?.uid });
        return send(res, 200, { ok: true, updateRequest: task.updateRequest });
      }

      // Needs-you option click: record the choice on the card. Opening bots poll via kanban_get_choice;
      // the board never POSTs to the relay or any agent. Only this path may write choice.source "board".
      const choose = url.pathname.match(/^\/api\/tasks\/([^/]+)\/choice$/);
      if (choose) {
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }, { allow: "POST" });
        const key = decodeURIComponent(choose[1]);
        if (!store.get(key)) return send(res, 404, { error: "not found" });
        const body = parseJson(await readBody(req));
        if (body?.value != null && typeof body.value !== "string") {
          return send(res, 400, { error: "value must be a string" });
        }
        const session = sessionOk(req);
        const by = session?.uid || (tokenOk(req, url, token) ? "admin-token" : null);
        const result = store.recordChoice(key, { value: body?.value, by });
        if (result.error) return send(res, result.status, { error: result.error });
        return send(res, 200, { ok: true, choice: store.get(key).choice, changed: result.changed });
      }

      // 我确认已完成 / 已放弃 on a card the agent left open. Board-only; the relay is never written.
      const close = url.pathname.match(/^\/api\/tasks\/([^/]+)\/close$/);
      if (close) {
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }, { allow: "POST" });
        const body = parseJson(await readBody(req));
        const by = sessionOk(req)?.uid || (tokenOk(req, url, token) ? "admin-token" : null);
        const result = store.closeByBoard(decodeURIComponent(close[1]), { status: body?.status, by });
        if (result.error) return send(res, result.status, { error: result.error });
        return send(res, 200, { ok: true, status: result.task.status });
      }

      const one = url.pathname.match(/^\/api\/tasks\/(.+)$/);
      if (one) {
        const key = decodeURIComponent(one[1]);
        if (req.method === "GET") {
          const task = store.get(key);
          return task ? send(res, 200, { task: publicTask(task), children: store.children(key).map((t) => publicTask(t, { events: false })) }) : send(res, 404, { error: "not found" });
        }
        if (req.method === "DELETE") return store.remove(key) ? send(res, 200, { ok: true }) : send(res, 404, { error: "not found" });
        return send(res, 405, { error: "method not allowed" });
      }

      if (url.pathname === "/api/events" && req.method === "POST") {
        return applyEvents(req, res, null);
      }

      return send(res, 404, { error: "not found" });
    } catch (err) {
      return send(res, err.status || 500, { error: err.message });
    }
  });
  server.on("close", () => {
    clearInterval(heartbeat);
    for (const res of clients) res.end();
  });
  return server;
}

// Runs each poller now and every `intervalMs`; logs a failure once until it recovers.
export function startPollers(pollers, intervalMs, log = console) {
  const timers = [];
  for (const p of pollers) {
    let failing = false;
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      try {
        await p.poll();
        if (failing) log.error(`[akb] ${p.name} recovered`);
        failing = false;
      } catch (err) {
        if (!failing) log.error(`[akb] ${p.name} poll failed: ${err.message}`);
        failing = true;
      } finally {
        running = false;
      }
    };
    run();
    const t = setInterval(run, intervalMs);
    t.unref?.();
    timers.push(t);
  }
  return () => timers.forEach(clearInterval);
}

export function pollersFromEnv(store, env = process.env) {
  // Always on: closes hook session cards nobody has talked to for hours (AKB_SESSION_QUIET_HOURS, default 6; 0 turns it off).
  const quietHours = env.AKB_SESSION_QUIET_HOURS == null || env.AKB_SESSION_QUIET_HOURS === "" ? 6 : Number(env.AKB_SESSION_QUIET_HOURS);
  const pollers = quietHours > 0 ? [createSessionSweeper({ store, quietMs: quietHours * 3600 * 1000 })] : [];
  const cursorKey = env.CURSOR_API_KEY;
  if (cursorKey) pollers.push(createCursorCloudPoller({ store, apiKey: cursorKey }));
  if (env.GROK_RELAY_URL && env.GROK_RELAY_KEYS) {
    pollers.push(createGrokRelayPoller({
      store,
      baseUrl: env.GROK_RELAY_URL,
      keys: env.GROK_RELAY_KEYS.split(",").map((s) => s.trim()).filter(Boolean),
      // Without our own Cursor poller, Grok Bot's result is the best signal for the agents it launched.
      closeCursorChildren: !cursorKey,
    }));
  }
  return pollers;
}
