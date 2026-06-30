import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { gitStatusEntries, handleStaticGuardFailure, makePrompt, updateTaskAfterVerification } from "./loop";
import { makeAutoReviewFeedbackPrompt } from "./prompts";
import { getTask } from "./task-state";

describe("makePrompt", () => {
  test("embeds the Ralph-selected current task and tells the provider not to choose tasks or edit TASKS.md", () => {
    const target = mkdtempSync(join(tmpdir(), "ralph-loop-test-"));
    try {
      const tasks = `- [x] Completed task.
  - Files: src/done.ts M
  - Expectation: Already done.
  - Test Cases: done test.

- [ ] Pass the Ralph-selected current task to provider prompts.
  - Files: src/loop.ts M, src/loop.test.ts C
  - Expectation: makePrompt receives the selected current task, embeds it in the prompt, and no longer tells providers to choose tasks or edit TASKS.md.
  - Test Cases: makePrompt embeds the Ralph-selected current task and tells the provider not to choose tasks or edit TASKS.md.
`;

      writeFileSync(join(target, "PRD.md"), "# PRD\n");
      writeFileSync(join(target, "TASKS.md"), tasks);
      writeFileSync(join(target, "STATUS.md"), "# Status\n");

      const currentTask = getTask(tasks);
      if (!currentTask) throw new Error("Expected current task");

      const prompt = makePrompt(target, "bun test", 2, currentTask);

      expect(prompt).toContain("<CURRENT_TASK>");
      expect(prompt).toContain("Description: Pass the Ralph-selected current task to provider prompts.");
      expect(prompt).toContain("- src/loop.ts M");
      expect(prompt).toContain("- src/loop.test.ts C");
      expect(prompt).toContain(
        "Expectation: makePrompt receives the selected current task, embeds it in the prompt, and no longer tells providers to choose tasks or edit TASKS.md."
      );
      expect(prompt).toContain(
        "- makePrompt embeds the Ralph-selected current task and tells the provider not to choose tasks or edit TASKS.md."
      );
      expect(prompt).toContain("Ralph has already selected the current task. Do not choose a task from TASKS.md.");
      expect(prompt).toContain("Do not edit TASKS.md. The Ralph runner owns checking and unchecking the selected task.");
      expect(prompt).toContain("<!-- RALPH_STATIC_GUARD:START -->");
      expect(prompt).toContain("If it reports \"Static guard: FAIL\", resolve those failures as part of the selected task.");
      expect(prompt).not.toContain("<TASKS>");
      expect(prompt).not.toContain("Completed task.");
      expect(prompt).not.toContain("Pick the FIRST unchecked task");
      expect(prompt).not.toContain("Check off that one task");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("makeAutoReviewFeedbackPrompt", () => {
  test("embeds full PRD and selected task without full TASKS.md or STATUS.md", () => {
    const target = mkdtempSync(join(tmpdir(), "ralph-loop-test-"));
    try {
      const tasks = `- [x] Completed task.
  - Files: src/done.ts M
  - Expectation: Already done.
  - Test Cases: done test.

- [ ] Review the selected task only.
  - Files: src/loop.ts M
  - Expectation: Review prompt uses the selected task and commit diff.
  - Test Cases: Review prompt excludes full TASKS.md and STATUS.md.
`;

      writeFileSync(join(target, "PRD.md"), "# PRD\n\n## QA requirement validation\n- Full PRD context.\n");
      writeFileSync(join(target, "TASKS.md"), tasks);
      writeFileSync(join(target, "STATUS.md"), "# Status\nStatus-only context.\n");

      const currentTask = getTask(tasks);
      if (!currentTask) throw new Error("Expected current task");

      const prompt = makeAutoReviewFeedbackPrompt(target, 3, currentTask, {
        touchedFiles: ["src/loop.ts"],
        diff: "diff --git a/src/loop.ts b/src/loop.ts",
      });

      expect(prompt).toContain("# PRD");
      expect(prompt).toContain("Full PRD context.");
      expect(prompt).toContain("Description: Review the selected task only.");
      expect(prompt).toContain("Scope is limited to the selected current task Files list and the PRD below.");
      expect(prompt).toContain("Touched files outside the selected current task Files list are scope violations.");
      expect(prompt).toContain("Every requested change must target a file listed in the selected current task Files list.");
      expect(prompt).toContain("diff --git a/src/loop.ts b/src/loop.ts");
      expect(prompt).not.toContain("<TASKS>");
      expect(prompt).not.toContain("Completed task.");
      expect(prompt).not.toContain("<STATUS>");
      expect(prompt).not.toContain("Status-only context.");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("gitStatusEntries", () => {
  test("reports nested untracked files instead of collapsed directories", () => {
    const target = mkdtempSync(join(tmpdir(), "ralph-loop-test-"));
    try {
      const init = Bun.spawnSync(["git", "init"], { cwd: target, stdout: "ignore", stderr: "ignore" });
      if (init.exitCode !== 0) throw new Error("git init failed");

      mkdirSync(join(target, "src", "extractions"), { recursive: true });
      writeFileSync(join(target, "src", "extractions", "types.ts"), "export type Extraction = {};\n");

      const entries = gitStatusEntries(target, true);
      expect(entries).toContainEqual({
        path: "src/extractions/types.ts",
        index: "?",
        worktree: "?",
      });
      expect(entries.map((entry) => entry.path)).not.toContain("src/extractions/");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe("runner-owned task state", () => {
  test("static guard failure rollback unchecks the selected current task and writes guard failure notes to STATUS.md", () => {
    const target = mkdtempSync(join(tmpdir(), "ralph-loop-test-"));
    try {
      const tasksBefore = `- [ ] Wire runner-owned task checking, unchecking, and retry behavior.
  - Files: src/loop.ts M, src/loop.test.ts M
  - Expectation: The loop uses getTask before provider execution, unchecks the selected task and writes STATUS.md notes on static guard failure, checks it only after successful verification, and leaves it unchecked after failed verification.
  - Test Cases: Static guard failure rollback unchecks the selected current task and writes guard failure notes to STATUS.md.
`;
      const tasksAfterProvider = tasksBefore.replace("- [ ] Wire", "- [x] Wire");

      writeFileSync(join(target, "TASKS.md"), tasksAfterProvider);
      writeFileSync(join(target, "STATUS.md"), "# Status\n");

      const currentTask = getTask(tasksBefore);
      if (!currentTask) throw new Error("Expected current task");

      const summary = handleStaticGuardFailure(
        target,
        currentTask,
        "Static guard: FAIL\n- src/outside.ts changed but is not listed in the selected task Files: line.\n"
      );

      expect(summary).toContain("Static guard: FAIL");
      expect(readFileSync(join(target, "TASKS.md"), "utf-8")).toBe(tasksBefore);
      expect(readFileSync(join(target, "STATUS.md"), "utf-8")).toContain(
        "src/outside.ts changed but is not listed in the selected task Files: line."
      );
      expect(readFileSync(join(target, "STATUS.md"), "utf-8")).toContain("<!-- RALPH_STATIC_GUARD:START -->");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("successful verification checks the selected current task before auto-commit", () => {
    const target = mkdtempSync(join(tmpdir(), "ralph-loop-test-"));
    try {
      const tasks = `- [ ] Wire runner-owned task checking, unchecking, and retry behavior.
  - Files: src/loop.ts M, src/loop.test.ts M
  - Expectation: The loop uses getTask before provider execution, unchecks the selected task and writes STATUS.md notes on static guard failure, checks it only after successful verification, and leaves it unchecked after failed verification.
  - Test Cases: Successful verification checks the selected current task before auto-commit.
`;
      writeFileSync(join(target, "TASKS.md"), tasks);

      const currentTask = getTask(tasks);
      if (!currentTask) throw new Error("Expected current task");

      expect(updateTaskAfterVerification(target, currentTask, 0)).toBe(true);
      expect(readFileSync(join(target, "TASKS.md"), "utf-8")).toBe(
        tasks.replace("- [ ] Wire", "- [x] Wire")
      );
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("failed verification leaves the selected current task unchecked for retry", () => {
    const target = mkdtempSync(join(tmpdir(), "ralph-loop-test-"));
    try {
      const tasks = `- [ ] Wire runner-owned task checking, unchecking, and retry behavior.
  - Files: src/loop.ts M, src/loop.test.ts M
  - Expectation: The loop uses getTask before provider execution, unchecks the selected task and writes STATUS.md notes on static guard failure, checks it only after successful verification, and leaves it unchecked after failed verification.
  - Test Cases: Failed verification leaves the selected current task unchecked for retry.
`;
      writeFileSync(join(target, "TASKS.md"), tasks);

      const currentTask = getTask(tasks);
      if (!currentTask) throw new Error("Expected current task");

      expect(updateTaskAfterVerification(target, currentTask, 1)).toBe(false);
      expect(readFileSync(join(target, "TASKS.md"), "utf-8")).toBe(tasks);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
