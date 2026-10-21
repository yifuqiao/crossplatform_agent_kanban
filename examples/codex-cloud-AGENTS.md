<!--
Codex cloud (chatgpt.com/codex) tasks: paste this section into the repository's AGENTS.md.
The cloud environment needs:
  - environment variable AKB_URL=https://relay.onetopway.com/kanban
  - environment variable AKB_SOURCE_KEY = a key made with `akb token-new --source codex-cloud`
    (an environment variable, not a "secret": secrets are removed before the agent runs)
  - agent internet access on, with relay.onetopway.com in the allowed domains
Nothing here can block the task: every call is best-effort and its errors are ignored.
-->

## 看板上报（agent-kanban）

如果环境里有 `AKB_URL` 和 `AKB_SOURCE_KEY`，把这次任务报到看板上；没有就跳过，照常干活，不要去找或索要钥匙。
钥匙只从环境变量读，不能写进代码、提交信息、PR 或回复里。

开工时先运行（标题写清楚这次做什么）：

```bash
echo "codex-cloud:$(date +%Y%m%d%H%M%S)-$RANDOM" > /tmp/akb-key
akb() { curl -fsS -m 10 -X POST "$AKB_URL/api/events" -H "Authorization: Bearer $AKB_SOURCE_KEY" -H 'content-type: application/json' -d "$1" >/dev/null 2>&1 || true; }
akb "{\"key\":\"$(cat /tmp/akb-key)\",\"kind\":\"cloud\",\"status\":\"running\",\"title\":\"<这次做什么>\"}"
```

做完时（`status` 用 `done`；做不下去用 `failed`，`summary` 写原因；需要用户回答才能继续用 `waiting`）：

```bash
akb() { curl -fsS -m 10 -X POST "$AKB_URL/api/events" -H "Authorization: Bearer $AKB_SOURCE_KEY" -H 'content-type: application/json' -d "$1" >/dev/null 2>&1 || true; }
akb "{\"key\":\"$(cat /tmp/akb-key)\",\"status\":\"review\",\"summary\":\"<一两句结果>\"}"
```

改完代码、等用户看 diff 或开 PR 时用 `review`，不要用 `done`：卡片会进「审核中」。
