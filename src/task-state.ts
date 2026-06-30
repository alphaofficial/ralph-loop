export type TaskFileOp = "C" | "M" | "D";

export type TaskFileContract = {
  path: string;
  op: TaskFileOp;
  annotation?: string;
};

export type CurrentTask = {
  index: number;
  lineIndex: number;
  description: string;
  files: TaskFileContract[];
  expectation: string;
  testCases: string[];
};

const TASK_LINE_RE = /^- \[[ x]\] \S/;
const UNCHECKED_TASK_LINE_RE = /^- \[ \] \S/;

export function getTask(tasksMarkdown: string): CurrentTask | null {
  const lines = tasksMarkdown.split("\n");
  let taskIndex = -1;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (!TASK_LINE_RE.test(line)) continue;

    taskIndex += 1;
    if (!UNCHECKED_TASK_LINE_RE.test(line)) continue;

    const block = taskBlock(lines, lineIndex);
    const filesLine = contractLine(block, "Files");
    const expectation = contractLine(block, "Expectation") ?? "";
    const testCasesLine = contractLine(block, "Test Cases") ?? contractLine(block, "Verification") ?? "";

    return {
      index: taskIndex,
      lineIndex,
      description: taskDescription(line),
      files: filesLine ? parseFilesLine(filesLine) : [],
      expectation: expectation.trim(),
      testCases: splitTestCasesLine(testCasesLine),
    };
  }

  return null;
}

export function checkTask(tasksMarkdown: string, currentTask: CurrentTask): string {
  return setTaskChecked(tasksMarkdown, currentTask, true);
}

export function uncheckTask(tasksMarkdown: string, currentTask: CurrentTask): string {
  return setTaskChecked(tasksMarkdown, currentTask, false);
}

function setTaskChecked(tasksMarkdown: string, currentTask: CurrentTask, checked: boolean): string {
  const lines = tasksMarkdown.split("\n");
  const lineIndex = findSelectedTaskLine(lines, currentTask);
  const line = lines[lineIndex];
  const checkedPrefix = "- [x]";
  const uncheckedPrefix = "- [ ]";
  const desiredPrefix = checked ? checkedPrefix : uncheckedPrefix;
  const currentPrefix = checked ? uncheckedPrefix : checkedPrefix;

  if (line.startsWith(desiredPrefix)) return tasksMarkdown;

  lines[lineIndex] = line.replace(currentPrefix, desiredPrefix);
  return lines.join("\n");
}

function findSelectedTaskLine(lines: string[], currentTask: CurrentTask): number {
  const originalLine = lines[currentTask.lineIndex];
  if (originalLine && TASK_LINE_RE.test(originalLine) && taskDescription(originalLine) === currentTask.description) {
    return currentTask.lineIndex;
  }

  const matches: number[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (TASK_LINE_RE.test(line) && taskDescription(line) === currentTask.description) {
      matches.push(lineIndex);
    }
  }

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Selected task is ambiguous: ${currentTask.description}`);
  throw new Error(`Selected task not found: ${currentTask.description}`);
}

function taskBlock(lines: string[], start: number): string[] {
  const block: string[] = [];
  for (let lineIndex = start; lineIndex < lines.length; lineIndex++) {
    if (lineIndex !== start && TASK_LINE_RE.test(lines[lineIndex])) break;
    block.push(lines[lineIndex]);
  }
  return block;
}

function taskDescription(line: string): string {
  return line.replace(/^- \[[ x]\]\s*/, "").trim();
}

function contractLine(block: string[], label: string): string | null {
  const prefix = `${label}:`;
  for (const entry of block) {
    const line = entry.trimStart().replace(/^- /, "");
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return null;
}

function parseFilesLine(line: string): TaskFileContract[] {
  if (line.trim().toUpperCase() === "N/A") return [];

  return splitCommaList(line).map((entry) => {
    const match = entry.match(/^(.+?)\s+([CMD])\s*(\[.+\])?$/);
    if (!match) throw new Error(`Invalid Files entry: ${entry}`);
    return {
      path: normalizePath(match[1]),
      op: match[2] as TaskFileOp,
      annotation: match[3] ? match[3].slice(1, -1) : undefined,
    };
  });
}

function splitCommaList(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function splitTestCasesLine(value: string): string[] {
  const separator = /(?<=\.),\s+/;
  if (separator.test(value)) {
    return value.split(separator).map((entry) => entry.trim()).filter(Boolean);
  }
  return splitCommaList(value);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").trim();
}
