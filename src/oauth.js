import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hashToken, matchSourceToken } from "./source-tokens.js";
import { clearCookieHeader, cookieHeader, parseCookies, signPayload, verifyPayload } from "./session.js";
import { isWecomWired, loadWecomConfig } from "./wecom.js";

// OAuth 2.1 for MCP clients that cannot send a static Bearer (claude.ai, Claude iOS, ChatGPT).
// Everything lives under /kanban so the relay's own OAuth page at the domain root is not involved.
// Tokens are opaque; only sha256 hashes are stored. oauth.json sits next to state.json and is the
// only file this module writes. Pending consent requests stay in memory. If the signing key or
// oauth.json cannot be loaded, ready is false: these routes return 503 and static Bearer keys
// keep working.

export const OAUTH_CSRF_COOKIE = "akb_oauth_csrf";
export const DEFAULT_REDIRECTS = Object.freeze([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  // ChatGPT (developer-mode apps) and Codex use this one only when the authorization response
  // carries `iss` (RFC 9207, see serverMetadata); otherwise they fall back to a per-app callback URL.
  "https://chatgpt.com/connector_platform_oauth_redirect",
]);

const CODE_TTL_MS = 60 * 1000;
const CODE_KEEP_MS = 10 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
// Absolute grant lifetime, measured from consent. Refresh rotates tokens but does not extend this.
const GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const VERIFIER_RE = /^[\w.~-]{43,128}$/;
const SOURCE_NAME = /^[a-z0-9][a-z0-9._-]{0,59}$/;
const MAX_CLIENTS = 400;
const MAX_PENDING = 500;
const MAX_PENDING_PER_CLIENT = 5;
const FRAME_HEADERS = {
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
};

const PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
  "/oauth/register",
  "/oauth/authorize",
  "/oauth/token",
  "/oauth/revoke",
]);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version",
  "access-control-max-age": "86400",
};

function safeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function cleanName(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80);
}

export function normalizePublicUrl(value) {
  try {
    const u = new URL(String(value || "").trim());
    if (u.protocol !== "https:") return "";
    if (u.username || u.password || u.search || u.hash) return "";
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

function redirectShapeOk(uri) {
  try {
    const u = new URL(uri);
    return u.protocol === "https:" && !u.username && !u.password && !u.hash;
  } catch {
    return false;
  }
}

export function redirectAllowList(env = process.env) {
  const set = new Set(DEFAULT_REDIRECTS);
  for (const raw of String(env?.AKB_OAUTH_REDIRECT_ALLOW || "").split(",")) {
    const uri = raw.trim();
    if (uri && redirectShapeOk(uri)) set.add(uri);
  }
  return set;
}

// Sources a WeCom session may consent to. Unset → only claude-code.
// An explicit empty value allows none. Names are source ids, not source@agent.
export function oauthSourceAllowList(env = process.env) {
  const configured = env != null && Object.prototype.hasOwnProperty.call(env, "AKB_OAUTH_SOURCES");
  const raw = configured ? String(env.AKB_OAUTH_SOURCES || "") : "claude-code";
  const out = new Set();
  for (const part of raw.split(",")) {
    const s = part.trim().toLowerCase();
    if (SOURCE_NAME.test(s)) out.add(s);
  }
  return out;
}

function normalizeIp(value) {
  let s = String(value || "").trim().toLowerCase();
  if (s.startsWith("::ffff:")) s = s.slice("::ffff:".length);
  return s;
}

// X-Forwarded-For is ignored unless AKB_TRUST_PROXY lists the TCP peer (Caddy on 127.0.0.1).
function trustedProxySet(env) {
  const raw = String(env?.AKB_TRUST_PROXY || "").trim();
  if (!raw) return null;
  const set = new Set();
  for (const part of raw.split(",")) {
    const ip = normalizeIp(part);
    if (ip) set.add(ip);
  }
  return set.size ? set : null;
}

function clientIp(req, trust) {
  const remote = normalizeIp(req.socket?.remoteAddress || "") || "local";
  if (trust && trust.has(remote)) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.trim()) {
      const hop = normalizeIp(xff.split(",")[0]);
      if (hop) return hop.slice(0, 80);
    }
  }
  return remote.slice(0, 80);
}

function makeLimiter(now, limit, windowMs) {
  const hits = new Map();
  return (ip) => {
    const t = now();
    let arr = hits.get(ip);
    if (!arr) {
      arr = [];
      hits.set(ip, arr);
    }
    let i = 0;
    while (i < arr.length && t - arr[i] >= windowMs) i++;
    if (i) arr.splice(0, i);
    if (arr.length >= limit) return false;
    arr.push(t);
    if (hits.size > 4000) hits.delete(hits.keys().next().value);
    return true;
  };
}

function pkceOk(verifier, challenge) {
  if (typeof verifier !== "string" || !VERIFIER_RE.test(verifier)) return false;
  if (typeof challenge !== "string" || !CHALLENGE_RE.test(challenge)) return false;
  const digest = createHash("sha256").update(verifier).digest("base64url");
  return safeEqualStr(digest, challenge);
}

export function createOauth({
  dataDir = null,
  publicUrl = "",
  sourceEntries = [],
  env = process.env,
  now = Date.now,
} = {}) {
  const clock = typeof now === "function" ? now : Date.now;
  const issuer = normalizePublicUrl(publicUrl);
  const allow = redirectAllowList(env);
  const trust = trustedProxySet(env);
  const resource = issuer ? `${issuer}/mcp` : "";
  const file = dataDir ? path.join(dataDir, "oauth.json") : null;
  const allowToken = makeLimiter(clock, 30, 60 * 1000);
  const allowPaste = makeLimiter(clock, 5, 10 * 60 * 1000);
  const allowRegister = makeLimiter(clock, 30, 60 * 60 * 1000);
  const allowAuthorizeIp = makeLimiter(clock, 30, 60 * 1000);
  const allowAuthorizeClient = makeLimiter(clock, 10, 10 * 60 * 1000);
  const ipOf = (req) => clientIp(req, trust);

  let ready = false;
  let state = null;
  // Consent requests are not written to oauth.json. A restart drops in-progress logins.
  const pending = new Map();

  function logDisabled(reason) {
    console.error(`[akb] oauth disabled: ${reason}`);
  }

  function persist() {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
  }

  function mutate(fn) {
    const snap = JSON.stringify(state);
    fn();
    try {
      persist();
    } catch {
      state = JSON.parse(snap);
      console.error("[akb] oauth state write failed");
      throw Object.assign(new Error("oauth_unavailable"), { status: 503 });
    }
  }

  function consentOptions() {
    const allowSources = oauthSourceAllowList(env);
    const grouped = new Map();
    for (const e of sourceEntries || []) {
      if (!e || typeof e.source !== "string" || !allowSources.has(e.source)) continue;
      if (!grouped.has(e.source)) grouped.set(e.source, []);
      grouped.get(e.source).push(e);
    }
    const options = [];
    for (const [source, entries] of grouped) {
      // An unbound key already sees every card of this source, so the session grant matches it.
      // A source that only has @agent keys is offered per bot; the grant carries that agentName
      // and is never a wider unbound principal.
      if (entries.some((e) => !e.agentName)) {
        options.push({ source, agentName: null, value: source });
        continue;
      }
      const seen = new Set();
      for (const e of entries) {
        if (!e.agentName || seen.has(e.agentName)) continue;
        seen.add(e.agentName);
        options.push({ source, agentName: e.agentName, value: `${source}@${e.agentName}` });
      }
    }
    return options;
  }

  function wecomAllow() {
    const cfg = loadWecomConfig({ env, dataDir });
    if (!isWecomWired(cfg)) return [];
    return cfg.users;
  }

  function grantCovered(rec) {
    const entries = (sourceEntries || []).filter((e) => e && e.source === rec.source);
    if (rec.agentName) return entries.some((e) => e.agentName === rec.agentName);
    return entries.some((e) => !e.agentName);
  }

  // Pasted-key grants die when that entry id is gone. WeCom grants die when the uid leaves
  // the allow-list, the source leaves AKB_OAUTH_SOURCES, or no configured key still covers
  // the principal. grantExp is the absolute cap from consent.
  function provenanceOk(rec) {
    if (!rec || typeof rec.grantExp !== "number" || rec.grantExp <= clock()) return false;
    const auth = rec.auth;
    if (!auth || typeof auth !== "object") return false;
    if (auth.kind === "key") {
      const entry = (sourceEntries || []).find((e) => e && e.id === auth.id);
      if (!entry || entry.source !== rec.source) return false;
      return (entry.agentName || null) === (rec.agentName || null);
    }
    if (auth.kind === "wecom") {
      if (typeof auth.uid !== "string" || !auth.uid) return false;
      if (!wecomAllow().includes(auth.uid)) return false;
      if (!oauthSourceAllowList(env).has(rec.source)) return false;
      return grantCovered(rec);
    }
    return false;
  }

  function copyAuth(auth) {
    if (!auth || typeof auth !== "object") return null;
    if (auth.kind === "key" && typeof auth.id === "string" && auth.id) return { kind: "key", id: auth.id };
    if (auth.kind === "wecom" && typeof auth.uid === "string" && auth.uid) return { kind: "wecom", uid: auth.uid };
    return null;
  }

  function load() {
    if (!dataDir || !file) return;
    if (!issuer) {
      logDisabled("AKB_PUBLIC_URL must be an https URL");
      return;
    }
    try {
      if (!fs.existsSync(file)) {
        state = {
          version: 1,
          signingKey: randomBytes(32).toString("base64url"),
          clients: {},
          codes: {},
          access: {},
          refresh: {},
        };
        persist();
        ready = true;
        return;
      }
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!raw || raw.version !== 1 || typeof raw.signingKey !== "string" || raw.signingKey.length < 32) {
        logDisabled("oauth state unreadable");
        return;
      }
      state = {
        version: 1,
        signingKey: raw.signingKey,
        clients: raw.clients && typeof raw.clients === "object" ? raw.clients : {},
        codes: raw.codes && typeof raw.codes === "object" ? raw.codes : {},
        access: raw.access && typeof raw.access === "object" ? raw.access : {},
        refresh: raw.refresh && typeof raw.refresh === "object" ? raw.refresh : {},
      };
      ready = true;
    } catch {
      // Do not overwrite a file we could not read. Static Bearer keys stay available.
      logDisabled("oauth state unreadable");
      ready = false;
      state = null;
    }
  }

  load();

  function unauthorizedHeaders() {
    if (!ready) return {};
    return { "www-authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"` };
  }

  function dropFamily(family) {
    if (!family) return;
    try {
      mutate(() => revokeFamily(family));
    } catch {
      // Still deny the token if the revoke could not be persisted.
    }
  }

  function principalForBearer(token) {
    if (!ready || typeof token !== "string" || token.length < 32 || token.length > 256) return null;
    const rec = state.access[hashToken(token)];
    if (!rec || typeof rec.exp !== "number" || typeof rec.source !== "string") return null;
    if (rec.exp <= clock()) return null;
    if (!provenanceOk(rec)) {
      dropFamily(rec.family);
      return null;
    }
    return { source: rec.source, agentName: rec.agentName || null };
  }

  function resourceMetadata() {
    return {
      resource,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
    };
  }

  function serverMetadata() {
    return {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      // Every redirect back to the client (code or error) carries iss=<issuer>.
      authorization_response_iss_parameter_supported: true,
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["offline_access"],
    };
  }

  function json(res, send, status, body, headers = {}) {
    send(res, status, body, { ...CORS, "cache-control": "no-store", ...headers });
  }

  function noContent(res) {
    res.writeHead(204, { ...CORS, "cache-control": "no-store" });
    res.end();
  }

  function redirectTo(res, location, headers = {}) {
    res.writeHead(302, {
      location,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      ...headers,
    });
    res.end();
  }

  function errorRedirect(res, redirectUri, error, oauthState) {
    const u = new URL(redirectUri);
    u.searchParams.set("error", error);
    if (oauthState) u.searchParams.set("state", oauthState);
    u.searchParams.set("iss", issuer);
    redirectTo(res, u.toString());
  }

  function page(res, sendHtml, status, html, headers = {}) {
    sendHtml(res, status, html, {
      // Not "no-referrer": browsers then send `Origin: null` on the consent form POST and
      // originOk refuses it. same-origin still keeps the URL from leaving the board.
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
      ...FRAME_HEADERS,
      ...headers,
    });
  }

  function originOk(req) {
    const origin = req.headers.origin;
    if (typeof origin !== "string" || !origin || origin.length > 200 || !issuer) return false;
    try {
      const got = new URL(origin);
      return got.origin === origin && got.origin === new URL(issuer).origin;
    } catch {
      return false;
    }
  }

  function csrfSetCookie(base, id) {
    const signed = signPayload(state.signingKey, { id, exp: clock() + PENDING_TTL_MS });
    return cookieHeader(OAUTH_CSRF_COOKIE, signed, { basePath: base || "/", maxAge: PENDING_TTL_MS / 1000 });
  }

  function consentHtml({ base, client, pending: reqPending, id, session, banner, wecomWired }) {
    const options = consentOptions();
    const requested = new Set(String(reqPending.scope || "").split(/\s+/).filter(Boolean));
    const pre = options.find((o) => requested.has(o.value) || requested.has(o.source))?.value || options[0]?.value || "";
    let host = "";
    try { host = new URL(reqPending.redirectUri).host; } catch { host = ""; }
    const who = client.name || "这个客户端";
    const clientPrefix = String(reqPending.clientId || "").slice(0, 8);
    const registered = typeof client.createdAt === "number" ? new Date(client.createdAt).toISOString() : "未知";
    const loginNext = `${base}/oauth/authorize?resume=${encodeURIComponent(id)}`;
    const loginHref = `${base}/auth/wecom/start?next=${encodeURIComponent(loginNext)}`;
    const radios = options.map((o) => {
      const checked = o.value === pre ? " checked" : "";
      return `<label class="choice"><input type="radio" name="source" value="${escapeHtml(o.value)}"${checked}> ${escapeHtml(o.value)}</label>`;
    }).join("");
    const sessionBlock = session && options.length
      ? `<p>已登录：<strong>${escapeHtml(session.uid)}</strong>。选择这个连接要充当的来源（不能选管理员）：</p>
        <form method="POST" action="${escapeHtml(base)}/oauth/authorize">
          <input type="hidden" name="csrf" value="${escapeHtml(id)}">
          <input type="hidden" name="resume" value="${escapeHtml(id)}">
          ${radios}
          <button type="submit">允许</button>
        </form>`
      : session
        ? `<p>已登录：<strong>${escapeHtml(session.uid)}</strong>，但没有可通过登录授予的来源。来源若只配置了某个 bot 的钥匙，只会按该 bot 列出；未列入 AKB_OAUTH_SOURCES 的来源不会出现。</p>`
        : `<p>尚未登录。${wecomWired ? `<a href="${escapeHtml(loginHref)}">用企业微信登录</a>，登录后选择来源。` : "请粘贴一把来源钥匙。"}</p>`;
    const note = banner ? `<p class="warn">${escapeHtml(banner)}</p>` : "";
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>允许连接看板</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:28rem;margin:2rem auto;padding:0 1rem;line-height:1.5}
  code{font-size:.95rem}
  button{margin-top:.75rem;padding:.55rem 1rem;font-size:1rem}
  input[type=password]{display:block;width:100%;margin:.4rem 0;padding:.55rem;font-size:1rem;box-sizing:border-box}
  .choice{display:block;margin:.35rem 0}
  .warn{color:#b45309}
  .muted{color:#475569;font-size:.9rem}
</style></head><body>
<h1>允许连接看板</h1>
<p class="warn">「只在你自己刚在 Claude 或 ChatGPT 里点了连接时才允许」</p>
${note}
<p><strong>${escapeHtml(who)}</strong> 要连接 Agent Kanban，并以某个来源的身份上报任务。这不会授予管理员权限。</p>
<p>客户端 <code>${escapeHtml(clientPrefix)}…</code>，注册于 <code>${escapeHtml(registered)}</code></p>
<p>回调主机：<code>${escapeHtml(host)}</code></p>
${sessionBlock}
<h2>或者粘贴来源钥匙</h2>
<p class="muted">用一把已经配置的来源钥匙作为证明。发出来的令牌只拥有这把钥匙的来源（以及它绑定的 bot），不能冒充其他来源，也不是管理员钥匙。</p>
<form method="POST" action="${escapeHtml(base)}/oauth/authorize">
  <input type="hidden" name="csrf" value="${escapeHtml(id)}">
  <input type="hidden" name="resume" value="${escapeHtml(id)}">
  <label>来源钥匙 <input type="password" name="source_key" autocomplete="off"></label>
  <button type="submit">用这把钥匙允许</button>
</form>
<form method="POST" action="${escapeHtml(base)}/oauth/authorize">
  <input type="hidden" name="csrf" value="${escapeHtml(id)}">
  <input type="hidden" name="resume" value="${escapeHtml(id)}">
  <input type="hidden" name="deny" value="1">
  <button type="submit">拒绝</button>
</form>
</body></html>`;
  }

  function showConsent(res, sendHtml, ctx, id, reqPending) {
    const client = state.clients[reqPending.clientId];
    if (!client) {
      page(res, sendHtml, 400, "<!doctype html><title>Expired</title><p>This sign-in expired. Go back to Claude or ChatGPT and try again.</p>");
      return;
    }
    const session = ctx.session() || null;
    page(res, sendHtml, 200, consentHtml({
      base: ctx.base, client, pending: reqPending, id, session, banner: "", wecomWired: ctx.wecomWired,
    }), {
      "set-cookie": csrfSetCookie(ctx.base, id),
    });
  }

  function rejectConsent(res, sendHtml, ctx, id, reqPending, status, banner) {
    const client = state.clients[reqPending.clientId];
    page(res, sendHtml, status, consentHtml({
      base: ctx.base, client, pending: reqPending, id, session: ctx.session() || null, banner, wecomWired: ctx.wecomWired,
    }), { "set-cookie": csrfSetCookie(ctx.base, id) });
  }

  function revokeFamily(family) {
    if (!family) return;
    for (const [k, v] of Object.entries(state.access)) if (v.family === family) delete state.access[k];
    for (const [k, v] of Object.entries(state.refresh)) if (v.family === family) delete state.refresh[k];
  }

  function clientHasLiveRefresh(clientId) {
    const t = clock();
    for (const rec of Object.values(state.refresh)) {
      if (rec && rec.clientId === clientId && rec.exp > t && !rec.replacedBy) return true;
    }
    return false;
  }

  function trim() {
    const ids = Object.keys(state.clients);
    if (ids.length > MAX_CLIENTS) {
      const evictable = ids.filter((id) => !clientHasLiveRefresh(id));
      evictable.sort((a, b) => (state.clients[a].createdAt || 0) - (state.clients[b].createdAt || 0));
      let extra = ids.length - MAX_CLIENTS;
      for (const id of evictable) {
        if (extra <= 0) break;
        delete state.clients[id];
        extra--;
      }
    }
    for (const bag of [state.access, state.refresh, state.codes]) {
      const keys = Object.keys(bag);
      if (keys.length <= 2000) continue;
      keys.sort((a, b) => (bag[a].exp || bag[a].keepUntil || 0) - (bag[b].exp || bag[b].keepUntil || 0));
      for (const k of keys.slice(0, keys.length - 2000)) delete bag[k];
    }
  }

  function sweepPending() {
    const t = clock();
    for (const [id, rec] of pending) {
      if (!rec || rec.exp <= t) pending.delete(id);
    }
  }

  function rememberPending(id, rec) {
    sweepPending();
    const mine = [];
    for (const [k, v] of pending) if (v.clientId === rec.clientId) mine.push(k);
    mine.sort((a, b) => pending.get(a).exp - pending.get(b).exp);
    while (mine.length >= MAX_PENDING_PER_CLIENT) pending.delete(mine.shift());
    pending.set(id, rec);
    if (pending.size <= MAX_PENDING) return;
    const ranked = [...pending.entries()].sort((a, b) => a[1].exp - b[1].exp);
    while (pending.size > MAX_PENDING && ranked.length) pending.delete(ranked.shift()[0]);
  }

  async function readForm(req, readBody) {
    const raw = await readBody(req);
    const ct = String(req.headers["content-type"] || "");
    if (ct.includes("application/json")) return { json: true, params: null, raw };
    return { json: false, params: new URLSearchParams(raw.toString("utf8")), raw };
  }

  function issueTokens(rec) {
    const auth = copyAuth(rec.auth);
    const t = clock();
    if (!auth || typeof rec.grantExp !== "number" || rec.grantExp <= t) return null;
    const access = randomBytes(32).toString("base64url");
    const refresh = randomBytes(32).toString("base64url");
    const accessExp = Math.min(t + ACCESS_TTL_MS, rec.grantExp);
    const expiresIn = Math.max(0, Math.floor((accessExp - t) / 1000));
    const baseRec = {
      clientId: rec.clientId,
      source: rec.source,
      agentName: rec.agentName || null,
      family: rec.family,
      auth,
      grantExp: rec.grantExp,
    };
    state.access[hashToken(access)] = { ...baseRec, exp: accessExp };
    state.refresh[hashToken(refresh)] = { ...baseRec, exp: rec.grantExp, replacedBy: null };
    return { access, refresh, source: rec.source, expiresIn };
  }

  function tokenJson(res, send, issued) {
    json(res, send, 200, {
      access_token: issued.access,
      token_type: "Bearer",
      expires_in: issued.expiresIn,
      refresh_token: issued.refresh,
      scope: `${issued.source} offline_access`,
    }, { pragma: "no-cache" });
  }

  async function handle(req, res, url, ctx) {
    if (!PATHS.has(url.pathname)) return false;
    const { send, sendHtml, readBody } = ctx;
    try {
      if (!ready) {
        if (req.method === "OPTIONS") {
          noContent(res);
          return true;
        }
        json(res, send, 503, { error: "oauth_unavailable" });
        return true;
      }
      if (req.method === "OPTIONS" && url.pathname.startsWith("/oauth/")) {
        noContent(res);
        return true;
      }

      if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        if (req.method !== "GET") {
          json(res, send, 405, { error: "method not allowed" }, { allow: "GET" });
          return true;
        }
        json(res, send, 200, resourceMetadata());
        return true;
      }

      if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration") {
        if (req.method !== "GET") {
          json(res, send, 405, { error: "method not allowed" }, { allow: "GET" });
          return true;
        }
        json(res, send, 200, serverMetadata());
        return true;
      }

      if (url.pathname === "/oauth/register") {
        if (req.method !== "POST") {
          json(res, send, 405, { error: "method not allowed" }, { allow: "POST" });
          return true;
        }
        if (!allowRegister(ipOf(req))) {
          json(res, send, 429, { error: "slow_down" });
          return true;
        }
        const ct = String(req.headers["content-type"] || "");
        if (!ct.includes("application/json")) {
          json(res, send, 400, { error: "invalid_client_metadata", error_description: "registration body must be JSON" });
          return true;
        }
        let body;
        try {
          body = JSON.parse((await readBody(req)).toString("utf8") || "null");
        } catch {
          json(res, send, 400, { error: "invalid_client_metadata" });
          return true;
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          json(res, send, 400, { error: "invalid_client_metadata" });
          return true;
        }
        const uris = body.redirect_uris;
        if (!Array.isArray(uris) || uris.length < 1 || uris.length > 8 || uris.some((u) => typeof u !== "string" || !allow.has(u))) {
          json(res, send, 400, { error: "invalid_redirect_uri" });
          return true;
        }
        if (body.token_endpoint_auth_method != null && body.token_endpoint_auth_method !== "none") {
          json(res, send, 400, { error: "invalid_client_metadata", error_description: "only public clients (token_endpoint_auth_method=none) are accepted" });
          return true;
        }
        if (body.grant_types != null) {
          const ok = Array.isArray(body.grant_types)
            && body.grant_types.length > 0
            && body.grant_types.every((g) => g === "authorization_code" || g === "refresh_token")
            && body.grant_types.includes("authorization_code");
          if (!ok) {
            json(res, send, 400, { error: "invalid_client_metadata" });
            return true;
          }
        }
        if (body.response_types != null) {
          const ok = Array.isArray(body.response_types) && body.response_types.length === 1 && body.response_types[0] === "code";
          if (!ok) {
            json(res, send, 400, { error: "invalid_client_metadata" });
            return true;
          }
        }
        const clientId = randomBytes(32).toString("base64url");
        const createdAt = clock();
        const client = { name: cleanName(body.client_name), redirectUris: uris.slice(), createdAt };
        const atCap = Object.keys(state.clients).length >= MAX_CLIENTS;
        const canEvict = Object.keys(state.clients).some((id) => !clientHasLiveRefresh(id));
        if (atCap && !canEvict) {
          json(res, send, 429, { error: "slow_down" });
          return true;
        }
        mutate(() => {
          state.clients[clientId] = client;
          trim();
        });
        const out = {
          client_id: clientId,
          client_id_issued_at: Math.floor(createdAt / 1000),
          redirect_uris: client.redirectUris,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        };
        if (client.name) out.client_name = client.name;
        json(res, send, 201, out);
        return true;
      }

      if (url.pathname === "/oauth/authorize") {
        if (!allowAuthorizeIp(ipOf(req))) {
          json(res, send, 429, { error: "slow_down" });
          return true;
        }
        if (req.method === "GET") {
          const resume = url.searchParams.get("resume");
          if (resume && !url.searchParams.get("client_id")) {
            const reqPending = pending.get(resume);
            if (!reqPending || reqPending.exp <= clock()) {
              page(res, sendHtml, 400, "<!doctype html><title>Expired</title><p>This sign-in expired. Go back to Claude or ChatGPT and try again.</p>");
              return true;
            }
            showConsent(res, sendHtml, ctx, resume, reqPending);
            return true;
          }
          const clientId = url.searchParams.get("client_id") || "";
          const redirectUri = url.searchParams.get("redirect_uri") || "";
          const client = state.clients[clientId];
          const redirectOk = Boolean(client && client.redirectUris.includes(redirectUri) && allow.has(redirectUri));
          const oauthState = url.searchParams.get("state") || "";
          if (oauthState.length > 512) {
            if (redirectOk) errorRedirect(res, redirectUri, "invalid_request", "");
            else page(res, sendHtml, 400, "<!doctype html><title>Invalid request</title><p>Authorization request was rejected.</p>");
            return true;
          }
          if (!client || !redirectOk) {
            page(res, sendHtml, 400, "<!doctype html><title>Invalid client</title><p>Unknown client or redirect URI.</p>");
            return true;
          }
          if (!allowAuthorizeClient(clientId)) {
            json(res, send, 429, { error: "slow_down" });
            return true;
          }
          const fail = (error) => errorRedirect(res, redirectUri, error, oauthState);
          if (url.searchParams.get("response_type") !== "code") return fail("unsupported_response_type"), true;
          if (url.searchParams.get("code_challenge_method") !== "S256") return fail("invalid_request"), true;
          const challenge = url.searchParams.get("code_challenge") || "";
          if (!CHALLENGE_RE.test(challenge)) return fail("invalid_request"), true;
          const resourceParam = url.searchParams.get("resource");
          if (resourceParam && resourceParam !== resource) return fail("invalid_target"), true;
          const id = randomBytes(32).toString("base64url");
          const reqPending = {
            clientId,
            redirectUri,
            state: oauthState,
            challenge,
            scope: (url.searchParams.get("scope") || "").slice(0, 200),
            exp: clock() + PENDING_TTL_MS,
          };
          rememberPending(id, reqPending);
          showConsent(res, sendHtml, ctx, id, reqPending);
          return true;
        }
        if (req.method !== "POST") {
          json(res, send, 405, { error: "method not allowed" }, { allow: "GET, POST" });
          return true;
        }
        const form = await readForm(req, readBody);
        if (form.json || !form.params) {
          page(res, sendHtml, 400, "<!doctype html><title>Bad request</title><p>Consent form was rejected.</p>");
          return true;
        }
        const params = form.params;
        if (!originOk(req)) {
          page(res, sendHtml, 403, "<!doctype html><title>Bad origin</title><p>Consent form was rejected.</p>");
          return true;
        }
        const csrf = params.get("csrf") || "";
        const resume = params.get("resume") || "";
        const cookies = parseCookies(req.headers.cookie);
        const payload = verifyPayload(state.signingKey, cookies[OAUTH_CSRF_COOKIE]);
        const reqPending = pending.get(resume);
        if (!payload || payload.id !== csrf || csrf !== resume || !reqPending) {
          page(res, sendHtml, 403, "<!doctype html><title>Bad session</title><p>Consent session expired. Go back to Claude or ChatGPT and try again.</p>");
          return true;
        }
        if (reqPending.exp <= clock() || !state.clients[reqPending.clientId]) {
          page(res, sendHtml, 400, "<!doctype html><title>Expired</title><p>This sign-in expired. Go back to Claude or ChatGPT and try again.</p>");
          return true;
        }
        if (params.get("deny") === "1") {
          const { redirectUri, state: oauthState } = reqPending;
          pending.delete(resume);
          errorRedirect(res, redirectUri, "access_denied", oauthState);
          return true;
        }
        const pasted = params.get("source_key") || "";
        let principal = null;
        if (pasted.trim()) {
          if (!allowPaste(ipOf(req))) {
            json(res, send, 429, { error: "slow_down" });
            return true;
          }
          if (pasted.length > 256 || !matchSourceToken(pasted.trim(), sourceEntries || [])) {
            rejectConsent(res, sendHtml, ctx, resume, reqPending, 401, "钥匙无法识别。");
            return true;
          }
          const entry = matchSourceToken(pasted.trim(), sourceEntries || []);
          principal = {
            source: entry.source,
            agentName: entry.agentName || null,
            auth: { kind: "key", id: entry.id },
          };
        } else {
          const session = ctx.session();
          const choice = consentOptions().find((o) => o.value === String(params.get("source") || "").trim());
          if (!session || !choice) {
            rejectConsent(res, sendHtml, ctx, resume, reqPending, 400, session ? "请选择一个允许的来源。" : "请先登录，或粘贴来源钥匙。");
            return true;
          }
          principal = {
            source: choice.source,
            agentName: choice.agentName,
            auth: { kind: "wecom", uid: session.uid },
          };
        }
        const code = randomBytes(32).toString("base64url");
        const family = randomBytes(16).toString("hex");
        const t = clock();
        mutate(() => {
          pending.delete(resume);
          state.codes[hashToken(code)] = {
            clientId: reqPending.clientId,
            redirectUri: reqPending.redirectUri,
            challenge: reqPending.challenge,
            source: principal.source,
            agentName: principal.agentName,
            auth: copyAuth(principal.auth),
            grantExp: t + GRANT_TTL_MS,
            redeemUntil: t + CODE_TTL_MS,
            keepUntil: t + CODE_KEEP_MS,
            used: false,
            family,
          };
          trim();
        });
        const dest = new URL(reqPending.redirectUri);
        dest.searchParams.set("code", code);
        if (reqPending.state) dest.searchParams.set("state", reqPending.state);
        dest.searchParams.set("iss", issuer);
        redirectTo(res, dest.toString(), {
          "set-cookie": clearCookieHeader(OAUTH_CSRF_COOKIE, { basePath: ctx.base || "/" }),
        });
        return true;
      }

      if (url.pathname === "/oauth/token") {
        if (req.method !== "POST") {
          json(res, send, 405, { error: "method not allowed" }, { allow: "POST" });
          return true;
        }
        if (!allowToken(ipOf(req))) {
          json(res, send, 429, { error: "slow_down" });
          return true;
        }
        const form = await readForm(req, readBody);
        if (form.json || !form.params) {
          json(res, send, 400, { error: "invalid_request", error_description: "use application/x-www-form-urlencoded" });
          return true;
        }
        const params = form.params;
        const grant = params.get("grant_type") || "";
        const clientId = params.get("client_id") || "";
        const client = state.clients[clientId];
        if (!client) {
          json(res, send, 400, { error: "invalid_client" });
          return true;
        }
        const resourceParam = params.get("resource");
        if (resourceParam && resourceParam !== resource) {
          json(res, send, 400, { error: "invalid_target" });
          return true;
        }
        if (grant === "authorization_code") {
          const code = params.get("code") || "";
          const redirectUri = params.get("redirect_uri") || "";
          const verifier = params.get("code_verifier") || "";
          if (!code || !redirectUri || !verifier) {
            json(res, send, 400, { error: "invalid_request" });
            return true;
          }
          if (code.length > 256 || verifier.length > 256) {
            json(res, send, 400, { error: "invalid_grant" });
            return true;
          }
          const rec = state.codes[hashToken(code)];
          const mismatch = !rec || rec.clientId !== clientId || rec.redirectUri !== redirectUri || !client.redirectUris.includes(redirectUri);
          if (mismatch) {
            json(res, send, 400, { error: "invalid_grant" });
            return true;
          }
          if (rec.used) {
            mutate(() => revokeFamily(rec.family));
            json(res, send, 400, { error: "invalid_grant" });
            return true;
          }
          if (clock() > rec.redeemUntil) {
            json(res, send, 400, { error: "invalid_grant" });
            return true;
          }
          if (!pkceOk(verifier, rec.challenge)) {
            mutate(() => { rec.used = true; });
            json(res, send, 400, { error: "invalid_grant" });
            return true;
          }
          if (!provenanceOk(rec)) {
            mutate(() => {
              rec.used = true;
              revokeFamily(rec.family);
            });
            json(res, send, 400, { error: "invalid_grant" });
            return true;
          }
          let issued;
          mutate(() => {
            rec.used = true;
            issued = issueTokens(rec);
            trim();
          });
          if (!issued) {
            json(res, send, 400, { error: "invalid_grant" });
            return true;
          }
          tokenJson(res, send, issued);
          return true;
        }
        if (grant === "refresh_token") {
          const presented = params.get("refresh_token") || "";
          if (!presented || presented.length > 256) {
            json(res, send, 400, { error: "invalid_grant" });
            return true;
          }
          const rec = state.refresh[hashToken(presented)];
          if (!rec || rec.clientId !== clientId) {
            json(res, send, 400, { error: "invalid_grant" });
            return true;
          }
          if (rec.replacedBy) {
            mutate(() => revokeFamily(rec.family));
            json(res, send, 400, { error: "invalid_grant" });
            return true;
          }
          if (!provenanceOk(rec)) {
            mutate(() => revokeFamily(rec.family));
            json(res, send, 400, { error: "invalid_grant" });
            return true;
          }
          let issued;
          mutate(() => {
            for (const [k, a] of Object.entries(state.access)) if (a.family === rec.family) delete state.access[k];
            issued = issueTokens(rec);
            if (issued) rec.replacedBy = hashToken(issued.refresh);
            trim();
          });
          if (!issued) {
            json(res, send, 400, { error: "invalid_grant" });
            return true;
          }
          tokenJson(res, send, issued);
          return true;
        }
        json(res, send, 400, { error: grant ? "unsupported_grant_type" : "invalid_request" });
        return true;
      }

      if (url.pathname === "/oauth/revoke") {
        if (req.method !== "POST") {
          json(res, send, 405, { error: "method not allowed" }, { allow: "POST" });
          return true;
        }
        if (!allowToken(ipOf(req))) {
          json(res, send, 429, { error: "slow_down" });
          return true;
        }
        const form = await readForm(req, readBody);
        if (form.json || !form.params) {
          json(res, send, 200, {});
          return true;
        }
        const token = form.params.get("token") || "";
        const clientId = form.params.get("client_id") || "";
        if (token && token.length <= 256) {
          const h = hashToken(token);
          const acc = state.access[h];
          const ref = state.refresh[h];
          const owned = (rec) => rec && (!clientId || rec.clientId === clientId);
          if (owned(acc) || owned(ref)) {
            const family = (owned(acc) ? acc : ref).family;
            mutate(() => revokeFamily(family));
          }
        }
        json(res, send, 200, {});
        return true;
      }

      json(res, send, 404, { error: "not found" });
      return true;
    } catch (err) {
      if (res.headersSent) return true;
      const status = err.status === 413 ? 413 : err.status === 503 ? 503 : 500;
      json(res, send, status, { error: status === 503 ? "oauth_unavailable" : status === 413 ? "body too large" : "server_error" });
      return true;
    }
  }

  return { ready, handle, principalForBearer, unauthorizedHeaders, issuer, resource };
}
