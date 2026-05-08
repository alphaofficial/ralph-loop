import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const TMP = join(import.meta.dir, ".tmp-cli");
const CLI = join(import.meta.dir, "..", "src", "cli.ts");

async function run(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, RALPH_CHECK_CMD: undefined, RALPH_MAX_LOOPS: undefined },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
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

  test("--help lists copilot as a provider", async () => {
    const { stdout } = await run("--help");
    expect(stdout).toContain("copilot");
  });

  test("--help lists gemini as a provider", async () => {
    const { stdout } = await run("--help");
    expect(stdout).toContain("gemini");
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

  test("gen gemini passes provider validation before requiring description", async () => {
    const { stderr, exitCode } = await run("gen", "gemini");
    expect(exitCode).toBe(1);
    expect(stderr).not.toContain("Unknown provider: gemini");
    expect(stderr).toContain('Usage: ralph gen <provider> "description" [target_dir]');
  });
});
