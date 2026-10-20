import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { createServer } from "../src/server.js";
import { COLUMNS, normalizeStatus } from "../src/status.js";
import { hashToken, matchSourceToken, parseSourceTokens } from "../src/source-tokens.js";
import { grokTaskEvents } from "../src/pollers/grok-relay.js";

// Test-only keys; real keys never appear in the repo.
const CLAUDE_KEY = "test-claude-key-0001";
const BOT_KEY = "test-bot-key-0002";
const ADMIN = "test-admin-token";
const SOURCE_TOKENS = `claude-code:${hashToken(CLAUDE_KEY)},grok-bot@日川驾驶舱大总管:${hashToken(BOT_KEY)}`;

async function withServer(opts, fn) {
  const store = opts.store || new Store();
  const server = createServer({ store, token: ADMIN, sourceTokens: SOURCE_TOKENS, ...opts });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let id = 0;
  const rpc = async (key, name, args) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
    });
    return { status: res.status, body: res.status === 200 ? await res.json() : null };
  };
  try {
    await fn({ base, store, rpc });
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

// --- planning ---

test("planning is a column between queued and running, labelled 规划中", () => {
  const ids = COLUMNS.map((c) => c.id);
  assert.equal(ids.indexOf("planning"), ids.indexOf("queued") + 1);
  assert.equal(ids.indexOf("running"), ids.indexOf("planning") + 1);
  assert.equal(COLUMNS.find((c) => c.id === "planning").label, "规划中");
  assert.equal(normalizeStatus("planning"), "planning");
  assert.equal(normalizeStatus("规划中"), "planning");
  // Existing mappings are unchanged.
  assert.equal(normalizeStatus("submitted"), "queued");
  assert.equal(normalizeStatus("executing"), "running");
});

test("kanban_report accepts planning", async () => {
  await withServer({}, async ({ rpc, store }) => {
    const { body } = await rpc(ADMIN, "kanban_report", { title: "Design the plan", status: "planning", source: "claude-code" });
    assert.equal(body.result.isError, false);
    assert.equal(store.get(body.result.structuredContent.task_key).status, "planning");
    const list = await rpc(ADMIN, "kanban_list", { status: "planning" });
    assert.equal(list.body.result.structuredContent.tasks.length, 1);
  });
});

test("a placeholder parent follows its most urgent child, planning ranked between running and queued", () => {
  const s = new Store();
  s.apply({ key: "grok-bot:a", parent: "claude-code-web:session_x", status: "queued" });
  assert.equal(s.get("claude-code-web:session_x").status, "queued");
  s.apply({ key: "grok-bot:b", parent: "claude-code-web:session_x", status: "planning" });
  assert.equal(s.get("claude-code-web:session_x").status, "planning");
  s.apply({ key: "grok-bot:c", parent: "claude-code-web:session_x", status: "running" });
  assert.equal(s.get("claude-code-web:session_x").status, "running");
  s.apply({ key: "grok-bot:c", status: "done" });
  assert.equal(s.get("claude-code-web:session_x").status, "planning");
});

test("saved boards load unchanged: statuses and cards stay as they were", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akb-"));
  const old = new Store({ dataDir: dir });
  for (const status of ["queued", "running", "waiting", "review", "done", "failed"]) old.apply({ key: `x:${status}`, title: status, status });
  old.flush();
  const again = new Store({ dataDir: dir });
  for (const status of ["queued", "running", "waiting", "review", "done", "failed"]) {
    assert.equal(again.get(`x:${status}`).status, status);
    assert.equal(again.get(`x:${status}`).agentName, undefined);
  }
});

// --- source keys ---

test("AKB_SOURCE_TOKENS parsing: hashes only, optional bot name, bad entries rejected without echoing them", () => {
  const entries = parseSourceTokens(SOURCE_TOKENS);
  assert.deepEqual(entries.map((e) => [e.source, e.agentName]), [["claude-code", null], ["grok-bot", "日川驾驶舱大总管"]]);
  assert.equal(matchSourceToken(CLAUDE_KEY, entries).source, "claude-code");
  assert.equal(matchSourceToken(BOT_KEY, entries).agentName, "日川驾驶舱大总管");
  assert.equal(matchSourceToken("wrong", entries), null);
  assert.deepEqual(parseSourceTokens(""), []);
  // A pasted key instead of a hash is refused, and the error does not repeat it.
  assert.throws(() => parseSourceTokens(`claude-code:${CLAUDE_KEY}`), (err) => !err.message.includes(CLAUDE_KEY));
  assert.throws(() => parseSourceTokens(`Bad Source:${hashToken("x")}`));
  assert.throws(() => parseSourceTokens(`a:${hashToken("x")},b:${hashToken("x")}`), /repeats/);
});

test("a source key creates cards as its own source; omitting source is fine", async () => {
  await withServer({}, async ({ rpc, store }) => {
    const r = await rpc(CLAUDE_KEY, "kanban_report", { title: "Add planning column", status: "running" });
    const key = r.body.result.structuredContent.task_key;
    assert.match(key, /^claude-code:/);
    assert.equal(store.get(key).kind, "cli");
    const same = await rpc(CLAUDE_KEY, "kanban_report", { title: "x", status: "running", source: "claude-code" });
    assert.equal(same.body.result.isError, false);
  });
});

test("a source key cannot impersonate another source", async () => {
  await withServer({}, async ({ rpc, store }) => {
    const r = await rpc(CLAUDE_KEY, "kanban_report", { title: "Pretend", status: "done", source: "grok-bot" });
    assert.equal(r.body.result.isError, true);
    assert.match(r.body.result.content[0].text, /cannot report as "grok-bot"/);
    assert.equal(store.tasks.size, 0);
  });
});

test("a source key cannot update another source's card, but can nest its own card under it", async () => {
  await withServer({}, async ({ rpc, store }) => {
    store.apply({ key: "grok-bot:r1", title: "Relay task", status: "running" });
    const r = await rpc(CLAUDE_KEY, "kanban_report", { task_key: "grok-bot:r1", status: "done" });
    assert.equal(r.body.result.isError, true);
    assert.equal(store.get("grok-bot:r1").status, "running");
    const child = await rpc(CLAUDE_KEY, "kanban_report", { title: "Handed to Grok: deploy", status: "waiting", parent_key: "grok-bot:r1" });
    assert.equal(store.get(child.body.result.structuredContent.task_key).parentKey, "grok-bot:r1");
  });
});

test("a key bound to a bot name forces that name and refuses another bot's", async () => {
  await withServer({}, async ({ rpc, store }) => {
    const r = await rpc(BOT_KEY, "kanban_report", { title: "Merge PR #23", status: "running" });
    const key = r.body.result.structuredContent.task_key;
    assert.equal(store.get(key).agentName, "日川驾驶舱大总管");
    assert.equal(r.body.result.structuredContent.agent_name, "日川驾驶舱大总管");

    const fake = await rpc(BOT_KEY, "kanban_report", { title: "x", status: "running", agent_name: "乔绎夫助理" });
    assert.equal(fake.body.result.isError, true);
    assert.match(fake.body.result.content[0].text, /cannot report as "乔绎夫助理"/);

    store.apply({ key: "grok-bot:other", title: "Assistant task", status: "running", agent_name: "乔绎夫助理" });
    const steal = await rpc(BOT_KEY, "kanban_report", { task_key: "grok-bot:other", status: "done" });
    assert.equal(steal.body.result.isError, true);
    assert.equal(store.get("grok-bot:other").agentName, "乔绎夫助理");
  });
});

test("AKB_TOKEN keeps its full powers, including any source and agent_name", async () => {
  await withServer({}, async ({ rpc, store }) => {
    const r = await rpc(ADMIN, "kanban_report", { title: "Manual", status: "running", source: "grok-bot", agent_name: "乔绎夫助理" });
    const key = r.body.result.structuredContent.task_key;
    assert.match(key, /^grok-bot:/);
    assert.equal(store.get(key).agentName, "乔绎夫助理");
    assert.equal(store.get(key).kind, "chat");
    const upd = await rpc(ADMIN, "kanban_report", { task_key: key, status: "done" });
    assert.equal(upd.body.result.isError, false);
  });
});

test("source keys only open /mcp, and each key can be revoked on its own", async () => {
  await withServer({}, async ({ base, rpc }) => {
    for (const p of ["/api/tasks", "/api/stream"]) {
      assert.equal((await fetch(`${base}${p}`, { headers: { authorization: `Bearer ${CLAUDE_KEY}` } })).status, 401);
    }
    const ev = await fetch(`${base}/api/events`, { method: "POST", headers: { authorization: `Bearer ${CLAUDE_KEY}`, "content-type": "application/json" }, body: "{}" });
    assert.equal(ev.status, 401);
    assert.equal((await rpc("not-a-key", "kanban_list", {})).status, 401);
    assert.equal((await rpc(CLAUDE_KEY, "kanban_list", {})).status, 200);
  });
  // Revoke only the Claude key: remove its entry.
  const onlyBot = `grok-bot@日川驾驶舱大总管:${hashToken(BOT_KEY)}`;
  await withServer({ sourceTokens: onlyBot }, async ({ rpc }) => {
    assert.equal((await rpc(CLAUDE_KEY, "kanban_list", {})).status, 401);
    assert.equal((await rpc(BOT_KEY, "kanban_list", {})).status, 200);
    assert.equal((await rpc(ADMIN, "kanban_list", {})).status, 200);
  });
});

test("a misconfigured AKB_SOURCE_TOKENS stops the server from starting", () => {
  assert.throws(() => createServer({ store: new Store(), token: ADMIN, sourceTokens: "claude-code:not-a-hash" }), /AKB_SOURCE_TOKENS entry #1/);
});

// --- agent names ---

test("cards without agent_name keep showing the source only; relay hand-offs carry the bot name", () => {
  const s = new Store();
  s.apply({ key: "grok-bot:plain", title: "Old card", status: "running" });
  assert.equal(s.get("grok-bot:plain").agentName, undefined);
  const id = "15ee3b55-0ce7-4244-bed4-0d386611c815";
  const detail = {
    relayTaskId: id, status: "forwarded", updates: [
      { event_id: "u2", status: "forwarded", summary: "已转交日川驾驶舱大总管（1a698906-4fe2-418c-8e6b-e52f17548df1）", at: "2026-10-19T08:01:29.312Z" },
    ],
  };
  for (const ev of grokTaskEvents(detail, { listed: { relayTaskId: id, title: "t" } })) s.apply(ev);
  const [handoff] = s.children(`grok-bot:${id}`);
  assert.equal(handoff.agentName, "日川驾驶舱大总管");
  assert.equal(s.get(`grok-bot:${id}`).agentName, undefined);
});
