import { existsSync } from "node:fs";
import { join } from "node:path";

export type FileOp = "C" | "M" | "D";

export type FileContract = {
  path: string;
  op: FileOp;
};

export type TaskContract = {
  description: string;
  files: FileContract[];
  expectation: string;
  testCases: string[];
};

export type StaticGuardInput = {
  prd: string;
  tasks: string;
  changedFiles: string[];
  beforeExists: Map<string, boolean>;
  afterExists: Map<string, boolean>;
};

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

export function parseFirstUncheckedTask(tasks: string): TaskContract | null {
  const lines = tasks.split("\n");
  const start = lines.findIndex((line) => /^- \[ \] \S/.test(line));
  if (start === -1) return null;

  const block: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (i !== start && /^- \[[ x]\] \S/.test(lines[i])) break;
    block.push(lines[i]);
  }

  const description = block[0].replace(/^- \[ \]\s*/, "").trim();
  const filesLine = contractLine(block, "Files");
  const expectation = contractLine(block, "Expectation");
  const testCasesLine = contractLine(block, "Verification") ?? contractLine(block, "Test Cases");

  return {
    description,
    files: filesLine ? parseFilesLine(filesLine) : [],
    expectation: expectation?.trim() ?? "",
    testCases: testCasesLine ? splitCommaList(testCasesLine) : [],
  };
}

export function parseFilesLine(line: string): FileContract[] {
  return splitCommaList(line).map((entry) => {
    const match = entry.match(/^(.+?)\s+([CMD])$/);
    if (!match) {
      throw new Error(`Invalid file contract entry: ${entry}`);
    }
    return { path: normalizePath(match[1].trim()), op: match[2] as FileOp };
  });
}

export function parseGitStatusFiles(output: string): string[] {
  const files: string[] = [];
  let i = 0;

  while (i < output.length) {
    const status = output.slice(i, i + 2);
    i += 3;
    const end = output.indexOf("\0", i);
    if (end === -1) break;
    const path = output.slice(i, end);
    i = end + 1;

    if (status.includes("R") || status.includes("C")) {
      const oldEnd = output.indexOf("\0", i);
      if (oldEnd === -1) break;
      i = oldEnd + 1;
    }

    files.push(normalizePath(path));
  }

  return [...new Set(files)];
}

export function validateStaticGuard(input: StaticGuardInput): StaticGuardResult {
  const failures: string[] = [];
  const prdFiles = parsePrdFilesToTouch(input.prd);
  const task = safeParseTask(input.tasks, failures);
  const prdMap = contractMap(prdFiles, "PRD ## Files to touch", failures);
  const taskMap = task ? contractMap(task.files, "selected task Files", failures) : new Map<string, FileOp>();

  if (prdFiles.length === 0) {
    failures.push("PRD.md is missing a valid ## Files to touch tree.");
  }

  if (!task) {
    failures.push("TASKS.md has no unchecked task.");
  } else {
    if (task.files.length === 0) failures.push("Selected task is missing a valid Files: line.");
    if (!task.expectation) failures.push("Selected task is missing an Expectation: line.");
    if (task.testCases.length === 0) failures.push("Selected task is missing a valid Verification line.");
  }

  for (const [path, op] of taskMap) {
    const prdOp = prdMap.get(path);
    if (!prdOp) {
      failures.push(`${path} is listed in the task but not in PRD.md ## Files to touch.`);
    } else if (prdOp !== op) {
      failures.push(`${path} has operation ${op} in the task but ${prdOp} in PRD.md.`);
    }
  }

  for (const path of input.changedFiles) {
    if (isRalphOperationalFile(path)) continue;
    if (path === "PRD.md") {
      failures.push("PRD.md was modified during an implementation iteration.");
      continue;
    }
    if (!taskMap.has(path)) {
      failures.push(`${path} changed but is not listed in the selected task Files: line.`);
    }
  }

  for (const [path, op] of taskMap) {
    const changed = input.changedFiles.includes(path);
    const before = input.beforeExists.get(path) ?? false;
    const after = input.afterExists.get(path) ?? false;

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

function contractLine(block: string[], label: string): string | null {
  const prefix = `${label}:`;
  for (const entry of block) {
    const line = entry.trimStart().replace(/^- /, "");
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return null;
}

function splitCommaList(value: string): string[] {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
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

function safeParseTask(tasks: string, failures: string[]): TaskContract | null {
  try {
    return parseFirstUncheckedTask(tasks);
  } catch (e) {
    failures.push(e instanceof Error ? e.message : String(e));
    return null;
  }
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
