# 任务单：更新看板

只有一部分：**A. 把看板更新到指定 commit**。

核对卡住的 relay 任务并往 relay 回报状态（`report` / `progress` 的 POST）是写操作，不在这份部署单里，以后需要时单独报批。

不要把任何密钥（AKB_TOKEN、relay 调用方 key 等）写进回复、进度报告、仓库、截图或日志输出。

**最高要求：不能影响任何现有服务**（relay、dashboard、其他站点）。
- A 只允许 `git` 更新 `/opt/agent-kanban` 并重启 `agent-kanban` 这一个服务。
- 不改 Caddy，不改 relay、dashboard 及它们的配置/环境文件，不改 `/etc/agent-kanban.env`，不改 systemd unit。
- 不往 relay 发任何写请求（不调 `report` / `progress`，不提交新任务）。
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

### A1. 前置检查（任何一项不满足：停止，报告原因）

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
- 新版本已生效（反向检查：旧的 Ask Grok Bot 入口已去掉，Get update 已上线）：
  - `curl -s http://127.0.0.1:7311/kanban/app.js | grep -c askGrok` 为 `0`
  - `curl -s http://127.0.0.1:7311/kanban/app.js | grep -c update-request` 至少为 `1`
  - `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:7311/kanban/api/grok/status-check` 返回 `401`（不带钥匙）
  - 带钥匙同一个请求返回 `404`（接口已删除）。钥匙从 `/etc/agent-kanban.env` 读进变量，不要回显：
    ```bash
    AKB_TOKEN=$(sudo sed -n 's/^AKB_TOKEN=//p' /etc/agent-kanban.env | tr -d "\"'")
    curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $AKB_TOKEN" http://127.0.0.1:7311/kanban/api/grok/status-check
    unset AKB_TOKEN
    ```
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

## 最终报告（回报到本任务自己的 relay_task_id）

`finished` 报告包含：

1. 更新前后的 commit（`OLD` → `TARGET`）、A3 每项检查结果、A0 基线是否全部不变；失败则写原因和回滚结果。
2. 不含任何密钥。

如果无法进行（例如无法登录服务器），报告 `failed` 并说明原因。

## 不要做的事

- 不要停掉、重启或修改 relay、dashboard、Caddy 及其配置。只重启 `agent-kanban`。
- 不要往 relay 回报其他任务的状态，不要部署其他项目、合并 PR、增删 SSH 钥匙。
- 不要删除服务器上的任何数据。
- 不要再次提交本任务。
