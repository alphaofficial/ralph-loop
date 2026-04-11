#!/usr/bin/env bash
set -euo pipefail

RALPH_HOME="${HOME}/.ralph"
REPO="https://github.com/alphaofficial/ralph-loop.git"

# Clone or update
if [[ -d "$RALPH_HOME/.git" ]]; then
  printf 'Updating Ralph in %s\n' "$RALPH_HOME"
  git -C "$RALPH_HOME" pull --ff-only
else
  printf 'Installing Ralph to %s\n' "$RALPH_HOME"
  rm -rf "$RALPH_HOME"
  git clone "$REPO" "$RALPH_HOME"
fi

# Add to PATH if not already there
SHELL_RC="${HOME}/.$(basename "${SHELL:-bash}")rc"
if [[ -f "$SHELL_RC" ]] && ! grep -q '.ralph/bin' "$SHELL_RC" 2>/dev/null; then
  printf '\nexport PATH="$HOME/.ralph/bin:$PATH"\n' >> "$SHELL_RC"
  printf 'Added %s/bin to PATH in %s\n' "$RALPH_HOME" "$SHELL_RC"
fi

printf 'Done!\n'
exec zsh -l
