#!/usr/bin/env bun
import { basename, resolve } from "node:path";
import { ensureTemplates } from "./files";
import { autoDetectCheck } from "./detect";
import { mainLoop } from "./loop";
import { cleanup, log } from "./ui";
import type { Provider } from "./providers";

const USAGE = `Usage: ralph <command> [target_dir] [options]

Commands:
  init                  Initialize Ralph files in a project
  claude                Run loop with Claude Code
  copilot               Run loop with GitHub Copilot CLI
  codex                 Run loop with Codex
  opencode              Run loop with OpenCode

Options:
  --max-loops N         Max iterations (default: 8)
  --check CMD           Override verification command
  --dry-run             Show prompt without invoking
  -h, --help            Show this help

Environment:
  RALPH_CHECK_CMD       Override verification command
  RALPH_MAX_LOOPS       Override max loops
  RALPH_MODEL           Provider-specific model string
`;

function parseArgs() {
  let command: string | undefined;
  let target = process.cwd();
  let maxLoops = parseInt(process.env.RALPH_MAX_LOOPS ?? "8", 10);
  let checkCmd = "";
  let dryRun = false;

  // detect if invoked as ralph-claude, ralph-codex, etc.
  const invoked = basename(process.argv[1] ?? "");
  const ALIASES: Record<string, string> = {
    "ralph-init": "init",
    "ralph-claude": "claude",
    "ralph-codex": "codex",
    "ralph-copilot": "copilot",
    "ralph-opencode": "opencode",
  };
  if (invoked in ALIASES) {
    command = ALIASES[invoked];
  }

  const args = process.argv.slice(2);
  let i = 0;

  // if no command yet, first non-flag arg is the command
  if (!command && args.length > 0 && !args[0].startsWith("-")) {
    command = args[0];
    i = 1;
  }

  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--max-loops":
        if (i + 1 >= args.length) {
          console.error("--max-loops requires a value");
          process.exit(1);
        }
        maxLoops = parseInt(args[++i], 10);
        if (isNaN(maxLoops) || maxLoops < 1) {
          console.error("--max-loops must be a positive number");
          process.exit(1);
        }
        break;
      case "--check":
        if (i + 1 >= args.length) {
          console.error("--check requires a value");
          process.exit(1);
        }
        checkCmd = args[++i];
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
      default:
        if (!arg.startsWith("-")) target = resolve(arg);
        break;
    }
    i++;
  }

  return { command, target, maxLoops, checkCmd, dryRun };
}

// Signal handling for clean exit
process.on("SIGINT", () => {
  cleanup();
  log("interrupted");
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});
// Suppress Bun's "Execution error" on unhandled rejections from killed subprocesses
process.on("unhandledRejection", () => {});

async function main() {
  const { command, target, maxLoops, checkCmd, dryRun } = parseArgs();

  if (!command || command === "help") {
    console.log(USAGE);
    process.exit(command ? 0 : 1);
  }

  if (command === "init") {
    ensureTemplates(target);
    console.log(`Initialized Ralph files in ${target}`);
    process.exit(0);
  }

  const providers: Provider[] = ["claude", "copilot", "codex", "opencode"];
  if (!providers.includes(command as Provider)) {
    console.error(`Unknown command: ${command}`);
    console.log(USAGE);
    process.exit(1);
  }

  const provider = command as Provider;
  const check = checkCmd || autoDetectCheck(target);
  const code = await mainLoop(provider, target, maxLoops, check, dryRun);
  process.exit(code);
}

main();
