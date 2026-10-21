#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Store } from "./store.js";
import { createServer, pollersFromEnv, startPollers } from "./server.js";
import { applyEnvLinks } from "./adapters/common.js";
import { claudeCodeEvents } from "./adapters/claude-code.js";
import { cursorEvents, cursorHookResponse } from "./adapters/cursor.js";
import { codexEvents } from "./adapters/codex.js";
import { COLUMNS } from "./status.js";
import { hashToken, newToken, parseSourceTokens, MIN_TOKEN_LENGTH } from "./source-tokens.js";

const BASE = (process.env.AKB_URL || "http://127.0.0.1:7311").replace(/\/+$/, "");
const HOOKS = { "claude-code": claudeCodeEvents, claude: claudeCodeEvents, cursor: cursorEvents, codex: codexEvents };

const USAGE = `akb — cross-platform agent kanban

  akb serve [--port 7311] [--host 127.0.0.1] [--data ~/.agent-kanban] [--poll 30]
  akb hook <claude-code|cursor|codex>          adapter for agent hooks (reads stdin / argv)
  akb run [--title T] [--source S] [--parent K] -- <cmd...>  track any CLI process as a card
  akb report --title T --status S [--key K] [--parent K] [--note N] [--source S]
  akb list                                     print the board
  akb mcp                                      stdio MCP bridge to the running board
  akb token-new --source S [--agent NAME]      new per-source MCP key + its AKB_SOURCE_TOKENS entry
  akb token-hash --source S [--agent NAME]     same, for a key read from stdin

Env: AKB_URL (default http://127.0.0.1:7311), AKB_TOKEN or AKB_SOURCE_KEY, AKB_PARENT_KEY, AKB_TASK_KEY`;

function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out["--"] = argv.slice(i + 1);
      break;
    }
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      out[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true);
    } else out._.push(a);
  }
  return out;
}

async function post(pathname, body, timeoutMs = 2000) {
  const headers = { "content-type": "application/json" };
  // AKB_SOURCE_KEY: a per-source key, for machines that must not hold AKB_TOKEN (cloud sessions).
  // The board only accepts it on /api/events, for that source's cards.
  const key = process.env.AKB_TOKEN || process.env.AKB_SOURCE_KEY;
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${BASE}${pathname}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok && res.status !== 207) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function cmdServe(f) {
  if (!process.env.AKB_TOKEN) {
    console.error("[akb] AKB_TOKEN is required; refuse to start without authentication");
    process.exit(1);
  }
  const dataDir = path.resolve(f.data || process.env.AKB_DATA_DIR || path.join(os.homedir(), ".agent-kanban"));
  const store = new Store({ dataDir });
  const server = createServer({ store, dataDir });
  const port = Number(f.port || process.env.PORT || 7311);
  const host = f.host || process.env.AKB_HOST || "127.0.0.1";
  const pollers = pollersFromEnv(store);
  server.listen(port, host, () => {
    console.log(`[akb] board on http://${host}:${port}  (data: ${dataDir})`);
    if (pollers.length) console.log(`[akb] polling: ${pollers.map((p) => p.name).join(", ")}`);
  });
  const stop = startPollers(pollers, Number(f.poll || process.env.AKB_POLL_SECONDS || 30) * 1000);
  const shutdown = () => {
    stop();
    store.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Hooks must never break or slow the agent: short timeout, swallow errors, always exit 0.
async function cmdHook(f) {
  const which = f._[1];
  const adapter = HOOKS[which];
  if (!adapter) throw new Error(`unknown hook ${which}; use claude-code, cursor or codex`);
  let payload = null;
  try {
    // Codex passes the JSON as the last argument; Claude Code and Cursor use stdin.
    const raw = which === "codex" && f._[2] ? f._.slice(2).join(" ") : await readStdin();
    payload = JSON.parse(raw);
    const { rootKey, events } = adapter(payload);
    // Stamp now: the board orders statuses by this, since background sends can arrive out of order.
    const at = new Date().toISOString();
    const out = applyEnvLinks(events, rootKey).map((ev) => ({ at, ...ev }));
    // Codex on Windows ends a hook's child processes when the hook exits, so a detached send never
    // happens there: send inline, well inside Codex's hook timeout. AKB_HOOK_SYNC=1 forces this anywhere.
    if (events.length && syncHook(which)) await post("/api/events", out, 3500).catch(() => {});
    else if (events.length) sendInBackground(out);
  } catch (err) {
    if (process.env.AKB_DEBUG) console.error(`[akb] hook ${which}: ${err.message}`);
  }
  if (which === "cursor") process.stdout.write(JSON.stringify(cursorHookResponse(payload)));
}

function syncHook(which) {
  return process.env.AKB_HOOK_SYNC === "1" || (which === "codex" && process.platform === "win32");
}

// Hand the events to a detached `akb send` so the agent never waits on the network
// (a remote board can be seconds away).
function sendInBackground(events) {
  const env = { ...process.env };
  // Node's fetch ignores HTTPS_PROXY unless told to; cloud sandboxes route egress through one.
  if ((env.HTTPS_PROXY || env.https_proxy) && !env.NODE_USE_ENV_PROXY) env.NODE_USE_ENV_PROXY = "1";
  const child = spawn(process.execPath, ["--no-warnings", fileURLToPath(import.meta.url), "send"], {
    detached: true,
    env,
    stdio: ["pipe", "ignore", env.AKB_DEBUG ? "inherit" : "ignore"],
  });
  child.on("error", () => {});
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(events));
  child.unref();
}

async function cmdSend() {
  try {
    await post("/api/events", JSON.parse(await readStdin()), 15000);
  } catch (err) {
    if (process.env.AKB_DEBUG) console.error(`[akb] send: ${err.message}`);
  }
}

async function cmdRun(f) {
  const cmd = f["--"];
  if (!cmd?.length) throw new Error("usage: akb run [--title T] -- <command...>");
  const source = f.source || path.basename(cmd[0]);
  const key = `${source}:${randomUUID()}`;
  const parent = f.parent || process.env.AKB_TASK_KEY || process.env.AKB_PARENT_KEY;
  const report = (ev) => post("/api/events", { key, ...ev }).catch((err) => console.error(`[akb] could not reach board: ${err.message}`));
  await report({ title: f.title || cmd.join(" ").slice(0, 100), title_mode: f.title ? "replace" : "default", kind: "cli", status: "running", parent, cwd: process.cwd(), message: `Started: ${cmd.join(" ").slice(0, 300)}` });
  const env = { ...process.env, AKB_TASK_KEY: key };
  delete env.AKB_PARENT_KEY;
  const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", env });
  const forward = (sig) => child.kill(sig);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  const code = await new Promise((resolve) => {
    child.on("error", (err) => {
      console.error(`[akb] ${err.message}`);
      resolve(127);
    });
    child.on("exit", (c, sig) => resolve(c ?? (sig ? 128 : 1)));
  });
  await report({ status: code === 0 ? "done" : "failed", message: `Exited with code ${code}` });
  process.exit(code);
}

async function cmdReport(f) {
  const key = f.key || `${f.source || "manual"}:${randomUUID()}`;
  const out = await post("/api/events", {
    key, title: f.title, status: f.status, message: f.note, summary: f.summary,
    parent: f.parent || process.env.AKB_PARENT_KEY, url: f.url, kind: f.kind,
  });
  console.log(out.key);
}

async function cmdList() {
  const headers = process.env.AKB_TOKEN ? { authorization: `Bearer ${process.env.AKB_TOKEN}` } : {};
  const res = await fetch(`${BASE}/api/tasks`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { tasks } = await res.json();
  const byParent = new Map();
  for (const t of tasks) {
    const k = t.parentKey || "";
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(t);
  }
  const print = (t, depth) => {
    console.log(`${"  ".repeat(depth)}${depth ? "└ " : "• "}[${t.source}] ${t.title}  (${t.status})`);
    for (const c of byParent.get(t.key) || []) print(c, depth + 1);
  };
  const keys = new Set(tasks.map((t) => t.key));
  for (const col of COLUMNS) {
    const roots = tasks.filter((t) => t.status === col.id && (!t.parentKey || !keys.has(t.parentKey)));
    if (!roots.length) continue;
    console.log(`\n== ${col.label} (${roots.length})`);
    for (const t of roots) print(t, 0);
  }
}

// Bridges a local stdio MCP client (Claude Desktop, Cursor, Claude Code) to the board's /mcp.
async function cmdMcp() {
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    try {
      const out = await post("/mcp", msg, 10000);
      if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
    } catch (err) {
      if (msg.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `agent kanban unreachable at ${BASE}: ${err.message}` } })}\n`);
    }
  }
}

const f = flags(process.argv.slice(2));
// Per-source keys: the key goes to the bot owner privately; only the entry (with its hash) goes in
// AKB_SOURCE_TOKENS. Run on the server; never paste the key into chat, PRs or task text.
function sourceEntry(f, token) {
  if (!f.source || f.source === true) throw new Error("--source is required, e.g. --source claude-code");
  const who = f.agent && f.agent !== true ? `${f.source}@${f.agent}` : String(f.source);
  const entry = `${who}:${hashToken(token)}`;
  parseSourceTokens(entry); // validate before printing
  return entry;
}

async function cmdTokenNew(f) {
  const token = newToken();
  const entry = sourceEntry(f, token);
  console.error("Key (shown once; give it to the bot owner privately):");
  console.log(token);
  console.error(`Add to AKB_SOURCE_TOKENS (comma separated), then restart the board:\n${entry}`);
}

async function cmdTokenHash(f) {
  const token = (await readStdin()).trim();
  if (!token) throw new Error("pipe the key on stdin, e.g. read -rs K && printf %s \"$K\" | akb token-hash --source claude-code");
  if (token.length < MIN_TOKEN_LENGTH) throw new Error(`the key must be at least ${MIN_TOKEN_LENGTH} characters; use akb token-new for a fresh one`);
  console.log(sourceEntry(f, token));
}

const commands = { "token-new": cmdTokenNew, "token-hash": cmdTokenHash, serve: cmdServe, hook: cmdHook, send: cmdSend, run: cmdRun, report: cmdReport, list: cmdList, mcp: cmdMcp };
const fn = commands[f._[0]];
if (!fn) {
  console.log(USAGE);
  process.exit(f._[0] ? 1 : 0);
}
fn(f).catch((err) => {
  console.error(`[akb] ${err.message}`);
  process.exit(1);
});
