# 部署清单：把 agent kanban 放到 relay 服务器上

目标：在已经运行 grok-bot-task-relay 的服务器上运行看板，用户通过 HTTPS 网址直接打开。
用户已批准。按顺序做，做完一项再做下一项。不要把密钥写进回复、仓库、截图或进度报告。

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
- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7311/api/tasks` 返回 `401`（说明 token 生效）；
- `journalctl -u agent-kanban -n 30` 里有 `polling: grok-relay`，且没有 `poll failed`；
- relay 的 `/health` 仍然正常。

## 4. HTTPS 网址

- 不要改动或替换现有站点（dashboard、relay）。
- 只有在已经有指向本机的新域名时，才按 `deploy/Caddyfile.snippet` 增加一个站点反代到 `127.0.0.1:7311`。改之前 `caddy validate`，然后 reload。
- 没有新域名时不要改 Caddy，在报告里写明缺哪个域名。

完成：
- `https://<域名>/health` 返回 ok；
- `https://<域名>/api/tasks` 不带 token 返回 401；
- 旧站点仍可访问。

## 报告

finished 报告写：看板网址 `https://<域名>/`（或缺的域名）、部署的 commit、各项检查结果。
用户打开 `https://<域名>/?token=<AKB_TOKEN>` 即可，token 只私下给，不写进报告。

## 不要做的事

- 不要停掉或重启 relay、dashboard。
- 不要删除服务器上任何已有数据。
- 不要再提交一次这个部署任务。
