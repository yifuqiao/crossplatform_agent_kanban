# Grok Bot：让看板看清你的任务状态

看板自己轮询 relay（`GET /tasks`、`GET /tasks/<id>`），从你写进 relay 的进展里读状态。
**你不需要往看板发任何东西，也不需要接 MCP**；每个任务多花的 token 为零。
看板只能看到你写进 relay 的那几条进展，所以状态词要写对。把下面这段加进分拣 bot 和执行 bot（例如大总管）的提示词。

## 提示词（直接贴）

```text
每个 relay 任务的进展都会显示在看板上，看板只看 relay 里的状态词，不看你在聊天里说了什么。按下面写：

1. 开工写 executing，一句话说在做什么。
2. 在等人的时候写 waiting_approval，并在 summary 里写清等谁、等什么，例如「等乔总对来源钥匙点头」「等提供 FTP 凭据」。
   等代码二审 bot 时可以继续写 executing，但 summary 里写「待二审 allow」。
3. 任务结束时必须再发一条 finished 或 failed，summary 写结果；有 PR 写 PR 链接，部署了写部署的 commit。
   这一条不能省：包括「做完了」「决定不做了」「被新任务取代了」「换成别的任务继续」，都要收尾。
   被取代时写 failed，summary 写「被 <新任务 id 前 8 位> 取代」。
4. 重新提交同一件事时，新任务标题写「（取代 <旧任务 id 前 8 位>）」。
5. 不要为了让看板显示而额外发心跳或重复进展；没变化就不用写。
```

## 看板会怎么显示

| 你在 relay 里写的 | 看板上 |
| --- | --- |
| `received` | 排队 |
| `forwarded`，summary 带 bot 名和 id | 进行中，卡片 Agent 显示那个 bot |
| `executing` | 进行中 |
| `executing`，summary 含「待二审 / 等…allow」 | 进行中，标「等代码二审」 |
| `waiting_approval`，或 summary 含「等乔总 / 点头 / 待提供 / 等…授权、确认、凭据」 | 等您 |
| 24 小时没有新进展 | 等您：请用户判断是不是已经做完 |
| `finished` / `failed` | 完成 / 失败 |

## Cursor cloud agents

在进展里提到 `bc-…` agent id 就行：看板把它挂在任务下面，Cursor 轮询器自己查它的状态和 PR。

## 可选：更细的内部步骤

只有确实需要把内部步骤拆成子卡时，才用 grok-bot 来源钥匙往 `POST {AKB_URL}/api/events` 上报，
`key` 用 `grok-bot:<relay_task_id>/<步骤>`，`parent` 用 `grok-bot:<relay_task_id>`。默认不做，因为每次上报都花 token。
钥匙由看板管理员用 `akb token-new --source grok-bot` 生成后私下交付，不能出现在任务文本或聊天里。
