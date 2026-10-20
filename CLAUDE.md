# CLAUDE.md

## 看板上报（agent-kanban MCP）

本仓库的 `.mcp.json` 接了看板 MCP：`https://relay.onetopway.com/kanban/mcp`，认证用 `Authorization: Bearer ${AKB_CLAUDE_TOKEN}`。
`AKB_CLAUDE_TOKEN` 由乔总提供，放在环境变量里；没设置时不要自己去找、猜或向任何人索要钥匙，跳过上报照常干活，并在回复里说一句“看板未接通”。
钥匙不能出现在仓库、PR、提交信息、任务文本或聊天里。

用 `kanban_report` 维护自己的卡：

1. **开工就开卡**：`status: "running"`，`source: "claude-code"`，`title` 写清楚这次做什么。记住返回的 `task_key`，后面都用它更新。
   还在想方案、没动手时可以先用 `status: "planning"`。
2. **卡住了改 `waiting`**：`note` 里写清楚**等谁、等什么**，例如“等乔总提供 AKB_CLAUDE_TOKEN”、“等日川驾驶舱大总管二审 PR #3”。等到了改回 `running`。
3. **做完改 `done`，失败改 `failed`**：`summary` 写结果，`links` 附上 PR 链接，例如 `[{"url": "https://github.com/…/pull/3", "label": "PR"}]`。失败要写原因。
4. **派给 Grok 的活挂成子卡**：通过 task relay 交给 Grok Bot 的每个任务，再调一次 `kanban_report` 新建子卡：`parent_key` 填自己这张卡的 `task_key`，`title` 写派的内容，`note` 写 `relay_task_id`，状态按实际走（交出去时 `queued`；Grok Bot 回报进展后跟着更新）。

只更新自己的卡。来源钥匙只能写 `claude-code` 的卡，写别的来源会被看板拒绝。
