#!/usr/bin/env bun
import { basename, dirname, parse, resolve, join } from "node:path";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { ensureTemplates } from "./files";
import { autoDetectCheck } from "./detect";
import { mainLoop } from "./loop";
import { generate } from "./generate";
import { cleanup, log } from "./ui";
import {
  GENERATION_PROVIDERS,
  LOOP_PROVIDERS,
  type Provider,
} from "./providers";

declare const RALPH_VERSION: string;
const VERSION = typeof RALPH_VERSION !== "undefined" ? RALPH_VERSION : "dev";
const REPO = "alphaofficial/ralph-loop";

function ralphHome() {
  if (process.env.RALPH_HOME) return process.env.RALPH_HOME;
  if (!process.env.HOME) throw new Error("HOME is required when RALPH_HOME is not set");
  return join(process.env.HOME, ".ralph");
}

function safeRalphHomeForDeletion() {
  const home = resolve(ralphHome());
  const root = parse(home).root;
  if (home === root || dirname(home) === home || basename(home) !== ".ralph") {
    throw new Error(`Refusing to uninstall unsafe Ralph home: ${home}`);
  }
  return home;
}

function platformBinary() {
  const os = process.platform;
  if (os !== "darwin" && os !== "linux") {
    throw new Error(`Unsupported platform: ${os}`);
  }
  const arch = process.arch;
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported architecture: ${arch}`);
  }
  return `ralph-${os}-${arch}`;
}

async function binaryVersion(binary: string) {
  if (!existsSync(binary)) return "not installed";
  try {
    const proc = Bun.spawn([binary, "--version"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const [version, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return code === 0 ? version.trim() : "unknown";
  } catch {
    return "unknown";
  }
}

async function upgradeRalph() {
  const binDir = join(ralphHome(), "bin");
  const binary = join(binDir, "ralph");
  const download = join(binDir, "ralph.tmp");
  const url = `https://github.com/${REPO}/releases/latest/download/${platformBinary()}`;
  mkdirSync(binDir, { recursive: true });
  rmSync(download, { force: true });
  const oldVersion = await binaryVersion(binary);
  const code = await Bun.spawn(["curl", "-fsSL", url, "-o", download], {
    stdout: "inherit",
    stderr: "inherit",
  }).exited;
  if (code !== 0) return code;
  try {
    chmodSync(download, 0o755);
    renameSync(download, binary);
    if (process.platform === "darwin") {
      await Bun.spawn(["xattr", "-cr", binary], {
        stdout: "ignore",
        stderr: "ignore",
      }).exited.catch(() => {});
    }
  } catch (e) {
    rmSync(download, { force: true });
    throw e;
  }
  const newVersion = await binaryVersion(binary);
  console.log(`Upgraded ralph from ${oldVersion} to ${newVersion}`);
  return 0;
}

const USAGE = `Usage: ralph <command> [target_dir] [options]

Commands:
  init                  Initialize Ralph files with templates
  upgrade               Upgrade Ralph to the latest release binary
  uninstall             Remove Ralph from RALPH_HOME, default ~/.ralph
  gen <provider> "desc" Generate PRD, TASKS, STATUS from a description
  claude                Run loop with Claude Code
  copilot               Run loop with GitHub Copilot CLI
  codex                 Run loop with Codex
  gemini                Run loop with Gemini CLI
  hermes                Run loop with Hermes Agent
  opencode              Run loop with OpenCode
  pi                    Run loop with Pi

Options:
  --max-loops N         Max consecutive failed retries per task (default: 8)
  --check CMD           Override verification command
  --no-check            Disable runner-managed verification
  --dry-run             Show prompt without invoking
  -i, --interactive     With gen, dynamically ask provider-generated clarifying questions before writing files
  -h, --help            Show this help

Environment:
  RALPH_CHECK_CMD       Override verification command
  RALPH_MAX_LOOPS       Override max consecutive failed retries per task
  RALPH_MODEL           Provider-specific model string
`;

function parseArgs() {
  let command: string | undefined;
  let target = process.cwd();
  let maxLoops = parseInt(process.env.RALPH_MAX_LOOPS ?? "8", 10);
  let checkCmd = "";
  let noCheck = false;
  let dryRun = false;

  // detect if invoked as ralph-claude, ralph-codex, etc.
  const invoked = basename(process.argv[1] ?? "");
  const ALIASES: Record<string, string> = {
    "ralph-init": "init",
    "ralph-claude": "claude",
    "ralph-codex": "codex",
    "ralph-copilot": "copilot",
    "ralph-gemini": "gemini",
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
      case "--no-check":
        noCheck = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "-v":
      case "--version":
        console.log(VERSION);
        process.exit(0);
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

  if (checkCmd && noCheck) {
    console.error("--check cannot be used with --no-check");
    process.exit(1);
  }

  return { command, target, maxLoops, checkCmd, noCheck, dryRun };
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
  const { command, target, maxLoops, checkCmd, noCheck, dryRun } = parseArgs();

  if (!command || command === "help") {
    console.log(USAGE);
    process.exit(command ? 0 : 1);
  }

  if (command === "init") {
    const ralphDir = join(target, ".ralph");
    const reinit = existsSync(ralphDir);
    rmSync(ralphDir, { recursive: true, force: true });
    ensureTemplates(target);
    console.log(
      `${reinit ? "Reinitialized" : "Initialized"} Ralph files in ${target}`
    );
    process.exit(0);
  }

  if (command === "upgrade") {
    try {
      process.exit(await upgradeRalph());
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    }
  }

  if (command === "uninstall") {
    try {
      const home = safeRalphHomeForDeletion();
      rmSync(home, { recursive: true, force: true });
      console.log(`Uninstalled Ralph from ${home}`);
      process.exit(0);
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    }
  }

  if (command === "gen") {
    // ralph gen <provider> "description" [target] [--interactive]
    const args = process.argv.slice(3);
    const positionals: string[] = [];
    let interactive = false;
    for (const arg of args) {
      if (arg === "--interactive" || arg === "-i") {
        interactive = true;
      } else if (arg.startsWith("-") && positionals.length !== 1) {
        console.error(`Unknown gen option: ${arg}`);
        process.exit(1);
      } else {
        positionals.push(arg);
      }
    }

    if (positionals.length < 2) {
      console.error('Usage: ralph gen <provider> "description" [target_dir]');
      process.exit(1);
    }
    if (positionals.length > 3) {
      console.error(`Unexpected extra argument: ${positionals[3]}`);
      process.exit(1);
    }
    const genProvider = positionals[0] as Provider;
    if (!GENERATION_PROVIDERS.includes(genProvider)) {
      console.error(`Unknown provider: ${genProvider}`);
      process.exit(1);
    }
    const description = positionals[1];
    const genTarget = positionals[2] ? resolve(positionals[2]) : process.cwd();
    try {
      await generate(genProvider, genTarget, description, process.env.RALPH_MODEL, interactive);
    } catch (e) {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    }
    process.exit(0);
  }

  if (!LOOP_PROVIDERS.includes(command as Provider)) {
    console.error(`Unknown command: ${command}`);
    console.log(USAGE);
    process.exit(1);
  }

  const provider = command as Provider;
  const check = noCheck ? "" : checkCmd || autoDetectCheck(target);
  const code = await mainLoop(provider, target, maxLoops, check, dryRun, noCheck);
  process.exit(code);
}

main();
