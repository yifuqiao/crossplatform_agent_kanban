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
  # Build the new copy beside the old one and swap it in, so a hook running right now never sees a half-copied tree.
  rm -rf "$HOME_DIR/akb.new" && mkdir -p "$HOME_DIR/akb.new" \
    && cp -R "$tmp/x/src" "$tmp/x/package.json" "$HOME_DIR/akb.new/" || return 1
  rm -rf "$HOME_DIR/akb.old"
  if [ -d "$HOME_DIR/akb" ]; then mv "$HOME_DIR/akb" "$HOME_DIR/akb.old" || return 1; fi
  mv "$HOME_DIR/akb.new" "$HOME_DIR/akb" || return 1
  rm -rf "$HOME_DIR/akb.old"
  # Kept so the hook can re-run this same installer later (see below).
  cp "$tmp/x/scripts/install-cloud-hooks.sh" "$HOME_DIR/install.sh" 2>/dev/null || true

  # Skip when the opened repo ships its own board hooks (this repo does), so one session makes one card.
  # Cloud containers start from a snapshot taken after the setup script ran, so this copy can be days
  # behind main: at most once an hour, re-run the installer in the background (the hook never waits on it).
  cat > "$HOME_DIR/hook.sh" <<EOF
#!/usr/bin/env bash
d="\${CLAUDE_PROJECT_DIR:-.}/.claude"
if grep -qs 'hook claude-code' "\$d/settings.json" "\$d/settings.local.json"; then cat >/dev/null; exit 0; fi
if [ -f "$HOME_DIR/install.sh" ] && [ -n "\$(find "$HOME_DIR/akb/package.json" -mmin +60 2>/dev/null)" ]; then
  touch "$HOME_DIR/akb/package.json"
  AKB_REPO="$REPO" AKB_REF="$REF" AKB_HOME="$HOME_DIR" CLAUDE_SETTINGS="$SETTINGS" \\
    nohup bash "$HOME_DIR/install.sh" </dev/null >/dev/null 2>&1 &
fi
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
    const events = { SessionStart: null, UserPromptSubmit: null, PreToolUse: "*", PostToolUse: "Task|Agent|Bash|TodoWrite|mcp__.*__(set_thread_resolved|rename_thread|set_session_title|create_pull_request|update_progress_checklist)",
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
