import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const invokeProvider = mock(async () => 0);
let stderrWrite: ReturnType<typeof spyOn>;
let consoleLog: ReturnType<typeof spyOn>;

mock.module("../src/providers", () => ({
  invokeProvider,
}));

const { REVIEW_PROMPT, review } = await import("../src/review");

describe("review", () => {
  beforeEach(() => {
    stderrWrite = spyOn(process.stderr, "write").mockImplementation(() => true);
    consoleLog = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    invokeProvider.mockClear();
    stderrWrite.mockRestore();
    consoleLog.mockRestore();
  });

  test("logs review progress and completion", async () => {
    invokeProvider.mockImplementationOnce(async () => {
      await Bun.sleep(120);
      return 0;
    });

    const code = await review("gemini", "/tmp/project");

    expect(code).toBe(0);
    expect(invokeProvider).toHaveBeenCalledTimes(1);
    expect(stderrWrite.mock.calls.some((call) => String(call[0]).includes("Reviewing project with gemini"))).toBe(true);
    expect(consoleLog.mock.calls.some((call) => String(call[0]).includes("✅ Review complete"))).toBe(true);
  });

  test("invokes provider with simplification review prompt", async () => {
    const code = await review("gemini", "/tmp/project", "gemini-2.5-pro");

    expect(code).toBe(0);
    expect(invokeProvider).toHaveBeenCalledTimes(1);
    expect(invokeProvider.mock.calls[0]?.[0]).toBe("gemini");
    expect(invokeProvider.mock.calls[0]?.[1]).toBe("/tmp/project");
    expect(invokeProvider.mock.calls[0]?.[2]).toContain(REVIEW_PROMPT);
    expect(invokeProvider.mock.calls[0]?.[3]).toBe("gemini-2.5-pro");
  });

  test("includes only project artifacts in provider prompt", async () => {
    const target = mkdtempSync(join(tmpdir(), "ralph-review-"));
    try {
      writeFileSync(join(target, "PRD.md"), "# PRD\nShip review context");
      writeFileSync(join(target, "TASKS.md"), "- [x] build feature\n- [ ] review feature");
      writeFileSync(join(target, "STATUS.md"), "# Status\nImplementation changed review prompt");
      runGit(target, "init");
      runGit(target, "config", "user.email", "ralph@example.test");
      runGit(target, "config", "user.name", "Ralph Test");
      writeFileSync(join(target, "tracked.txt"), "before\n");
      runGit(target, "add", "tracked.txt");
      runGit(target, "commit", "-m", "initial");
      writeFileSync(join(target, "tracked.txt"), "after\n");
      writeFileSync(join(target, "new-file.txt"), "untracked\n");

      await review("gemini", target);

      const prompt = invokeProvider.mock.calls[0]?.[2] as string;
      expect(prompt).toContain(REVIEW_PROMPT);
      expect(prompt).toContain("The project planning artifacts are embedded below.");
      expect(prompt).toContain("<PRD>\n# PRD\nShip review context\n</PRD>");
      expect(prompt).toContain("<TASKS>\n- [x] build feature\n- [ ] review feature\n</TASKS>");
      expect(prompt).toContain("<STATUS>\n# Status\nImplementation changed review prompt\n</STATUS>");
      expect(prompt).not.toContain("<GIT_STATUS>");
      expect(prompt).not.toContain("<GIT_DIFF_STAT>");
      expect(prompt).not.toContain("<GIT_STAGED_DIFF_STAT>");
      expect(prompt).not.toContain(" M tracked.txt");
      expect(prompt).not.toContain("new-file.txt");
      expect(prompt).not.toContain("1 file changed");
      expect(prompt).not.toContain("@@ -1 +1 @@");
      expect(prompt).not.toContain("-before");
      expect(prompt).not.toContain("+after");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("omits staged changes from provider prompt", async () => {
    const target = mkdtempSync(join(tmpdir(), "ralph-review-"));
    try {
      runGit(target, "init");
      runGit(target, "config", "user.email", "ralph@example.test");
      runGit(target, "config", "user.name", "Ralph Test");
      writeFileSync(join(target, "tracked.txt"), "before\n");
      runGit(target, "add", "tracked.txt");
      runGit(target, "commit", "-m", "initial");
      writeFileSync(join(target, "tracked.txt"), "staged\n");
      runGit(target, "add", "tracked.txt");

      await review("gemini", target);

      const prompt = invokeProvider.mock.calls[0]?.[2] as string;
      expect(prompt).not.toContain("<GIT_STAGED_DIFF_STAT>");
      expect(prompt).not.toContain("tracked.txt");
      expect(prompt).not.toContain("1 file changed");
      expect(prompt).not.toContain("@@ -1 +1 @@");
      expect(prompt).not.toContain("-before");
      expect(prompt).not.toContain("+staged");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("invokes provider with fallback artifact context when artifacts are unavailable", async () => {
    const target = mkdtempSync(join(tmpdir(), "ralph-review-"));
    try {
      await review("gemini", target);

      expect(invokeProvider).toHaveBeenCalledTimes(1);
      const prompt = invokeProvider.mock.calls[0]?.[2] as string;
      expect(prompt).toContain("PRD.md could not be read.");
      expect(prompt).toContain("TASKS.md could not be read.");
      expect(prompt).toContain("STATUS.md could not be read.");
      expect(prompt).not.toContain("Git context could not be read.");
      expect(prompt).not.toContain("<GIT_STATUS>");
      expect(prompt).not.toContain("<GIT_DIFF_STAT>");
      expect(prompt).not.toContain("<GIT_STAGED_DIFF_STAT>");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

function runGit(target: string, ...args: string[]) {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: target,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.exitCode).toBe(0);
}
