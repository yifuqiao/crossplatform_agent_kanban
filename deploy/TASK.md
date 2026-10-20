# 部署清单：把 agent kanban 放到 relay 服务器上

目标：在已经运行 grok-bot-task-relay 的服务器上运行看板，用户通过 https://relay.onetopway.com/kanban/ 直接打开。
用户已批准。按顺序做，做完一项再做下一项。不要把密钥写进回复、仓库、截图或进度报告。

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
- `git clone https://github.com/yifuqiao/crossplatform_agent_kanban /opt/agent-kanban`；目录已存在就在里面 `git pull`，不要另起一份。
- 需要 Node.js 22 或更新版本（relay 已在用），项目没有第三方依赖，不需要 `npm install`。

完成：`/opt/agent-kanban/src/cli.js` 存在，`git -C /opt/agent-kanban log -1` 是 main 的最新提交。

## 2. 环境文件

- 按 `deploy/agent-kanban.env.example` 写 `/etc/agent-kanban.env`，权限 `0600`，属主 root。
- `AKB_TOKEN` 新生成一个随机值（`openssl rand -hex 24`）。不要写进进度报告；用已有的私下渠道交给用户。
- `GROK_RELAY_KEYS` 从 `/etc/grok-bot-task-relay.env` 里的 `RELAY_API_KEY`，以及 `RELAY_CLIENT_KEYS` 里各调用方（例如 `claude`）的值取，逗号分隔。不要打印。
- `mkdir -p /var/lib/agent-kanban`。

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

- 如果 relay 的 HTTPS 不是由这台机器上的 Caddy 终止（例如前面还有一层代理、或 Caddy 站点只 `bind 127.0.0.1`），不要改任何东西，在报告里写明实际的入口在哪里。
- 备份：`cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-agent-kanban-$(date +%Y%m%d%H%M%S)`（如果 Caddyfile 在别的位置，备份实际文件）。
- 在现有 `relay.onetopway.com { ... }` 站点里，**只新增** `deploy/Caddyfile.snippet` 中的 `handle /kanban* { reverse_proxy 127.0.0.1:7311 }`，放在站点块内第一行。站点里原有的每一行都保持原样；不新建第二个同名站点；不改其他站点。
- `caddy validate --config <Caddyfile> --adapter caddyfile` 通过后，再 `systemctl reload caddy`（用 reload，不要 restart）。validate 不通过就恢复备份，不 reload。
- reload 后立刻对比第 0 步的基线。**任何一项和基线不同**：恢复备份、`systemctl reload caddy`、再次确认基线恢复，然后报告 failed。

完成：
- 第 0 步的基线全部不变；
- `https://relay.onetopway.com/kanban/health` 返回 ok；
- `https://relay.onetopway.com/kanban/api/tasks` 不带 token 返回 401；
- `https://relay.onetopway.com/kanban` 跳转到 `/kanban/`。

## 报告

finished 报告写：看板网址 `https://relay.onetopway.com/kanban/`、部署的 commit、各项检查结果。
用户打开 `https://relay.onetopway.com/kanban/?token=<AKB_TOKEN>` 即可，token 只私下给，不写进报告。

## 不要做的事

- 不要停掉、重启或修改 relay、dashboard 及其配置/环境文件（只读取 relay 环境文件里的钥匙）。
- 不要 restart Caddy，只用 reload；不要改除 relay.onetopway.com 以外的任何站点。
- 不要删除服务器上任何已有数据。
- 不要再提交一次这个部署任务。
