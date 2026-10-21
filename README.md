# Cross-platform Agent Kanban

一块看板，看到你从各个 agent 窗口发起的所有任务：

| 类型 | 平台 | 接入方式 | 能看到什么 |
| --- | --- | --- | --- |
| CLI | **Claude Code** | hooks → `akb hook claude-code` | 每个会话一张卡；运行中 / 等你批准 / 一轮结束；**subagent 作为子卡** |
| CLI | **Codex CLI** | hooks → `akb hook codex` | 每个会话一张卡；运行中 / 等你批准 / 一轮结束 / 子 agent / 开了 PR |
| 云端 | **Codex cloud**（chatgpt.com/codex） | `AGENTS.md` 约定 + `POST /api/events` | 开工、做完、失败（靠 agent 照约定上报） |
| IDE/CLI | **Cursor**（编辑器 agent 和 `cursor-agent`） | `.cursor/hooks.json` → `akb hook cursor` | 每个对话一张卡；改文件、跑命令、结束状态 |
| 云端 | **Cursor cloud agents** | 轮询 Cursor API，或 webhook | 状态、PR 链接；被谁发起就挂在谁下面 |
| Bot | **Grok Bot**（grok-bot-task-relay） | 轮询 relay `GET /tasks` | 任务时间线，以及它**包在里面的活动**：转交给其他 bot、Cursor cloud agent、审批等待 |
| 聊天 | claude.ai、ChatGPT（开发者模式 app）、Claude Desktop 等 | MCP 工具 `kanban_report`（OAuth） | 聊天里发起的任务也上同一块板 |
| 任意 | 任何命令行工具 | `akb run -- <cmd>` 或 HTTP `POST /api/events` | 开始 / 结束 / 退出码 |

无依赖，只需要 Node.js ≥ 20。


## 快速开始

```bash
git clone https://github.com/yifuqiao/crossplatform_agent_kanban
cd crossplatform_agent_kanban
npm link            # 安装 `akb` 命令
akb serve           # http://127.0.0.1:7311
```

打开 http://127.0.0.1:7311 。数据保存在 `~/.agent-kanban/state.json`。

### 部署到服务器（通过网址访问）

[`deploy/`](deploy/) 里有 systemd 服务、Caddy 反代片段、环境文件示例和部署清单 [`deploy/TASK.md`](deploy/TASK.md)。
看板跑在 relay 同一台服务器上，监听 `127.0.0.1:7311`，由 Caddy 提供 HTTPS；本机直接轮询 relay。
也可以挂在已有站点的子路径下：设置 `AKB_BASE_PATH=/kanban`，看板就在 `https://relay.onetopway.com/kanban/`。
部署后在你的电脑上设置 `AKB_URL=https://relay.onetopway.com/kanban` 和 `AKB_TOKEN=<token>`，hook 就会上报到线上看板；
MCP 地址是 `https://relay.onetopway.com/kanban/mcp`，Cursor webhook 是 `https://relay.onetopway.com/kanban/webhooks/cursor`。

## 看板怎么读

- 七列：**Queued**、**规划中**（planning：在想方案、还没动手）、**Running**、**Needs you**（等你批准/回答）、**Review**（一轮做完，等你看结果或下一句话）、**Done**、**Failed**。
- 只有顶层任务是卡片；它发起的活动以**树**的形式显示在卡片里（可以多层：Grok 任务 → 转交的 bot → Cursor cloud agent）。
- 卡片标签显示来源；上报时带了 `agent_name` 的，显示成「grok-bot · ops-bot」，详情页也有 Agent 一栏。
- 卡片下方的小标签汇总子活动状态（例如 `2 Running · 1 Needs you`）。**任何一层子活动在等你，整张卡会被橙色描边**，即使父任务本身还在 Running。
- 勾选 “Sub-tasks as cards” 可以把子活动也平铺成独立卡片，按各自状态分列。
- **会话卡自动收起**：Claude Code、Codex、Cursor 的 hook 会话卡（不含通过 MCP 自报的卡、等您的卡）6 小时没有任何动静就自动移到完成，时间线写明原因；在那个会话里再说话会回到进行中。`AKB_SESSION_QUIET_HOURS` 改小时数，设成 `0` 关闭。
- 点卡片看时间线、链接（PR、Cursor agent 页面）、元数据和完整的嵌套树。

## 接入各个 agent

先确保 `akb` 在 PATH 里（`npm link`），并且看板在运行。hook 脚本超时 1.5 秒、吞掉所有错误、永远以 0 退出，看板没开也不会影响 agent。

### Claude Code

把 [`examples/claude-code-settings.json`](examples/claude-code-settings.json) 里的 `hooks` 合并到 `~/.claude/settings.json`（全局）或项目的 `.claude/settings.json`。

| Hook | 看板上 |
| --- | --- |
| `SessionStart` | 新卡片，标题 `Claude Code · <目录>` |
| `UserPromptSubmit` | → Running；你说的第一句话成为标题（项目线程里取你的原话，不取 XML 外壳） |
| `PreToolUse` | 保持 Running（不再把每条命令写上卡片）；`Task`/`Agent` 工具 → **新的子卡（subagent）** |
| `PostToolUse` (`Task\|Agent\|Bash\|TodoWrite\|mcp__.*__(set_thread_resolved\|rename_thread\|set_session_title\|create_pull_request\|update_progress_checklist\|post_message\|request_decision)`) | 子卡 → Done；进度清单 / TodoWrite → 卡片上的勾选清单；回复里交了产出（文档、页面、链接）→ 链接挂到卡上，这一轮结束后进等您；发了决定卡 → 这一轮结束后进等您；开了 PR → 审核中；线程改名 → 卡片标题；项目线程关闭 → Done |
| `Notification` | → 等您（要权限）；“等你输入”只算空闲 |
| `Stop` | 这一轮交了产出或发了决定卡的进等您（你回话后回到进行中）；开过 PR 的回到审核中；其余留在原列，标“空闲” |
| `SessionEnd` | → Done |

**Claude Code on the web（claude.ai/code 云端会话）**：**不要**把管理员的 `AKB_TOKEN` 放进 claude.ai 云端环境，它能读写看板上的所有卡。
改用来源钥匙：管理员在服务器上运行 `akb token-new --source claude-code` 生成一把（见下文“按来源分钥匙”），私下交给你。
然后在云端环境设置（会话标题栏的环境菜单 → Edit）里加环境变量 `AKB_CLAUDE_TOKEN`（填这把钥匙），并按 [`CLAUDE.md`](CLAUDE.md) 配好 `.mcp.json`，新会话生效。
会话里的 Claude 通过 MCP 的 `kanban_report` 开卡、更新状态，派给别的 bot 的活挂成子卡。来源钥匙只能读写 `claude-code` 自己建的卡。

本仓库自带的 [`.claude/settings.json`](.claude/settings.json) hook 走 `/api/events`。云端会话里不放 `AKB_TOKEN`，改用来源钥匙让 hook 自动上报：
管理员运行 `akb token-new --source claude-code-web` 生成一把，在云端环境里设 `AKB_URL=https://<看板地址>` 和 `AKB_SOURCE_KEY=<这把钥匙>`，
并让环境的网络策略放行看板域名。这样会话卡的状态（运行中 / 等你 / 一轮结束 / 子 agent）由 hook 自动更新，不再依赖 Claude 记得调 `kanban_report`。
hook 在后台进程里发送，失败不会影响会话。

**所有仓库都自动上报**：上面的 hook 只在打开本仓库时生效。想让云端环境里每个会话（不管开的是哪个仓库）都自动上报，
在云端环境的 Setup script 里加一行：

```bash
curl -fsSL https://raw.githubusercontent.com/yifuqiao/crossplatform_agent_kanban/main/scripts/install-cloud-hooks.sh | bash
```

它从 `main` 拉下 `akb`（无依赖，Node 22），把 hook 写进用户级 `~/.claude/settings.json`（保留已有设置，重复运行不会重复添加）。
打开的仓库自己已经配了看板 hook（例如本仓库）时，用户级 hook 自动跳过，一个会话只出一张卡。钥匙仍然只从环境变量读，不写进磁盘；任何一步失败都只打印提示，不会让 setup 失败。

### Codex CLI

把 [`examples/codex-config.toml`](examples/codex-config.toml) 里的 hooks 加进 `~/.codex/config.toml`（Windows 是 `%USERPROFILE%\.codex\config.toml`），
环境变量里设 `AKB_URL=https://<看板地址>` 和 `AKB_SOURCE_KEY`（`akb token-new --source codex` 生成的钥匙）。
Codex 只运行你信任过的 hook：第一次在 Codex 里打开 `/hooks`，把这些 hook 标为信任；改过 hook 要重新信任。

| Hook | 看板上 |
| --- | --- |
| `SessionStart` | 新卡片，标题 `Codex · <目录>`，在排队 |
| `UserPromptSubmit` | → 进行中；第一句话成为标题 |
| `PreToolUse` | 保持进行中（不把每条命令写上卡片） |
| `PermissionRequest` | → 等您，时间线写「等你批准：<要做什么>」 |
| `PostToolUse` | 批准后回到进行中；`gh pr create` 开出的 PR → 审核中，链接挂到卡上 |
| `SubagentStart` / `SubagentStop` | 子卡（subagent），结束时写它的最后回复 |
| `Stop` / `Interrupt` | 留在原列，标“空闲”，最后回复写进摘要 |
| `SessionEnd` | → 完成 |

hook 的 `session_id` 就是 Codex 的 thread id，和旧的 `notify` 是同一张卡。没有 hooks 的旧版 Codex 只能用 `notify = ["akb", "hook", "codex"]`，它只在每轮结束时触发（卡进审核中，带最后回复）；不要和 hooks 同时开。
想看到整次运行的开始和退出码，仍然可以用包装器启动：`akb run --title "重构 auth" -- codex`，hook 会写进包装器那张卡（通过 `AKB_TASK_KEY`）。

Windows 上的 Codex 会在 hook 退出时结束它的子进程，所以 `akb hook codex` 在 Windows 上直接发送（最多 3.5 秒，Codex 的上限是 5 秒），不交给后台进程；别的系统想这样也可以设 `AKB_HOOK_SYNC=1`。

`AKB_CODEX_SOURCE` 可以给卡片换来源名（例如在别的机器上用 `codex-cloud`），钥匙要和来源对应。

### Codex cloud（chatgpt.com/codex）

云端任务跑在 OpenAI 的容器里，看板没有接口能拉到它们的状态，所以靠 agent 照 `AGENTS.md` 的约定自己上报：

1. 管理员生成一把 `codex-cloud` 来源钥匙（`akb token-new --source codex-cloud`），私下交给你。
2. Codex 的环境设置里：**环境变量**（不是 Secrets：Secrets 在 agent 开始前就被移除了）加 `AKB_URL=https://<看板地址>` 和 `AKB_SOURCE_KEY=<这把钥匙>`；
   打开 agent 的联网，允许的域名里加看板的域名。
3. 把 [`examples/codex-cloud-AGENTS.md`](examples/codex-cloud-AGENTS.md) 的那一节贴进仓库的 `AGENTS.md`。本仓库的 [`AGENTS.md`](AGENTS.md) 已经带上这一节。

agent 开工时开卡（进行中），做完改审核中或失败。这是约定而不是 hook：agent 忘了就不会上报。钥匙在环境变量里，agent 能读到，所以只给它一把只能写 `codex-cloud` 卡的来源钥匙，不要放 `AKB_TOKEN`。

### ChatGPT（网页对话，开发者模式 app）

ChatGPT 在网页版的开发者模式里可以加自定义 MCP app，走看板的 OAuth（和 claude.ai 的 connector 是同一套，见 [`deploy/OAUTH.md`](deploy/OAUTH.md)）：

1. 服务器上：`AKB_SOURCE_TOKENS` 里有一条 `chatgpt:<sha256>`（`akb token-new --source chatgpt`）；要用企业微信登录授权，再把 `chatgpt` 加进 `AKB_OAUTH_SOURCES`（例如 `claude-code,chatgpt`）。
2. ChatGPT 网页 → 设置 → Apps（应用）→ Advanced settings → 打开 Developer mode → Create app。
   URL 填 `https://<看板地址>/mcp`，认证选 OAuth，其余留空。
3. 跳到看板的同意页：企业微信登录后选 `chatgpt`，或者贴那把 `chatgpt` 钥匙，点允许。
4. 对话里从工具菜单打开这个 app，或在 ChatGPT 的自定义指令里写：*“开始我交给你的任务时用 kanban_report 上报，状态变化时更新。”*

看板在授权跳回时带 `iss`（RFC 9207），所以 ChatGPT 用固定的回调 `https://chatgpt.com/connector_platform_oauth_redirect`，它已经在默认允许列表里。
开发者模式只在网页版；手机 App 里用不了自定义 app。

### Cursor（编辑器 agent 和 cursor-agent CLI）

把 [`examples/cursor-hooks.json`](examples/cursor-hooks.json) 放到 `~/.cursor/hooks.json`（全局）或项目的 `.cursor/hooks.json`。

只注册观察类 hook。`beforeShellExecution` 这类审批 hook **故意不注册**，审批仍然由 Cursor 自己做；`beforeSubmitPrompt` 永远回答 `{"continue": true}`。想把 CLI 和编辑器分开显示，给 cursor-agent 设置 `AKB_CURSOR_SOURCE=cursor-cli`。

### Cursor cloud agents

两种方式，可以同时用：

- **轮询**：`CURSOR_API_KEY=... akb serve`，每 30 秒拉一次你所有的 cloud agents。
- **Webhook**：启动 agent 时把 webhook 设成 `https://<看板地址>/webhooks/cursor`，设置 `CURSOR_WEBHOOK_SECRET` 校验 `X-Webhook-Signature`。

卡片 key 是 `cursor-cloud:<bc-id>`。如果这个 agent 是 Grok Bot 或别的 agent 发起的，它会自动挂在那个任务下面（见“嵌套”）。

### Grok Bot（grok-bot-task-relay）

```bash
GROK_RELAY_URL=https://relay.example.com \
GROK_RELAY_KEYS=<claude 调用方 key>,<wecom 调用方 key> \
akb serve
```

relay 按调用方 key 隔离任务，所以每个提交任务的平台给一个 key（逗号分隔）。看板只读：调用 `GET /tasks` 和 `GET /tasks/<id>`，只有状态或 `updatedAt` 变化时才重新拉详情。

每个 relay 任务变成 `grok-bot:<relayTaskId>` 一张卡：

- **时间线**：relay 的每条 progress（received / forwarded / executing / waiting_approval …）和完成报告。
- **状态**：`received`→排队，`forwarded`/`executing`→进行中，`waiting_approval`→等您，`finished`→完成，`failed`/`rejected`→失败。`dry_run`（如 `relay-ping`）不上板。
- **从最近一条进展推断在等谁**（Grok 常把等待写成 `executing`）：
  - 「待二审 / 等…allow」→ 仍是进行中，卡上标「等代码二审」；
  - 「等乔总 / 等您 / 点头 / 待提供 / 等…授权、确认、凭据」或 relay 有未处理的 `approval` → 等您。
- **24 小时没有新进展**的未关任务移到「等您」，请你判断；进行中但 2 小时没动静的 Grok 卡标「失联」。卡片详情里有「我确认已完成 / 已放弃」，只改看板上的卡，不写 relay；relay 之后有更新的进展仍以 relay 为准。
- **重试合并**：标题带「取代 <id 前 8 位>」，或失败任务之后有同样「… PR #n」标题的新任务，旧任务折叠成「已被取代」。
- **执行者**：`forwarded` 里的 bot（如 `已转交日川驾驶舱大总管（1a69…）`）写到卡片的 Agent 上（显示「grok-bot · 日川驾驶舱大总管」），不另开子卡。
- **子卡只给有真实状态源的活动**：出现 Cursor agent id `bc-…` → 子卡 `cursor-cloud:bc-…`，如果同时开了 Cursor 轮询，状态和 PR 以 Cursor 为准。
- GitHub PR 链接、完成报告的 artifacts → 卡片链接。
- 如果 relay 任务带 `source_thread`，它会挂在那个对话的卡片下面；对话卡用任务标题命名，不显示原始 thread id。

Grok Bot 不需要额外往看板上报，也不需要 MCP：看板只读 relay。Grok 只要在 relay 进展里用对状态词，见 [`examples/grok-bot-reporting.md`](examples/grok-bot-reporting.md)。

### 聊天类 agent（MCP）

看板在 `/mcp` 提供 MCP 服务（Streamable HTTP，JSON 响应），四个工具：

- `kanban_report` — 新建或更新卡片（`status`、`title`、`note`、`summary`、`links`、`parent_key`、`agent_name`）；返回 `task_key`，之后用它更新。`status` 可以是 `planning`。返回值里的 `update_requests` 列出同一来源下用户点了 Get update 的卡。
- `kanban_list` — 列出卡片。
- `kanban_update_requests` — 列出等着 agent 写更新简报的卡（可按 `source` 过滤）。
- `kanban_get` — 读一张卡的时间线和子活动。

**Get update**：卡片详情里的 Get update 按钮只在卡上记一笔“请求更新”，看板不会主动联系 agent 或 relay。agent 下次调用 `kanban_report` 时会在返回值里看到这个请求（或用 `kanban_update_requests` 主动查），用带 `summary` 的 `kanban_report` 回写最新简报，请求随之清除。卡片进入 done / failed 时请求也会清除。

**远程（claude.ai、ChatGPT 等）**：聊天平台的服务器要能访问看板，所以需要公网 HTTPS 地址（例如 Cloudflare Tunnel / Tailscale Funnel / 反向代理），并且**必须设置 `AKB_TOKEN`**。能自己带 `Authorization` 头的客户端继续用静态 Bearer。claude.ai / Claude iOS 的自定义 connector 不会发静态头，走看板自己的 OAuth（全部在 `/kanban/` 下面，不经过域名根上的 relay 登录页）。步骤和部署注意见 [`deploy/OAUTH.md`](deploy/OAUTH.md)。MCP 地址填 `https://relay.onetopway.com/kanban/mcp`，不要加 `?token=`。

**按来源分钥匙（推荐给每个 bot / agent 一把）**：除了 `AKB_TOKEN`，看板还认一组只能用于 `/mcp` 的来源钥匙。配置里只放哈希：

```bash
# 在服务器上生成（钥匙只显示一次，私下交给 bot 的主人；不要贴进聊天、PR 或任务文本）
akb token-new --source claude-code
akb token-new --source grok-bot --agent ops-bot
# 已有钥匙算哈希：read -rs K && printf %s "$K" | akb token-hash --source claude-code
```

把输出的条目用逗号连起来写进 `AKB_SOURCE_TOKENS`（例如 `claude-code:<sha256>,grok-bot@ops-bot:<sha256>`），重启看板。

- 用来源钥匙调 `kanban_report`：新卡的 source 固定为钥匙绑定的来源；传了别的 `source` 直接拒绝。
- 只能改自己通过 MCP 建的卡。轮询器或 hook 建的卡（即使来源相同）只有 `AKB_TOKEN` 或对应的轮询器能改。
- `parent_key` 必须是已经存在、而且属于自己来源的卡，不能借它造出别的来源的卡。
- `kanban_list` 只返回自己来源的卡，`kanban_get` 读别的来源的卡返回 `No task`。
- 钥匙绑定了 bot 名（`@名字`）时，`agent_name` 固定为该名字，传别的名字会被拒绝；读和挂子卡也只限这个 bot 的卡。
- 钥匙至少 32 个字符（`akb token-new` 生成的是 43 个）；更短的钥匙 `token-hash` 拒绝，看板也不认。
- 来源钥匙只能访问 `/mcp` 和 `POST /api/events`（给 hook 用，`akb` 读 `AKB_SOURCE_KEY`），不能调其他 `/api/*`，也不能用 `?token=`，只认 `Authorization: Bearer`。
- 在 `/api/events` 上，来源钥匙只能写自己来源（绑定 bot 时只限该 bot）的卡，`parent` 也必须是自己来源的卡；通过 MCP 建的卡不能用 hook 改，`created_by` 会被忽略。
- 作废某一把：从 `AKB_SOURCE_TOKENS` 删掉那一条再重启，其他钥匙不受影响。条目格式不对时看板拒绝启动，报错只写第几条，不回显内容。
- `AKB_TOKEN` 的行为不变：任何来源、任何 `agent_name` 都可以。

**本地（Claude Desktop、Cursor、Claude Code）**：用 stdio 桥：

```json
{ "mcpServers": { "agent-kanban": { "command": "akb", "args": ["mcp"] } } }
```

然后在对话里告诉它（或写进项目说明 / 自定义指令）：*“开始我交给你的任务时用 kanban_report 上报，状态变化时更新。”* MCP 的 `initialize` 也会带上这条说明。

### 其他任何东西

```bash
akb run --title "nightly e2e" -- npm run e2e           # 包装任何命令
akb report --source manual --title "手动跟进客户" --status waiting   # 打印 key
akb report --key manual:<id> --status done --note "已回复"
akb list                                              # 在终端看板子
```

或者直接 HTTP：

```bash
curl -X POST http://127.0.0.1:7311/api/events -H 'content-type: application/json' -d '{
  "key": "gemini-cli:job-42", "title": "生成测试数据", "status": "running",
  "parent": "grok-bot:15ee3b55-…", "message": "开始", "links": [{"url": "https://…", "label": "PR"}]
}'
```

## 嵌套：一个 agent 发起另一个 agent

每张卡的 key 是 `source:id`。子活动有三种方式挂到父任务下面：

1. **显式 `parent`**：任何事件都可以带 `"parent": "source:id"`。父卡还不存在时会先建一个占位卡，等父任务自己的事件来了再填充；子卡先到、父卡后到都可以。
2. **环境变量传递**（CLI agent 互相启动时）：
   - `AKB_PARENT_KEY=source:id` — 这个进程里的 agent 会话显示为该卡的子卡；
   - `AKB_TASK_KEY=source:id` — 这个进程里的 agent 直接写进该卡（`akb run` 就是这样把 Codex/Claude Code 的 hook 合并进包装器卡片的）。
   `akb run` 会把自己的 key 作为 `AKB_TASK_KEY` 传给子进程；子进程里再 `akb run` 别的 agent，就会自动成为子卡。
3. **适配器推断**：Claude Code 的 subagent、Grok relay 里的转交和 Cursor agent id（见上文）。

同一个活动从不同来源上报（比如 Grok Bot 提到 `bc-123`，Cursor 轮询也看到 `bc-123`）会合并成同一张卡，因为 key 相同。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/events` | 上报一个事件或事件数组 |
| `GET` | `/api/tasks` | 所有卡片（可选 `?status=`、`?source=`） |
| `GET` | `/api/tasks/<key>` | 一张卡和它的子卡 |
| `DELETE` | `/api/tasks/<key>` | 删除卡片及所有子孙 |
| `POST` | `/api/tasks/<key>/update-request` | Get update：记录“请求更新简报”（已结束的卡返回 409） |
| `GET` | `/api/stream` | SSE 实时推送（`task`、`remove`） |
| `POST` | `/mcp` | MCP JSON-RPC |
| `POST` | `/webhooks/cursor` | Cursor cloud agent webhook |
| `GET` | `/health` | 健康检查（不需要 token） |

事件字段：

| 字段 | 说明 |
| --- | --- |
| `key` 或 `source` + `external_id` | 卡片身份（必填） |
| `status` | `queued` `planning` `running` `waiting` `review` `done` `failed`，也接受各平台原生状态（`executing`、`FINISHED`、`waiting_approval`…） |
| `title`, `title_mode` | `replace`（默认）、`first`（只在还没有真正标题时设置）、`default`（兜底标题，之后任何标题都会覆盖） |
| `message` | 时间线上的一行 |
| `summary` | 当前状态或最终结果 |
| `parent` | 父卡 key |
| `agent_name` | 具体是哪个 bot / agent（例如 `ops-bot`），显示在来源旁边 |
| `kind` | `cli` `ide` `cloud` `chat` `bot` `other` |
| `url`, `links`, `cwd`, `meta` | 附加信息 |
| `event_id` | 去重：同一张卡上相同 `event_id` 只处理一次 |
| `initial_status` | 只在这个事件创建卡片时使用 |
| `at` | 事件时间（ISO 8601），默认是现在 |

## 安全

- 默认只监听 `127.0.0.1`。监听其他地址或通过隧道暴露时，**一定要设置 `AKB_TOKEN`**；否则能访问到的人都能改看板（启动时会警告）。
- 设置 `AKB_TOKEN` 后，除静态页面、`/health` 外的所有接口都需要 `Authorization: Bearer <token>` 或 `?token=`。网页第一次打开时会询问 token 并存在浏览器本地。
- 浏览器发来的跨站写请求（`Origin` 和 Host 不一致）会被拒绝。
- 外部内容（relay summary、agent 回复）在页面里一律作为纯文本渲染。
- Hook 只读取 agent 传给它的数据并上报，不会阻止或批准 agent 的任何操作。
- 看板只读访问 Grok relay 和 Cursor API；key 只放在环境变量里（见 [`examples/board.env.example`](examples/board.env.example)）。

## 已知限制

- Codex 的 `notify` 只报告“一轮结束”；要看 Running 用 `akb run -- codex`。
- 聊天平台不会自己汇报，除非它们连上了 MCP 工具并且被要求使用；纯网页聊天没有可以挂钩的地方。
- 从 Grok relay progress 文本里识别转交、等待对象和 Cursor agent 是启发式的，卡上「等…」标记写明是推断。relay 每个任务只保留最近 20 条 progress。
- 状态存在单个 JSON 文件里，适合个人使用；同一个数据目录只运行一个 `akb serve`。

## 开发

```bash
npm test
```

```
src/
  store.js            卡片模型：按 key 合并、父子关系、去重、持久化
  status.js           各平台状态 → 七列
  source-tokens.js    按来源分的 MCP 钥匙（只存哈希）
  server.js           HTTP / SSE / MCP / webhook，轮询调度
  oauth.js            MCP OAuth 2.1（发现文档、动态注册、PKCE、刷新）
  mcp.js              MCP 工具
  cli.js              akb 命令
  adapters/           Claude Code、Cursor、Codex hook 映射
  pollers/            Grok relay、Cursor cloud agents
public/               看板页面（无构建步骤）
examples/             各平台配置示例
```
