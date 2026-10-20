import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWecomClient,
  isWecomWired,
  loadWecomConfig,
  wecomSecretPath,
  writeWecomSecret,
} from "../src/wecom.js";
import {
  SESSION_TTL_MS,
  issueSession,
  issueState,
  signPayload,
  verifySession,
  verifyState,
  verifyPayload,
} from "../src/session.js";

function stubFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts, calls.length);
  };
  return { fetchImpl, calls };
}

test("authorizeUrl builds snsapi_base URL with agentid and redirect", () => {
  const client = createWecomClient({
    corpId: "wwCORP",
    agentId: "1000030",
    secret: "sec",
    publicUrl: "https://relay.example.com/kanban",
  });
  const url = client.authorizeUrl("abc123");
  assert.match(url, /^https:\/\/open\.weixin\.qq\.com\/connect\/oauth2\/authorize\?/);
  assert.match(url, /#wechat_redirect$/);
  const q = new URL(url.replace(/#wechat_redirect$/, "")).searchParams;
  assert.equal(q.get("appid"), "wwCORP");
  assert.equal(q.get("agentid"), "1000030");
  assert.equal(q.get("scope"), "snsapi_base");
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("state"), "abc123");
  assert.equal(q.get("redirect_uri"), "https://relay.example.com/kanban/auth/wecom/callback");
});

test("gettoken caches until TTL-300s; getuserinfo returns userid", async () => {
  let tokenCalls = 0;
  const { fetchImpl, calls } = stubFetch((url) => {
    if (url.includes("/gettoken")) {
      tokenCalls++;
      return {
        json: async () => ({ errcode: 0, access_token: "tok-AAA", expires_in: 7200 }),
      };
    }
    if (url.includes("/auth/getuserinfo")) {
      assert.match(url, /access_token=tok-AAA/);
      assert.match(url, /code=oauth-code/);
      return { json: async () => ({ errcode: 0, userid: "QiaoYiFu" }) };
    }
    throw new Error(`unexpected url ${url}`);
  });
  const client = createWecomClient({
    corpId: "wwCORP",
    agentId: "1000030",
    secret: "super-secret-value",
    publicUrl: "https://relay.example.com/kanban",
    fetchImpl,
  });
  assert.equal(await client.gettoken(), "tok-AAA");
  assert.equal(await client.gettoken(), "tok-AAA");
  assert.equal(tokenCalls, 1);
  assert.equal(await client.getuserinfo("oauth-code"), "QiaoYiFu");
  assert.equal(tokenCalls, 1);
  assert.equal(calls.length, 2);
});

test("gettoken/getuserinfo errors never include secret, access_token, or code", async () => {
  const secret = "SUPER_SECRET_XYZ";
  const code = "CODE_SHOULD_NOT_LEAK";
  const accessToken = "ACCESS_TOKEN_LEAK";
  const { fetchImpl } = stubFetch((url) => {
    if (url.includes("/gettoken")) {
      return { json: async () => ({ errcode: 0, access_token: accessToken, expires_in: 7200 }) };
    }
    return { json: async () => ({ errcode: 50001, errmsg: "redirect_uri not match" }) };
  });
  const client = createWecomClient({
    corpId: "wwCORP",
    agentId: "1000030",
    secret,
    publicUrl: "https://relay.example.com/kanban",
    fetchImpl,
  });
  await assert.rejects(() => client.getuserinfo(code), (err) => {
    const msg = String(err.message);
    assert.equal(msg.includes(secret), false);
    assert.equal(msg.includes(accessToken), false);
    assert.equal(msg.includes(code), false);
    assert.match(msg, /errcode=50001/);
    return true;
  });
});

test("getuserinfo without userid is treated as failure", async () => {
  const { fetchImpl } = stubFetch((url) => {
    if (url.includes("/gettoken")) {
      return { json: async () => ({ errcode: 0, access_token: "t", expires_in: 7200 }) };
    }
    return { json: async () => ({ errcode: 0, openid: "ext" }) };
  });
  const client = createWecomClient({
    corpId: "c",
    agentId: "1",
    secret: "s",
    publicUrl: "https://example.com/kanban",
    fetchImpl,
  });
  await assert.rejects(() => client.getuserinfo("c"), /no userid/);
});

test("loadWecomConfig: env secret beats wecom.json; wired needs all fields", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akb-wecom-"));
  writeWecomSecret(dir, "from-file");
  const envFile = {
    AKB_WECOM_CORP_ID: "corp",
    AKB_WECOM_AGENT_ID: "1000030",
    AKB_PUBLIC_URL: "https://relay.example.com/kanban",
    AKB_WECOM_USERS: "QiaoYiFu,Other",
    AKB_SESSION_SECRET: "sess",
  };
  const fromFile = loadWecomConfig({ env: envFile, dataDir: dir });
  assert.equal(fromFile.secret, "from-file");
  assert.equal(fromFile.secretFromFile, true);
  assert.deepEqual(fromFile.users, ["QiaoYiFu", "Other"]);
  assert.equal(isWecomWired(fromFile), true);

  const fromEnv = loadWecomConfig({ env: { ...envFile, AKB_WECOM_SECRET: "from-env" }, dataDir: dir });
  assert.equal(fromEnv.secret, "from-env");
  assert.equal(fromEnv.secretFromFile, false);

  assert.equal(isWecomWired(loadWecomConfig({ env: { ...envFile }, dataDir: dir + "-missing" })), false);
  assert.equal(isWecomWired(loadWecomConfig({ env: { ...envFile, AKB_SESSION_SECRET: "" }, dataDir: dir })), false);
});

test("writeWecomSecret is 0600 and refuses second write", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akb-wecom-"));
  const file = writeWecomSecret(dir, "once-only");
  assert.equal(file, wecomSecretPath(dir));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).secret, "once-only");
  assert.throws(() => writeWecomSecret(dir, "again"), (err) => err.code === "EEXIST");
});

test("session HMAC verify rejects forgery, expiry, and tampering", () => {
  const secret = "session-secret-key";
  const tok = issueSession(secret, "QiaoYiFu");
  assert.equal(verifySession(secret, tok).uid, "QiaoYiFu");
  assert.equal(verifySession("wrong", tok), null);
  assert.equal(verifySession(secret, tok.slice(0, -2) + "xx"), null);
  const expired = signPayload(secret, { uid: "QiaoYiFu", exp: Date.now() - 1000 });
  assert.equal(verifySession(secret, expired), null);
  const { state, cookie } = issueState(secret);
  assert.equal(verifyState(secret, cookie, state), true);
  assert.equal(verifyState(secret, cookie, "nope"), false);
  assert.equal(verifyPayload(secret, null), null);
  assert.ok(SESSION_TTL_MS >= 12 * 60 * 60 * 1000 - 1);
});
