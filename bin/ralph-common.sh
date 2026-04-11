#!/usr/bin/env bash
set -euo pipefail

RALPH_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage_common() {
  cat <<USAGE
Usage: $1 [target_dir] [--max-loops N] [--check CMD] [--dry-run]

Defaults:
  target_dir   current directory
  max loops    8
  check cmd    auto-detected

Only PRD.md, TASKS.md, and STATUS.md are intended to be edited by hand.
Optional overrides:
  RALPH_CHECK_CMD       override verification command
  RALPH_MAX_LOOPS       override max loops
  RALPH_MODEL           provider-specific model string
USAGE
}

log() { printf '[ralph] %s\n' "$*"; }
err() { printf '[ralph] ERROR: %s\n' "$*" >&2; }

notify() {
  local title="$1" message="$2"
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$message\" with title \"$title\" sound name \"Glass\"" 2>/dev/null || true
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send "$title" "$message" 2>/dev/null || true
  fi
}

ensure_git_excludes() {
  local target="$1"
  if ! git -C "$target" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    return 0
  fi
  local exclude_file="$target/.git/info/exclude"
  mkdir -p "$(dirname "$exclude_file")"
  touch "$exclude_file"
  local pattern
  for pattern in "PRD.md" "TASKS.md" "STATUS.md" ".ralph/"; do
    if ! grep -qxF "$pattern" "$exclude_file" 2>/dev/null; then
      printf '%s\n' "$pattern" >> "$exclude_file"
    fi
  done
}

ensure_templates() {
  local target="$1"
  mkdir -p "$target/.ralph"
  [[ -f "$target/PRD.md" ]] || cp "$RALPH_ROOT/templates/PRD.md" "$target/PRD.md"
  [[ -f "$target/TASKS.md" ]] || cp "$RALPH_ROOT/templates/TASKS.md" "$target/TASKS.md"
  [[ -f "$target/STATUS.md" ]] || cp "$RALPH_ROOT/templates/STATUS.md" "$target/STATUS.md"
  ensure_git_excludes "$target"
}

package_manager() {
  local target="$1"
  if [[ -f "$target/pnpm-lock.yaml" ]]; then echo pnpm
  elif [[ -f "$target/yarn.lock" ]]; then echo yarn
  elif [[ -f "$target/bun.lockb" || -f "$target/bun.lock" ]]; then echo bun
  else echo npm
  fi
}

json_has_script() {
  local target="$1" name="$2"
  python3 - "$target/package.json" "$name" <<'PY'
import json,sys
path,name=sys.argv[1],sys.argv[2]
try:
    data=json.load(open(path))
    print('yes' if name in (data.get('scripts') or {}) else 'no')
except Exception:
    print('no')
PY
}

auto_detect_check() {
  local target="$1"
  if [[ -n "${RALPH_CHECK_CMD:-}" ]]; then echo "$RALPH_CHECK_CMD"; return; fi
  if [[ -x "$target/verify.sh" ]]; then echo "./verify.sh"; return; fi
  if [[ -f "$target/Makefile" ]] && grep -qE '^test:' "$target/Makefile"; then echo "make test"; return; fi
  if [[ -f "$target/package.json" ]]; then
    local pm
    pm="$(package_manager "$target")"
    if [[ "$(json_has_script "$target" test)" == yes ]]; then echo "$pm test"; return; fi
    if [[ "$(json_has_script "$target" build)" == yes ]]; then echo "$pm run build"; return; fi
    if [[ "$(json_has_script "$target" lint)" == yes ]]; then echo "$pm run lint"; return; fi
  fi
  if [[ -f "$target/pyproject.toml" ]]; then
    if command -v uv >/dev/null 2>&1; then echo "uv run pytest -q"; return; fi
    echo "pytest -q"; return
  fi
  if [[ -f "$target/Cargo.toml" ]]; then echo "cargo test"; return; fi
  if [[ -f "$target/go.mod" ]]; then echo "go test ./..."; return; fi
  echo ""
}

update_runner_block() {
  local status_file="$1" content_file="$2"
  python3 - "$status_file" "$content_file" <<'PY'
from pathlib import Path
import re,sys
status = Path(sys.argv[1])
content = Path(sys.argv[2]).read_text().rstrip() + "\n"
text = status.read_text() if status.exists() else ""
start = '<!-- RALPH_RUNNER:START -->'
end = '<!-- RALPH_RUNNER:END -->'
block = f"{start}\n{content}{end}"
pat = re.compile(re.escape(start)+r'.*?'+re.escape(end), re.S)
if pat.search(text):
    text = pat.sub(block, text)
else:
    if text and not text.endswith('\n'):
        text += '\n'
    text += '\n' + block + '\n'
status.write_text(text)
PY
}

make_prompt() {
  local provider="$1" target="$2" check_cmd="$3" loop_no="$4" prompt_file="$5"
  cat > "$prompt_file" <<EOF2
You are running a Ralph loop iteration inside this project.

Read these files first:
- PRD.md
- TASKS.md
- STATUS.md

Rules:
- Do one focused iteration only.
- Make real file changes in the project when useful.
- Update TASKS.md to reflect progress.
- Update STATUS.md with what changed, what failed, and the next best step.
- Keep STATUS.md concrete, short, and truthful.
- Do not claim the task is done unless checks pass.
- Avoid huge refactors unless the PRD requires them.
- Prefer the smallest change that moves the task forward.

Iteration number: ${loop_no}
Verification command after your run: ${check_cmd:-<none auto-detected>}

If you need to leave notes for the next fresh run, put them in STATUS.md, not in chat.
EOF2
}

run_check() {
  local target="$1" check_cmd="$2" out_file="$3"
  if [[ -z "$check_cmd" ]]; then
    printf 'No verification command detected.\n' > "$out_file"
    return 2
  fi
  set +e
  (cd "$target" && bash -lc "$check_cmd") > "$out_file" 2>&1
  local code=$?
  set -e
  return "$code"
}

main_loop() {
  local provider="$1" target="$2" max_loops="$3" check_cmd="$4" dry_run="$5"
  ensure_templates "$target"
  local loop prompt_file check_out summary_file code
  for ((loop=1; loop<=max_loops; loop++)); do
    log "loop $loop/$max_loops ($provider) in $target"
    prompt_file="$target/.ralph/prompt-$provider.txt"
    make_prompt "$provider" "$target" "$check_cmd" "$loop" "$prompt_file"
    if [[ "$dry_run" == "1" ]]; then
      log "dry run, not invoking $provider"
      cat "$prompt_file"
      return 0
    fi
    invoke_provider "$provider" "$target" "$prompt_file"
    summary_file="$target/.ralph/check-summary.txt"
    check_out="$target/.ralph/check-output.txt"
    if run_check "$target" "$check_cmd" "$check_out"; then
      code=0
      {
        printf 'Verification: PASS\n'
        if [[ -n "$check_cmd" ]]; then printf 'Command: %s\n\n' "$check_cmd"; fi
        sed -n '1,120p' "$check_out"
      } > "$summary_file"
      update_runner_block "$target/STATUS.md" "$summary_file"
      log "checks passed"
      notify "Ralph ✓" "Checks passed on loop $loop/$max_loops"
      return 0
    else
      code=$?
      {
        if [[ $code -eq 2 ]]; then
          printf 'Verification: SKIPPED\n'
        else
          printf 'Verification: FAIL\n'
        fi
        if [[ -n "$check_cmd" ]]; then printf 'Command: %s\n\n' "$check_cmd"; fi
        sed -n '1,120p' "$check_out"
      } > "$summary_file"
      update_runner_block "$target/STATUS.md" "$summary_file"
      if [[ $code -eq 2 ]]; then
        log "no check command detected, stopping after one loop"
        notify "Ralph" "Completed 1 loop (no check command)"
        return 0
      fi
      log "checks failed, continuing"
    fi
  done
  err "max loops reached"
  notify "Ralph ✗" "Failed after $max_loops loops"
  return 1
}
