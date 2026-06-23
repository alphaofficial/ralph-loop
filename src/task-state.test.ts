import { describe, expect, test } from "bun:test";
import { checkTask, getTask, uncheckTask, type CurrentTask } from "./task-state";

const tasks = `# Tasks

- [x] Done task.
  - Files: ignored.ts M
  - Expectation: Already complete.
  - Test Cases: ignored test.

- [ ] Add task-state parsing and checkbox helpers.
  - Files: ./src//task-state.ts C, src\\task-state.test.ts C
  - Expectation: getTask, checkTask, and uncheckTask implement the PRD-specified current task contract with focused unit coverage.
  - Test Cases: getTask returns the first unchecked task with stable identity, file contracts, expectation, and test cases., checkTask and uncheckTask toggle only the selected task and preserve all other TASKS.md content.
  - Extra: Preserve this line.

  - [ ] Nested checkbox is not a top-level task.

- [ ] Later task.
  - Files: src/later.ts M
  - Expectation: Not selected.
  - Test Cases: later test.
`;

describe("getTask", () => {
  test("returns the first unchecked task with stable identity, file contracts, expectation, and test cases", () => {
    expect(getTask(tasks)).toEqual({
      index: 1,
      lineIndex: 7,
      description: "Add task-state parsing and checkbox helpers.",
      files: [
        { path: "src/task-state.ts", op: "C" },
        { path: "src/task-state.test.ts", op: "C" },
      ],
      expectation:
        "getTask, checkTask, and uncheckTask implement the PRD-specified current task contract with focused unit coverage.",
      testCases: [
        "getTask returns the first unchecked task with stable identity, file contracts, expectation, and test cases.",
        "checkTask and uncheckTask toggle only the selected task and preserve all other TASKS.md content.",
      ],
    });
  });

  test("returns null when no unchecked top-level task exists", () => {
    expect(getTask("- [x] Done.\n  - Files: src/a.ts M\n")).toBeNull();
  });

  test("throws a concise error for invalid Files entries", () => {
    expect(() =>
      getTask(`- [ ] Invalid task.
  - Files: src/task-state.ts X
  - Expectation: Fails.
  - Test Cases: parse failure.
`)
    ).toThrow("Invalid Files entry: src/task-state.ts X");
  });

  test("uses Verification as a backwards-compatible Test Cases alias", () => {
    expect(
      getTask(`- [ ] Legacy task.
  - Files: src/task-state.ts C
  - Expectation: Parse legacy tasks.
  - Verification: legacy case one., legacy case two.
`)?.testCases
    ).toEqual(["legacy case one.", "legacy case two."]);
  });
});

describe("checkTask and uncheckTask", () => {
  test("toggle only the selected task and preserve all other TASKS.md content", () => {
    const currentTask = mustGetTask(tasks);
    const checked = checkTask(tasks, currentTask);

    expect(checked).toBe(tasks.replace("- [ ] Add task-state parsing", "- [x] Add task-state parsing"));
    expect(checkTask(checked, currentTask)).toBe(checked);

    const unchecked = uncheckTask(checked, currentTask);
    expect(unchecked).toBe(tasks);
    expect(uncheckTask(unchecked, currentTask)).toBe(unchecked);
  });

  test("use a unique-description fallback when the original line index shifts", () => {
    const currentTask = mustGetTask(tasks);
    const shifted = `Intro line\n${tasks}`;

    expect(checkTask(shifted, currentTask)).toBe(
      shifted.replace("- [ ] Add task-state parsing", "- [x] Add task-state parsing")
    );
  });

  test("throw when the selected task is missing or ambiguous", () => {
    const currentTask: CurrentTask = {
      ...mustGetTask(tasks),
      lineIndex: 0,
    };

    expect(() => checkTask("- [ ] Different task.\n", currentTask)).toThrow(
      "Selected task not found: Add task-state parsing and checkbox helpers."
    );

    const shiftedTask: CurrentTask = { ...currentTask, lineIndex: 99 };
    expect(() =>
      checkTask(
        `- [ ] Add task-state parsing and checkbox helpers.
- [x] Add task-state parsing and checkbox helpers.
`,
        shiftedTask
      )
    ).toThrow("Selected task is ambiguous: Add task-state parsing and checkbox helpers.");
  });
});

function mustGetTask(markdown: string): CurrentTask {
  const task = getTask(markdown);
  if (!task) throw new Error("Expected task");
  return task;
}
