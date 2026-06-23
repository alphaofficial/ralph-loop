import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { makePrompt } from "./loop";
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
      expect(prompt).not.toContain("Pick the FIRST unchecked task");
      expect(prompt).not.toContain("Check off that one task");
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
