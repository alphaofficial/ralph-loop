#!/usr/bin/env bash
set -euo pipefail

RALPH_HOME="${HOME}/.ralph"
RALPH_BIN="${RALPH_HOME}/bin"
REPO="alphaofficial/ralph-loop"

# Detect platform
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  ARCH="x64" ;;
  aarch64) ARCH="arm64" ;;
  arm64)   ARCH="arm64" ;;
  *)       printf 'Unsupported architecture: %s\n' "$ARCH" >&2; exit 1 ;;
esac

BINARY="ralph-${OS}-${ARCH}"
URL="https://github.com/${REPO}/releases/latest/download/${BINARY}"

printf 'Installing Ralph (%s-%s)...\n' "$OS" "$ARCH"

# Clean up old git-based install
if [[ -d "$RALPH_HOME/.git" ]]; then
  printf 'Cleaning up old installation...\n'
  rm -rf "$RALPH_HOME"
fi

mkdir -p "$RALPH_BIN"
curl -fsSL "$URL" -o "${RALPH_BIN}/ralph"
chmod +x "${RALPH_BIN}/ralph"

printf 'Installed ralph to %s/ralph\n' "$RALPH_BIN"

# Add to PATH if not already there
SHELL_RC="${HOME}/.$(basename "${SHELL:-bash}")rc"
if [[ -f "$SHELL_RC" ]] && ! grep -q '.ralph/bin' "$SHELL_RC" 2>/dev/null; then
  printf '\nexport PATH="$HOME/.ralph/bin:$PATH"\n' >> "$SHELL_RC"
  printf 'Added %s to PATH in %s\n' "$RALPH_BIN" "$SHELL_RC"
fi

printf 'Done!\n'
exec "${SHELL:-zsh}" -l
