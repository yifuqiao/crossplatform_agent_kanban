import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { Store, publicTask } from "./store.js";
import { COLUMNS } from "./status.js";
import { handleMcp } from "./mcp.js";
import { cursorAgentEvent, verifyCursorWebhook, createCursorCloudPoller } from "./pollers/cursor-cloud.js";
import { createGrokRelayPoller } from "./pollers/grok-relay.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const STATIC = { "/": "index.html", "/app.js": "app.js", "/style.css": "style.css" };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const MAX_BODY = 1024 * 1024;

function send(res, status, body, headers = {}) {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(text);
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
  if (!token) return true;
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

export function createServer({ store = new Store(), token = process.env.AKB_TOKEN, cursorWebhookSecret = process.env.CURSOR_WEBHOOK_SECRET } = {}) {
  const clients = new Set();
  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  };
  store.on("change", (task) => broadcast("task", { ...publicTask(task), events: task.events.slice(-5) }));
  store.on("remove", (keys) => broadcast("remove", keys));
  const heartbeat = setInterval(() => broadcast("ping", Date.now()), 25000);
  heartbeat.unref();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    try {
      if (req.method === "GET" && STATIC[url.pathname]) {
        const file = path.join(PUBLIC_DIR, STATIC[url.pathname]);
        res.writeHead(200, { "content-type": TYPES[path.extname(file)], "cache-control": "no-cache" });
        return fs.createReadStream(file).pipe(res);
      }
      if (url.pathname === "/health") return send(res, 200, { ok: true, tasks: store.tasks.size });

      if (url.pathname === "/webhooks/cursor" && req.method === "POST") {
        const raw = await readBody(req);
        if (!verifyCursorWebhook(raw, req.headers["x-webhook-signature"], cursorWebhookSecret)) return send(res, 401, { error: "bad signature" });
        if (!cursorWebhookSecret && !tokenOk(req, url, token)) return send(res, 401, { error: "unauthorized" });
        const ev = cursorAgentEvent(parseJson(raw));
        if (ev) store.apply(ev);
        return send(res, 200, { ok: true });
      }

      if (!tokenOk(req, url, token)) return send(res, 401, { error: "unauthorized" });
      if (req.method !== "GET" && !originOk(req)) return send(res, 403, { error: "cross-origin write refused" });

      if (url.pathname === "/mcp") {
        if (req.method !== "POST") return send(res, 405, { error: "POST JSON-RPC messages to /mcp" }, { allow: "POST" });
        const msg = parseJson(await readBody(req));
        if (Array.isArray(msg)) {
          const out = msg.map((m) => handleMcp(store, m)).filter(Boolean);
          return out.length ? send(res, 200, out) : send(res, 202);
        }
        const out = handleMcp(store, msg);
        return out ? send(res, 200, out) : send(res, 202);
      }

      if (url.pathname === "/api/stream" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": connected\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }

      if (url.pathname === "/api/tasks" && req.method === "GET") {
        const tasks = store.list({ status: url.searchParams.get("status") || undefined, source: url.searchParams.get("source") || undefined });
        return send(res, 200, { columns: COLUMNS, tasks: tasks.map((t) => ({ ...publicTask(t), events: t.events.slice(-5) })) });
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
        const body = parseJson(await readBody(req));
        const events = Array.isArray(body) ? body : [body];
        const results = [];
        for (const ev of events) {
          try {
            const { task } = store.apply(ev);
            results.push({ ok: true, key: task.key, status: task.status });
          } catch (err) {
            results.push({ ok: false, error: err.message });
          }
        }
        const status = results.every((r) => r.ok) ? 200 : results.some((r) => r.ok) ? 207 : 400;
        return send(res, status, Array.isArray(body) ? { results } : results[0]);
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
  const pollers = [];
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
