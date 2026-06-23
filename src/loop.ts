import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { log, err, startSpinner, formatDuration } from "./ui";
import { ensureTemplates, readProjectFile, updateRunnerBlock, updateStatusNextStep } from "./files";
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
import { makeLoopPrompt } from "./prompts";

export const makePrompt = makeLoopPrompt;

export const SKIP = Symbol("skip");

function writeUncheckedTask(target: string, currentTask: CurrentTask): void {
  const tasksPath = join(target, "TASKS.md");
  const latestTasks = readFileSync(tasksPath, "utf-8");
  writeFileSync(tasksPath, uncheckSelectedTask(latestTasks, currentTask));
}

function tryUncheckCurrentTask(target: string, currentTask: CurrentTask): boolean {
  try {
    writeUncheckedTask(target, currentTask);
    updateNextStepFromTasks(target);
    return true;
  } catch {
    return false;
  }
}

function updateNextStepFromTasks(target: string): void {
  const nextTask = getTask(readProjectFile(target, "TASKS.md"));
  updateStatusNextStep(
    join(target, "STATUS.md"),
    nextTask ? `Next task: ${nextTask.description}` : "All tasks complete."
  );
}

export function handleStaticGuardFailure(
  target: string,
  currentTask: CurrentTask,
  staticSummary: string
): string {
  let summary = staticSummary;
  try {
    writeUncheckedTask(target, currentTask);
    updateNextStepFromTasks(target);
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

  const prdBefore = readProjectFile(ctx.target, "PRD.md");
  const tasksBefore = readProjectFile(ctx.target, "TASKS.md");
  const currentTask = getTask(tasksBefore);
  if (!currentTask) return { completed: true };
  const beforeExists = baselineFileExistence(ctx.target, currentTask.files);

  const prompt = makeLoopPrompt(ctx.target, ctx.checkCmd, state.loop, currentTask, state.lastFailedOutput, ctx.checkDisabled);

  const stopProvider = startSpinner(`🌀 ${ctx.provider} is working · loop ${state.loop}`);
  try {
    const providerCode = await invokeProvider(ctx.provider, ctx.target, prompt, process.env.RALPH_MODEL);
    if (providerCode !== 0) err(`${ctx.provider} exited with code ${providerCode}`);
  } catch (e) {
    err(`failed to run ${ctx.provider}: ${e instanceof Error ? e.message : e}`);
  }
  stopProvider();

  const changedFiles = gitChangedFiles(ctx.target, ctx.canAutoCommit);
  const afterExists = baselineFileExistence(ctx.target, currentTask.files);
  const staticResult = staticGuard({
    prd: prdBefore,
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
    updateNextStepFromTasks(ctx.target);
    const committed = await autoCommit(ctx.target, state.loop, ctx.canAutoCommit);
    if (committed) {
      const reviewPassed = await runAutoReviewFeedback(
        ctx.provider,
        ctx.target,
        state.loop,
        currentTask,
        lastCommitReviewScope(ctx.target),
        process.env.RALPH_MODEL
      );
      if (!reviewPassed) {
        if (tryUncheckCurrentTask(ctx.target, currentTask)) {
          log("reopened task after failed auto review");
        }
        return { completed: false };
      }
    }
    return { completed: true };
  }

  if (tryUncheckCurrentTask(ctx.target, currentTask)) {
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
    console.log(makeLoopPrompt(target, checkCmd, 1, currentTask, "", checkDisabled));
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
