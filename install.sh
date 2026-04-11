#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
DEST="${HOME}/.local/bin"
mkdir -p "$DEST"
ln -sf "$ROOT/bin/ralph-claude" "$DEST/ralph-claude"
ln -sf "$ROOT/bin/ralph-codex" "$DEST/ralph-codex"
ln -sf "$ROOT/bin/ralph-init" "$DEST/ralph-init"
printf 'Installed Ralph commands into %s\n' "$DEST"
printf 'Make sure %s is on your PATH.\n' "$DEST"
