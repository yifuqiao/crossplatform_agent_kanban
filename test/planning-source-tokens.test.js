import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { createServer } from "../src/server.js";
import { COLUMNS, normalizeStatus } from "../src/status.js";
import { hashToken, matchSourceToken, parseSourceTokens, MIN_TOKEN_LENGTH } from "../src/source-tokens.js";
import { grokTaskEvents } from "../src/pollers/grok-relay.js";

// Test-only keys; real keys never appear in the repo.
const CLAUDE_KEY = "test-claude-key-0001-padded-to-32-chars";
const BOT_KEY = "test-bot-key-0002-padded-to-32-chars-x";
const ADMIN = "test-admin-token-padded-to-32-chars-x";
const SOURCE_TOKENS = `claude-code:${hashToken(CLAUDE_KEY)},grok-bot@示例机器人:${hashToken(BOT_KEY)}`;

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
  assert.deepEqual(entries.map((e) => [e.source, e.agentName]), [["claude-code", null], ["grok-bot", "示例机器人"]]);
  assert.equal(matchSourceToken(CLAUDE_KEY, entries).source, "claude-code");
  assert.equal(matchSourceToken(BOT_KEY, entries).agentName, "示例机器人");
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

test("a source key cannot update another source's card", async () => {
  await withServer({}, async ({ rpc, store }) => {
    store.apply({ key: "grok-bot:r1", title: "Relay task", status: "running" });
    const r = await rpc(CLAUDE_KEY, "kanban_report", { task_key: "grok-bot:r1", status: "done" });
    assert.equal(r.body.result.isError, true);
    assert.equal(store.get("grok-bot:r1").status, "running");
  });
});

// --- B1: reads are limited to the key's own source (and bot) ---

test("kanban_list with a source key returns only that source's cards; a bound key only its bot's", async () => {
  await withServer({}, async ({ rpc, store }) => {
    store.apply({ key: "grok-bot:r1", title: "Relay task", status: "running" });
    store.apply({ key: "grok-bot:other", title: "Other bot", status: "running", agent_name: "assistant-bot" });
    store.apply({ key: "cursor:a1", title: "Cursor agent", status: "running" });
    const mine = await rpc(CLAUDE_KEY, "kanban_report", { title: "Mine", status: "running" });
    const botCard = await rpc(BOT_KEY, "kanban_report", { title: "Bot work", status: "running" });

    const claude = (await rpc(CLAUDE_KEY, "kanban_list", {})).body.result.structuredContent.tasks.map((t) => t.task_key);
    assert.deepEqual(claude, [mine.body.result.structuredContent.task_key]);

    const bot = (await rpc(BOT_KEY, "kanban_list", {})).body.result.structuredContent.tasks.map((t) => t.task_key);
    assert.deepEqual(bot, [botCard.body.result.structuredContent.task_key]);

    const all = (await rpc(ADMIN, "kanban_list", {})).body.result.structuredContent.tasks;
    assert.equal(all.length, 5);
  });
});

test("kanban_get with a source key on another source's (or bot's) card returns No task", async () => {
  await withServer({}, async ({ rpc, store }) => {
    store.apply({ key: "grok-bot:r1", title: "Relay task", status: "running", message: "secret detail" });
    store.apply({ key: "grok-bot:other", title: "Other bot", status: "running", agent_name: "assistant-bot" });
    for (const [key, task] of [[CLAUDE_KEY, "grok-bot:r1"], [BOT_KEY, "grok-bot:r1"], [BOT_KEY, "grok-bot:other"]]) {
      const r = await rpc(key, "kanban_get", { task_key: task });
      assert.equal(r.body.result.isError, true);
      assert.equal(r.body.result.content[0].text, `No task ${task}.`);
    }
    assert.equal((await rpc(ADMIN, "kanban_get", { task_key: "grok-bot:r1" })).body.result.isError, false);
  });
});

// --- B2: parent_key cannot conjure cards of another source ---

test("a source key cannot nest under a missing card or another source's card, and no placeholder appears", async () => {
  await withServer({}, async ({ rpc, store }) => {
    store.apply({ key: "grok-bot:r1", title: "Relay task", status: "running" });
    for (const parent_key of ["grok-bot:does-not-exist", "cursor:made-up", "grok-bot:r1", "claude-code:does-not-exist"]) {
      const r = await rpc(CLAUDE_KEY, "kanban_report", { title: "Child", status: "running", parent_key });
      assert.equal(r.body.result.isError, true, parent_key);
      assert.match(r.body.result.content[0].text, /parent_key must be an existing "claude-code" card/);
    }
    assert.deepEqual([...store.tasks.keys()], ["grok-bot:r1"]);

    const parent = (await rpc(CLAUDE_KEY, "kanban_report", { title: "Parent", status: "running" })).body.result.structuredContent.task_key;
    const child = await rpc(CLAUDE_KEY, "kanban_report", { title: "Child", status: "queued", parent_key: parent });
    assert.equal(store.get(child.body.result.structuredContent.task_key).parentKey, parent);
    // Re-parenting an own card onto someone else's is refused too.
    const move = await rpc(CLAUDE_KEY, "kanban_report", { task_key: child.body.result.structuredContent.task_key, status: "running", parent_key: "grok-bot:r1" });
    assert.equal(move.body.result.isError, true);
    assert.equal(store.get(child.body.result.structuredContent.task_key).parentKey, parent);
  });
});

// --- B3: keys only change cards they created through MCP ---

test("a bot-bound key cannot take over a poller card with no agent_name", async () => {
  await withServer({}, async ({ rpc, store }) => {
    // What the relay poller creates: source grok-bot, no agent name.
    store.apply({ key: "grok-bot:relay-1", title: "Relay task", status: "running", at: "2026-10-20T08:00:00.000Z" });
    const r = await rpc(BOT_KEY, "kanban_report", { task_key: "grok-bot:relay-1", status: "done", agent_name: "示例机器人" });
    assert.equal(r.body.result.isError, true);
    assert.equal(store.get("grok-bot:relay-1").status, "running");
    assert.equal(store.get("grok-bot:relay-1").agentName, undefined);
    // The relay's later real status still lands.
    store.apply({ key: "grok-bot:relay-1", status: "waiting", at: "2026-10-20T08:05:00.000Z" });
    assert.equal(store.get("grok-bot:relay-1").status, "waiting");
  });
});

test("a source key cannot change a same-source card made by a hook, or one made by another key", async () => {
  const both = `${SOURCE_TOKENS},claude-code@helper:${hashToken(BOT_KEY + "-helper")}`;
  await withServer({ sourceTokens: both }, async ({ rpc, store }) => {
    store.apply({ key: "claude-code:session-1", title: "From the hook", status: "running" });
    const hook = await rpc(CLAUDE_KEY, "kanban_report", { task_key: "claude-code:session-1", status: "failed" });
    assert.equal(hook.body.result.isError, true);
    assert.match(hook.body.result.content[0].text, /only update cards it created/);
    assert.equal(store.get("claude-code:session-1").status, "running");

    // A card made by the bound claude-code@helper key is not the unbound claude-code key's to change.
    const made = await rpc(BOT_KEY + "-helper", "kanban_report", { title: "Helper card", status: "running" });
    const key = made.body.result.structuredContent.task_key;
    assert.equal(store.get(key).createdBy, "mcp:claude-code@helper");
    const steal = await rpc(CLAUDE_KEY, "kanban_report", { task_key: key, status: "done" });
    assert.equal(steal.body.result.isError, true);
    assert.equal(store.get(key).status, "running");

    // The admin token can still change all of them.
    assert.equal((await rpc(ADMIN, "kanban_report", { task_key: "claude-code:session-1", status: "done" })).body.result.isError, false);
    assert.equal((await rpc(ADMIN, "kanban_report", { task_key: key, status: "done" })).body.result.isError, false);
  });
});

test("a source key can keep updating the cards it created", async () => {
  await withServer({}, async ({ rpc, store }) => {
    const r = await rpc(CLAUDE_KEY, "kanban_report", { title: "Mine", status: "running" });
    const key = r.body.result.structuredContent.task_key;
    assert.equal(store.get(key).createdBy, "mcp:claude-code");
    const done = await rpc(CLAUDE_KEY, "kanban_report", { task_key: key, status: "done", summary: "ok" });
    assert.equal(done.body.result.isError, false);
    assert.equal(store.get(key).status, "done");
  });
});

// --- input hygiene ---

test("keys shorter than 32 characters never match", () => {
  assert.equal(MIN_TOKEN_LENGTH, 32);
  const short = "a".repeat(31);
  const entries = parseSourceTokens(`claude-code:${hashToken(short)},cursor:${hashToken("b".repeat(32))}`);
  assert.equal(matchSourceToken(short, entries), null);
  assert.equal(matchSourceToken("b".repeat(32), entries).source, "cursor");
});

test("a non-string source gets a plain validation error, not an internal one", async () => {
  await withServer({}, async ({ rpc, store }) => {
    for (const key of [CLAUDE_KEY, ADMIN]) {
      const r = await rpc(key, "kanban_report", { title: "x", status: "running", source: { toLowerCase: 1 } });
      assert.equal(r.body.result.isError, true);
      assert.equal(r.body.result.content[0].text, "source must be a string.");
    }
    assert.equal(store.tasks.size, 0);
  });
});

test("an invalid status is refused before any card, or placeholder parent, is created", async () => {
  await withServer({}, async ({ rpc, store }) => {
    const r = await rpc(ADMIN, "kanban_report", { title: "x", status: "bogus", parent_key: "chat:ghost-parent" });
    assert.equal(r.body.result.isError, true);
    assert.match(r.body.result.content[0].text, /status must be one of/);
    assert.equal(store.tasks.size, 0);
  });
  const s = new Store();
  assert.throws(() => s.apply({ key: "chat:ghost", status: "bogus" }), /unknown status/);
  assert.equal(s.tasks.size, 0);
});

test("a key bound to a bot name forces that name and refuses another bot's", async () => {
  await withServer({}, async ({ rpc, store }) => {
    const r = await rpc(BOT_KEY, "kanban_report", { title: "Merge PR #23", status: "running" });
    const key = r.body.result.structuredContent.task_key;
    assert.equal(store.get(key).agentName, "示例机器人");
    assert.equal(r.body.result.structuredContent.agent_name, "示例机器人");

    const fake = await rpc(BOT_KEY, "kanban_report", { title: "x", status: "running", agent_name: "assistant-bot" });
    assert.equal(fake.body.result.isError, true);
    assert.match(fake.body.result.content[0].text, /cannot report as "assistant-bot"/);

    store.apply({ key: "grok-bot:other", title: "Assistant task", status: "running", agent_name: "assistant-bot" });
    const steal = await rpc(BOT_KEY, "kanban_report", { task_key: "grok-bot:other", status: "done" });
    assert.equal(steal.body.result.isError, true);
    assert.equal(store.get("grok-bot:other").agentName, "assistant-bot");
  });
});

test("AKB_TOKEN keeps its full powers, including any source and agent_name", async () => {
  await withServer({}, async ({ rpc, store }) => {
    const r = await rpc(ADMIN, "kanban_report", { title: "Manual", status: "running", source: "grok-bot", agent_name: "assistant-bot" });
    const key = r.body.result.structuredContent.task_key;
    assert.match(key, /^grok-bot:/);
    assert.equal(store.get(key).agentName, "assistant-bot");
    assert.equal(store.get(key).kind, "chat");
    const upd = await rpc(ADMIN, "kanban_report", { task_key: key, status: "done" });
    assert.equal(upd.body.result.isError, false);
  });
});

test("source keys only open /mcp and /api/events, and each key can be revoked on its own", async () => {
  await withServer({}, async ({ base, rpc }) => {
    for (const p of ["/api/tasks", "/api/stream"]) {
      assert.equal((await fetch(`${base}${p}`, { headers: { authorization: `Bearer ${CLAUDE_KEY}` } })).status, 401);
    }
    for (const p of ["/api/tasks/claude-code:x/update", "/api/tasks/claude-code:x/choice"]) {
      assert.equal((await fetch(`${base}${p}`, { method: "POST", headers: { authorization: `Bearer ${CLAUDE_KEY}` } })).status, 401);
    }
    const viaQuery = await fetch(`${base}/api/events?token=${CLAUDE_KEY}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "claude-code:q", status: "running" }) });
    assert.equal(viaQuery.status, 401);
    assert.equal((await rpc("not-a-key", "kanban_list", {})).status, 401);
    assert.equal((await rpc(CLAUDE_KEY, "kanban_list", {})).status, 200);
  });
  // Revoke only the Claude key: remove its entry.
  const onlyBot = `grok-bot@示例机器人:${hashToken(BOT_KEY)}`;
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

test("cards without agent_name keep showing the source only; a relay hand-off names the task's bot", () => {
  const s = new Store();
  s.apply({ key: "grok-bot:plain", title: "Old card", status: "running" });
  assert.equal(s.get("grok-bot:plain").agentName, undefined);
  const id = "15ee3b55-0ce7-4244-bed4-0d386611c815";
  const detail = {
    relayTaskId: id, status: "forwarded", updates: [
      { event_id: "u2", status: "forwarded", summary: "已转交示例机器人（1a698906-4fe2-418c-8e6b-e52f17548df1）", at: "2026-10-19T08:01:29.312Z" },
    ],
  };
  for (const ev of grokTaskEvents(detail, { listed: { relayTaskId: id, title: "t" } })) s.apply(ev);
  assert.equal(s.children(`grok-bot:${id}`).length, 0, "a hand-off is not a card of its own");
  assert.equal(s.get(`grok-bot:${id}`).agentName, "示例机器人");
});

test("a per-source key only sees Get update requests on cards it can answer", async () => {
  await withServer({}, async ({ rpc, store }) => {
    const mine = (await rpc(CLAUDE_KEY, "kanban_report", { title: "Mine", status: "running" })).body.result.structuredContent.task_key;
    store.apply({ key: "claude-code:polled", status: "running", title: "From the hook" });
    store.apply({ key: "grok-bot:other", status: "running", title: "Other source" });
    for (const k of [mine, "claude-code:polled", "grok-bot:other"]) store.requestUpdate(k);

    const keys = (r) => r.body.result.structuredContent.update_requests.map((t) => t.task_key).sort();
    assert.deepEqual(keys(await rpc(CLAUDE_KEY, "kanban_update_requests", {})), [mine]);
    assert.deepEqual(keys(await rpc(CLAUDE_KEY, "kanban_update_requests", { source: "grok-bot" })), []);
    assert.deepEqual(keys(await rpc(ADMIN, "kanban_update_requests", {})), [mine, "claude-code:polled", "grok-bot:other"].sort());

    const answered = await rpc(CLAUDE_KEY, "kanban_report", { task_key: mine, status: "running", summary: "Halfway there" });
    assert.deepEqual(keys(answered), []);
    assert.equal(store.get(mine).updateRequest, null);
  });
});

// --- hooks with a per-source key on /api/events ---

const postEvents = (base, key, body) => fetch(`${base}/api/events`, {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("a source key can post hook events for its own source", async () => {
  await withServer({}, async ({ base, store }) => {
    const res = await postEvents(base, CLAUDE_KEY, [
      { source: "claude-code", external_id: "s1", status: "running", title: "Fix bug", created_by: "mcp:claude-code" },
      { source: "claude-code", external_id: "s1/t1", parent: "claude-code:s1", status: "running", title: "Subagent" },
    ]);
    assert.equal(res.status, 200);
    const card = store.get("claude-code:s1");
    assert.equal(card.status, "running");
    assert.equal(card.createdBy, undefined, "created_by is ignored for source keys");
    assert.equal(store.get("claude-code:s1/t1").parentKey, "claude-code:s1");
    const done = await postEvents(base, CLAUDE_KEY, { key: "claude-code:s1", status: "done" });
    assert.equal(done.status, 200);
    assert.equal(store.get("claude-code:s1").status, "done");
  });
});

test("a source key cannot write other sources, other bots, or MCP-created cards", async () => {
  await withServer({}, async ({ base, store, rpc }) => {
    store.apply({ key: "grok-bot:r1", title: "Deploy", status: "running" });
    let res = await postEvents(base, CLAUDE_KEY, { key: "grok-bot:r1", status: "done" });
    assert.equal(res.status, 400);
    assert.equal(store.get("grok-bot:r1").status, "running");

    res = await postEvents(base, CLAUDE_KEY, { source: "claude-code", external_id: "s2", parent: "grok-bot:r2", status: "running" });
    assert.equal(res.status, 400);
    assert.equal(store.get("grok-bot:r2"), null, "no placeholder in another source");
    assert.equal(store.get("claude-code:s2"), null);

    const made = await rpc(CLAUDE_KEY, "kanban_report", { title: "MCP card", status: "running" });
    const mcpKey = made.body.result.structuredContent.task_key;
    res = await postEvents(base, CLAUDE_KEY, { key: mcpKey, status: "failed" });
    assert.equal(res.status, 400);
    res = await postEvents(base, CLAUDE_KEY, { source: "claude-code", external_id: ` ${mcpKey.slice("claude-code:".length)} `, status: "failed" });
    assert.equal(res.status, 400);
    res = await postEvents(base, CLAUDE_KEY, { key: mcpKey.replace("claude-code", "Claude-Code"), status: "failed" });
    assert.equal(res.status, 400);
    assert.equal(store.get(mcpKey).status, "running");

    store.apply({ key: "grok-bot:other", title: "Other bot", status: "running", agent_name: "assistant-bot" });
    res = await postEvents(base, BOT_KEY, { key: "grok-bot:other", status: "done" });
    assert.equal(res.status, 400);
    res = await postEvents(base, BOT_KEY, { key: "grok-bot:mine", status: "running", agent_name: "assistant-bot" });
    assert.equal(res.status, 400);
    res = await postEvents(base, BOT_KEY, { key: "grok-bot:mine", status: "running" });
    assert.equal(res.status, 200);
    assert.equal(store.get("grok-bot:mine").agentName, "示例机器人");

    // A bot-bound key cannot claim an unassigned card (e.g. a relay root), but can nest under it.
    store.apply({ key: "grok-bot:relay1", title: "Relay task", status: "running" });
    res = await postEvents(base, BOT_KEY, { key: "grok-bot:relay1", status: "done", title: "hijack" });
    assert.equal(res.status, 400);
    assert.equal(store.get("grok-bot:relay1").status, "running");
    assert.equal(store.get("grok-bot:relay1").agentName, undefined);
    res = await postEvents(base, BOT_KEY, { key: "grok-bot:relay1/step", parent: "grok-bot:relay1", status: "running" });
    assert.equal(res.status, 200);
    assert.equal(store.get("grok-bot:relay1/step").parentKey, "grok-bot:relay1");

    const mixed = await postEvents(base, CLAUDE_KEY, [{ key: "claude-code:ok", status: "running" }, { key: "cursor:x", status: "running" }]);
    assert.equal(mixed.status, 207);
    assert.equal(store.get("cursor:x"), null);
  });
});
