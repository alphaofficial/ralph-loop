import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { makePrompt, runCheck, allTasksComplete, autoCommit, SKIP } from "../src/loop";

const TMP = join(import.meta.dir, ".tmp-loop");

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, ".ralph"), { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("makePrompt", () => {
  test("writes prompt file", () => {
    const file = join(TMP, ".ralph", "prompt-claude.txt");
    makePrompt("claude", TMP, "npm test", 1, file);
    expect(existsSync(file)).toBe(true);
  });

  test("includes iteration number", () => {
    const file = join(TMP, ".ralph", "prompt-claude.txt");
    makePrompt("claude", TMP, "npm test", 3, file);
    const content = readFileSync(file, "utf-8");
    expect(content).toContain("Iteration number: 3");
  });

  test("includes check command", () => {
    const file = join(TMP, ".ralph", "prompt-claude.txt");
    makePrompt("claude", TMP, "cargo test", 1, file);
    const content = readFileSync(file, "utf-8");
    expect(content).toContain("Verification command after your run: cargo test");
  });

  test("includes commit message length guidance from recent commits", () => {
    Bun.spawnSync(["git", "init"], { cwd: TMP, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "config", "user.name", "Ralph Test"], { cwd: TMP });
    Bun.spawnSync(["git", "config", "user.email", "ralph@example.test"], { cwd: TMP });
    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "Short fix"], {
      cwd: TMP,
      stdout: "pipe",
      stderr: "pipe",
    });
    Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "Clarify generated prompts"], {
      cwd: TMP,
      stdout: "pipe",
      stderr: "pipe",
    });

    const file = join(TMP, ".ralph", "prompt-claude.txt");
    makePrompt("claude", TMP, "bun test", 1, file);
    const content = readFileSync(file, "utf-8");

    expect(content).toContain("Recent commit subject lengths:");
    expect(content).toContain("median 17 chars");
    expect(content).toContain("longest 25 chars");
    expect(content).toContain("Do not exceed 25 chars unless the recent history clearly supports it.");
  });

  test("caps commit message length guidance at 40 chars", () => {
    Bun.spawnSync(["git", "init"], { cwd: TMP, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "config", "user.name", "Ralph Test"], { cwd: TMP });
    Bun.spawnSync(["git", "config", "user.email", "ralph@example.test"], { cwd: TMP });
    Bun.spawnSync([
      "git",
      "commit",
      "--allow-empty",
      "-m",
      "This commit subject is intentionally much longer than the conventional limit",
    ], {
      cwd: TMP,
      stdout: "pipe",
      stderr: "pipe",
    });

    const file = join(TMP, ".ralph", "prompt-claude.txt");
    makePrompt("claude", TMP, "bun test", 1, file);
    const content = readFileSync(file, "utf-8");

    expect(content).toContain("longest 76 chars");
    expect(content).toContain("Do not exceed 40 chars unless the recent history clearly supports it.");
  });

  test("shows none auto-detected when no check cmd", () => {
    const file = join(TMP, ".ralph", "prompt-claude.txt");
    makePrompt("claude", TMP, "", 1, file);
    const content = readFileSync(file, "utf-8");
    expect(content).toContain("<none auto-detected>");
  });

  test("includes pick ONE task instruction", () => {
    const file = join(TMP, ".ralph", "prompt-claude.txt");
    makePrompt("claude", TMP, "", 1, file);
    const content = readFileSync(file, "utf-8");
    expect(content).toContain("exactly ONE unchecked task from TASKS.md");
  });

  test("writes file with 0o600 permissions", () => {
    const file = join(TMP, ".ralph", "prompt-claude.txt");
    makePrompt("claude", TMP, "", 1, file);
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("runCheck", () => {
  test("returns 0 for passing command", async () => {
    const outFile = join(TMP, ".ralph", "check-output.txt");
    const code = await runCheck(TMP, "echo hello", outFile);
    expect(code).toBe(0);
    expect(readFileSync(outFile, "utf-8")).toContain("hello");
  });

  test("returns non-zero for failing command", async () => {
    const outFile = join(TMP, ".ralph", "check-output.txt");
    const code = await runCheck(TMP, "exit 1", outFile);
    expect(code).toBe(1);
  });

  test("returns SKIP for empty check command", async () => {
    const outFile = join(TMP, ".ralph", "check-output.txt");
    const code = await runCheck(TMP, "", outFile);
    expect(code).toBe(SKIP);
    expect(readFileSync(outFile, "utf-8")).toContain("No verification command detected");
  });

  test("returns 2 when command exits with 2 (not SKIP)", async () => {
    const outFile = join(TMP, ".ralph", "check-output.txt");
    const code = await runCheck(TMP, "exit 2", outFile);
    expect(code).toBe(2);
    expect(code).not.toBe(SKIP);
  });

  test("captures stderr", async () => {
    const outFile = join(TMP, ".ralph", "check-output.txt");
    await runCheck(TMP, "echo error >&2", outFile);
    expect(readFileSync(outFile, "utf-8")).toContain("error");
  });

  test("writes output with 0o600 permissions", async () => {
    const outFile = join(TMP, ".ralph", "check-output.txt");
    await runCheck(TMP, "echo test", outFile);
    const mode = statSync(outFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("autoCommit", () => {
  test("logs git commit failures with stderr", async () => {
    Bun.spawnSync(["git", "init"], { cwd: TMP, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "config", "user.name", "Ralph Test"], { cwd: TMP });
    Bun.spawnSync(["git", "config", "user.email", "ralph@example.test"], { cwd: TMP });

    writeFileSync(join(TMP, "changed.txt"), "tracked change\n");
    writeFileSync(join(TMP, ".ralph", "commit-msg.txt"), "Commit hook failure test\n");

    const hook = join(TMP, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho nope from hook >&2\nexit 1\n");
    chmodSync(hook, 0o700);

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg?: unknown) => {
      errors.push(String(msg));
    };
    try {
      await autoCommit(TMP, 1);
    } finally {
      console.error = originalError;
    }

    expect(errors.join("\n")).toContain("git commit failed");
    expect(errors.join("\n")).toContain("nope from hook");
  });
});

describe("allTasksComplete", () => {
  test("returns true when all tasks checked", () => {
    writeFileSync(
      join(TMP, "TASKS.md"),
      "- [x] task one\n- [x] task two\n- [x] task three\n"
    );
    expect(allTasksComplete(TMP)).toBe(true);
  });

  test("returns false when some tasks unchecked", () => {
    writeFileSync(
      join(TMP, "TASKS.md"),
      "- [x] task one\n- [ ] task two\n- [x] task three\n"
    );
    expect(allTasksComplete(TMP)).toBe(false);
  });

  test("returns false when all tasks unchecked", () => {
    writeFileSync(
      join(TMP, "TASKS.md"),
      "- [ ] task one\n- [ ] task two\n"
    );
    expect(allTasksComplete(TMP)).toBe(false);
  });

  test("returns true when no tasks exist", () => {
    writeFileSync(join(TMP, "TASKS.md"), "# Tasks\n\nNo tasks yet.\n");
    expect(allTasksComplete(TMP)).toBe(true);
  });

  test("returns true when file is empty", () => {
    writeFileSync(join(TMP, "TASKS.md"), "");
    expect(allTasksComplete(TMP)).toBe(true);
  });

  test("returns true when file does not exist", () => {
    expect(allTasksComplete(TMP)).toBe(true);
  });

  test("ignores non-task lines", () => {
    writeFileSync(
      join(TMP, "TASKS.md"),
      "# Tasks\n\nSome description.\n\n- [x] the only task\n"
    );
    expect(allTasksComplete(TMP)).toBe(true);
  });
});
