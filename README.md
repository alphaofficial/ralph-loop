# Ralph Loop

A minimal fresh-context loop for **Claude Code**, **Codex**, and **OpenCode**.

The whole point is to keep project state in files instead of one giant dying chat.

## What you edit by hand
Only these three files in the target project:
- `PRD.md`
- `TASKS.md`
- `STATUS.md`

Everything else is optional.

If the target directory is a git repo, Ralph automatically adds these to `.git/info/exclude`:
- `PRD.md`
- `TASKS.md`
- `STATUS.md`
- `.ralph/`

## Install once
```bash
./install.sh
```

## Requirements
- `claude` installed and authenticated if you want `ralph-claude`
- `codex` installed and authenticated if you want `ralph-codex`
- `opencode` installed and authenticated if you want `ralph-opencode`

Note: `ralph-claude` automatically ignores a stale `ANTHROPIC_API_KEY` env var so it uses your logged-in Claude Code session instead.

That gives you:
- `ralph-init`
- `ralph-claude`
- `ralph-codex`
- `ralph-opencode`

## Basic usage
Inside any project:
```bash
ralph-init
# edit PRD.md, TASKS.md, STATUS.md
ralph-claude
```

Or run against another project without copying scripts into it:
```bash
ralph-init ~/code/my-app
ralph-claude ~/code/my-app
ralph-codex ~/code/my-app
ralph-opencode ~/code/my-app
```

## What happens each loop
1. The runner ensures the three files exist.
2. It asks the model to read them.
3. The model does one focused chunk of work.
4. The model updates `TASKS.md` and `STATUS.md`.
5. The runner executes a verification command.
6. The runner writes the verification result back into `STATUS.md`.
7. If checks fail, it starts a fresh loop.

## Verification command
The runner auto-detects a check command in this order:
1. `RALPH_CHECK_CMD`
2. `./verify.sh`
3. `make test`
4. package.json scripts (`test`, then `build`, then `lint`)
5. `pytest -q` or `uv run pytest -q`
6. `cargo test`
7. `go test ./...`

You can also override it directly:
```bash
ralph-claude --check "npm run test:unit"
ralph-codex --check "pnpm test"
ralph-opencode --check "pytest -q"
```

## Max loops
Default is 8.

Override it if needed:
```bash
ralph-claude --max-loops 12
RALPH_MAX_LOOPS=12 ralph-codex
```

## Model overrides
Optional:
```bash
RALPH_MODEL=sonnet ralph-claude
RALPH_MODEL=gpt-5.4 ralph-codex
RALPH_MODEL=opencode/qwen3.6-plus-free ralph-opencode
```

## Good workflow
```bash
cd ~/code/my-app
ralph-init
$EDITOR PRD.md TASKS.md STATUS.md
ralph-claude
```

Then review the diff, commit, and either rerun or stop.

## Example PRD
```md
# Goal
Add Stripe subscriptions.

## Requirements
- create checkout session
- handle webhook updates
- show current plan in billing UI

## Constraints
- use existing stack patterns
- keep the change small

## Definition of done
- tests pass
- billing flow works end to end
```

## Example TASKS
```md
- [ ] inspect current billing code
- [ ] add backend checkout flow
- [ ] add webhook handler
- [ ] update billing UI
- [ ] verify with tests
```

## Example STATUS
```md
# Current status
Billing work not started yet.

# Last attempt
N/A

# Known issues
None.

# Next step
Inspect the existing billing and auth code.
```

## Design choices
- no giant config system
- no database
- no hidden project state outside the target directory
- no requirement to edit anything except the three files

## Optional `verify.sh`
If auto-detection is wrong, add a tiny script in the target project:
```bash
#!/usr/bin/env bash
set -euo pipefail
pnpm test && pnpm build
```

Then:
```bash
chmod +x verify.sh
ralph-claude
```

## Dry run
See the generated prompt without invoking the model:
```bash
ralph-claude --dry-run
ralph-codex --dry-run ~/code/my-app
ralph-opencode --dry-run ~/code/my-app
```

## Rule of thumb
Ralph loop is great for:
- features
- bugfixes
- refactors
- migrations

It is bad for:
- vague ideation
- taste-only UI tweaking
- tasks with no real verification

Keep the goal sharp, keep the checks real, and let the model come back fresh every time.
