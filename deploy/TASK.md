# 部署清单：把 agent kanban 放到 relay 服务器上

目标：在已经运行 grok-bot-task-relay 的服务器上运行看板，用户通过 https://relay.onetopway.com/kanban/ 直接打开。
按顺序做，做完一项再做下一项。不要把密钥写进回复、仓库、截图或进度报告。

**最高要求：不能影响任何现有服务**（relay、dashboard、其他站点）。看板是新增的独立服务，
除了第 4 步在 relay 站点里加一个 `/kanban` 块，不改动任何已有文件、服务或配置。
拿不准时停下来报告，不要猜。

## 0. 部署前记录基线

- 记下这些结果，后面每一步都要对比，不一致就回滚并报告：
  - `curl -s -o /dev/null -w '%{http_code}' https://relay.onetopway.com/health`
  - `curl -s -o /dev/null -w '%{http_code}' https://relay.onetopway.com/mcp`（不带钥匙，应为 401）
  - 服务器上其他已有站点首页的 HTTP 状态码
  - `systemctl is-active grok-bot-task-relay`
- 确认 7311 端口空闲：`ss -ltn | grep -w 7311` 应无输出；被占用就停下来报告，不要换端口或停掉占用者。

## 1. 拷贝代码

- 用已有的 SSH 登录 relay 服务器，不要猜测新账号。
- `git clone https://github.com/yifuqiao/crossplatform_agent_kanban /opt/agent-kanban`；目录已存在就在里面 `git fetch`，不要另起一份。
- **钉死部署提交**：检出本次安全加固 PR 合入 `main` 后的 **merge commit**（或该 PR 的明确 commit SHA），不要用浮动的 `main` / `git pull` 最新 tip。例如：
  - `git -C /opt/agent-kanban fetch origin`
  - `git -C /opt/agent-kanban checkout <merge-commit-sha>`
- 需要 Node.js 22 或更新版本（relay 已在用），项目没有第三方依赖，不需要 `npm install`。

完成：`/opt/agent-kanban/src/cli.js` 存在，`git -C /opt/agent-kanban rev-parse HEAD` 等于计划部署的那个 commit（不是“main 最新”）。

## 2. 环境文件

- 按 `deploy/agent-kanban.env.example` 写 `/etc/agent-kanban.env`，权限 `0600`，属主 **root**（`root:root 0600`）。systemd 在 `DynamicUser` 降权之前以 root 读取 `EnvironmentFile`，所以文件保持 root 0600 即可，不要改成服务用户可读。
- `AKB_TOKEN` 新生成一个随机值（`openssl rand -hex 24`）。不要写进进度报告；用已有的私下渠道交给用户。**必填**：没有 `AKB_TOKEN` 服务会拒绝启动。
- `GROK_RELAY_KEYS` 从 `/etc/grok-bot-task-relay.env` 里的 `RELAY_API_KEY`，以及 `RELAY_CLIENT_KEYS` 里各调用方（例如 `claude`）的值取，逗号分隔。不要打印。
- **不要**手动 `mkdir /var/lib/agent-kanban`：单元里的 `StateDirectory=agent-kanban` 会创建并收紧权限（`StateDirectoryMode=0700`）。`AKB_DATA_DIR=/var/lib/agent-kanban` 已由 unit / env 对齐。

完成：环境文件只有 root 可读，回复里没有密钥。

## 3. 开机自启

```bash
cp /opt/agent-kanban/deploy/agent-kanban.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now agent-kanban
```

完成：
- `curl -s http://127.0.0.1:7311/health` 返回 `"ok":true`；
- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7311/kanban/api/tasks` 返回 `401`（说明 token 生效）；
- `journalctl -u agent-kanban -n 30` 里有 `polling: grok-relay`，且没有 `poll failed`；
- relay 的 `/health` 仍然正常。

## 4. HTTPS 网址：relay.onetopway.com/kanban

先确认第 3 步全部通过，否则不做这一步。

- **现网拓扑**：haproxy `:443` 按 SNI 透传 → Caddy `127.0.0.1:4443` 终止 TLS。relay 站点 `bind 127.0.0.1` 是正常配置，**可以**在该站点里加 `handle` 块；不要因为看到 bind 环回就停手。若确认 TLS 根本不在本机 Caddy 终止，再停下来报告实际入口。
- 备份：`cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-agent-kanban-$(date +%Y%m%d%H%M%S)`（如果 Caddyfile 在别的位置，备份实际文件）。
- 在现有 `relay.onetopway.com { ... }` 站点里，按下面顺序新增两个 `handle`（都放在站点块靠前位置；**`/WW_verify_*` 必须在 `/kanban*` 之上**）。站点里原有的每一行都保持原样；不新建第二个同名站点；不改其他站点。

```
	handle /WW_verify_* {
		root * /opt/agent-kanban-verify
		file_server
	}

	handle /kanban* {
		reverse_proxy 127.0.0.1:7311
	}
```

- 创建校验目录（一次）：`mkdir -p /opt/agent-kanban-verify && chown root:root /opt/agent-kanban-verify && chmod 755 /opt/agent-kanban-verify`。只放 1000030 后台下载的 `WW_verify_*.txt`（不是密钥）。
- **Caddy 生效方式（重要）**：`caddy.service` **没有** `ExecReload`，禁止 `systemctl restart caddy` / `systemctl reload caddy`。流程固定为：
  1. 备份 Caddyfile（见上）
  2. `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`（路径以实机为准）
  3. 通过后：`caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`
  - validate 不通过就恢复备份，**不要** reload。
- reload 后立刻对比第 0 步的基线。**任何一项和基线不同**：恢复备份、再次 `caddy reload --config ... --adapter caddyfile`、确认基线恢复，然后报告 failed。

完成：
- 第 0 步的基线全部不变；
- `https://relay.onetopway.com/kanban/health` 返回 ok（**不含** `wecom_wired`；接线状态见需鉴权的 `GET /kanban/api/tasks`）；
- `https://relay.onetopway.com/kanban/api/tasks` 不带 token 返回 401；
- `https://relay.onetopway.com/kanban` 跳转到 `/kanban/`；
- 放入校验文件后 `https://relay.onetopway.com/WW_verify_<xxx>.txt` 返回 200，且仅该文件。

## 4b. 企微静默登录（AgentId 1000030）— 后台配置顺序

代码已支持；**本仓不自动改服务器**。在中继上按顺序做（Secret 不经聊天）：

1. `/etc/agent-kanban.env` 补齐非密钥项（见 `deploy/agent-kanban.env.example`）：`AKB_PUBLIC_URL`、`AKB_WECOM_CORP_ID`、`AKB_WECOM_AGENT_ID=1000030`、`AKB_WECOM_USERS=QiaoYiFu`、`AKB_SESSION_SECRET`（至少 32 字节，推荐 `openssl rand -hex 32`，不要复用 `AKB_TOKEN`）。**不要**在 env 里写 Secret（除非走方案 B）。
2. `systemctl restart agent-kanban`（只重启看板单元，不动 Caddy/relay）。
3. 企微管理后台 → Agent Kanban(1000030)：
   - 可信域名 `relay.onetopway.com`（先把 `WW_verify_*.txt` 放到 `/opt/agent-kanban-verify/` 再点校验）
   - 企业可信 IP `82.157.187.207`
   - 应用主页 `https://relay.onetopway.com/kanban/`
4. Secret 录入（推荐方案 A）：在浏览器打开**不含 token 的**  
   `https://relay.onetopway.com/kanban/setup/wecom`  
   在表单里填写 board token（`AKB_TOKEN`）和 WeCom Secret → 写入 `$AKB_DATA_DIR/wecom.json`（0600，写一次锁定）→ 页面只显示 gettoken 的 `errcode`/`errmsg`，绝不回显 Secret。  
   备选 B：在腾讯云网页终端 `read -rs S && printf 'AKB_WECOM_SECRET=%s\n' "$S" >> /etc/agent-kanban.env && unset S` 后重启看板。
5. 确认 `curl -s -H "Authorization: Bearer $AKB_TOKEN" http://127.0.0.1:7311/kanban/api/tasks` 中 `"wecom_wired":true`；企微工作台打开应用应静默进看板。  
   `journalctl -u agent-kanban` 不应出现 errcode 50001/60020；日志中不应出现 Secret / access_token / OAuth code。

## 5. 部署后安全检查

全部做完后跑这些，全部通过再报告 finished：

- `systemd-analyze security agent-kanban`：总体暴露分数 **< 3**（OK / 较低暴露）。
- `ss -ltnp | grep 7311`：只监听 `127.0.0.1:7311`（不要出现 `0.0.0.0` 或 `*`）。
- 未带 token 时下列请求均为 **401**：
  - `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7311/kanban/api/tasks`
  - `curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:7311/kanban/mcp -H 'content-type: application/json' -d '{}'`
  - `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7311/kanban/api/stream`
  - `curl -s -o /dev/null -w '%{http_code}' -X DELETE http://127.0.0.1:7311/kanban/api/tasks/x:1`

## 报告

finished 报告写：看板网址 `https://relay.onetopway.com/kanban/`、部署的 commit、各项检查结果（含第 5 步）。
用户打开 `https://relay.onetopway.com/kanban/?token=<AKB_TOKEN>` 即可，token 只私下给，不写进报告。

## 不要做的事

- 不要停掉、重启或修改 relay、dashboard 及其配置/环境文件（只读取 relay 环境文件里的钥匙）。
- 不要 `systemctl restart caddy` / `systemctl reload caddy`（unit 无 ExecReload）；只用 `caddy reload --config ... --adapter caddyfile`。不要改除 relay.onetopway.com 以外的任何站点。
- 不要把 WeCom Secret / `AKB_TOKEN` / `AKB_SESSION_SECRET` 写进聊天、PR、截图或进度报告。
- 不要删除服务器上任何已有数据。
- 不要再提交一次这个部署任务。
