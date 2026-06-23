import { describe, expect, test } from "bun:test";
import { parseGitDiffFiles, staticGuard } from "./spec-guard";
import type { CurrentTask } from "./task-state";

const prd = `# PRD

## Files to touch
- src/
  - spec-guard.ts M
  - spec-guard.test.ts C
  - task-state.ts C
  - loop.test.ts C
- README.md M

## Test cases
- staticGuard passes when changed implementation files are within the selected current task and match PRD file operations.
- staticGuard fails when a changed implementation file is outside the selected current task.
- staticGuard fails when a current task file is missing from PRD.md Files to touch or has a different operation marker.
- staticGuard fails when a current task test case is not listed in PRD.md Test cases.
- staticGuard fails when PRD.md or TASKS.md changes during provider execution.
`;

const currentTask: CurrentTask = {
  index: 2,
  lineIndex: 12,
  description: "Replace first-unchecked static guard logic with currentTask-aware staticGuard.",
  files: [
    { path: "src/spec-guard.ts", op: "M" },
    { path: "src/spec-guard.test.ts", op: "C" },
  ],
  expectation: "staticGuard validates provider changes against the explicit currentTask and the PRD file/test-case contract.",
  testCases: [
    "staticGuard passes when changed implementation files are within the selected current task and match PRD file operations.",
    "staticGuard fails when a changed implementation file is outside the selected current task.",
  ],
};

describe("staticGuard", () => {
  test("passes when changed implementation files are within the selected current task and match PRD file operations", () => {
    const result = staticGuard({
      prd,
      currentTask,
      changedFiles: ["src/spec-guard.ts", "src/spec-guard.test.ts", "STATUS.md", ".ralph/static-guard-summary.txt"],
      beforeExists: new Map([
        ["src/spec-guard.ts", true],
        ["src/spec-guard.test.ts", false],
      ]),
      afterExists: new Map([
        ["src/spec-guard.ts", true],
        ["src/spec-guard.test.ts", true],
      ]),
    });

    expect(result).toEqual({ passed: true, failures: [] });
  });

  test("fails when a changed implementation file is outside the selected current task", () => {
    const result = staticGuard({
      prd,
      currentTask,
      changedFiles: ["src/spec-guard.ts", "src/loop.ts"],
      beforeExists: new Map([["src/spec-guard.ts", true]]),
      afterExists: new Map([["src/spec-guard.ts", true]]),
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("src/loop.ts changed but is not listed in the selected task Files: line.");
  });

  test("does not compare current task operation markers against PRD.md operation markers", () => {
    const result = staticGuard({
      prd,
      currentTask: {
        ...currentTask,
        files: [{ path: "src/loop.test.ts", op: "M" }],
      },
      changedFiles: ["src/loop.test.ts"],
      beforeExists: new Map([["src/loop.test.ts", true]]),
      afterExists: new Map([["src/loop.test.ts", true]]),
    });

    expect(result).toEqual({ passed: true, failures: [] });
  });

  test("fails when a current task file is missing from PRD.md Files to touch", () => {
    const taskWithInvalidFiles: CurrentTask = {
      ...currentTask,
      files: [{ path: "src/not-listed.ts", op: "M" }],
    };

    const result = staticGuard({
      prd,
      currentTask: taskWithInvalidFiles,
      changedFiles: ["src/not-listed.ts"],
      beforeExists: new Map([["src/not-listed.ts", true]]),
      afterExists: new Map([["src/not-listed.ts", true]]),
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("src/not-listed.ts is listed in the task but not in PRD.md ## Files to touch.");
  });

  test("does not require current task test cases to exactly match PRD.md test cases", () => {
    const result = staticGuard({
      prd,
      currentTask: {
        ...currentTask,
        testCases: ["Type check verifies all route-path code compiles using `req.ctx` and no longer relies on deleted request typings."],
      },
      changedFiles: ["src/spec-guard.ts"],
      beforeExists: new Map([
        ["src/spec-guard.ts", true],
        ["src/spec-guard.test.ts", false],
      ]),
      afterExists: new Map([
        ["src/spec-guard.ts", true],
        ["src/spec-guard.test.ts", true],
      ]),
    });

    expect(result).toEqual({ passed: true, failures: [] });
  });

  test("passes for Files N/A tasks when no implementation files changed", () => {
    const result = staticGuard({
      prd,
      currentTask: {
        ...currentTask,
        files: [],
        expectation: "The configured verification command passes without code changes.",
        testCases: ["Run the configured verification command."],
      },
      changedFiles: ["STATUS.md", ".ralph/check-output.txt"],
      beforeExists: new Map(),
      afterExists: new Map(),
    });

    expect(result).toEqual({ passed: true, failures: [] });
  });

  test("fails for Files N/A tasks when implementation files changed", () => {
    const result = staticGuard({
      prd,
      currentTask: {
        ...currentTask,
        files: [],
        expectation: "The configured verification command passes without code changes.",
        testCases: ["Run the configured verification command."],
      },
      changedFiles: ["src/spec-guard.ts"],
      beforeExists: new Map(),
      afterExists: new Map(),
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("src/spec-guard.ts changed but is not listed in the selected task Files: line.");
  });

  test("fails when PRD.md or TASKS.md appears in the git diff", () => {
    const result = staticGuard({
      prd,
      currentTask,
      changedFiles: ["PRD.md", "TASKS.md"],
      beforeExists: new Map([
        ["src/spec-guard.ts", true],
        ["src/spec-guard.test.ts", false],
      ]),
      afterExists: new Map([
        ["src/spec-guard.ts", true],
        ["src/spec-guard.test.ts", true],
      ]),
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("PRD.md was modified during an implementation iteration.");
    expect(result.failures).toContain("TASKS.md was modified during provider execution; the Ralph runner owns task state.");
  });

  test("does not compare ignored TASKS.md snapshots outside the git diff", () => {
    const result = staticGuard({
      prd,
      currentTask: {
        ...currentTask,
        files: [{ path: "src/spec-guard.ts", op: "M" }],
      },
      changedFiles: ["src/spec-guard.ts"],
      tasksBefore: "- [ ] Selected task.\n",
      tasksAfter: "- [x] Selected task.\n",
      beforeExists: new Map([["src/spec-guard.ts", true]]),
      afterExists: new Map([["src/spec-guard.ts", true]]),
    });

    expect(result).toEqual({ passed: true, failures: [] });
  });
});

describe("parseGitDiffFiles", () => {
  test("parses null-separated git diff name output", () => {
    expect(parseGitDiffFiles("src/loop.ts\0./src/spec-guard.ts\0src/loop.ts\0")).toEqual([
      "src/loop.ts",
      "src/spec-guard.ts",
    ]);
  });
});
