# Claude 自定义 connector（OAuth）部署说明

让 claude.ai 网页和 Claude iPhone 应用连上 `https://relay.onetopway.com/kanban/mcp`。
这两个客户端不会带静态 `Authorization` 头，它们按 MCP 的 OAuth 2.1 发现流程走。

看板自己在 `/kanban/` 下面提供发现文档和 `/kanban/oauth/*`。
**不要**把 connector 地址填成 `https://relay.onetopway.com/mcp`：那是 grok-bot-task-relay，会弹出 Relay key 页面。
本文件描述的默认部署**不改 Caddy**。可选的根路径补丁单独写在文末，现在不要加。

不要改 `deploy/agent-kanban.service`，不要动 systemd 加固项。

## 乔总在 iPhone 上怎么加

Claude iPhone 应用可以**使用**已经连上的自定义 connector；添加界面在手机上是测试功能，如果应用里没有「添加自定义 connector」，用 iPhone 的 Safari 打开 claude.ai 做下面第 1–9 步，完成后回到 App 里启用即可（账号是通的）。

1. 打开 Claude → 左上角头像（或菜单）→ **Customize（自定义）** → **Connectors（连接器）**。
2. 点 **+ Add** → **Add custom connector**（自定义 → Web）。
3. 名称填 `Agent Kanban`。
4. 远程 MCP URL **原样**填写：`https://relay.onetopway.com/kanban/mcp`
   - 不要加 `?token=`
   - 不要加末尾斜杠
   - 不要填域名根上的 `/mcp`
5. Continue。Claude 会先打到看板，收到 `401` 和 `WWW-Authenticate` 里的 `resource_metadata`，然后自己去读 `/kanban/.well-known/...`。
6. Authentication（认证）选 **Sign in now（立即登录）**。不要选 No sign in。
7. OAuth client（OAuth 客户端）选 **Register automatically（自动注册）**。
   不要选 “Use Claude’s published identity”：看板没有实现 Client ID Metadata Document，选那个会注册失败。
8. Request headers（请求头）留空。不要把 `AKB_TOKEN` 或来源钥匙贴进这里。
9. 点 Add。Claude 会打开看板的同意页（应用内浏览器）。
10. 在同意页上二选一。同意页会写明「只在你自己刚在 Claude 里点了连接时才允许」，并给出客户端编号前几位和注册时间。只在自己刚点了连接时才点允许。
    - **企业微信**：点「用企业微信登录」，用白名单里的账号（`QiaoYiFu`）完成登录，回到同意页后来源选 **`claude-code`**，点「允许」。
    - **来源钥匙**：把已经配在 `AKB_SOURCE_TOKENS` 里的那把 `claude-code` 钥匙贴进密码框，点「用这把钥匙允许」。钥匙只在这一次证明身份，不会变成管理员。
11. 浏览器回到 Claude，连接器显示已连接。开一个对话，在工具里打开 **Agent Kanban**。

同意页明确不会发管理员令牌。发出来的访问令牌和当时那次授权的凭证等价：

- 企业微信登录后只能选 `AKB_OAUTH_SOURCES` 里的来源（默认只有 `claude-code`），看不到 admin，也看不到没列进去的 `grok-bot`。
- 某个来源如果只配置了 `source@bot` 钥匙，同意页按 bot 列出（例如 `grok-bot@ops-bot`）。令牌绑在这个 bot 上，不会变成能看该来源全部卡片的无绑定令牌。
- 贴钥匙则按那把钥匙的来源（以及 `@bot` 绑定）授权，并且记的是这把钥匙的条目。换一把同名钥匙后，旧的 OAuth 令牌失效。
- 不能改成别的来源，也不能调用 `/api/*`。

访问令牌大约 1 小时。整次授权从同意那一刻起最多 30 天；刷新会轮换令牌，但不会把这 30 天往后推。Claude 会自己刷新。撤掉对应的来源钥匙，或把企业微信用户移出 `AKB_WECOM_USERS`，然后重启看板：已发出的 OAuth 访问令牌和刷新令牌一起失效。静态钥匙的撤销方式不变（删掉那一行并重启）。

## 服务器上要先有的东西

这次上线要改 `/etc/agent-kanban.env`（`root:root 0600`）。不要改 Caddyfile，不要改 systemd 单元。

- `AKB_PUBLIC_URL` 必须继续是 `https://relay.onetopway.com/kanban`（https，不要尾部斜杠）。OAuth 的 issuer 和企微登录的回调都用这一个地址，两边要保持一致，不要为 OAuth 另设一个 URL。
- `AKB_BASE_PATH=/kanban`。
- 企业微信登录：在企业微信 App 里打开时走 App 内授权；在电脑浏览器（包括 ChatGPT、Claude 弹出的登录窗口）里打开时跳企业微信**扫码登录**。扫码登录要在企业微信管理后台 → 应用管理 → 这个应用（`AKB_WECOM_AGENT_ID`）→ 企业微信授权登录 → Web 网页，把授权回调域设成 `relay.onetopway.com`。
- `AKB_OAUTH_SOURCES`：企业微信同意页允许点选的来源名，逗号分隔。不设时只有 `claude-code`。不要把 `grok-bot` 加进去，除非确实要让登录用户代那个来源发令牌。只配了 `@bot` 钥匙的来源会按 bot 出现，令牌带上这个 bot。
- `AKB_SOURCE_TOKENS` 里至少有一条不带 `@bot` 的 `claude-code:<sha256>`，同意页才列得出 `claude-code`，贴钥匙才能对上。
  生成：在服务器上 `akb token-new --source claude-code`，钥匙只私下给，哈希写进 env。
- `AKB_TRUST_PROXY`：默认不设。不设时看板用 TCP 对端做限流，忽略客户端自己带的 `X-Forwarded-For`。看板只听 `127.0.0.1:7311`，对端是本机 Caddy，所以要让限流看见真实客户端时，设 `AKB_TRUST_PROXY=127.0.0.1`。这只有在 Caddy **覆盖**（不是追加）客户端送来的 `X-Forwarded-For` 时才安全：第一跳必须是 Caddy 看到的地址，不能是客户端自己填的。本说明不修改 Caddy；在确认 Caddy 会覆盖该头之前，不要设 `AKB_TRUST_PROXY`。
- `AKB_DATA_DIR` 可写。OAuth 状态在 `$AKB_DATA_DIR/oauth.json`（原子写入，`0600`），和 `state.json` 分开。进行中的同意请求只放内存，不写进这个文件；看板重启后要重新在 Claude 里点连接。
  已有卡片不会被删、也不会因为 OAuth 被重写。
- 重定向默认只允许：
  - `https://claude.ai/api/mcp/auth_callback`
  - `https://claude.com/api/mcp/auth_callback`
  - `https://chatgpt.com/connector_platform_oauth_redirect`（ChatGPT 开发者模式 app 和 Codex；看板在每个授权跳回里带 `iss`，ChatGPT 才会用这个固定地址）
  要多放一个，设 `AKB_OAUTH_REDIRECT_ALLOW` 为逗号分隔的 **完整 https URL**（精确匹配，追加到上面两个，不替换）。`http://` 和带 `#` 的会被忽略。

PKCE 只用 S256。授权码 60 秒、一次性。访问令牌只存哈希。

## 发布（只重启看板）

1. 把包含本改动的 commit 部署到 `/opt/agent-kanban`（按 `deploy/TASK.md` 钉死 SHA，不要浮动 `git pull`）。
2. 按上面改 `/etc/agent-kanban.env`（`root:root 0600`）。不要把钥匙写进聊天或 PR。
3. **只**重启看板：`systemctl restart agent-kanban`。
   不要 `systemctl restart/reload caddy`，不要重启 relay。
4. 确认：
   - `systemctl is-active grok-bot-task-relay` 仍是 `active`
   - `curl -s -o /dev/null -w '%{http_code}' https://relay.onetopway.com/health` 和部署前一样
   - `curl -s -o /dev/null -w '%{http_code}' https://relay.onetopway.com/mcp` 不带钥匙仍是 relay 的 401（不是看板）
   - `curl -sI -X POST https://relay.onetopway.com/kanban/mcp -H 'content-type: application/json' -d '{}'` 是 **401**，并且有：
     `WWW-Authenticate: Bearer resource_metadata="https://relay.onetopway.com/kanban/.well-known/oauth-protected-resource"`
   - `curl -s https://relay.onetopway.com/kanban/.well-known/oauth-protected-resource` 里 `resource` 是 `https://relay.onetopway.com/kanban/mcp`，`authorization_servers` 只有 `https://relay.onetopway.com/kanban`
   - `curl -s https://relay.onetopway.com/kanban/.well-known/oauth-authorization-server` 和 `.../kanban/.well-known/openid-configuration` 都能打开，`issuer` 是 `https://relay.onetopway.com/kanban`，`code_challenge_methods_supported` 含 `S256`，`registration_endpoint` 是 `https://relay.onetopway.com/kanban/oauth/register`
   - 用原来的 `AKB_TOKEN` 或 `claude-code` 来源钥匙调 `/kanban/mcp` 仍然 200（Claude Code CLI / grok-bot 不用改）
   - `ls -l /var/lib/agent-kanban/oauth.json` 是 `0600`；`state.json` 还在
5. `journalctl -u agent-kanban -n 50` 里不应出现钥匙、授权码、access token、refresh token、WeCom Secret。

OAuth 状态读不出来时（文件坏了、`AKB_PUBLIC_URL` 不是 https、目录不可写），`/kanban/oauth/*` 和发现文档返回 **503**，`/kanban/mcp` 不再带 `resource_metadata`，静态 Bearer 照旧。不要为了“修好”去删 `state.json`。修 `oauth.json` 时先备份；确认备份可读再决定是否移走坏文件让看板生成新的（这会使已发出的 OAuth 令牌失效，静态钥匙不受影响）。

## 可选：根路径发现（现在不要做）

有的客户端会**忽略** `WWW-Authenticate`，自己去域名根上探测，例如：

- `https://relay.onetopway.com/.well-known/oauth-protected-resource/kanban/mcp`
- `https://relay.onetopway.com/.well-known/oauth-authorization-server/kanban`

这些路径**不**在现有的 `handle /kanban*` 里。不改 Caddy 时它们会落到 relay，可能出现 Relay key 页面。
Claude 按规范会先用我们 401 里给出的 `/kanban/.well-known/oauth-protected-resource`，所以默认不依赖下面这块。

只有在确认客户端确实在打根路径、并且看板自己的 401 头已经被忽略时，才考虑加上。步骤固定：

1. 备份：`cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-oauth-$(date +%Y%m%d%H%M%S)`
2. 在**现有** `relay.onetopway.com` 站点里、`handle /kanban*` **之上**，加上下面三个**精确** handle。不要写 `/.well-known*` 这种通配，那会把 relay 自己的 `/.well-known/oauth-authorization-server` 抢走。
3. `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`。失败就恢复备份，不要 reload。
4. 通过后：`caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`。
   禁止 `systemctl restart caddy` / `systemctl reload caddy`。
5. 立刻对比 relay 的 `/health`、`/mcp`（不带钥匙仍是 relay 的 401）和其他站点首页。有任何一项变了：恢复备份，再 `caddy reload`，然后停下来报告。

```
	handle /.well-known/oauth-protected-resource/kanban/mcp {
		rewrite * /kanban/.well-known/oauth-protected-resource
		reverse_proxy 127.0.0.1:7311
	}

	handle /.well-known/oauth-authorization-server/kanban {
		rewrite * /kanban/.well-known/oauth-authorization-server
		reverse_proxy 127.0.0.1:7311
	}

	handle /.well-known/openid-configuration/kanban {
		rewrite * /kanban/.well-known/openid-configuration
		reverse_proxy 127.0.0.1:7311
	}
```

看板进程只认 `/kanban/...`（`AKB_BASE_PATH`）。上面的 `rewrite` 把根路径翻译成看板已经提供的文档，所以不需要改 Node，也不需要改 systemd。
