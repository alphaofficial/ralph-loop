import type { CurrentTask, TaskFileContract, TaskFileOp } from "./task-state";

export type FileOp = TaskFileOp;

export type FileContract = {
  path: string;
};

export type StaticGuardInput = {
  prd: string;
  currentTask: CurrentTask;
  changedEntries?: GitStatusEntry[];
} & Record<string, unknown>;

export type GitStatusEntry = {
  path: string;
  index: string;
  worktree: string;
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

    const match = line.match(/^(.+?)\s*$/);
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

    if (line.endsWith("/")) {
      stack.push({ indent, path: line });
      continue;
    }

    const parent = stack.map((entry) => entry.path).join("");
    files.push({ path: normalizePath(`${parent}${match[1].trim()}`) });
  }

  return files;
}

export function parseGitStatusEntries(output: string): GitStatusEntry[] {
  const tokens = output.split("\0").filter(Boolean);
  const entries: GitStatusEntry[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length < 4) continue;

    const index = token[0];
    const worktree = token[1];
    const path = normalizePath(token.slice(3));
    if (!path) continue;

    entries.push({ path, index, worktree });
    if (index === "R" || index === "C") i++;
  }

  return entries;
}

export function staticGuard(input: StaticGuardInput): StaticGuardResult {
  const failures: string[] = [];
  const prdFiles = parsePrdFilesToTouch(input.prd);
  const task = input.currentTask;
  const prdSet = buildFileSet(prdFiles, "PRD ## Files to touch", failures);
  const taskMap = contractMap(task.files, "selected task Files", failures);

  if (prdFiles.length === 0) {
    failures.push("PRD.md is missing a valid ## Files to touch tree.");
  }

  if (!task.expectation) failures.push("Selected task is missing an Expectation: line.");
  if (task.testCases.length === 0) failures.push("Selected task is missing a valid Test Cases: line.");

  for (const [path, op] of taskMap) {
    if (!prdSet.has(path)) {
      failures.push(`${path} is listed in the task but not in PRD.md ## Files to touch.`);
    }
  }

  const changedEntries = input.changedEntries ?? [];

  for (const entry of changedEntries) {
    const path = normalizePath(entry.path);
    if (path === "PRD.md") {
      failures.push("PRD.md was modified during an implementation iteration.");
      continue;
    }
    if (path === "TASKS.md") {
      failures.push("TASKS.md was modified during provider execution; the Ralph runner owns task state.");
      continue;
    }
    if (path === "STATUS.md" || path.startsWith(".ralph/")) continue;
    const expectedOp = taskMap.get(path);
    if (!expectedOp) {
      failures.push(`${path} changed but is not listed in the selected task Files: line.`);
      continue;
    }
    if (!statusMatchesTaskOp(entry, expectedOp)) {
      failures.push(`${path} is marked ${expectedOp} but git status is ${entry.index}${entry.worktree}.`);
    }
  }

  return { passed: failures.length === 0, failures };
}

function extractSection(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${title.toLowerCase()}`);
  if (start === -1) return "";
  const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

function contractMap(
  files: readonly TaskFileContract[],
  label: string,
  failures: string[]
): Map<string, FileOp> {
  const map = new Map<string, FileOp>();
  for (const file of files) {
    if (!file.path) {
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

function buildFileSet(
  files: readonly FileContract[],
  label: string,
  failures: string[]
): Set<string> {
  const set = new Set<string>();
  for (const file of files) {
    if (!file.path) {
      failures.push(`${label} contains an invalid file entry.`);
      continue;
    }
    if (set.has(file.path)) {
      failures.push(`${label} lists ${file.path} more than once.`);
      continue;
    }
    set.add(file.path);
  }
  return set;
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

function statusMatchesTaskOp(entry: GitStatusEntry, expectedOp: FileOp): boolean {
  const status = `${entry.index}${entry.worktree}`;
  if (status === "!!") return true;
  if (status.includes("U")) return false;

  if (expectedOp === "C") return status === "??" || entry.index === "A";
  if (expectedOp === "M") return entry.index === "M" || entry.worktree === "M" || entry.index === "T" || entry.worktree === "T";
  if (expectedOp === "D") return entry.index === "D" || entry.worktree === "D";
  return false;
}
