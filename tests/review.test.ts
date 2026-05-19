import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const invokeProvider = mock(async () => 0);
const captureProvider = mock(async () => ({ code: 0, stdout: "", stderr: "" }));
let stderrWrite: ReturnType<typeof spyOn>;
let consoleLog: ReturnType<typeof spyOn>;

mock.module("../src/providers", () => ({
  captureProvider,
  invokeProvider,
}));

const { REVIEW_PROMPT, appendReviewFollowups, parseReviewTasks, review, runCapturedReview } = await import("../src/review");

describe("review", () => {
  beforeEach(() => {
    stderrWrite = spyOn(process.stderr, "write").mockImplementation(() => true);
    consoleLog = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    invokeProvider.mockClear();
    captureProvider.mockClear();
    stderrWrite.mockRestore();
    consoleLog.mockRestore();
  });

  test("parses only unchecked tasks inside explicit review markers", () => {
    const tasks = parseReviewTasks(`
- [ ] ignored outside
<RALPH_REVIEW_TASKS>
- [ ] Add focused regression test
- [x] Ignore completed task
  - [ ] Ignore nested task
* [ ] Ignore wrong bullet
- [ ] Add focused regression test
</RALPH_REVIEW_TASKS>
- [ ] ignored outside too
`);

    expect(tasks).toEqual(["Add focused regression test"]);
  });

  test("parses unchecked tasks from all explicit review marker blocks", () => {
    const tasks = parseReviewTasks(`
<RALPH_REVIEW_TASKS>
- [ ] First follow-up
</RALPH_REVIEW_TASKS>
review prose
<RALPH_REVIEW_TASKS>
- [ ] Second follow-up
</RALPH_REVIEW_TASKS>
`);

    expect(tasks).toEqual(["First follow-up", "Second follow-up"]);
  });

  test("appends deduplicated review tasks under review follow-ups", () => {
    const target = mkdtempSync(join(tmpdir(), "ralph-review-"));
    try {
      writeFileSync(join(target, "TASKS.md"), "# Tasks\n\n- [x] Existing complete\n- [ ] Existing follow-up\n");

      const appended = appendReviewFollowups(target, [
        "Existing follow-up",
        "Tighten parser",
        "Tighten parser",
        "Add integration coverage",
      ]);

      expect(appended).toBe(2);
      expect(readFileSync(join(target, "TASKS.md"), "utf-8")).toBe(`# Tasks

- [x] Existing complete
- [ ] Existing follow-up

## Review follow-ups

- [ ] Tighten parser
- [ ] Add integration coverage
`);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("appends to existing review follow-ups section with normalized spacing", () => {
    const target = mkdtempSync(join(tmpdir(), "ralph-review-"));
    try {
      writeFileSync(join(target, "TASKS.md"), "# Tasks\n\n## Review follow-ups\n- [ ] Existing task");

      const appended = appendReviewFollowups(target, ["New task"]);

      expect(appended).toBe(1);
      expect(readFileSync(join(target, "TASKS.md"), "utf-8")).toBe(`# Tasks

## Review follow-ups

- [ ] Existing task
- [ ] New task
`);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("captured review saves raw output and appends parsed follow-up tasks", async () => {
    const target = mkdtempSync(join(tmpdir(), "ralph-review-"));
    try {
      mkdirSync(join(target, ".ralph"), { recursive: true });
      writeFileSync(join(target, "PRD.md"), "# PRD");
      writeFileSync(join(target, "TASKS.md"), "- [x] Initial task\n");
      writeFileSync(join(target, "STATUS.md"), "Green");
      captureProvider.mockResolvedValueOnce({
        code: 0,
        stdout: "Notes\n<RALPH_REVIEW_TASKS>\n- [ ] Add audit log\n</RALPH_REVIEW_TASKS>\n",
        stderr: "warning\n",
      });

      const code = await runCapturedReview("gemini", target, "gemini-2.5-pro");

      expect(code).toBe(0);
      expect(captureProvider).toHaveBeenCalledTimes(1);
      expect(captureProvider.mock.calls[0]?.[3]).toBe("gemini-2.5-pro");
      expect(captureProvider.mock.calls[0]?.[2]).toContain("<RALPH_REVIEW_TASKS>");
      expect(captureProvider.mock.calls[0]?.[2]).toContain("Only include unchecked top-level markdown task bullets");
      expect(readFileSync(join(target, ".ralph", "review-output.md"), "utf-8")).toBe(
        "Notes\n<RALPH_REVIEW_TASKS>\n- [ ] Add audit log\n</RALPH_REVIEW_TASKS>\n\nwarning\n"
      );
      expect(readFileSync(join(target, "TASKS.md"), "utf-8")).toContain("## Review follow-ups\n\n- [ ] Add audit log");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
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

  test("review prompt asks for plan alignment, realistic severity, and readiness", () => {
    expect(REVIEW_PROMPT).toContain("Check the implementation against the PRD, TASKS, and STATUS context.");
    expect(REVIEW_PROMPT).toContain("Call out deviations from the plan");
    expect(REVIEW_PROMPT).toContain("Categorize findings by actual severity");
    expect(REVIEW_PROMPT).toContain("Include a short strengths section before issues.");
    expect(REVIEW_PROMPT).toContain("Use concrete file references when possible.");
    expect(REVIEW_PROMPT).toContain("End with a clear readiness assessment.");
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
      writeFileSync(join(target, "tracked.txt"), "baseline\n");
      runGit(target, "add", "tracked.txt");
      runGit(target, "commit", "-m", "baseline");
      writeFileSync(join(target, "tracked.txt"), "after\n");
      writeFileSync(join(target, "new-file.txt"), "untracked\n");

      await review("gemini", target);

      const prompt = invokeProvider.mock.calls[0]?.[2] as string;
      expect(prompt).toContain(REVIEW_PROMPT);
      expect(prompt).toContain("## Git Range to Review");
      expect(prompt).toContain("**Base:**");
      expect(prompt).toContain("**Head:**");
      expect(prompt).toContain("git diff --stat");
      expect(prompt).toContain("git diff ");
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
      expect(prompt).not.toContain("## Git Range to Review");
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
