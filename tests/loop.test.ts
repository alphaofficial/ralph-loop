import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { makePrompt, runCheck, allTasksComplete } from "../src/loop";

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
    expect(content).toContain("Pick ONE unchecked task from TASKS.md");
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

  test("returns 2 for empty check command", async () => {
    const outFile = join(TMP, ".ralph", "check-output.txt");
    const code = await runCheck(TMP, "", outFile);
    expect(code).toBe(2);
    expect(readFileSync(outFile, "utf-8")).toContain("No verification command detected");
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
