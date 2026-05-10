import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, writeFileSync, chmodSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let TMP = "";
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
let BIN = "";

async function runWithInput(args: string[], input = ""): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: input ? "pipe" : undefined,
    env: { ...process.env, RALPH_CHECK_CMD: undefined, RALPH_MAX_LOOPS: undefined, PATH: `${BIN}:${process.env.PATH}` },
  });
  if (input && proc.stdin) {
    proc.stdin.write(input);
    proc.stdin.end();
  }
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function run(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runWithInput(args);
}

async function runWithOpenInput(args: string[], input: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env: { ...process.env, RALPH_CHECK_CMD: undefined, RALPH_MAX_LOOPS: undefined, PATH: `${BIN}:${process.env.PATH}` },
  });
  proc.stdin.write(input);

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("process did not exit after required answers")), 1000);
  });

  try {
    const [stdout, stderr, exitCode] = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]),
      timeout,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    proc.kill();
  }
}

function installFakeGemini() {
  mkdirSync(BIN, { recursive: true });
  writeFileSync(
    join(BIN, "gemini"),
    String.raw`#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const prompt = process.argv.includes("-p")
  ? process.argv[process.argv.indexOf("-p") + 1] ?? ""
  : readFileSync(join(process.cwd(), ".ralph", "prompt-gen.txt"), "utf-8");
if (prompt.includes("Generate clarifying questions")) {
  writeFileSync(join(process.cwd(), "question-prompt-seen.txt"), prompt);
  writeFileSync(join(process.cwd(), "question-args-seen.txt"), JSON.stringify(process.argv.slice(2)));
  const questions = prompt.includes("billing")
    ? ["Which payment processor should billing use?", "Which customer regions need tax handling?", "Should billing support subscriptions?"]
    : ["Which chat channels should support agents use?", "What escalation SLA should support follow?", "Which customer data should agents see?"];
  console.log(JSON.stringify(questions));
  process.exit(0);
}
writeFileSync(join(process.cwd(), "prompt-seen.txt"), prompt);
writeFileSync(join(process.cwd(), "args-seen.txt"), JSON.stringify(process.argv.slice(2)));
writeFileSync(join(process.cwd(), "PRD.md"), "# Goal\nGenerated\n");
writeFileSync(join(process.cwd(), "TASKS.md"), "- [ ] Generated task\n");
writeFileSync(join(process.cwd(), "STATUS.md"), "# Current status\nNot started.\n");
`,
    { mode: 0o755 }
  );
  chmodSync(join(BIN, "gemini"), 0o755);
}

function installFakeClaudeCompletesTask() {
  mkdirSync(BIN, { recursive: true });
  writeFileSync(
    join(BIN, "claude"),
    String.raw`#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { join } from "node:path";

writeFileSync(join(process.cwd(), "TASKS.md"), "- [x] first task\n");
writeFileSync(join(process.cwd(), "STATUS.md"), "# Current status\nTask done.\n");
writeFileSync(join(process.cwd(), ".ralph", "commit-msg.txt"), "Complete first task\n");
`,
    { mode: 0o755 }
  );
  chmodSync(join(BIN, "claude"), 0o755);
}

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "ralph-cli-"));
  BIN = join(TMP, "bin");
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("cli", () => {
  test("--help exits 0 with usage", async () => {
    const { stdout, exitCode } = await run("--help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage: ralph");
  });

  test("no args exits 1 with usage", async () => {
    const { stdout, exitCode } = await run();
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Usage: ralph");
  });

  test("unknown command exits 1", async () => {
    const { stderr, exitCode } = await run("foobar");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command: foobar");
  });

  test("init creates files", async () => {
    const { stdout, exitCode } = await run("init", TMP);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^Initialized Ralph files in/);
    expect(existsSync(join(TMP, "PRD.md"))).toBe(true);
    expect(existsSync(join(TMP, "TASKS.md"))).toBe(true);
    expect(existsSync(join(TMP, "STATUS.md"))).toBe(true);
  });

  test("re-running init wipes .ralph scratch dir, preserves edited PRD/TASKS/STATUS, and reports 'Reinitialized'", async () => {
    const { writeFileSync, readFileSync } = await import("node:fs");
    mkdirSync(join(TMP, ".ralph"), { recursive: true });
    writeFileSync(join(TMP, ".ralph", "stale.txt"), "old");
    writeFileSync(join(TMP, "PRD.md"), "custom prd");

    const { stdout, exitCode } = await run("init", TMP);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Reinitialized Ralph files in");
    expect(existsSync(join(TMP, ".ralph", "stale.txt"))).toBe(false);
    expect(existsSync(join(TMP, ".ralph"))).toBe(true);
    expect(readFileSync(join(TMP, "PRD.md"), "utf-8")).toBe("custom prd");
  });

  test("--max-loops without value exits 1", async () => {
    const { stderr, exitCode } = await run("claude", "--max-loops");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--max-loops requires a value");
  });

  test("--max-loops 0 exits 1", async () => {
    const { stderr, exitCode } = await run("claude", "--max-loops", "0");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--max-loops must be a positive number");
  });

  test("--max-loops -1 exits 1", async () => {
    const { stderr, exitCode } = await run("claude", "--max-loops", "-1");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--max-loops must be a positive number");
  });

  test("--max-loops abc exits 1", async () => {
    const { stderr, exitCode } = await run("claude", "--max-loops", "abc");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--max-loops must be a positive number");
  });

  test("--check without value exits 1", async () => {
    const { stderr, exitCode } = await run("claude", "--check");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--check requires a value");
  });

  test("--check and --no-check together exits 1", async () => {
    const { stderr, exitCode } = await run("claude", "--check", "bun test", "--no-check");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("--check cannot be used with --no-check");
  });

  test("--help lists no-check flag", async () => {
    const { stdout } = await run("--help");
    expect(stdout).toContain("--no-check");
    expect(stdout).toContain("Disable runner-managed verification");
  });

  test("--dry-run prints prompt without invoking", async () => {
    await run("init", TMP);
    const { stdout, exitCode } = await run("claude", "--dry-run", TMP);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Iteration number: 1");
    expect(stdout).toContain("The project planning files are embedded below.");
    expect(stdout).toContain("<PRD>");
    expect(stdout).toContain("<TASKS>");
    expect(stdout).toContain("<STATUS>");
    expect(existsSync(join(TMP, ".ralph", "prompt-claude.txt"))).toBe(false);
  });

  test("--no-check disables auto-detected verification in dry run", async () => {
    await run("init", TMP);
    writeFileSync(join(TMP, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));

    const { stdout, exitCode } = await run("claude", "--no-check", "--dry-run", TMP);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Verification command after your run: <disabled by --no-check>");
    expect(stdout).not.toContain("Verification command after your run: bun test");
  });

  test("--no-check records disabled verification in status during a run", async () => {
    installFakeClaudeCompletesTask();
    await run("init", TMP);
    writeFileSync(join(TMP, "TASKS.md"), "- [ ] first task\n");
    writeFileSync(join(TMP, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));

    const { stdout, exitCode } = await run("claude", "--no-check", TMP);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("verification disabled by --no-check");
    expect(stdout).not.toContain("no check command");

    const status = readFileSync(join(TMP, "STATUS.md"), "utf-8");
    expect(status).toContain("Verification: SKIPPED");
    expect(status).toContain("Runner-managed verification disabled by --no-check");
    expect(status).not.toContain("No verification command detected");
  });

  test("--help lists copilot as a provider", async () => {
    const { stdout } = await run("--help");
    expect(stdout).toContain("copilot");
  });

  test("--help lists gemini as a provider", async () => {
    const { stdout } = await run("--help");
    expect(stdout).toContain("gemini");
  });

  test("--help lists hermes as a provider", async () => {
    const { stdout } = await run("--help");
    expect(stdout).toContain("hermes");
  });

  test("--help lists pi as a provider", async () => {
    const { stdout } = await run("--help");
    expect(stdout).toContain("pi");
  });

  test("--help lists gen interactive flag", async () => {
    const { stdout } = await run("--help");
    expect(stdout).toContain("-i, --interactive");
  });

  test("copilot --dry-run works", async () => {
    await run("init", TMP);
    const { stdout, exitCode } = await run("copilot", "--dry-run", TMP);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Iteration number: 1");
  });

  test("gemini --dry-run works", async () => {
    await run("init", TMP);
    const { stdout, exitCode } = await run("gemini", "--dry-run", TMP);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Iteration number: 1");
  });

  test("hermes --dry-run works", async () => {
    await run("init", TMP);
    const { stdout, exitCode } = await run("hermes", "--dry-run", TMP);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Iteration number: 1");
  });

  test("pi --dry-run works", async () => {
    await run("init", TMP);
    const { stdout, exitCode } = await run("pi", "--dry-run", TMP);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Iteration number: 1");
  });

  test("gen gemini passes provider validation before requiring description", async () => {
    const { stderr, exitCode } = await run("gen", "gemini");
    expect(exitCode).toBe(1);
    expect(stderr).not.toContain("Unknown provider: gemini");
    expect(stderr).toContain('Usage: ralph gen <provider> "description" [target_dir]');
  });

  test("gen hermes passes provider validation before requiring description", async () => {
    const { stderr, exitCode } = await run("gen", "hermes");
    expect(exitCode).toBe(1);
    expect(stderr).not.toContain("Unknown provider: hermes");
    expect(stderr).toContain('Usage: ralph gen <provider> "description" [target_dir]');
  });

  test("gen pi passes provider validation before requiring description", async () => {
    const { stderr, exitCode } = await run("gen", "pi");
    expect(exitCode).toBe(1);
    expect(stderr).not.toContain("Unknown provider: pi");
    expect(stderr).toContain('Usage: ralph gen <provider> "description" [target_dir]');
  });

  test("gen --interactive dynamically obtains request-specific questions and sends answers to provider one-shot", async () => {
    installFakeGemini();

    const { stdout, exitCode } = await runWithInput(
      ["gen", "gemini", "Add billing for SaaS customers", TMP, "--interactive"],
      "Stripe only\nEU customers\nNo subscriptions\n"
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Which payment processor should billing use?");
    expect(stdout).toContain("Which customer regions need tax handling?");
    expect(stdout).toContain("Should billing support subscriptions?");
    expect(stdout).not.toContain("Who are the users or stakeholders?");
    const prompt = readFileSync(join(TMP, "prompt-seen.txt"), "utf-8");
    expect(prompt).toContain("Interactive clarification answers collected by Ralph CLI:");
    expect(prompt).toContain("Which payment processor should billing use?\nStripe only");
    expect(prompt).toContain("Which customer regions need tax handling?\nEU customers");
    expect(prompt).toContain("Should billing support subscriptions?\nNo subscriptions");
    const questionPrompt = readFileSync(join(TMP, "question-prompt-seen.txt"), "utf-8");
    expect(questionPrompt).toContain("Add billing for SaaS customers");
    expect(readFileSync(join(TMP, "question-args-seen.txt"), "utf-8")).toContain('"-p"');
    expect(readFileSync(join(TMP, "args-seen.txt"), "utf-8")).toContain('"-p"');
    expect(existsSync(join(TMP, "PRD.md"))).toBe(true);
    expect(existsSync(join(TMP, "TASKS.md"))).toBe(true);
    expect(existsSync(join(TMP, "STATUS.md"))).toBe(true);
  });

  test("gen without interactive does not ask clarifying questions", async () => {
    installFakeGemini();

    const { exitCode } = await run("gen", "gemini", "Add billing", TMP);

    expect(exitCode).toBe(0);
    const prompt = readFileSync(join(TMP, "prompt-seen.txt"), "utf-8");
    expect(prompt).not.toContain("Interactive clarification answers collected by Ralph CLI:");
    expect(existsSync(join(TMP, "question-prompt-seen.txt"))).toBe(false);
  });

  test("gen accepts quoted descriptions that begin with a dash", async () => {
    installFakeGemini();

    const { exitCode, stderr } = await run("gen", "gemini", "- Add billing", TMP);

    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("Unknown gen option");
    const prompt = readFileSync(join(TMP, "prompt-seen.txt"), "utf-8");
    expect(prompt).toContain("The user wants to build: - Add billing");
  });

  test("gen accepts quoted descriptions that begin with double dash", async () => {
    installFakeGemini();

    const { exitCode, stderr } = await run("gen", "gemini", "-- migrate auth to OIDC", TMP);

    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("Unknown gen option");
    const prompt = readFileSync(join(TMP, "prompt-seen.txt"), "utf-8");
    expect(prompt).toContain("The user wants to build: -- migrate auth to OIDC");
  });

  test("gen --interactive questions vary with description instead of using a fixed list", async () => {
    installFakeGemini();

    const { stdout, exitCode } = await runWithInput(
      ["gen", "gemini", "Add support agent chat tooling", TMP, "--interactive"],
      "Email and in-app\nFour business hours\nOrder history only\n"
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Which chat channels should support agents use?");
    expect(stdout).toContain("What escalation SLA should support follow?");
    expect(stdout).toContain("Which customer data should agents see?");
    expect(stdout).not.toContain("Which payment processor should billing use?");
    const prompt = readFileSync(join(TMP, "prompt-seen.txt"), "utf-8");
    expect(prompt).toContain("Which chat channels should support agents use?\nEmail and in-app");
    expect(prompt).toContain("What escalation SLA should support follow?\nFour business hours");
    expect(prompt).toContain("Which customer data should agents see?\nOrder history only");
  });

  test("gen -i enables interactive clarification", async () => {
    installFakeGemini();

    const { exitCode } = await runWithInput(
      ["gen", "gemini", "Add billing", TMP, "-i"],
      "Admins\nWeb app\nNo mobile\n"
    );

    expect(exitCode).toBe(0);
    const prompt = readFileSync(join(TMP, "prompt-seen.txt"), "utf-8");
    expect(prompt).toContain("Interactive clarification answers collected by Ralph CLI:");
  });

  test("gen accepts --interactive before target", async () => {
    installFakeGemini();

    const { exitCode } = await runWithInput(
      ["gen", "gemini", "Add billing", "--interactive", TMP],
      "Support agents\nCLI\nNo dashboard\n"
    );

    expect(exitCode).toBe(0);
    const prompt = readFileSync(join(TMP, "prompt-seen.txt"), "utf-8");
    expect(prompt).toContain("Interactive clarification answers collected by Ralph CLI:");
  });

  test("gen --interactive exits after answers without requiring stdin EOF", async () => {
    installFakeGemini();

    const { exitCode } = await runWithOpenInput(
      ["gen", "gemini", "Add billing", TMP, "--interactive"],
      "Customers\nCheckout\nNo trials\n"
    );

    expect(exitCode).toBe(0);
    const prompt = readFileSync(join(TMP, "prompt-seen.txt"), "utf-8");
    expect(prompt).toContain("Customers");
    expect(prompt).toContain("Checkout");
    expect(prompt).toContain("No trials");
  });

  test("gen accepts -i before provider", async () => {
    installFakeGemini();

    const { exitCode } = await runWithInput(
      ["gen", "-i", "gemini", "Add billing", TMP],
      "Admins\nSettings\nNo mobile\n"
    );

    expect(exitCode).toBe(0);
    const prompt = readFileSync(join(TMP, "prompt-seen.txt"), "utf-8");
    expect(prompt).toContain("Interactive clarification answers collected by Ralph CLI:");
  });

  test("gen rejects unknown options after description", async () => {
    const { stderr, exitCode } = await run("gen", "gemini", "Add billing", "--interactiv");

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown gen option: --interactiv");
  });

  test("gen rejects extra positional arguments", async () => {
    const { stderr, exitCode } = await run("gen", "gemini", "Add billing", TMP, "other");

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unexpected extra argument: other");
  });
});
