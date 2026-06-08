import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readProjectFile } from "./files";

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

export function parseAutoReviewResult(output: string): AutoReviewResult {
  const trimmed = output.trim();
  if (!trimmed) {
    return invalid("empty_output", "review output was empty");
  }

  const jsonText = extractJsonPayload(trimmed);
  if (!jsonText) {
    return invalid("missing_json", "review output did not contain a JSON object");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return invalid("invalid_json", "review output contained invalid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return invalid("invalid_json", "review output JSON must be an object");
  }

  const record = parsed as Record<string, unknown>;
  if (record.status === "approved") {
    if (record.changes === undefined) {
      return { status: "approved", changes: [] };
    }
    if (!Array.isArray(record.changes) || record.changes.length > 0) {
      return invalid(
        "approved_has_changes",
        'approved review output must not include requested changes'
      );
    }
    return { status: "approved", changes: [] };
  }

  if (record.status !== "changes_requested") {
    return invalid(
      "invalid_status",
      'review output status must be "approved" or "changes_requested"'
    );
  }

  if (!Array.isArray(record.changes) || record.changes.length === 0) {
    return invalid(
      "missing_changes",
      'changes_requested review output must include a non-empty "changes" array'
    );
  }

  const changes: AutoReviewChange[] = [];
  for (const entry of record.changes) {
    const change = parseChange(entry);
    if (!change) {
      return invalid(
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

export function makeAutoReviewPrompt(target: string, loop: number): string {
  const prd = readProjectFile(target, "PRD.md");
  const tasks = readProjectFile(target, "TASKS.md");
  const status = readProjectFile(target, "STATUS.md");
  const scope = readIterationReviewScope(target, loop);
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

Return exactly one JSON object and nothing else.

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

Iteration review artifacts:
- touched files artifact: .ralph/iteration-${loop}-touched-files.txt
- diff artifact: .ralph/iteration-${loop}-diff.patch
- metadata artifact: .ralph/iteration-${loop}-git.json

Touched files:
${formatTouchedFiles(scope.touchedFiles)}

Iteration diff:
\`\`\`diff
${scope.diff || "# No iteration diff artifact was recorded."}
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

export function makeAutoReviewFixPrompt(
  target: string,
  loop: number,
  review: AutoReviewChangesRequested
): string {
  const prd = readProjectFile(target, "PRD.md");
  const tasks = readProjectFile(target, "TASKS.md");
  const status = readProjectFile(target, "STATUS.md");
  const scope = readIterationReviewScope(target, loop);
  const currentTask =
    completedTaskFromTasksDiff(scope.diff) ??
    firstUncheckedTask(tasks) ??
    "Unable to determine the current iteration task.";

  return `You are continuing Ralph iteration ${loop} after the blocking auto-review gate requested changes.

Your job is to fix only the requested blockers below, then stop. Do not run verification or any git write commands.

Fix rules:
- Scope is limited to the requested blockers below, the completed task, the relevant PRD acceptance criteria, and the files already touched in this iteration.
- Focus on the minimal blocking fixes needed for approval. Do not start the next TASKS.md item.
- Do not introduce unrelated refactors, cleanup, or scope expansion.
- If the minimal blocker fix requires touching an additional file, keep that edit directly in service of one requested change.
- Preserve the completed current task checkbox in TASKS.md. Do not change any other task status.
- Keep STATUS.md concrete and truthful if the blocker fix changes what the next iteration should know.

Blocking changes requested by auto-review:
${formatRequestedChanges(review.changes)}

Completed iteration task:
- ${currentTask}

Relevant PRD acceptance criteria:
${extractRelevantAcceptanceCriteria(prd)}

Touched files so far:
${formatTouchedFiles(scope.touchedFiles)}

Iteration diff so far:
\`\`\`diff
${scope.diff || "# No iteration diff artifact was recorded."}
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

function parseChange(entry: unknown): AutoReviewChange | null {
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

function invalid(
  reason: AutoReviewInvalidReason,
  message: string
): AutoReviewInvalid {
  return { status: "invalid", reason, message };
}

function extractJsonPayload(output: string): string | null {
  const fencedMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  if (output.startsWith("{") && output.endsWith("}")) {
    return output;
  }

  const objectStart = output.indexOf("{");
  if (objectStart === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = objectStart; i < output.length; i++) {
    const char = output[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth++;
      continue;
    }

    if (char === "}") {
      depth--;
      if (depth === 0) {
        return output.slice(objectStart, i + 1);
      }
    }
  }

  return null;
}

function readIterationReviewScope(target: string, loop: number): {
  diff: string;
  touchedFiles: string[];
} {
  const ralphDir = join(target, ".ralph");
  const touchedFilesPath = join(ralphDir, `iteration-${loop}-touched-files.txt`);
  const diffPath = join(ralphDir, `iteration-${loop}-diff.patch`);

  const touchedFiles = existsSync(touchedFilesPath)
    ? readFileSync(touchedFilesPath, "utf-8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
  const diff = existsSync(diffPath) ? readFileSync(diffPath, "utf-8").trimEnd() : "";

  return { diff, touchedFiles };
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

function formatRequestedChanges(changes: AutoReviewChange[]): string {
  return changes
    .map(
      (change) =>
        `- ${change.file}:${change.line} — ${change.requested_change}`
    )
    .join("\n");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
