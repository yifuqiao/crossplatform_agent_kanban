import fs from "node:fs";
import path from "node:path";

const API = "https://qyapi.weixin.qq.com";
/** Cache access_token until expires_in minus this skew (ms). */
const CACHE_SKEW_MS = 300_000;
const FETCH_TIMEOUT_MS = 10_000;
/** WeCom errcodes that mean the cached access_token is dead. */
const STALE_TOKEN_ERR = new Set([40014, 42001]);
/** Session HMAC key must be at least this many UTF-8 bytes. */
export const MIN_SESSION_SECRET_BYTES = 32;

/** @type {{ path: string, mtimeMs: number, secret: string } | null} */
let wecomFileCache = null;

function readWecomSecretCached(dataDir) {
  const file = path.join(dataDir, "wecom.json");
  try {
    const st = fs.statSync(file);
    if (wecomFileCache && wecomFileCache.path === file && wecomFileCache.mtimeMs === st.mtimeMs) {
      return wecomFileCache.secret;
    }
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    const secret = parsed && typeof parsed.secret === "string" ? parsed.secret.trim() : "";
    wecomFileCache = { path: file, mtimeMs: st.mtimeMs, secret };
    return secret;
  } catch {
    if (wecomFileCache?.path === file) wecomFileCache = null;
    return "";
  }
}

/** @internal test helper — drop mtime cache after fixture writes. */
export function clearWecomFileCache() {
  wecomFileCache = null;
}

/**
 * Resolve WeCom config. Secret priority: env AKB_WECOM_SECRET > dataDir/wecom.json.
 * Never log or return secrets in error messages.
 */
export function loadWecomConfig({ env = process.env, dataDir } = {}) {
  const corpId = String(env.AKB_WECOM_CORP_ID || "").trim();
  const agentId = String(env.AKB_WECOM_AGENT_ID || "").trim();
  let secret = String(env.AKB_WECOM_SECRET || "").trim();
  let secretFromFile = false;
  if (!secret && dataDir) {
    const fromFile = readWecomSecretCached(dataDir);
    if (fromFile) {
      secret = fromFile;
      secretFromFile = true;
    }
  }
  const publicUrl = String(env.AKB_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  const users = String(env.AKB_WECOM_USERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const rawSession = String(env.AKB_SESSION_SECRET || "").trim();
  // Shorter than 32 bytes → treat as unset (cookie verify / OAuth start stay off).
  const sessionSecret = Buffer.byteLength(rawSession, "utf8") >= MIN_SESSION_SECRET_BYTES ? rawSession : "";
  return { corpId, agentId, secret, secretFromFile, publicUrl, users, sessionSecret };
}

/** Wired only when CorpID, AgentId, secret, session secret (≥32 bytes), and public URL are all set. */
export function isWecomWired(cfg) {
  return Boolean(cfg?.corpId && cfg?.agentId && cfg?.secret && cfg?.sessionSecret && cfg?.publicUrl);
}

export function wecomSecretPath(dataDir) {
  return path.join(dataDir, "wecom.json");
}

/** Write secret once (0600). Throws if file already exists. Does not echo the secret. */
export function writeWecomSecret(dataDir, secret) {
  if (!dataDir) throw Object.assign(new Error("data dir not configured"), { status: 500 });
  const file = wecomSecretPath(dataDir);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify({ secret: String(secret) })}\n`, { encoding: "utf8" });
  } finally {
    fs.closeSync(fd);
  }
  wecomFileCache = null;
  return file;
}

async function wecomFetch(fetchImpl, url) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  return res.json();
}

/**
 * @param {{ corpId: string, agentId: string, secret: string, publicUrl: string, fetchImpl?: typeof fetch }} opts
 */
export function createWecomClient({ corpId, agentId, secret, publicUrl, fetchImpl = globalThis.fetch } = {}) {
  let cached = null; // { token, expiresAt }

  function clearTokenCache() {
    cached = null;
  }

  function authorizeUrl(state) {
    const redirectUri = `${publicUrl}/auth/wecom/callback`;
    const q = new URLSearchParams({
      appid: corpId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "snsapi_base",
      state: String(state),
      agentid: String(agentId),
    });
    return `https://open.weixin.qq.com/connect/oauth2/authorize?${q.toString()}#wechat_redirect`;
  }

  async function gettoken() {
    if (cached && Date.now() < cached.expiresAt) return cached.token;
    const url = `${API}/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`;
    let data;
    try {
      data = await wecomFetch(fetchImpl, url);
    } catch {
      throw Object.assign(new Error("wecom gettoken network error"), { status: 502 });
    }
    if (!data || (data.errcode != null && data.errcode !== 0) || !data.access_token) {
      if (STALE_TOKEN_ERR.has(data?.errcode)) clearTokenCache();
      const errcode = data?.errcode ?? "unknown";
      throw Object.assign(new Error(`wecom gettoken failed: errcode=${errcode}`), {
        status: 502,
        errcode: data?.errcode,
        errmsg: data?.errmsg,
      });
    }
    const expiresInMs = Math.max(0, (Number(data.expires_in) || 7200) * 1000 - CACHE_SKEW_MS);
    cached = { token: data.access_token, expiresAt: Date.now() + expiresInMs };
    return cached.token;
  }

  /** Exchange OAuth code for member userid. Never include code/token/secret in thrown messages. */
  async function getuserinfo(code) {
    if (!code) throw Object.assign(new Error("wecom getuserinfo: missing code"), { status: 400 });
    const accessToken = await gettoken();
    const url = `${API}/cgi-bin/auth/getuserinfo?access_token=${encodeURIComponent(accessToken)}&code=${encodeURIComponent(code)}`;
    let data;
    try {
      data = await wecomFetch(fetchImpl, url);
    } catch {
      throw Object.assign(new Error("wecom getuserinfo network error"), { status: 502 });
    }
    if (!data || (data.errcode != null && data.errcode !== 0)) {
      if (STALE_TOKEN_ERR.has(data?.errcode)) clearTokenCache();
      const errcode = data?.errcode ?? "unknown";
      throw Object.assign(new Error(`wecom getuserinfo failed: errcode=${errcode}`), {
        status: 502,
        errcode: data?.errcode,
        errmsg: data?.errmsg,
      });
    }
    const userid = data.userid;
    if (!userid || typeof userid !== "string") {
      throw Object.assign(new Error("wecom getuserinfo: no userid"), { status: 502 });
    }
    return userid;
  }

  return {
    authorizeUrl,
    gettoken,
    getuserinfo,
    /** @internal test helper */
    _cache() {
      return cached;
    },
    /** @internal test helper */
    _clearCache() {
      clearTokenCache();
    },
  };
}
