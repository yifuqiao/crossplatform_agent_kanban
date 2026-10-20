# 任务单：更新看板 + 核对 7 个卡住的 relay 任务

用户已批准。共两部分：**A. 把看板更新到指定 commit**，**B. 核对 7 个长时间没有进展的 relay 任务并回报真实状态**。
A 和 B 互不依赖：A 失败并回滚后，B 照常做。

不要把任何密钥（AKB_TOKEN、BOT_REPORT_KEY、relay 调用方 key 等）写进回复、进度报告、仓库、截图或日志输出。

**最高要求：不能影响任何现有服务**（relay、dashboard、其他站点）。
- A 只允许 `git` 更新 `/opt/agent-kanban` 并重启 `agent-kanban` 这一个服务。
- 不改 Caddy，不改 relay、dashboard 及它们的配置/环境文件，不改 `/etc/agent-kanban.env`，不改 systemd unit。
- B 只读调查 + 用执行端接口回报状态，**不重新执行、部署、合并或修改任何东西**。
- 拿不准就停下来，在报告里说明，不要猜。

目标 commit（下文记作 `TARGET`）在提交本任务时给出，是 40 位 sha。

---

## A. 更新看板

### A0. 记录基线（先做，后面对比）

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://relay.onetopway.com/health          # 应 200
curl -s -o /dev/null -w '%{http_code}\n' https://relay.onetopway.com/mcp             # 不带钥匙，应 401
curl -s -o /dev/null -w '%{http_code}\n' https://relay.onetopway.com/kanban/health   # 应 200
systemctl is-active grok-bot-task-relay                                             # 应 active
systemctl is-active agent-kanban                                                    # 应 active
```

再记下服务器上其他已有站点首页的 HTTP 状态码。

### A1. 前置检查（任何一项不满足：停止 A，报告原因，直接做 B）

```bash
cd /opt/agent-kanban
git status --porcelain            # 必须为空：有本地改动就停下，不要覆盖
OLD=$(git rev-parse HEAD); echo "$OLD"   # 记下，用于回滚
git fetch origin main
git merge-base --is-ancestor "$OLD" TARGET && echo ff-ok   # 必须输出 ff-ok
diff -q /etc/systemd/system/agent-kanban.service deploy/agent-kanban.service   # 必须无输出
```

- `diff` 有输出说明 unit 文件和仓库不一致：本任务不改 unit，停止 A 并报告差异（不要贴出密钥）。
- 本次更新**不需要新的环境变量**，不需要 `npm install`（项目没有依赖）。

### A2. 更新并重启看板

```bash
cd /opt/agent-kanban
git merge --ff-only TARGET
test "$(git rev-parse HEAD)" = "TARGET" && echo head-ok
systemctl restart agent-kanban     # 只重启这一个服务
sleep 3
```

### A3. 验证

- `curl -s http://127.0.0.1:7311/health` 返回 `"ok":true`
- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7311/kanban/api/tasks` 返回 `401`
- `curl -s http://127.0.0.1:7311/kanban/app.js | grep -c askGrok` 至少为 `1`（新版本已生效）
- `journalctl -u agent-kanban --since "-2min"` 里有 `polling: grok-relay`，且没有 `poll failed`、没有报错堆栈
- `https://relay.onetopway.com/kanban/health` 返回 200
- A0 的所有基线结果不变

### A4. 回滚（A3 任何一项失败时）

```bash
cd /opt/agent-kanban
git checkout --detach "$OLD"
systemctl restart agent-kanban
```

确认 A0 基线恢复、`/kanban/health` 正常，然后在报告里写明 A 失败的原因和已回滚。

---

## B. 核对 7 个卡住的任务

### 背景

这 7 个任务在 relay 里一直不是终态（`submitted` 或 `forwarded`），但很久没有任何进度回报，看板因此显示不准。
请逐个查清**真实发生了什么**，并回报到**各自原来的 relay_task_id** 上。

### 怎么回报

用执行端钥匙（`BOT_REPORT_KEY`，只在服务器上使用，不要输出）调用 relay：

```text
POST https://relay.onetopway.com/executor/tasks/<relay_task_id>/report     # 终态：finished / failed
POST https://relay.onetopway.com/executor/tasks/<relay_task_id>/progress   # 非终态：executing / waiting_approval
Authorization: Bearer <BOT_REPORT_KEY>
Content-Type: application/json

{ "event_id": "reconcile-20261020-<relay_task_id 前 8 位>", "status": "...", "summary": "..." }
```

- `event_id` 用上面的固定格式，重试时保持不变，避免重复。
- `summary` 写清楚**依据**（例如 “PR #86 已于 10-12 合并，线上 commit abc1234 已包含该修复”），不要只写“已完成”。
- 如果 relay 返回 409（例如任务已关闭），记下原因，不要换 event_id 硬推。

### 判定规则

| 查到的事实 | 回报 |
| --- | --- |
| 有证据表明已经做完（PR 已合并、线上已是对应版本、配置已存在等） | `report` + `finished`，summary 写证据 |
| 被取代、被放弃、或确认没做且不再需要 | `report` + `failed`，summary 写原因（例如“已被 xxx 取代，未执行”） |
| 确实还在进行 | `progress` + `executing`，summary 写当前进度 |
| 卡在等人批准或等用户提供信息 | `progress` + `waiting_approval`，summary 写清楚在等谁、等什么 |
| 查不清楚 | `progress` + `waiting_approval`，summary 写“无法确认：<缺什么信息>，需要用户确认” |

**只调查、只回报。** 不要因为“还没做”就顺手去做：不部署、不合并、不改服务、不装钥匙。需要做的，在 summary 里写“未执行，如需执行请重新提交任务”。

### 7 个任务

| relay_task_id | 标题 | relay 当前状态 | 重点核对 |
| --- | --- | --- | --- |
| `375b898b-6074-4e6e-82c9-a132d7e99eee` | 部署 agent kanban 到 relay 服务器 | forwarded | 已被 `ad60c649-c58e-4cc5-9ca7-e9061d76e4a1` 取代（后者已 finished）。确认它本身没有被执行过，然后 `failed`，summary：“已被 ad60c649 取代，未单独执行”。如果发现它也执行过，如实写明做了什么。 |
| `d8092ef5-a455-4483-b187-44f4094ba6b5` | 部署 supplier-management PR #20 到 relay | forwarded | PR #20 现在是什么状态（open / merged / closed）？线上是否已包含它？之后的 PR #22、#23 已上线，PR #20 是否已被它们包含或取代？ |
| `ed4d737f-bf12-4641-9849-6ecd661e769f` | 部署手机地图标记定位修复 PR #86 | submitted | PR #86 是否已合并？线上版本是否包含该修复？ |
| `2d37a388-a910-48dd-9d97-1722a0f01855` | 给 Cursor agent 安装 relay SSH 公钥 | submitted | relay 服务器的 `authorized_keys` 里是否已有对应的 Cursor agent 公钥？**只读检查，不要添加或删除任何钥匙。** |
| `cec9713c-0a15-411f-b485-42a473af8e7c` | 部署日川数字工厂手机版 UI（PR #85） | submitted | PR #85 是否已合并？线上是否已是手机版 UI？ |
| `fa7e5adb-759c-493a-ab97-1a3cd452d26e` | 部署日川数字工厂正式版本 | submitted | 线上是否已是正式版本？对应哪个 commit / tag？ |
| `9986959e-ad53-4678-86c2-cb556ecd67e8` | 重新提交：老板驾驶舱版本保护规范 | submitted | 原任务 `f835f6a7-b3da-4c8e-bd17-69c9f681ea75`（老板驾驶舱版本保护与回滚机制）已 finished（PR #83 合并）。这次“重新提交”是否被那次完成覆盖？如果是，`finished` 并引用 f835f6a7 / PR #83；如果另有未完成的要求，写明是什么。 |

---

## 最终报告（回报到本任务自己的 relay_task_id）

`finished` 报告包含：

1. **A 的结果**：更新前后的 commit（`OLD` → `TARGET`）、A3 每项检查结果、A0 基线是否全部不变；失败则写原因和回滚结果。
2. **B 的结果**：一张表，每行一个任务：relay_task_id 前 8 位、回报的状态、一句话依据、relay 返回的 HTTP 状态码。
3. 不含任何密钥。

如果 A 和 B 都无法进行（例如无法登录服务器），报告 `failed` 并说明原因。

## 不要做的事

- 不要停掉、重启或修改 relay、dashboard、Caddy 及其配置。只重启 `agent-kanban`。
- 不要执行这 7 个任务中的任何一个；不要部署、合并 PR、增删 SSH 钥匙。
- 不要删除服务器上的任何数据。
- 不要再次提交本任务。
