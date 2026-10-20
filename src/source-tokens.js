import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Per-source MCP keys, in addition to the all-powerful AKB_TOKEN.
//
//   AKB_SOURCE_TOKENS=claude-code:<sha256 hex>,grok-bot@ops-bot:<sha256 hex>
//
// Each entry is `source[@agent_name]:<sha256 of the key>`. Only hashes are configured, never keys.
// A caller using such a key can only report as that source (and that bot, when one is bound).
// To revoke one key, delete its entry and restart the board; the other keys keep working.
const SOURCE = /^[a-z0-9][a-z0-9._-]{0,59}$/;
const HASH = /^[0-9a-f]{64}$/;
// Shorter keys are refused when hashing and never match, so a weak key cannot be configured.
export const MIN_TOKEN_LENGTH = 32;

export function hashToken(token) {
  return createHash("sha256").update(String(token), "utf8").digest("hex");
}

export function newToken() {
  return randomBytes(32).toString("base64url");
}

export function parseSourceTokens(value) {
  const entries = [];
  for (const raw of String(value || "").split(",")) {
    const item = raw.trim();
    if (!item) continue;
    const i = item.lastIndexOf(":");
    const who = i > 0 ? item.slice(0, i) : "";
    const hash = i > 0 ? item.slice(i + 1).toLowerCase() : "";
    const at = who.indexOf("@");
    const source = (at >= 0 ? who.slice(0, at) : who).trim().toLowerCase();
    const agentName = at >= 0 ? who.slice(at + 1).trim() : "";
    // Name the bad entry by position only: it may contain a pasted key instead of a hash.
    if (!SOURCE.test(source) || !HASH.test(hash) || (at >= 0 && (!agentName || agentName.length > 60))) {
      throw new Error(`AKB_SOURCE_TOKENS entry #${entries.length + 1} must look like source[@agent_name]:<64 hex sha256>`);
    }
    if (entries.some((e) => e.hash === hash)) throw new Error(`AKB_SOURCE_TOKENS entry #${entries.length + 1} repeats a hash`);
    entries.push({ source, agentName: agentName || null, hash, id: `${who.trim()}#${hash.slice(0, 8)}` });
  }
  return entries;
}

// Returns the entry the bearer key belongs to, or null.
export function matchSourceToken(given, entries) {
  if (!given || given.length < MIN_TOKEN_LENGTH || !entries.length) return null;
  const digest = Buffer.from(hashToken(given), "hex");
  let found = null;
  for (const e of entries) {
    if (timingSafeEqual(digest, Buffer.from(e.hash, "hex"))) found = e;
  }
  return found;
}
