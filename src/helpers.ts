import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readProjectFile, updateRunnerBlock } from "./files";
import type { ReviewScope } from "./review-scope";
import { err, log } from "./ui";

export const SKIP = Symbol("skip");

export type AutoReviewChange = {
  file: string;
  line: number;
  requested_change: string;
};

export type AutoReviewApproval = {
  status: "approved";
  changes: [];
};

export type AutoReviewChangesRequested = {
  status: "changes_requested";
  changes: AutoReviewChange[];
};

export type AutoReviewInvalidReason =
  | "empty_output"
  | "missing_json"
  | "invalid_json"
  | "invalid_status"
  | "approved_has_changes"
  | "missing_changes"
  | "invalid_change";

export type AutoReviewInvalid = {
  status: "invalid";
  reason: AutoReviewInvalidReason;
  message: string;
};

export type AutoReviewResult =
  | AutoReviewApproval
  | AutoReviewChangesRequested
  | AutoReviewInvalid;

export const AUTO_REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "changes"],
  properties: {
    status: {
      type: "string",
      enum: ["approved", "changes_requested"],
    },
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "line", "requested_change"],
        properties: {
          file: { type: "string" },
          line: { type: "integer" },
          requested_change: { type: "string" },
        },
      },
    },
  },
} as const;

export function parseAutoReviewResult(output: string): AutoReviewResult {
  const trimmed = output.trim();
  if (!trimmed) {
    return invalidAutoReviewResult("empty_output", "review output was empty");
  }

  const jsonText = extractJsonPayload(trimmed);
  if (!jsonText) {
    return invalidAutoReviewResult(
      "missing_json",
      "review output did not contain a JSON object"
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return invalidAutoReviewResult(
      "invalid_json",
      "review output contained invalid JSON"
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalidAutoReviewResult("invalid_json", "review output JSON must be an object");
  }

  const record = parsed as Record<string, unknown>;
  if (record.status === "approved") {
    if (record.changes === undefined) {
      return { status: "approved", changes: [] };
    }
    if (!Array.isArray(record.changes) || record.changes.length > 0) {
      return invalidAutoReviewResult(
        "approved_has_changes",
        "approved review output must not include requested changes"
      );
    }
    return { status: "approved", changes: [] };
  }

  if (record.status !== "changes_requested") {
    return invalidAutoReviewResult(
      "invalid_status",
      'review output status must be "approved" or "changes_requested"'
    );
  }

  if (!Array.isArray(record.changes) || record.changes.length === 0) {
    return invalidAutoReviewResult(
      "missing_changes",
      'changes_requested review output must include a non-empty "changes" array'
    );
  }

  const changes: AutoReviewChange[] = [];
  for (const entry of record.changes) {
    const change = parseAutoReviewChange(entry);
    if (!change) {
      return invalidAutoReviewResult(
        "invalid_change",
        "each requested change must include file, line, and requested_change"
      );
    }
    changes.push(change);
  }

  return { status: "changes_requested", changes };
}

export function isAutoReviewApproved(
  result: AutoReviewResult
): result is AutoReviewApproval {
  return result.status === "approved";
}

export function makeAutoReviewPrompt(
  target: string,
  loop: number,
  reviewScope: ReviewScope | null
): string {
  const prd = readProjectFile(target, "PRD.md");
  const tasks = readProjectFile(target, "TASKS.md");
  const status = readProjectFile(target, "STATUS.md");
  const scope = reviewScope ?? { diff: "", touchedFiles: [] };
  const currentTask =
    completedTaskFromTasksDiff(scope.diff) ??
    firstUncheckedTask(tasks) ??
    "Unable to determine the current iteration task.";

  return `You are the blocking auto-review gate for Ralph iteration ${loop}.

Your job is to do an adversarial review of only the work completed in this iteration before verification and auto-commit.

Review rules:
- Scope is limited to the completed task below, the relevant PRD acceptance criteria below, and the touched files from this iteration.
- Focus on blockers only. Ignore nits, style comments, speculative refactors, and unrelated improvements.
- Check whether the touched-file changes fully satisfy the task and acceptance criteria.
- Check whether the touched-file changes are internally consistent with the surrounding code they directly affect.
- Do not request changes in untouched files. Every requested change must target one of the touched files listed below.
- If the output format would be invalid, return changes_requested instead of prose.

Output contract:
- Return exactly one compact JSON string produced by JSON.stringify(result) and nothing else.
- The first character must be { and the final character must be }.
- Do not include Markdown fences, prose, comments, headings, or trailing text.

Approved format:
{"status":"approved","changes":[]}

Changes requested format:
{"status":"changes_requested","changes":[{"file":"relative/path.ts","line":123,"requested_change":"Concrete blocker to fix."}]}

Each requested change must:
- reference a touched file path exactly as listed below
- use a real 1-based line number
- describe the minimal blocking fix needed for approval
- stay inside the scope of this iteration task

Completed iteration task:
- ${currentTask}

Relevant PRD acceptance criteria:
${extractRelevantAcceptanceCriteria(prd)}

Touched files:
${formatTouchedFiles(scope.touchedFiles)}

Iteration diff:
\`\`\`diff
${scope.diff || "# No iteration diff was captured."}
\`\`\`

Project planning files are embedded below. Use these embedded copies instead of reading PRD.md, TASKS.md, or STATUS.md via tool calls.

<PRD>
${prd}
</PRD>

<TASKS>
${tasks}
</TASKS>

<STATUS>
${status}
</STATUS>`;
}

function commandOutput(proc: { stdout?: Uint8Array; stderr?: Uint8Array }): string {
  const decoder = new TextDecoder();
  return [proc.stderr, proc.stdout]
    .filter((output): output is Uint8Array => !!output && output.length > 0)
    .map((output) => decoder.decode(output).trim())
    .filter(Boolean)
    .join("\n");
}

function parseAutoReviewChange(entry: unknown): AutoReviewChange | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const record = entry as Record<string, unknown>;
  const file = typeof record.file === "string" ? record.file.trim() : "";
  const requestedChange =
    typeof record.requested_change === "string"
      ? record.requested_change.trim()
      : "";
  const line = record.line;

  if (!file || !requestedChange || !Number.isInteger(line) || (line as number) < 1) {
    return null;
  }

  return {
    file,
    line: line as number,
    requested_change: requestedChange,
  };
}

function invalidAutoReviewResult(
  reason: AutoReviewInvalidReason,
  message: string
): AutoReviewInvalid {
  return { status: "invalid", reason, message };
}

function extractJsonPayload(output: string): string | null {
  if (!output.startsWith("{")) return null;

  return output;
}

function firstUncheckedTask(tasks: string): string | null {
  for (const line of tasks.split("\n")) {
    const match = line.match(/^- \[ \] (\S.*)$/);
    if (match) return match[1].trim();
  }
  return null;
}

function completedTaskFromTasksDiff(diff: string): string | null {
  const marker = "diff --git a/TASKS.md b/TASKS.md";
  const start = diff.indexOf(marker);
  if (start === -1) return null;

  const nextPatch = diff.indexOf("\ndiff --git ", start + marker.length);
  const tasksPatch = (nextPatch === -1 ? diff.slice(start) : diff.slice(start, nextPatch)).trimEnd();
  if (!tasksPatch) return null;

  const uncheckedTasks = new Set<string>();
  const checkedTasks: string[] = [];

  for (const line of tasksPatch.split("\n")) {
    const match = line.match(/^([+-])- \[([ x])\] (\S.*)$/);
    if (!match) continue;

    const [, operation, state, task] = match;
    const trimmedTask = task.trim();
    if (operation === "-" && state === " ") uncheckedTasks.add(trimmedTask);
    if (operation === "+" && state === "x") checkedTasks.push(trimmedTask);
  }

  for (const task of checkedTasks) {
    if (uncheckedTasks.has(task)) return task;
  }

  return checkedTasks[0] ?? null;
}

function extractRelevantAcceptanceCriteria(prd: string): string {
  const goal = sectionBody(prd, "Goal");
  const bullets = [
    ...sectionBullets(prd, "Requirements"),
    ...sectionBullets(prd, "Technical requirements"),
    ...sectionBullets(prd, "Constraints"),
    ...sectionBullets(prd, "Definition of done"),
  ];

  const relevantKeywords = [
    "review",
    "prompt",
    "scope",
    "touched",
    "acceptance",
    "approved",
    "changes_requested",
    "verification",
    "commit",
    "untouched",
  ];
  const relevantBullets = bullets.filter((line) =>
    relevantKeywords.some((keyword) => line.toLowerCase().includes(keyword))
  );
  const selectedBullets = relevantBullets.length > 0 ? relevantBullets : bullets;

  const parts: string[] = [];
  if (goal) parts.push(`Goal:\n${goal}`);
  if (selectedBullets.length > 0) parts.push(selectedBullets.join("\n"));

  return parts.join("\n\n") || "No PRD acceptance criteria were available.";
}

function sectionBody(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const headingPattern = new RegExp(`^#{1,6} ${escapeRegex(heading)}$`);
  const anyHeadingPattern = /^#{1,6} /;
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start === -1) return "";

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (anyHeadingPattern.test(line.trim())) break;
    body.push(line);
  }

  return body.join("\n").trim();
}

function sectionBullets(markdown: string, heading: string): string[] {
  return sectionBody(markdown, heading)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));
}

function formatTouchedFiles(touchedFiles: string[]): string {
  if (touchedFiles.length === 0) return "- (none recorded)";
  return touchedFiles.map((file) => `- ${file}`).join("\n");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function runCheck(
  target: string,
  checkCmd: string,
  outFile: string,
  checkDisabled = false
): Promise<number | typeof SKIP> {
  if (!checkCmd) {
    writeFileSync(
      outFile,
      checkDisabled
        ? "Runner-managed verification disabled by --no-check.\n"
        : "No verification command detected.\n"
    );
    return SKIP;
  }

  const proc = Bun.spawn(["bash", "-lc", checkCmd], {
    cwd: target,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  writeFileSync(outFile, stdout + stderr, { mode: 0o600 });
  return await proc.exited;
}

export function allTasksComplete(target: string): boolean {
  try {
    const content = readFileSync(join(target, "TASKS.md"), "utf-8");
    const tasks = content.split("\n").filter((line) => /^- \[[ x]\]/.test(line));
    if (tasks.length === 0) return true;
    return tasks.every((line) => line.startsWith("- [x]"));
  } catch {
    return true;
  }
}

export function isGitRepo(target: string): boolean {
  const check = Bun.spawnSync(["git", "-C", target, "rev-parse", "--is-inside-work-tree"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return check.exitCode === 0;
}

export async function autoCommit(target: string, loop: number, canCommit = isGitRepo(target)) {
  if (!canCommit) return;

  const add = Bun.spawnSync(["git", "-C", target, "add", "-A"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (add.exitCode !== 0) {
    const output = commandOutput(add);
    err(`git add failed${output ? `: ${output}` : ""}`);
    return;
  }

  const diff = Bun.spawnSync(["git", "-C", target, "diff", "--cached", "--quiet"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (diff.exitCode === 0) return;
  if (diff.exitCode !== 1) {
    const output = commandOutput(diff);
    err(`git diff --cached failed${output ? `: ${output}` : ""}`);
    return;
  }

  const msgFile = join(target, ".ralph", "commit-msg.txt");
  let msg: string;
  try {
    msg = readFileSync(msgFile, "utf-8").trim().split("\n")[0];
  } catch {
    msg = "";
  }
  if (!msg) msg = `ralph: loop ${loop}`;

  const proc = Bun.spawn(["git", "-C", target, "commit", "-m", msg], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode === 0) {
    log(`✅ committed: ${msg}`);
  } else {
    const output = [stderr, stdout].map((text) => text.trim()).filter(Boolean).join("\n");
    err(`git commit failed${output ? `: ${output}` : ""}`);
  }
}

const CHECK_SUMMARY_LINE_LIMIT = 120;

export function readCheckOutputSummary(file: string): string {
  try {
    const content = readFileSync(file, "utf-8");
    return content.split("\n").slice(0, CHECK_SUMMARY_LINE_LIMIT).join("\n");
  } catch {
    return "";
  }
}

export function combineOutput(stdout: string, stderr: string): string {
  return [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n");
}

function autoReviewArtifactBase(target: string, loop: number, attempt: number): string {
  return join(target, ".ralph", `iteration-${loop}-auto-review-${attempt}`);
}

export function writeAutoReviewOutputArtifact(
  target: string,
  loop: number,
  attempt: number,
  rawOutput: string
): string {
  const path = `${autoReviewArtifactBase(target, loop, attempt)}-output.txt`;
  writeFileSync(path, rawOutput ? `${rawOutput}\n` : "", { mode: 0o600 });
  return path;
}

export function writeAutoReviewResultArtifact(
  target: string,
  loop: number,
  attempt: number,
  result: AutoReviewResult
): string {
  const path = `${autoReviewArtifactBase(target, loop, attempt)}-result.json`;
  writeFileSync(path, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  return path;
}

export function writeAutoReviewSummary(
  target: string,
  loop: number,
  summary: string,
  updateStatus = false
) {
  writeFileSync(
    join(target, ".ralph", `iteration-${loop}-auto-review-summary.txt`),
    summary,
    { mode: 0o600 }
  );
  if (updateStatus) updateRunnerBlock(join(target, "STATUS.md"), summary);
}

export function cleanupAutoReviewArtifacts(paths: string[]) {
  for (const path of paths) rmSync(path, { force: true });
}

export function formatAutoReviewFeedback(
  result: Extract<AutoReviewResult, { status: "changes_requested" }>
): string {
  const changes = result.changes
    .map(
      (change) =>
        `- file: ${change.file}\n  line: ${change.line}\n  requested_change: ${change.requested_change}`
    )
    .join("\n");

  return `Auto-review blocked this attempt before verification.
Treat this feedback as blocking context for the same task and fix it through the normal Ralph iteration prompt path.

Auto-review requested changes:
${changes}

Fix the requested changes before proceeding. Keep scope limited to the current task, acceptance criteria, and touched files.`;
}
