import { createHmac, timingSafeEqual } from "node:crypto";
import { oneLine } from "../adapters/common.js";
import { normalizeStatus } from "../status.js";

const SOURCE = "cursor-cloud";
const API = "https://api.cursor.com";

// One Cursor cloud (background) agent, from the list API or a statusChange webhook.
export function cursorAgentEvent(agent) {
  const id = agent?.id;
  if (!id) return null;
  const target = agent.target || {};
  const prUrl = target.prUrl || agent.prUrl;
  const raw = agent.status || agent.latestRun?.status;
  return {
    source: SOURCE,
    external_id: id,
    kind: "cloud",
    title: agent.name || agent.title || undefined,
    title_mode: agent.name || agent.title ? "replace" : "default",
    status: normalizeStatus(raw, undefined),
    summary: oneLine(agent.summary || agent.latestRun?.result, 1000) || undefined,
    url: agent.url || target.url || `https://cursor.com/agents?id=${id}`,
    links: prUrl ? [{ url: prUrl, label: "PR" }] : [],
    meta: { cursor_status: raw, repository: agent.source?.repository, branch: target.branchName },
    message: raw ? `Cursor status: ${raw}` : undefined,
    event_id: raw ? `${id}:${raw}` : undefined,
    at: agent.createdAt && !raw ? agent.createdAt : undefined,
  };
}

export function verifyCursorWebhook(rawBody, signature, secret) {
  // Fail closed: an unset secret never authenticates. Callers without CURSOR_WEBHOOK_SECRET
  // must require a valid AKB_TOKEN instead (see createServer webhook handler).
  if (!secret) return false;
  if (typeof signature !== "string") return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createCursorCloudPoller({ store, apiKey, limit = 50, fetchImpl = fetch }) {
  const auth = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
  let path = `/v1/agents?limit=${limit}`;

  async function poll() {
    let res = await fetchImpl(`${API}${path}`, { headers: { authorization: auth, accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (res.status === 404 && path.startsWith("/v1")) {
      path = `/v0/agents?limit=${limit}`;
      res = await fetchImpl(`${API}${path}`, { headers: { authorization: auth, accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    }
    if (!res.ok) throw new Error(`Cursor ${path} -> HTTP ${res.status}`);
    const body = await res.json();
    for (const agent of body.agents || body.items || []) {
      const ev = cursorAgentEvent(agent);
      if (ev) store.apply(ev);
    }
  }

  return { name: "cursor-cloud", poll };
}
