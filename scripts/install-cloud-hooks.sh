#!/usr/bin/env bash
# Install the board's Claude Code hooks at user level (~/.claude/settings.json), so every
# claude.ai/code cloud session reports to the board, whatever repository it opened.
# Meant for the cloud environment's setup script:
#   curl -fsSL https://raw.githubusercontent.com/yifuqiao/crossplatform_agent_kanban/main/scripts/install-cloud-hooks.sh | bash
# The hooks read AKB_URL and AKB_SOURCE_KEY from the environment at run time; no key is written to disk.
# Never fails the setup: any error is printed and the script exits 0.
set -uo pipefail

REPO="${AKB_REPO:-yifuqiao/crossplatform_agent_kanban}"
REF="${AKB_REF:-main}"
HOME_DIR="${AKB_HOME:-$HOME/.agent-kanban}"
SETTINGS="${CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"

log() { echo "[akb-install] $*" >&2; }

install() {
  command -v node >/dev/null || { log "node not found; skipping"; return 1; }
  local tmp; tmp="$(mktemp -d)" || return 1
  trap 'rm -rf "$tmp"' RETURN

  curl -fsSL --retry 3 "https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF" -o "$tmp/akb.tgz" \
    || { log "download of $REPO@$REF failed; skipping"; return 1; }
  mkdir -p "$tmp/x" && tar -xzf "$tmp/akb.tgz" -C "$tmp/x" --strip-components=1 \
    || { log "extract failed; skipping"; return 1; }
  [ -f "$tmp/x/src/cli.js" ] || { log "src/cli.js missing in $REPO@$REF; skipping"; return 1; }

  mkdir -p "$HOME_DIR"
  rm -rf "$HOME_DIR/akb" && mkdir -p "$HOME_DIR/akb" \
    && cp -R "$tmp/x/src" "$tmp/x/package.json" "$HOME_DIR/akb/" || return 1

  # Skip when the opened repo ships its own board hooks (this repo does), so one session makes one card.
  cat > "$HOME_DIR/hook.sh" <<EOF
#!/usr/bin/env bash
d="\${CLAUDE_PROJECT_DIR:-.}/.claude"
if grep -qs 'hook claude-code' "\$d/settings.json" "\$d/settings.local.json"; then cat >/dev/null; exit 0; fi
exec node "$HOME_DIR/akb/src/cli.js" hook claude-code
EOF
  chmod +x "$HOME_DIR/hook.sh"

  mkdir -p "$(dirname "$SETTINGS")"
  HOOK="$HOME_DIR/hook.sh" SETTINGS="$SETTINGS" node --input-type=module -e '
    import fs from "node:fs";
    const { HOOK, SETTINGS } = process.env;
    let s = {};
    try { s = JSON.parse(fs.readFileSync(SETTINGS, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw e; }
    s.hooks ||= {};
    const ours = (g) => (g.hooks || []).some((h) => h.command?.includes(".agent-kanban/hook.sh"));
    const events = { SessionStart: null, UserPromptSubmit: null, PreToolUse: "*", PostToolUse: "Task|Agent|mcp__.*__set_thread_resolved",
      Notification: null, Stop: null, SessionEnd: null };
    for (const [ev, matcher] of Object.entries(events)) {
      const groups = (s.hooks[ev] || []).filter((g) => !ours(g));
      groups.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: JSON.stringify(HOOK), timeout: 5 }] });
      s.hooks[ev] = groups;
    }
    fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + "\n");
  ' || { log "could not update $SETTINGS"; return 1; }

  log "installed $REPO@$REF hooks into $SETTINGS"
  [ -n "${AKB_URL:-}" ] && [ -n "${AKB_SOURCE_KEY:-${AKB_TOKEN:-}}" ] \
    || log "note: AKB_URL / AKB_SOURCE_KEY not set here; hooks stay silent until the session has them"
}

install || true
exit 0
