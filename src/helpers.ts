import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { updateRunnerBlock } from "./files";
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
