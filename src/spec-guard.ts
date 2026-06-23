import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CurrentTask, TaskFileContract, TaskFileOp } from "./task-state";

export type FileOp = TaskFileOp;

export type FileContract = TaskFileContract;

export type StaticGuardInput = {
  prd: string;
  currentTask: CurrentTask;
  changedFiles: string[];
} & Record<string, unknown>;

export type StaticGuardResult = {
  passed: boolean;
  failures: string[];
};

const FILE_OPS = new Set(["C", "M", "D"]);

export function parsePrdFilesToTouch(prd: string): FileContract[] {
  const section = extractSection(prd, "Files to touch");
  if (!section.trim()) return [];

  const stack: { indent: number; path: string }[] = [];
  const files: FileContract[] = [];

  for (const rawLine of section.split("\n")) {
    if (/^\s*```/.test(rawLine)) continue;

    const parsedLine = parseTreeLine(rawLine);
    if (!parsedLine) continue;

    const { indent, line, branch } = parsedLine;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();

    const match = line.match(/^(.+?)\s+([CMD])$/);
    if (!match && !branch && stack.length === 0) {
      if (line === ".") continue;
      stack.push({ indent: -1, path: `${line.replace(/\/$/, "")}/` });
      continue;
    }

    if (!match && (branch || line.endsWith("/"))) {
      const directory = line.endsWith("/") ? line : `${line}/`;
      stack.push({ indent, path: directory });
      continue;
    }

    if (!match) continue;

    const parent = stack.map((entry) => entry.path).join("");
    files.push({ path: normalizePath(`${parent}${match[1].trim()}`), op: match[2] as FileOp });
  }

  return files;
}

export function parsePrdTestCases(prd: string): string[] {
  const section = extractSection(prd, "Test cases");
  const testCases: string[] = [];

  for (const rawLine of section.split("\n")) {
    const match = rawLine.trim().match(/^-\s+(.+)$/);
    if (match) testCases.push(match[1].trim());
  }

  return testCases;
}

export function parseGitDiffFiles(output: string): string[] {
  return [...new Set(output.split("\0").map(normalizePath).filter(Boolean))];
}

export function staticGuard(input: StaticGuardInput): StaticGuardResult {
  const failures: string[] = [];
  const prdFiles = parsePrdFilesToTouch(input.prd);
  const task = input.currentTask;
  const prdMap = contractMap(prdFiles, "PRD ## Files to touch", failures);
  const taskMap = contractMap(task.files, "selected task Files", failures);
  const tasksBefore = stringInput(input, "tasksBefore");
  const tasksAfter = stringInput(input, "tasksAfter");
  const beforeExists = mapInput(input, "beforeExists");
  const afterExists = mapInput(input, "afterExists");

  if (prdFiles.length === 0) {
    failures.push("PRD.md is missing a valid ## Files to touch tree.");
  }

  if (task.files.length === 0) failures.push("Selected task is missing a valid Files: line.");
  if (!task.expectation) failures.push("Selected task is missing an Expectation: line.");
  if (task.testCases.length === 0) failures.push("Selected task is missing a valid Test Cases: line.");

  if (tasksBefore !== undefined && tasksAfter !== undefined && tasksBefore !== tasksAfter) {
    failures.push("TASKS.md changed during provider execution; the Ralph runner owns task state.");
  }

  for (const [path, op] of taskMap) {
    if (!prdMap.has(path)) {
      failures.push(`${path} is listed in the task but not in PRD.md ## Files to touch.`);
    }
  }

  const changedFileSet = new Set(input.changedFiles.map(normalizePath));

  for (const path of changedFileSet) {
    if (path === "PRD.md") {
      failures.push("PRD.md was modified during an implementation iteration.");
      continue;
    }
    if (path === "TASKS.md") {
      failures.push("TASKS.md was modified during provider execution; the Ralph runner owns task state.");
      continue;
    }
    if (path === "STATUS.md" || path.startsWith(".ralph/")) continue;
    if (!taskMap.has(path)) {
      failures.push(`${path} changed but is not listed in the selected task Files: line.`);
    }
  }

  for (const [path, op] of taskMap) {
    if (!beforeExists || !afterExists) continue;
    const changed = changedFileSet.has(path);
    const before = beforeExists.get(path) ?? false;
    const after = afterExists.get(path) ?? false;

    if (op === "C" && before) failures.push(`${path} is marked C but existed before the iteration.`);
    if (op === "C" && !after) failures.push(`${path} is marked C but does not exist after the iteration.`);
    if (op === "M" && changed && !before) failures.push(`${path} is marked M but did not exist before the iteration.`);
    if (op === "M" && changed && !after) failures.push(`${path} is marked M but does not exist after the iteration.`);
    if (op === "D" && !before) failures.push(`${path} is marked D but did not exist before the iteration.`);
    if (op === "D" && after) failures.push(`${path} is marked D but still exists after the iteration.`);
  }

  return { passed: failures.length === 0, failures };
}

export function isRalphOperationalFile(path: string): boolean {
  return path === "TASKS.md" || path === "STATUS.md" || path.startsWith(".ralph/");
}

export function baselineFileExistence(target: string, files: readonly FileContract[]): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (const file of files) {
    result.set(file.path, existsSync(join(target, file.path)));
  }
  return result;
}

function extractSection(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${title.toLowerCase()}`);
  if (start === -1) return "";
  const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

function contractMap(
  files: readonly FileContract[],
  label: string,
  failures: string[]
): Map<string, FileOp> {
  const map = new Map<string, FileOp>();
  for (const file of files) {
    if (!file.path || !FILE_OPS.has(file.op)) {
      failures.push(`${label} contains an invalid file entry.`);
      continue;
    }
    if (map.has(file.path)) {
      failures.push(`${label} lists ${file.path} more than once.`);
      continue;
    }
    map.set(file.path, file.op);
  }
  return map;
}

function parseTreeLine(rawLine: string): { indent: number; line: string; branch: boolean } | null {
  const withoutComment = rawLine.replace(/\s+#.*$/, "");
  if (!withoutComment.trim()) return null;

  const trimmed = withoutComment.trim();
  if (trimmed === ".") return null;

  const treeMatch = withoutComment.match(/^((?:│   |    )*)(?:├──|└──)\s+(.+)$/);
  if (treeMatch) {
    return { indent: (treeMatch[1].length / 4) * 2, line: treeMatch[2].trim(), branch: true };
  }

  const listMatch = withoutComment.match(/^(\s*)-\s+(.+)$/);
  if (listMatch) {
    return { indent: listMatch[1].length, line: listMatch[2].trim(), branch: true };
  }

  return { indent: leadingSpaces(withoutComment), line: trimmed, branch: false };
}

function leadingSpaces(value: string): number {
  return value.match(/^ */)?.[0].length ?? 0;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").trim();
}

function stringInput(input: StaticGuardInput, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function mapInput(input: StaticGuardInput, key: string): Map<string, boolean> | undefined {
  const value = input[key];
  return value instanceof Map ? value : undefined;
}
