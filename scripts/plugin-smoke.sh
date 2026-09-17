#!/usr/bin/env bash
# Installs this checkout as a Claude Code plugin into a throwaway config and proves
# each hook by its output, the way Claude Code runs them: through bash, with
# ${CLAUDE_PLUGIN_ROOT} set. Needs no login. Used by CI on Linux, macOS and Windows.
#
#   CLAUDE=/path/to/claude scripts/plugin-smoke.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE="${CLAUDE:-claude}"
WORK="$(mktemp -d)"
export CLAUDE_CONFIG_DIR="$WORK/config" HOME="$WORK/home" USERPROFILE="$WORK/home"
export CLAUDE_PROJECT_DIR="$WORK/project" TOKEN_HARNESS_COMPACT=off
mkdir -p "$CLAUDE_CONFIG_DIR" "$HOME" "$CLAUDE_PROJECT_DIR"
cd "$CLAUDE_PROJECT_DIR"

fail() { echo "FAIL: $*" >&2; exit 1; }

"$CLAUDE" plugin validate "$REPO"
"$CLAUDE" plugin marketplace add "$REPO"
"$CLAUDE" plugin install rcskills@riyans-claude-skills

HOOKS="$(find "$CLAUDE_CONFIG_DIR/plugins" -path '*rcskills*' -name hooks.json | head -1)"
[ -n "$HOOKS" ] || fail "plugin installed no hooks.json"
export CLAUDE_PLUGIN_ROOT="$(dirname "$(dirname "$HOOKS")")"
echo "plugin root: $CLAUDE_PLUGIN_ROOT"

command_for() { node -p "require(process.argv[1]).hooks[process.argv[2]][0].hooks[0].command" "$HOOKS" "$1"; }

# Runs one hook with a JSON input; fails on a non-zero exit or anything on stderr.
run_hook() {
  local out err
  err="$WORK/stderr"
  out="$(printf '%s' "$2" | bash -c "$(command_for "$1")" 2>"$err")" || fail "$1 exited non-zero: $(cat "$err")"
  [ ! -s "$err" ] || fail "$1 wrote to stderr: $(cat "$err")"
  printf '%s' "$out"
}

# A 250k-token Sonnet 4.5 session that last replied a minute ago.
TRANSCRIPT="$CLAUDE_PROJECT_DIR/session.jsonl"
node -e '
  const at = new Date(Date.now() - 60000).toISOString();
  const usage = { input_tokens: 10, cache_read_input_tokens: 249000, cache_creation_input_tokens: 1000,
    cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 0 }, output_tokens: 100 };
  const rec = { type: "assistant", requestId: "r1", timestamp: at,
    message: { model: "claude-sonnet-4-5-20250929", content: [{ type: "text", text: "ok" }], usage } };
  require("fs").writeFileSync(process.argv[1], JSON.stringify(rec) + "\n");
' "$TRANSCRIPT"
input() { node -p 'JSON.stringify({ session_id: process.argv[1], source: "startup", prompt: "what next", transcript_path: process.argv[2] })' "$1" "$TRANSCRIPT"; }

OUT="$(run_hook UserPromptSubmit "$(input s1)")"
echo "UserPromptSubmit: $OUT"
echo "$OUT" | grep -q '250k tokens cached.*re-sends it all (~\$1\.50)' || fail "no [cache] notice priced for Sonnet 4.5"

run_hook SessionStart "$(input s2)" >/dev/null
run_hook Stop "$(input s3)" >/dev/null
run_hook PreModelSwitch "$(input s4)" >/dev/null

OUT="$("$CLAUDE_PLUGIN_ROOT/bin/rcskills" route "rename the variable foo to bar")"
echo "$OUT" | grep -q '"tier"' || fail "rcskills shim did not run the router: $OUT"

# Installed both ways, the plugin must stand down so no line is doubled.
node -e '
  const fs = require("fs"); const f = process.argv[1];
  const s = JSON.parse(fs.readFileSync(f, "utf8"));
  s.hooks = { UserPromptSubmit: [{ hooks: [{ type: "command", command: "node \"/x/.claude/helpers/learning-hook.cjs\" recall --global" }] }] };
  fs.writeFileSync(f, JSON.stringify(s));
' "$CLAUDE_CONFIG_DIR/settings.json"
OUT="$(run_hook UserPromptSubmit "$(input s5)")"
[ -z "$OUT" ] || fail "plugin spoke beside a settings install: $OUT"

echo "plugin smoke: ok"
rm -rf "$WORK"
