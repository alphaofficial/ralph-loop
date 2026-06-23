import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { log, err, startSpinner, formatDuration } from "./ui";
import { ensureTemplates, readProjectFile, updateRunnerBlock } from "./files";
import { invokeProvider, type Provider } from "./providers";
import {
  baselineFileExistence,
  parseGitDiffFiles,
  staticGuard,
} from "./spec-guard";
import {
  lastCommitReviewScope,
  runAutoReviewFeedback,
} from "./review";
import { checkTask, getTask, uncheckTask as uncheckSelectedTask, type CurrentTask } from "./task-state";

export function makePrompt(
  target: string,
  checkCmd: string,
  loopNo: number,
  currentTask: CurrentTask | null,
  lastFailedOutput = "",
  checkDisabled = false
) {
  const prd = readProjectFile(target, "PRD.md");
  const tasks = readProjectFile(target, "TASKS.md");
  const status = readProjectFile(target, "STATUS.md");

  let content = `You are running one iteration of a Ralph loop inside this project.

The project planning files are embedded below. Use these embedded copies instead of reading PRD.md, TASKS.md, or STATUS.md via tool calls.

<PRD>
${prd}
</PRD>

<TASKS>
${tasks}
</TASKS>

<STATUS>
${status}
</STATUS>

${formatCurrentTask(currentTask)}

CRITICAL: You must complete exactly ONE Ralph-selected current task, then stop.
Do NOT attempt multiple tasks. Another fresh instance will handle the next task.

PRD.md is the source-of-truth implementation contract. Implement only what PRD.md and the selected task explicitly specify. Do not invent product behavior, architecture, files, dependencies, abstractions, or tests. Use code inspection only to locate the specified implementation points and follow existing style.

Rules:
- Ralph has already selected the current task. Do not choose a task from TASKS.md.
- The selected task must include Files:, Expectation:, and Test Cases: lines.
- Before editing, identify the PRD sections and selected task contract lines that authorize the work.
- Implement that single task only.
- Touch only implementation files listed in the selected task's Files: line, plus Ralph operational files: STATUS.md and .ralph/*.
- Every implementation file in the selected task's Files: line must also appear in PRD.md ## Files to touch with the same C/M/D marker.
- Do not modify PRD.md during implementation.
- Do not reinterpret, simplify, or expand the spec.
- If an unlisted file or unspecified behavior appears necessary, do not implement it. Update STATUS.md with the spec gap and leave the task unchecked.
- Implement only the checks listed in the selected task's Test Cases: line, except for direct equivalents required by the target project's test framework.
- Do not edit TASKS.md. The Ralph runner owns checking and unchecking the selected task.
- Update STATUS.md with what you changed and what the next task should be.
- Keep STATUS.md concrete, short, and truthful.
- Do not add rationale or departure sections to STATUS.md. PRD.md is authoritative. If the spec blocks implementation, record the blocking spec gap under Known issues and leave the task unchecked.
- Do not touch other unchecked tasks.
- If you encounter any code or test issues, fix them and update STATUS.md with what you did to fix them.
- Do not add tests which simply restate the implementation. These provide zero confidence. Avoid spurious tests.
- Do not leave known issues unfixed before checking off the task.

Iteration number: ${loopNo}
Verification command after your run: ${checkDisabled ? "<disabled by --no-check>" : checkCmd || "<none auto-detected>"}

Write a one-line commit message describing what you changed to .ralph/commit-msg.txt.
Ensure you follow the project's existing commit message style. Use git log to see project commit messsage format and follow it strictly.

IMPORTANT: ensure the generated commit message is concise, specific and no more than 48 charaters.

IMPORTANT: NEVER run git write commands (git add, git commit, git push, git stash, git reset, git checkout, git revert). Only git read commands are permitted (git log, git diff, git show, git status, git blame). The ralph runner handles all commits automatically.

If you need to leave notes for the next fresh instance, put them in STATUS.md.

IMPORTANT: Do not mark the task complete while any tests are failing. All tests must pass first, even if the failures look unrelated or pre-existing.
`;

  if (lastFailedOutput.trim()) {
    content += `
Your previous attempt FAILED verification. Here is the raw output:

${lastFailedOutput.trimEnd()}

Fix the issue before proceeding.
`;
  }

  return content;
}

function formatCurrentTask(currentTask: CurrentTask | null): string {
  if (!currentTask) {
    return `<CURRENT_TASK>
None selected.
</CURRENT_TASK>`;
  }

  return `<CURRENT_TASK>
Description: ${currentTask.description}
Files:
${currentTask.files.map((file) => `- ${file.path} ${file.op}`).join("\n")}
Expectation: ${currentTask.expectation}
Test Cases:
${currentTask.testCases.map((testCase) => `- ${testCase}`).join("\n")}
</CURRENT_TASK>`;
}

export const SKIP = Symbol("skip");

export function handleStaticGuardFailure(
  target: string,
  currentTask: CurrentTask,
  staticSummary: string
): string {
  let summary = staticSummary;
  try {
    const tasksPath = join(target, "TASKS.md");
    const latestTasks = readFileSync(tasksPath, "utf-8");
    writeFileSync(tasksPath, uncheckSelectedTask(latestTasks, currentTask));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    summary += `${summary.endsWith("\n") ? "" : "\n"}Task rollback failed: ${message}\n`;
  }

  updateRunnerBlock(join(target, "STATUS.md"), summary);
  return summary;
}

export function updateTaskAfterVerification(
  target: string,
  currentTask: CurrentTask,
  code: number | typeof SKIP
): boolean {
  if (code !== 0 && code !== SKIP) return false;

  const tasksPath = join(target, "TASKS.md");
  const latestTasks = readFileSync(tasksPath, "utf-8");
  writeFileSync(tasksPath, checkTask(latestTasks, currentTask));
  return true;
}

function commandOutput(proc: { stdout?: Uint8Array; stderr?: Uint8Array }): string {
  const decoder = new TextDecoder();
  return [proc.stderr, proc.stdout]
    .filter((output): output is Uint8Array => !!output && output.length > 0)
    .map((output) => decoder.decode(output).trim())
    .filter(Boolean)
    .join("\n");
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
  let content: string;
  try {
    content = readFileSync(join(target, "TASKS.md"), "utf-8");
  } catch {
    return true;
  }
  return getTask(content) === null;
}

function isGitRepo(target: string): boolean {
  const check = Bun.spawnSync(["git", "-C", target, "rev-parse", "--is-inside-work-tree"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return check.exitCode === 0;
}

export async function autoCommit(target: string, loop: number, canCommit = isGitRepo(target)): Promise<boolean> {
  // Only commit if target is a git repo
  const isGitRepo = canCommit;
  if (!isGitRepo) return false;

  // Stage all changes
  const add = Bun.spawnSync(["git", "-C", target, "add", "-A"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (add.exitCode !== 0) {
    const output = commandOutput(add);
    err(`git add failed${output ? `: ${output}` : ""}`);
    return false;
  }

  // Check if there's anything to commit
  const diff = Bun.spawnSync(["git", "-C", target, "diff", "--cached", "--quiet"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (diff.exitCode === 0) return false; // nothing staged
  if (diff.exitCode !== 1) {
    const output = commandOutput(diff);
    err(`git diff --cached failed${output ? `: ${output}` : ""}`);
    return false;
  }

  // Use AI-generated commit message if available, fall back to task description
  const msgFile = join(target, ".ralph", "commit-msg.txt");
  let msg: string;
  try {
    msg = readFileSync(msgFile, "utf-8").trim().split("\n")[0];
  } catch {
    msg = "";
  }
  if (!msg) msg = `ralph: loop ${loop}`;

  const proc = Bun.spawn(
    ["git", "-C", target, "commit", "-m", msg],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode === 0) {
    log(`✅ committed: ${msg}`);
    return true;
  } else {
    const output = [stderr, stdout].map((text) => text.trim()).filter(Boolean).join("\n");
    err(`git commit failed${output ? `: ${output}` : ""}`);
    return false;
  }
}

type TaskSnapshot = {
  index: number;
  text: string;
};

function firstUncheckedTask(target: string): TaskSnapshot | null {
  let content: string;
  try {
    content = readFileSync(join(target, "TASKS.md"), "utf-8");
  } catch {
    return null;
  }

  const index = content.split("\n").findIndex((line) => line.startsWith("- [ ] "));
  if (index === -1) return null;

  return {
    index,
    text: content.split("\n")[index].slice("- [ ] ".length),
  };
}

function uncheckTask(target: string, task: TaskSnapshot | null): boolean {
  if (!task) return false;

  const tasksFile = join(target, "TASKS.md");
  let content: string;
  try {
    content = readFileSync(tasksFile, "utf-8");
  } catch {
    return false;
  }

  const lines = content.split("\n");
  const checked = `- [x] ${task.text}`;
  const unchecked = `- [ ] ${task.text}`;

  if (lines[task.index] === checked) {
    lines[task.index] = unchecked;
    writeFileSync(tasksFile, lines.join("\n"));
    return true;
  }

  const movedIndex = lines.findIndex((line) => line === checked);
  if (movedIndex !== -1) {
    lines[movedIndex] = unchecked;
    writeFileSync(tasksFile, lines.join("\n"));
    return true;
  }

  return false;
}

function gitChangedFiles(target: string, canInspect = isGitRepo(target)): string[] {
  if (!canInspect) return [];
  const proc = Bun.spawnSync(["git", "-C", target, "diff", "--name-only", "-z", "HEAD"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) return [];
  return parseGitDiffFiles(new TextDecoder().decode(proc.stdout));
}

function staticGuardSummary(failures: readonly string[]): string {
  if (failures.length === 0) return "Static guard: PASS\n";
  return `Static guard: FAIL
${failures.map((failure) => `- ${failure}`).join("\n")}
`;
}

type LoopContext = {
  provider: Provider;
  target: string;
  maxLoops: number;
  checkCmd: string;
  checkDisabled: boolean;
  canAutoCommit: boolean;
  loopStart: number;
};

type LoopState = {
  loop: number;
  consecutiveFailures: number;
  lastFailedOutput: string;
};

type IterationResult = { completed: boolean; lastFailedOutput?: string };

async function runIteration(ctx: LoopContext, state: LoopState): Promise<IterationResult> {
  const iterationStart = Date.now();
  const total = formatDuration(Date.now() - ctx.loopStart);
  log(`loop ${state.loop} (${ctx.provider}) · total ${total}${state.consecutiveFailures > 0 ? ` · failure ${state.consecutiveFailures}/${ctx.maxLoops}` : ""}`);

  const taskForFailureRecovery = firstUncheckedTask(ctx.target);
  const prdBefore = readProjectFile(ctx.target, "PRD.md");
  const tasksBefore = readProjectFile(ctx.target, "TASKS.md");
  const currentTask = getTask(tasksBefore);
  if (!currentTask) return { completed: true };
  const beforeExists = baselineFileExistence(ctx.target, currentTask.files);

  const prompt = makePrompt(ctx.target, ctx.checkCmd, state.loop, currentTask, state.lastFailedOutput, ctx.checkDisabled);

  const stopProvider = startSpinner(`🌀 ${ctx.provider} is working · loop ${state.loop}`);
  try {
    const providerCode = await invokeProvider(ctx.provider, ctx.target, prompt, process.env.RALPH_MODEL);
    if (providerCode !== 0) err(`${ctx.provider} exited with code ${providerCode}`);
  } catch (e) {
    err(`failed to run ${ctx.provider}: ${e instanceof Error ? e.message : e}`);
  }
  stopProvider();

  const changedFiles = gitChangedFiles(ctx.target, ctx.canAutoCommit);
  const tasksAfterProvider = readProjectFile(ctx.target, "TASKS.md");
  const afterExists = baselineFileExistence(ctx.target, currentTask.files);
  const staticResult = staticGuard({
    prd: prdBefore,
    tasksBefore,
    tasksAfter: tasksAfterProvider,
    currentTask,
    changedFiles,
    beforeExists,
    afterExists,
  });
  const staticSummary = staticGuardSummary(staticResult.failures);
  const staticOut = join(ctx.target, ".ralph", "static-guard-summary.txt");

  if (!staticResult.passed) {
    const staticSummaryWithRollbackNotes = handleStaticGuardFailure(ctx.target, currentTask, staticSummary);
    writeFileSync(staticOut, staticSummaryWithRollbackNotes, { mode: 0o600 });
    const iterTime = formatDuration(Date.now() - iterationStart);
    log(`⚠️ static guard failed · ${iterTime}`);
    return { completed: false, lastFailedOutput: staticSummaryWithRollbackNotes };
  }
  writeFileSync(staticOut, staticSummary, { mode: 0o600 });

  const summaryFile = join(ctx.target, ".ralph", "check-summary.txt");
  const checkOut = join(ctx.target, ".ralph", "check-output.txt");

  const stopCheck = startSpinner(
    ctx.checkDisabled ? "verification disabled by --no-check" : `verifying · ${ctx.checkCmd || "no check cmd"}`
  );
  const code = await runCheck(ctx.target, ctx.checkCmd, checkOut, ctx.checkDisabled);
  stopCheck();

  const iterTime = formatDuration(Date.now() - iterationStart);
  let summary: string;
  if (code === SKIP) {
    summary = "Verification: SKIPPED\n";
    log(`${ctx.checkDisabled ? "verification disabled by --no-check" : "no check command"} · ${iterTime}`);
  } else if (code === 0) {
    summary = "Verification: PASS\n";
    if (ctx.checkCmd) summary += `Command: ${ctx.checkCmd}\n`;
    log(`✅ checks passed · ${iterTime}`);
  } else {
    summary = "Verification: FAIL\n";
    if (ctx.checkCmd) summary += `Command: ${ctx.checkCmd}\n`;
    log(`⚠️ checks failed · ${iterTime}`);
  }

  writeFileSync(summaryFile, summary, { mode: 0o600 });
  updateRunnerBlock(join(ctx.target, "STATUS.md"), summary);

  if (updateTaskAfterVerification(ctx.target, currentTask, code)) {
    const committed = await autoCommit(ctx.target, state.loop, ctx.canAutoCommit);
    if (committed) {
      const reviewPassed = await runAutoReviewFeedback(
        ctx.provider,
        ctx.target,
        state.loop,
        lastCommitReviewScope(ctx.target),
        process.env.RALPH_MODEL
      );
      if (!reviewPassed) return { completed: false };
    }
    return { completed: true };
  }

  if (uncheckTask(ctx.target, taskForFailureRecovery)) {
    log("reopened task after failed verification");
  }
  return { completed: false };
}

export async function mainLoop(
  provider: Provider,
  target: string,
  maxLoops: number,
  checkCmd: string,
  dryRun: boolean,
  checkDisabled = false
): Promise<number> {
  ensureTemplates(target);

  if (dryRun) {
    log("dry run, not invoking " + provider);
    const currentTask = getTask(readProjectFile(target, "TASKS.md"));
    console.log(makePrompt(target, checkCmd, 1, currentTask, "", checkDisabled));
    return 0;
  }

  const ctx: LoopContext = {
    provider,
    target,
    maxLoops,
    checkCmd,
    checkDisabled,
    canAutoCommit: isGitRepo(target),
    loopStart: Date.now(),
  };
  const state: LoopState = { loop: 0, consecutiveFailures: 0, lastFailedOutput: "" };

  while (!allTasksComplete(ctx.target)) {
    state.loop++;
    const result = await runIteration(ctx, state);
    if (result.completed) {
      state.consecutiveFailures = 0;
      state.lastFailedOutput = "";
      continue;
    }

    state.consecutiveFailures++;
    state.lastFailedOutput = result.lastFailedOutput ?? "";
    if (allTasksComplete(ctx.target)) {
      err("iteration failed but no unchecked tasks remain");
      return 1;
    }
    if (state.consecutiveFailures >= ctx.maxLoops) {
      const total = formatDuration(Date.now() - ctx.loopStart);
      err(`⚠️ ${state.consecutiveFailures} consecutive failed iterations — giving up after ${total}`);
      return 1;
    }
  }

  const total = formatDuration(Date.now() - ctx.loopStart);
  log(`all tasks complete in ${state.loop} loops (${total})`);
  return 0;
}
