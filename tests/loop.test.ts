import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { makePrompt, runCheck } from "../src/loop";

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

  test("includes required instructions", () => {
    const file = join(TMP, ".ralph", "prompt-claude.txt");
    makePrompt("claude", TMP, "", 1, file);
    const content = readFileSync(file, "utf-8");
    expect(content).toContain("Read these files first:");
    expect(content).toContain("PRD.md");
    expect(content).toContain("TASKS.md");
    expect(content).toContain("STATUS.md");
    expect(content).toContain("Do one focused iteration only");
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
