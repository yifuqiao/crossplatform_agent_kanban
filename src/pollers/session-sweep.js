// Agent sessions in the cloud (and many local ones) never send a session end: the person just stops
// talking to them. Their cards would then sit in 进行中 for days, marked 空闲 or 静默. A hook session
// card that has heard nothing for QUIET_MS is closed here; the next prompt in that session (a hook
// event with status running) puts it back in 进行中.
export const SESSION_SOURCES = new Set(["claude-code", "claude-code-web", "codex", "codex-cloud", "cursor", "cursor-cli"]);
export const QUIET_MS = 6 * 3600 * 1000;
// Waiting (等您) cards stay: they wait on the person, not on the agent.
const OPEN = new Set(["queued", "planning", "running"]);

export function createSessionSweeper({ store, quietMs = QUIET_MS, now = () => Date.now() }) {
  return {
    name: "session sweep",
    async poll() {
      const cutoff = now() - quietMs;
      const kids = new Map();
      for (const t of store.list()) if (t.parentKey) kids.set(t.parentKey, [...(kids.get(t.parentKey) || []), t]);
      // Newest update on the card or anything nested under it (a subagent may still be talking).
      const lastHeard = (t) => (kids.get(t.key) || []).map(lastHeard).reduce((m, at) => (at > m ? at : m), t.updatedAt);
      for (const t of store.list({ root: true })) {
        // MCP cards move only when their agent reports, and have their own Get update flow.
        if (!SESSION_SOURCES.has(t.source) || t.createdBy || !OPEN.has(t.status)) continue;
        const heard = lastHeard(t);
        if (Date.parse(heard) > cutoff) continue;
        const hours = Math.round(quietMs / 3600000);
        store.apply({
          key: t.key,
          status: "done",
          message: `${hours} 小时没有动静，自动收起；在这个会话里再说话会回到进行中`,
          type: "sweep",
        });
      }
    },
  };
}
