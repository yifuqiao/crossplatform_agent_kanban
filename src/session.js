import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "akb_session";
export const STATE_COOKIE = "akb_oauth_state";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const STATE_TTL_MS = 10 * 60 * 1000;

function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

function hmac(secret, body) {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function safeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Sign a payload that already includes `exp` (ms epoch). */
export function signPayload(secret, payload) {
  if (!secret) throw new Error("session secret not configured");
  const body = b64urlJson(payload);
  return `${body}.${hmac(secret, body)}`;
}

/** Verify HMAC and expiry. Returns payload or null. Uses timingSafeEqual. */
export function verifyPayload(secret, token) {
  if (!secret || !token || typeof token !== "string") return null;
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = hmac(secret, body);
  if (!safeEqualStr(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object") return null;
    if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function issueSession(secret, uid) {
  return signPayload(secret, { uid: String(uid), exp: Date.now() + SESSION_TTL_MS });
}

export function verifySession(secret, token) {
  const payload = verifyPayload(secret, token);
  if (!payload || typeof payload.uid !== "string" || !payload.uid) return null;
  return payload;
}

export function issueState(secret) {
  const state = randomBytes(16).toString("hex");
  const cookie = signPayload(secret, { s: state, exp: Date.now() + STATE_TTL_MS });
  return { state, cookie };
}

export function verifyState(secret, cookieValue, state) {
  if (!state) return false;
  const payload = verifyPayload(secret, cookieValue);
  if (!payload || typeof payload.s !== "string") return false;
  return safeEqualStr(payload.s, state);
}

export function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    let v = part.slice(i + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      // keep raw
    }
    out[k] = v;
  }
  return out;
}

/** Build Set-Cookie attributes: HttpOnly; Secure; SameSite=Lax; Path=<base|/ > */
export function cookieHeader(name, value, { basePath = "", maxAge } = {}) {
  const path = basePath || "/";
  const parts = [`${name}=${encodeURIComponent(value)}`, "HttpOnly", "Secure", "SameSite=Lax", `Path=${path}`];
  if (typeof maxAge === "number") parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  return parts.join("; ");
}

export function clearCookieHeader(name, { basePath = "" } = {}) {
  return cookieHeader(name, "", { basePath, maxAge: 0 });
}
