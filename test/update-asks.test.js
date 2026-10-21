import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";
import { createServer } from "../src/server.js";
import { hashToken } from "../src/source-tokens.js";
import { askHookOutput, clearAsk, readAsk, recordAsks } from "../src/asks.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
// Test-only keys; real keys never appear in the repo.
const ADMIN = "test-admin-token-padded-to-32-chars-x";
const WEB_KEY = "test-web-key-0003-padded-to-32-chars-x";

async function withServer(fn) {
  const store = new Store();
  const server = createServer({ store, token: ADMIN, sourceTokens: `claude-code-web:${hashToken(WEB_KEY)}` });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`, store);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail("timed out");
}

test("asks: the board's reply is kept per card and handed to the session once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akb-asks-"));
  const key = "claude-code-web:session_A";
  recordAsks({ ok: true, key, update_requests: [{ task_key: key, requested_at: "2026-10-21T04:00:00.000Z", due_at: "2026-10-21T04:10:00.000Z" }] }, dir);
  assert.equal(readAsk(dir, key).due_at, "2026-10-21T04:10:00.000Z");

  assert.equal(askHookOutput({ hook_event_name: "PreToolUse" }, key, { dir, cli: "/x/cli.js" }), null, "PreToolUse cannot add context");
  assert.equal(askHookOutput({ hook_event_name: "Stop", stop_hook_active: true }, key, { dir, cli: "/x/cli.js" }), null, "never block a Stop twice in a row");
  const out = askHookOutput({ hook_event_name: "PostToolUse" }, key, { dir, cli: "/x/cli.js" });
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(out.hookSpecificOutput.additionalContext, /node "\/x\/cli\.js" report --key "claude-code-web:session_A" --brief --summary/);
  assert.equal(askHookOutput({ hook_event_name: "Stop" }, key, { dir, cli: "/x/cli.js" }), null, "told once");

  // The same request again changes nothing; a reply made after it without it closes it.
  recordAsks({ ok: true, key, update_requests: [{ task_key: key, requested_at: "2026-10-21T04:00:00.000Z" }] }, dir);
  assert.ok(readAsk(dir, key).notified_at);
  recordAsks({ results: [{ ok: true, key }], update_requests: [], at: "2026-10-21T04:05:00.000Z" }, dir);
  assert.equal(readAsk(dir, key).done, true);
});

test("asks: replies that arrive out of order neither drop a new ask nor bring back an answered one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akb-asks-"));
  const key = "claude-code-web:session_B";
  const asked = { task_key: key, requested_at: "2026-10-21T04:00:00.000Z" };
  recordAsks({ ok: true, key, update_requests: [asked], at: "2026-10-21T04:00:05.000Z" }, dir);
  // A reply made before the click, delivered late.
  recordAsks({ ok: true, key, update_requests: [], at: "2026-10-21T03:59:59.000Z" }, dir);
  assert.equal(readAsk(dir, key).done, false);
  // The session answers; a late reply that still lists the ask does not reopen it.
  clearAsk(dir, key);
  recordAsks({ ok: true, key, update_requests: [asked], at: "2026-10-21T04:00:07.000Z" }, dir);
  assert.equal(readAsk(dir, key).done, true);
  assert.equal(askHookOutput({ hook_event_name: "Stop" }, key, { dir, cli: "/x/cli.js" }), null);
  // A newer request is a new ask.
  recordAsks({ ok: true, key, update_requests: [{ ...asked, requested_at: "2026-10-21T05:00:00.000Z" }] }, dir);
  assert.ok(askHookOutput({ hook_event_name: "Stop" }, key, { dir, cli: "/x/cli.js" }));
});

test("Get update on a cloud Claude Code card reaches the session through its hook and comes back as a brief", async () => {
  await withServer(async (base, store) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "akb-home-"));
    const env = { PATH: process.env.PATH, HOME: home, AKB_HOME: home, AKB_URL: base, AKB_SOURCE_KEY: WEB_KEY, CLAUDE_CODE_REMOTE_SESSION_ID: "cse_T1" };
    const key = "claude-code-web:session_T1";
    const hook = (payload) => spawnSync(process.execPath, [CLI, "hook", "claude-code"], { env, input: JSON.stringify({ session_id: "local", cwd: "/repo", ...payload }), encoding: "utf8" });

    hook({ hook_event_name: "UserPromptSubmit", prompt: "修一下导出" });
    await until(() => store.get(key));

    const ask = await fetch(`${base}/api/tasks/${encodeURIComponent(key)}/update-request`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } });
    assert.equal(ask.status, 200);
    assert.equal((await ask.json()).updateRequest.via, "hook");

    // The next hook's send brings the request back; the one after hands it to the session.
    assert.equal(hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }).stdout, "");
    await until(() => fs.existsSync(path.join(home, "asks")) && fs.readdirSync(path.join(home, "asks")).length);
    const stop = JSON.parse(hook({ hook_event_name: "Stop" }).stdout);
    assert.equal(stop.decision, "block");
    assert.ok(stop.reason.includes(`--key "${key}" --brief`));
    assert.equal(hook({ hook_event_name: "Stop" }).stdout, "", "only once");

    // What the session runs (async: the board lives in this process).
    await promisify(execFile)(process.execPath, [CLI, "report", "--key", key, "--brief", "--summary", "导出修好一半，下一步补测试", "--needs-you", "确认导出格式"], { env });
    assert.equal(store.get(key).updateRequest, null);
    assert.equal(store.get(key).summary, "导出修好一半，下一步补测试");
    assert.equal(store.get(key).needsYou.text, "确认导出格式");
    const [tomb] = fs.readdirSync(path.join(home, "asks"));
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, "asks", tomb), "utf8")).done, true);
  });
});

test("Get update is refused for a card nobody can answer", async () => {
  await withServer(async (base, store) => {
    store.apply({ key: "codex:x", status: "running", title: "Codex hook" });
    const res = await fetch(`${base}/api/tasks/${encodeURIComponent("codex:x")}/update-request`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}` } });
    assert.equal(res.status, 409);
    assert.equal(store.get("codex:x").updateRequest, undefined);
  });
});
