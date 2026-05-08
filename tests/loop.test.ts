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
  beforeEach(() => {
    writeFileSync(join(TMP, "PRD.md"), "# PRD\nBuild the thing.\n");
    writeFileSync(join(TMP, "TASKS.md"), "- [ ] first task\n");
    writeFileSync(join(TMP, "STATUS.md"), "Ready.\n");
  });

  test("returns prompt content", () => {
    const content = makePrompt(TMP, "npm test", 1);
    expect(content).toContain("You are running one iteration of a Ralph loop");
  });

  test("includes iteration number", () => {
    const content = makePrompt(TMP, "npm test", 3);
    expect(content).toContain("Iteration number: 3");
  });

  test("includes check command", () => {
    const content = makePrompt(TMP, "cargo test", 1);
    expect(content).toContain("Verification command after your run: cargo test");
  });

  test("includes fixed commit message guidance", () => {
    const content = makePrompt(TMP, "bun test", 1);

    expect(content).toContain(
      "Ensure you follow the project's existing commit message style. Use git log to see project commit messsage format and follow it strictly."
    );
    expect(content).toContain(
      "IMPORTANT: ensure the generated commit message is concise, specific and no more than 48 charaters."
    );
  });

  test("shows none auto-detected when no check cmd", () => {
    const content = makePrompt(TMP, "", 1);
    expect(content).toContain("<none auto-detected>");
  });

  test("includes pick ONE task instruction", () => {
    const content = makePrompt(TMP, "", 1);
    expect(content).toContain("exactly ONE unchecked task from TASKS.md");
  });

  test("requires all tests to pass before completing task", () => {
    const content = makePrompt(TMP, "npm test", 1);
    expect(content).toContain("Do not mark the task complete while any tests are failing.");
    expect(content).toContain(
      "All tests must pass first, even if the failures look unrelated or pre-existing."
    );
  });

  test("inlines project planning files", () => {
    const content = makePrompt(TMP, "", 1);

    expect(content).toContain("<PRD>\n# PRD\nBuild the thing.\n</PRD>");
    expect(content).toContain("<TASKS>\n- [ ] first task\n</TASKS>");
    expect(content).toContain("<STATUS>\nReady.\n</STATUS>");
    expect(content).toContain(
      "Use these embedded copies instead of reading PRD.md, TASKS.md, or STATUS.md via tool calls."
    );
  });

  test("includes last failed check output when provided", () => {
    const content = makePrompt(TMP, "bun test", 2, "expected 1, received 2\n");

    expect(content).toContain("Your previous attempt FAILED verification");
    expect(content).toContain("expected 1, received 2");
    expect(content).toContain("Fix the issue before proceeding.");
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
