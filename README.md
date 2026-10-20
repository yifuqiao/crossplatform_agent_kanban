# Cross-platform Agent Kanban

一块看板，看到你从各个 agent 窗口发起的所有任务：

| 类型 | 平台 | 接入方式 | 能看到什么 |
| --- | --- | --- | --- |
| CLI | **Claude Code** | hooks → `akb hook claude-code` | 每个会话一张卡；运行中 / 等你批准 / 一轮结束；**subagent 作为子卡** |
| CLI | **Codex CLI** | `notify` → `akb hook codex` | 每个 thread 一张卡；每轮结束和最后回复 |
| IDE/CLI | **Cursor**（编辑器 agent 和 `cursor-agent`） | `.cursor/hooks.json` → `akb hook cursor` | 每个对话一张卡；改文件、跑命令、结束状态 |
| 云端 | **Cursor cloud agents** | 轮询 Cursor API，或 webhook | 状态、PR 链接；被谁发起就挂在谁下面 |
| Bot | **Grok Bot**（grok-bot-task-relay） | 轮询 relay `GET /tasks` | 任务时间线，以及它**包在里面的活动**：转交给其他 bot、Cursor cloud agent、审批等待 |
| 聊天 | claude.ai、ChatGPT、Claude Desktop 等 | MCP 工具 `kanban_report` | 聊天里发起的任务也上同一块板 |
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

- 六列：**Queued**、**Running**、**Needs you**（等你批准/回答）、**Review**（一轮做完，等你看结果或下一句话）、**Done**、**Failed**。
- 只有顶层任务是卡片；它发起的活动以**树**的形式显示在卡片里（可以多层：Grok 任务 → 转交的 bot → Cursor cloud agent）。
- 卡片下方的小标签汇总子活动状态（例如 `2 Running · 1 Needs you`）。**任何一层子活动在等你，整张卡会被橙色描边**，即使父任务本身还在 Running。
- 勾选 “Sub-tasks as cards” 可以把子活动也平铺成独立卡片，按各自状态分列。
- 点卡片看时间线、链接（PR、Cursor agent 页面）、元数据和完整的嵌套树。

## 接入各个 agent

先确保 `akb` 在 PATH 里（`npm link`），并且看板在运行。hook 脚本超时 1.5 秒、吞掉所有错误、永远以 0 退出，看板没开也不会影响 agent。

### Claude Code

把 [`examples/claude-code-settings.json`](examples/claude-code-settings.json) 里的 `hooks` 合并到 `~/.claude/settings.json`（全局）或项目的 `.claude/settings.json`。

| Hook | 看板上 |
| --- | --- |
| `SessionStart` | 新卡片，标题 `Claude Code · <目录>` |
| `UserPromptSubmit` | → Running；第一句 prompt 成为标题 |
| `PreToolUse` | 时间线记一笔；`Task`/`Agent` 工具 → **新的子卡（subagent）** |
| `PostToolUse` (`Task\|Agent`) | 子卡 → Done，附 subagent 结果 |
| `Notification` | → Needs you（要权限 / 空闲等你） |
| `Stop` | → Review（这一轮做完了） |
| `SessionEnd` | → Done |

**Claude Code on the web（claude.ai/code 云端会话）**：本仓库自带 [`.claude/settings.json`](.claude/settings.json)，在这个仓库里开的每个会话都会自动上报。
只需在云端环境设置（会话标题栏的环境菜单 → Edit）里加两个环境变量：`AKB_URL=https://relay.onetopway.com/kanban` 和 `AKB_TOKEN`（看板 token），新会话生效。
云端会话按 `claude.ai/code/session_…` 建卡并链接回会话页面；从这个会话提交给 Grok Bot 的任务也会挂在同一张卡下面。
hook 在后台进程里发送（自动走沙箱的 HTTPS 代理），不会拖慢 Claude。

### Codex CLI

在 `~/.codex/config.toml` 加一行（见 [`examples/codex-config.toml`](examples/codex-config.toml)）：

```toml
notify = ["akb", "hook", "codex"]
```

Codex 的 `notify` 只在每轮结束时触发，所以只能看到 Review 和最后回复。想看到 Running，用包装器启动：

```bash
akb run --title "重构 auth" -- codex
```

包装器的卡片在启动时进入 Running、退出时变 Done/Failed，Codex 的 notify 会写进**同一张卡**（通过 `AKB_TASK_KEY`，见下文）。

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
- **状态**：`received`→Queued，`forwarded`/`executing`→Running，`waiting_approval`→Needs you，`finished`→Done，`failed`/`rejected`→Failed。
- **包在里面的活动**，从 progress 里识别出来，作为子卡：
  - `forwarded` 且带 bot id（如 `已转交日川驾驶舱大总管（1a69…）`）→ 子卡 “Handed to 日川驾驶舱大总管”，任务结束时一起关闭；
  - 出现 Cursor agent id `bc-…` → 子卡 `cursor-cloud:bc-…`，如果同时开了 Cursor 轮询，状态和 PR 以 Cursor 为准；
  - GitHub PR 链接 → 卡片链接；完成报告的 artifacts → 卡片链接。
- 如果 relay 任务带 `source_thread`，它会挂在那个聊天的卡片下面（例如 `claude-chat:<thread>`）。

从文字里推断只是兜底。想让 Grok Bot 内部的每一步（转交、二审、部署、它启动的 Cursor agent）都有自己的卡片和状态，让 Grok Bot 按 [`examples/grok-bot-reporting.md`](examples/grok-bot-reporting.md) 直接上报，`parent` 填 `grok-bot:<relay_task_id>`。

### 聊天类 agent（MCP）

看板在 `/mcp` 提供 MCP 服务（Streamable HTTP，JSON 响应），三个工具：

- `kanban_report` — 新建或更新卡片（`status`、`title`、`note`、`summary`、`links`、`parent_key`）；返回 `task_key`，之后用它更新。
- `kanban_list` — 列出卡片。
- `kanban_get` — 读一张卡的时间线和子活动。

**远程（claude.ai、ChatGPT 等）**：聊天平台的服务器要能访问看板，所以需要公网 HTTPS 地址（例如 Cloudflare Tunnel / Tailscale Funnel / 反向代理），并且**必须设置 `AKB_TOKEN`**。在平台里添加自定义 connector，URL 填 `https://<看板地址>/mcp?token=<AKB_TOKEN>`（平台支持自定义 header 时，用 `Authorization: Bearer` 更好）。

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
| `GET` | `/api/stream` | SSE 实时推送（`task`、`remove`） |
| `POST` | `/mcp` | MCP JSON-RPC |
| `POST` | `/webhooks/cursor` | Cursor cloud agent webhook |
| `GET` | `/health` | 健康检查（不需要 token） |

事件字段：

| 字段 | 说明 |
| --- | --- |
| `key` 或 `source` + `external_id` | 卡片身份（必填） |
| `status` | `queued` `running` `waiting` `review` `done` `failed`，也接受各平台原生状态（`executing`、`FINISHED`、`waiting_approval`…） |
| `title`, `title_mode` | `replace`（默认）、`first`（只在还没有真正标题时设置）、`default`（兜底标题，之后任何标题都会覆盖） |
| `message` | 时间线上的一行 |
| `summary` | 当前状态或最终结果 |
| `parent` | 父卡 key |
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
- 从 Grok relay progress 文本里识别转交和 Cursor agent 是启发式的；要准确的内部活动，让 Grok Bot 直接上报。relay 每个任务只保留最近 20 条 progress。
- 状态存在单个 JSON 文件里，适合个人使用；同一个数据目录只运行一个 `akb serve`。

## 开发

```bash
npm test
```

```
src/
  store.js            卡片模型：按 key 合并、父子关系、去重、持久化
  status.js           各平台状态 → 六列
  server.js           HTTP / SSE / MCP / webhook，轮询调度
  mcp.js              MCP 工具
  cli.js              akb 命令
  adapters/           Claude Code、Cursor、Codex hook 映射
  pollers/            Grok relay、Cursor cloud agents
public/               看板页面（无构建步骤）
examples/             各平台配置示例
```
