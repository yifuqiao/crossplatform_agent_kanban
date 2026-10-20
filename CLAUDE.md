# CLAUDE.md

## 看板上报（agent-kanban MCP）

要让 Claude Code 把自己的活报到看板上，把 `examples/claude-code.mcp.json` 复制成仓库根目录的 `.mcp.json`（已在 `.gitignore` 里，不会提交），
把里面的 `https://kanban.example.com/mcp` 换成你自己看板的 MCP 地址。认证用 `Authorization: Bearer ${AKB_CLAUDE_TOKEN}`。
`AKB_CLAUDE_TOKEN` 是看板管理员用 `akb token-new --source claude-code` 生成、私下交给你的来源钥匙，放在环境变量里；
没设置时不要自己去找、猜或向任何人索要钥匙，跳过上报照常干活，并在回复里说一句“看板未接通”。
钥匙不能出现在仓库、PR、提交信息、任务文本或聊天里。

用 `kanban_report` 维护自己的卡：

1. **开工就开卡**：`status: "running"`，`source: "claude-code"`，`title` 写清楚这次做什么。记住返回的 `task_key`，后面都用它更新。
   还在想方案、没动手时可以先用 `status: "planning"`。
2. **卡住了改 `waiting`**：`note` 里写清楚**等谁、等什么**，例如“等管理员提供 AKB_CLAUDE_TOKEN”、“等 PR 二审”。等到了改回 `running`。
3. **做完改 `done`，失败改 `failed`**：`summary` 写结果，`links` 附上 PR 链接，例如 `[{"url": "https://github.com/<owner>/<repo>/pull/<n>", "label": "PR"}]`。失败要写原因。
4. **派出去的活挂成子卡**：交给别的 bot 的每个任务，再调一次 `kanban_report` 新建子卡：`parent_key` 填自己这张卡的 `task_key`，`title` 写派的内容，`note` 写对方的任务 id，状态按实际走（交出去时 `queued`；对方回报进展后跟着更新）。

只更新自己建的卡。来源钥匙只能读写 `claude-code` 自己建的卡，`parent_key` 也只能是自己来源的卡，其他的会被看板拒绝。
