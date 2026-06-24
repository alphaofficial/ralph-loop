# Ralph Wiggum Loop

Ralph is a development methodology based on continuous AI agent loops. As Geoffrey Huntley describes it: "Ralph is a Bash loop" — a simple while true that repeatedly feeds an AI agent a prompt file, allowing it to iteratively improve its work until completion.

The technique is named after Ralph Wiggum from The Simpsons, embodying the philosophy of persistent iteration despite setbacks.

Supports **Claude Code**, **GitHub Copilot CLI**, **Codex**, **Gemini CLI**, **Hermes Agent**, **Pi**, and **OpenCode**.

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

## Install
```bash
curl -fsSL https://raw.githubusercontent.com/alphaofficial/ralph-loop/main/install.sh | bash
```

Installs a single binary to `~/.ralph/bin/ralph`. No runtime dependencies.

To update, run the same command again.

## Requirements
- `claude` installed and authenticated if you want `ralph claude`
- `copilot` installed and authenticated if you want `ralph copilot`
- `codex` installed and authenticated if you want `ralph codex`
- `gemini` installed and authenticated if you want `ralph gemini`
- `hermes` installed, on your `PATH`, and configured with at least one provider if you want `ralph hermes`
- `pi` installed, on your `PATH`, and authenticated with a supported provider if you want `ralph pi`
- `opencode` installed and authenticated if you want `ralph opencode`

Note: `ralph claude` automatically ignores a stale `ANTHROPIC_API_KEY` env var so it uses your logged-in Claude Code session instead.

## Provider notes
- Ralph never installs provider CLIs. It only checks whether the expected executable is already available on your `PATH`.
- `hermes`: executable `hermes`; user-managed setup is a working Hermes install plus at least one configured provider via `hermes model` or `~/.hermes/.env`; Ralph issues `hermes chat -q "<prompt>"`; `RALPH_MODEL` is honored as `hermes chat -q "<prompt>" --model "<model>"`.
- `pi`: executable `pi`; user-managed setup is a working Pi install plus provider auth via `/login`, provider env vars, or `~/.pi/agent/auth.json`; Ralph issues `pi -p "<prompt>"`; `RALPH_MODEL` is honored as `pi -p "<prompt>" --model "<model>"`.

## Basic usage
Inside any project:
```bash
ralph init
# edit PRD.md, TASKS.md, STATUS.md
ralph claude
ralph hermes
ralph pi
ralph gen gemini "Add Stripe subscriptions"
ralph gen hermes "Add Stripe subscriptions"
ralph gen pi "Add Stripe subscriptions"
ralph gen gemini "Add Stripe subscriptions" --interactive
```

With `ralph gen ... --interactive` or `-i`, Ralph first asks the selected provider for request-specific clarifying questions in non-interactive one-shot prompt mode. Ralph asks those questions in its own CLI, adds your answers to the final generation prompt, then invokes the selected provider again in non-interactive one-shot prompt mode to write the files. It does not launch the provider's interactive terminal session.

Or run against another project without copying scripts into it:
```bash
ralph init ~/code/my-app
ralph claude ~/code/my-app
ralph copilot ~/code/my-app
ralph codex ~/code/my-app
ralph gemini ~/code/my-app
ralph hermes ~/code/my-app
ralph pi ~/code/my-app
ralph opencode ~/code/my-app
```

## How it works
```
while (unchecked tasks in TASKS.md) {
  select the first unchecked task
  spawn fresh AI agent
  agent implements the selected task without editing TASKS.md
  run static guardrails to ensure agent follows spec
  run verification command
  run auto review gate
}
```

Each iteration gets a fresh context — no memory of previous runs. Progress is tracked in files and git history, not in the AI's context window.

Ralph selects the first unchecked task in `TASKS.md`, passes that current task to the provider, and owns task checkbox state: providers must not edit `TASKS.md`; Ralph checks the selected task only after static guard and verification pass and unchecks it on guard failure.

`PRD.md` is the source-of-truth implementation contract. `TASKS.md` slices that contract into one iteration at a time. The static guard validates provider changes against the runner-selected current task and `PRD.md`. Ralph fails an iteration before verification or auto-commit if implementation files changed outside the selected task's `Files:` line, if that task file list is outside `PRD.md`'s `## Files to touch` tree, if task test cases are not listed in `PRD.md`, if `TASKS.md` changes during provider execution, or if `PRD.md` is modified during implementation.

Auto-review runs once after each committed iteration. If the reviewer exits unsuccessfully or returns empty output, Ralph reverts the commit and records unavailable review feedback in `STATUS.md`. Otherwise, Ralph records the reviewer output in `STATUS.md` so the next normal iteration can address it.

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
ralph claude --check "npm run test:unit"
ralph codex --check "pnpm test"
ralph gemini --check "bun test"
ralph hermes --check "bun test"
ralph pi --check "bun test"
ralph opencode --check "pytest -q"
```

If your tasks already handle verification and you want to skip Ralph's runner-managed per-iteration check, disable it explicitly:
```bash
ralph claude --no-check
```

`--no-check` suppresses auto-detection and records verification as skipped. It cannot be combined with `--check`.

## Max loops
Default is 3.

This caps consecutive failed iterations before the runner gives up.

Override it if needed:
```bash
ralph claude --max-loops 12
RALPH_MAX_LOOPS=12 ralph codex
```

## Model overrides
Optional:
```bash
RALPH_MODEL=sonnet ralph claude
RALPH_MODEL=gpt-5.4 ralph codex
RALPH_MODEL=gemini-2.5-pro ralph gemini
RALPH_MODEL=anthropic/claude-sonnet-4 ralph hermes
RALPH_MODEL=sonnet ralph pi
RALPH_MODEL=opencode/qwen3.6-plus-free ralph opencode
```

## Good workflow
```bash
cd ~/code/my-app
ralph init
$EDITOR PRD.md TASKS.md STATUS.md
ralph claude
```

Ralph runs iterations until tasks are complete, committing successful iterations automatically.

## Example PRD
The `Files to touch` section uses standard `tree` output format. Use `.` for the repository root. Directory rows have no marker; file rows end with `C`, `M`, or `D`.

```md
# Goal
Add Stripe subscriptions.

## Requirements
- create checkout session
- handle webhook updates
- show current plan in billing UI

## Implementation details
- add checkout API route using the existing authenticated API route pattern
- add webhook handler using the existing raw-body middleware and billing module boundaries
- persist Stripe customer/subscription IDs in the existing user billing data shape
- verify webhook signatures before mutating billing state
- keep billing UI compatible with the current plan display state

## Files to touch
.
├── src
│   ├── api
│   │   └── billing
│   │       ├── checkout.ts C
│   │       └── webhook.ts C
│   ├── billing
│   │   └── stripe.ts M
│   └── ui
│       └── BillingPanel.tsx M
└── tests
    └── billing.test.ts C

## Test cases
- checkout route creates a Stripe checkout session for the authenticated user
- webhook rejects invalid signatures
- webhook stores subscription status updates
- billing UI renders the current plan from persisted billing state

## Guardrails
- PRD.md is the source of truth for the implementation
- do not add unlisted behavior, files, dependencies, abstractions, or tests
- do not touch files outside the Files to touch tree except TASKS.md, STATUS.md, and .ralph/*
- record spec gaps in STATUS.md instead of guessing

## Constraints
- use existing stack patterns
- keep the change small

## Definition of done
- tests pass
- billing flow works end to end
```

## Example TASKS
```md
- [ ] Add backend checkout flow.
Files: src/api/billing/checkout.ts C, src/billing/stripe.ts M, tests/billing.test.ts C
Expectation: Authenticated users can create Stripe checkout sessions using the existing billing module shape.
Test Cases: checkout route creates a Stripe checkout session for the authenticated user

- [ ] Add signed webhook handling.
Files: src/api/billing/webhook.ts C, src/billing/stripe.ts M, tests/billing.test.ts C
Expectation: Stripe webhook events update persisted billing state only after signature verification.
Test Cases: webhook rejects invalid signatures, webhook stores subscription status updates

- [ ] Update billing UI plan display.
Files: src/ui/BillingPanel.tsx M, tests/billing.test.ts C
Expectation: Billing UI shows the current plan from persisted billing state.
Test Cases: billing UI renders the current plan from persisted billing state
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

<!-- RALPH_REVIEW_FEEDBACK:START -->
{"status":"approved","changes":[]}
<!-- RALPH_REVIEW_FEEDBACK:END -->
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
ralph claude
```

## Dry run
See the generated prompt without invoking the model:
```bash
ralph claude --dry-run
ralph copilot --dry-run ~/code/my-app
ralph codex --dry-run ~/code/my-app
ralph gemini --dry-run ~/code/my-app
ralph hermes --dry-run ~/code/my-app
ralph pi --dry-run ~/code/my-app
ralph opencode --dry-run ~/code/my-app
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
