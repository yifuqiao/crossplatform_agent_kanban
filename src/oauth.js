import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { hashToken, matchSourceToken } from "./source-tokens.js";
import { clearCookieHeader, cookieHeader, parseCookies, signPayload, verifyPayload } from "./session.js";

// OAuth 2.1 for MCP clients that cannot send a static Bearer (claude.ai, Claude iOS).
// Everything lives under /kanban so the relay's own OAuth page at the domain root is not involved.
// Tokens are opaque; only sha256 hashes are stored. oauth.json sits next to state.json and is the
// only file this module writes. If the signing key or that file cannot be loaded, ready is false:
// these routes return 503 and static Bearer keys keep working.

export const OAUTH_CSRF_COOKIE = "akb_oauth_csrf";
export const DEFAULT_REDIRECTS = Object.freeze([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
]);

const CODE_TTL_MS = 60 * 1000;
const CODE_KEEP_MS = 10 * 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const ACCESS_EXPIRES_IN = 3600;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;
const VERIFIER_RE = /^[\w.~-]{43,128}$/;

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

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim().slice(0, 80);
  return req.socket?.remoteAddress || "local";
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
  const resource = issuer ? `${issuer}/mcp` : "";
  const file = dataDir ? path.join(dataDir, "oauth.json") : null;
  const allowToken = makeLimiter(clock, 30, 60 * 1000);
  const allowPaste = makeLimiter(clock, 5, 10 * 60 * 1000);
  const allowRegister = makeLimiter(clock, 30, 60 * 60 * 1000);

  let ready = false;
  let state = null;

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

  function sourceNames() {
    const out = [];
    for (const e of sourceEntries || []) {
      if (e && typeof e.source === "string" && e.source && !out.includes(e.source)) out.push(e.source);
    }
    return out;
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
          pending: {},
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
        pending: raw.pending && typeof raw.pending === "object" ? raw.pending : {},
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

  function principalForBearer(token) {
    if (!ready || typeof token !== "string" || token.length < 32 || token.length > 256) return null;
    const rec = state.access[hashToken(token)];
    if (!rec || typeof rec.exp !== "number" || rec.exp <= clock() || typeof rec.source !== "string") return null;
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
    redirectTo(res, u.toString());
  }

  function page(res, sendHtml, status, html, headers = {}) {
    sendHtml(res, status, html, {
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...headers,
    });
  }

  function csrfSetCookie(base, id) {
    const signed = signPayload(state.signingKey, { id, exp: clock() + PENDING_TTL_MS });
    return cookieHeader(OAUTH_CSRF_COOKIE, signed, { basePath: base || "/", maxAge: PENDING_TTL_MS / 1000 });
  }

  function consentHtml({ base, client, pending, id, session, banner, wecomWired }) {
    const names = sourceNames();
    const requested = new Set(String(pending.scope || "").split(/\s+/).filter(Boolean));
    const pre = names.find((s) => requested.has(s)) || names[0] || "";
    let host = "";
    try { host = new URL(pending.redirectUri).host; } catch { host = ""; }
    const who = client.name || "这个客户端";
    const loginNext = `${base}/oauth/authorize?resume=${encodeURIComponent(id)}`;
    const loginHref = `${base}/auth/wecom/start?next=${encodeURIComponent(loginNext)}`;
    const radios = names.map((s) => {
      const checked = s === pre ? " checked" : "";
      return `<label class="choice"><input type="radio" name="source" value="${escapeHtml(s)}"${checked}> ${escapeHtml(s)}</label>`;
    }).join("");
    const sessionBlock = session && names.length
      ? `<p>已登录：<strong>${escapeHtml(session.uid)}</strong>。选择这个连接要充当的来源（不能选管理员）：</p>
        <form method="POST" action="${escapeHtml(base)}/oauth/authorize">
          <input type="hidden" name="csrf" value="${escapeHtml(id)}">
          <input type="hidden" name="resume" value="${escapeHtml(id)}">
          ${radios}
          <button type="submit">允许</button>
        </form>`
      : session
        ? `<p>已登录：<strong>${escapeHtml(session.uid)}</strong>，但服务器没有配置任何来源钥匙，无法选择来源。</p>`
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
${note}
<p><strong>${escapeHtml(who)}</strong> 要连接 Agent Kanban，并以某个来源的身份上报任务。这不会授予管理员权限。</p>
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

  function showConsent(res, sendHtml, ctx, id, pending) {
    const client = state.clients[pending.clientId];
    if (!client) {
      page(res, sendHtml, 400, "<!doctype html><title>Expired</title><p>This sign-in expired. Go back to Claude and try again.</p>");
      return;
    }
    const session = ctx.session() || null;
    page(res, sendHtml, 200, consentHtml({
      base: ctx.base, client, pending, id, session, banner: "", wecomWired: ctx.wecomWired,
    }), {
      "set-cookie": csrfSetCookie(ctx.base, id),
    });
  }

  function rejectConsent(res, sendHtml, ctx, id, pending, status, banner) {
    const client = state.clients[pending.clientId];
    page(res, sendHtml, status, consentHtml({
      base: ctx.base, client, pending, id, session: ctx.session() || null, banner, wecomWired: ctx.wecomWired,
    }), { "set-cookie": csrfSetCookie(ctx.base, id) });
  }

  function revokeFamily(family) {
    if (!family) return;
    for (const [k, v] of Object.entries(state.access)) if (v.family === family) delete state.access[k];
    for (const [k, v] of Object.entries(state.refresh)) if (v.family === family) delete state.refresh[k];
  }

  function trim() {
    const ids = Object.keys(state.clients);
    if (ids.length > 400) {
      ids.sort((a, b) => (state.clients[a].createdAt || 0) - (state.clients[b].createdAt || 0));
      for (const id of ids.slice(0, ids.length - 400)) delete state.clients[id];
    }
    for (const bag of [state.access, state.refresh, state.codes, state.pending]) {
      const keys = Object.keys(bag);
      if (keys.length <= 2000) continue;
      keys.sort((a, b) => (bag[a].exp || bag[a].keepUntil || 0) - (bag[b].exp || bag[b].keepUntil || 0));
      for (const k of keys.slice(0, keys.length - 2000)) delete bag[k];
    }
  }

  async function readForm(req, readBody) {
    const raw = await readBody(req);
    const ct = String(req.headers["content-type"] || "");
    if (ct.includes("application/json")) return { json: true, params: null, raw };
    return { json: false, params: new URLSearchParams(raw.toString("utf8")), raw };
  }

  function issueTokens(rec) {
    const access = randomBytes(32).toString("base64url");
    const refresh = randomBytes(32).toString("base64url");
    const t = clock();
    state.access[hashToken(access)] = {
      clientId: rec.clientId, source: rec.source, agentName: rec.agentName || null,
      exp: t + ACCESS_TTL_MS, family: rec.family,
    };
    state.refresh[hashToken(refresh)] = {
      clientId: rec.clientId, source: rec.source, agentName: rec.agentName || null,
      exp: t + REFRESH_TTL_MS, family: rec.family, replacedBy: null,
    };
    return { access, refresh, source: rec.source };
  }

  function tokenJson(res, send, access, refresh, source) {
    json(res, send, 200, {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_EXPIRES_IN,
      refresh_token: refresh,
      scope: `${source} offline_access`,
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
        if (!allowRegister(clientIp(req))) {
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
        if (req.method === "GET") {
          const resume = url.searchParams.get("resume");
          if (resume && !url.searchParams.get("client_id")) {
            const pending = state.pending[resume];
            if (!pending || pending.exp <= clock()) {
              page(res, sendHtml, 400, "<!doctype html><title>Expired</title><p>This sign-in expired. Go back to Claude and try again.</p>");
              return true;
            }
            showConsent(res, sendHtml, ctx, resume, pending);
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
          const fail = (error) => errorRedirect(res, redirectUri, error, oauthState);
          if (url.searchParams.get("response_type") !== "code") return fail("unsupported_response_type"), true;
          if (url.searchParams.get("code_challenge_method") !== "S256") return fail("invalid_request"), true;
          const challenge = url.searchParams.get("code_challenge") || "";
          if (!CHALLENGE_RE.test(challenge)) return fail("invalid_request"), true;
          const resourceParam = url.searchParams.get("resource");
          if (resourceParam && resourceParam !== resource) return fail("invalid_target"), true;
          const id = randomBytes(32).toString("base64url");
          const pending = {
            clientId,
            redirectUri,
            state: oauthState,
            challenge,
            scope: (url.searchParams.get("scope") || "").slice(0, 200),
            exp: clock() + PENDING_TTL_MS,
          };
          mutate(() => {
            state.pending[id] = pending;
            trim();
          });
          showConsent(res, sendHtml, ctx, id, pending);
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
        const csrf = params.get("csrf") || "";
        const resume = params.get("resume") || "";
        const cookies = parseCookies(req.headers.cookie);
        const payload = verifyPayload(state.signingKey, cookies[OAUTH_CSRF_COOKIE]);
        if (!payload || payload.id !== csrf || csrf !== resume || !state.pending[resume]) {
          page(res, sendHtml, 403, "<!doctype html><title>Bad session</title><p>Consent session expired. Go back to Claude and try again.</p>");
          return true;
        }
        const pending = state.pending[resume];
        if (pending.exp <= clock() || !state.clients[pending.clientId]) {
          page(res, sendHtml, 400, "<!doctype html><title>Expired</title><p>This sign-in expired. Go back to Claude and try again.</p>");
          return true;
        }
        if (params.get("deny") === "1") {
          const { redirectUri, state: oauthState } = pending;
          mutate(() => { delete state.pending[resume]; });
          errorRedirect(res, redirectUri, "access_denied", oauthState);
          return true;
        }
        const pasted = params.get("source_key") || "";
        let principal = null;
        if (pasted.trim()) {
          if (!allowPaste(clientIp(req))) {
            json(res, send, 429, { error: "slow_down" });
            return true;
          }
          if (pasted.length > 256 || !matchSourceToken(pasted.trim(), sourceEntries || [])) {
            rejectConsent(res, sendHtml, ctx, resume, pending, 401, "钥匙无法识别。");
            return true;
          }
          const entry = matchSourceToken(pasted.trim(), sourceEntries || []);
          principal = { source: entry.source, agentName: entry.agentName || null };
        } else {
          const session = ctx.session();
          const source = String(params.get("source") || "").trim().toLowerCase();
          if (!session || !sourceNames().includes(source)) {
            rejectConsent(res, sendHtml, ctx, resume, pending, 400, session ? "请选择一个已配置的来源。" : "请先登录，或粘贴来源钥匙。");
            return true;
          }
          principal = { source, agentName: null };
        }
        const code = randomBytes(32).toString("base64url");
        const family = randomBytes(16).toString("hex");
        const t = clock();
        mutate(() => {
          delete state.pending[resume];
          state.codes[hashToken(code)] = {
            clientId: pending.clientId,
            redirectUri: pending.redirectUri,
            challenge: pending.challenge,
            source: principal.source,
            agentName: principal.agentName,
            redeemUntil: t + CODE_TTL_MS,
            keepUntil: t + CODE_KEEP_MS,
            used: false,
            family,
          };
          trim();
        });
        const dest = new URL(pending.redirectUri);
        dest.searchParams.set("code", code);
        if (pending.state) dest.searchParams.set("state", pending.state);
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
        if (!allowToken(clientIp(req))) {
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
          let issued;
          mutate(() => {
            rec.used = true;
            issued = issueTokens(rec);
            trim();
          });
          tokenJson(res, send, issued.access, issued.refresh, issued.source);
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
          if (rec.exp <= clock()) {
            json(res, send, 400, { error: "invalid_grant" });
            return true;
          }
          let issued;
          mutate(() => {
            for (const [k, a] of Object.entries(state.access)) if (a.family === rec.family) delete state.access[k];
            issued = issueTokens(rec);
            rec.replacedBy = hashToken(issued.refresh);
            trim();
          });
          tokenJson(res, send, issued.access, issued.refresh, issued.source);
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
        if (!allowToken(clientIp(req))) {
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
