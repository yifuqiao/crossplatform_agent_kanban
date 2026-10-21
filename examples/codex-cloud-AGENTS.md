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

每次上报都先定义这个函数（每条命令在新的 shell 里跑，函数不会保留）。它用 `python3` 编码 JSON，
标题和摘要里有引号、反斜杠或换行也没关系：

```bash
akb() { python3 -c 'import json,sys; k,s,t,m=sys.argv[1:5]; print(json.dumps({"key":k,"kind":"cloud","status":s,t:m}))' "$(cat /tmp/akb-key)" "$1" "$2" "$3" \
  | curl -fsS -m 10 -X POST "$AKB_URL/api/events" -H "Authorization: Bearer $AKB_SOURCE_KEY" -H 'content-type: application/json' --data-binary @- >/dev/null 2>&1 || true; }
```

**第一件事就是开工上报**：在读代码、装依赖、跑任何别的命令之前，在同一条命令里定义上面的函数并跑下面两行（标题写清楚这次做什么）。用户在看板上等这张卡出现，不要拖到最后和完工一起报：

```bash
echo "codex-cloud:$(date +%Y%m%d%H%M%S)-$RANDOM" > /tmp/akb-key
akb running title "<这次做什么>"
```

做完时：

```bash
akb review summary "<一两句结果>"
```

改完代码、等用户看 diff 或开 PR 时用 `review`，卡片会进「审核中」。做不下去用 `failed`，`summary` 写原因；需要用户回答才能继续用 `waiting`。
