# Grok Bot: report wrapped activity to the agent kanban

Give these instructions to Grok Bot (and to any bot it forwards work to) so the board can show
what happens *inside* a relay task. Without them the board still works: it polls the relay and
infers hand-offs (`forwarded` + bot id) and Cursor cloud agents (`bc-…` ids) from progress
summaries. With them, every inner step gets its own card, status and links.

## Where the board is

- `AKB_URL`, for example `https://kanban.example.com` (must be reachable from where Grok Bot runs)
- A `grok-bot` source key, sent as `Authorization: Bearer <key>`. The board admin makes one with
  `akb token-new --source grok-bot` (add `--agent <bot>` to bind it to one bot) and hands it over
  privately. Keep it out of task text and chat. Do not give Grok Bot the admin `AKB_TOKEN`.
  The key can only write `grok-bot:*` cards (its bot's, when bound) and only nest them under
  `grok-bot:*` cards.

## The task's own card

Every relay task is already on the board as `grok-bot:<relay_task_id>`. Do not create another
card for it; nest your inner activities under it with `parent`.

## Report an inner activity

```http
POST {AKB_URL}/api/events
Authorization: Bearer <grok-bot key>
Content-Type: application/json

{
  "key": "grok-bot:<relay_task_id>/review",
  "parent": "grok-bot:<relay_task_id>",
  "kind": "bot",
  "title": "代码二审 PR#23",
  "status": "waiting",
  "message": "等待二审 allow",
  "event_id": "<stable id, so retries are not duplicated>"
}
```

- `key` is `source:id` and must be stable for the activity, so later calls update the same card.
- `status` is one of `queued`, `running`, `waiting` (needs a human), `review`, `done`, `failed`.
  Native words such as `executing`, `waiting_approval`, `finished` are accepted too.
- `parent` can point at any card, so activities can nest several levels deep
  (task → bot hand-off → Cursor cloud agent).
- Optional: `summary`, `url`, `links: [{"url": "...", "label": "PR"}]`, `meta: {...}`.
- A list of events can be sent in one request as a JSON array.

## Keep running cards fresh

The board flags a running card as **Silent** after 30 minutes without an event, because a card
that says "running" but has gone quiet is the main reason the board stops being trusted.
While a task or inner activity is running, send an event at least every 15 minutes, even if it
only says what step you are on. Always send the final `done` or `failed`; never leave a card
running after the work stopped.

## Cursor cloud agents

A `grok-bot` key cannot write `cursor-cloud:*` cards. Mention the `bc-…` id in the relay progress
summary instead: the board nests the agent under the relay task and its Cursor poller keeps the
status current. With the admin `AKB_TOKEN` you can also report it directly with the Cursor agent
id so the poller merges into the same card:

```json
{ "key": "cursor-cloud:bc-xxxxxxxx", "parent": "grok-bot:<relay_task_id>", "status": "running",
  "title": "Fix DRAWING_STORE fail-closed", "url": "https://cursor.com/agents?id=bc-xxxxxxxx" }
```

Either way, mention the `bc-…` id in the relay progress summary; the board picks it up from there too.

## CLI agents you start

When you start Claude Code, Codex or Cursor CLI on a machine that has `akb` hooks installed, set
`AKB_PARENT_KEY=grok-bot:<relay_task_id>` in its environment (or launch it through
`akb run --parent grok-bot:<relay_task_id> -- <command>`). Its session then appears nested under
the relay task with live progress from its own hooks.

## Get update requests

The user can press **Get update** on a card. The board only marks the card; it does not message
Grok Bot or the relay. Every `kanban_report` result carries `update_requests` (cards of your
source waiting for a brief), and `kanban_update_requests` lists them on demand. Answer each one
with `kanban_report` on its `task_key` with a `summary`: the latest state in a few lines
(progress numbers, blockers, next step). Over HTTP, send the same as an event with
`"summary": "...", "brief": true`.
