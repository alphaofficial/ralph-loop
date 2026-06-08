import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { log, err, startSpinner, formatDuration } from "./ui";
import { ensureTemplates, readProjectFile, updateRunnerBlock } from "./files";
import {
  captureIterationGitBaseline,
  captureIterationReviewScope,
} from "./iteration-git";
import {
  isAutoReviewApproved,
  makeAutoReviewFixPrompt,
  makeAutoReviewPrompt,
  parseAutoReviewResult,
  type AutoReviewResult,
} from "./auto-review";
import { captureProvider, invokeProvider, type Provider } from "./providers";

export function makePrompt(
  target: string,
  checkCmd: string,
  loopNo: number,
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

CRITICAL: You must complete exactly ONE unchecked task from TASKS.md, then stop.
Do NOT attempt multiple tasks. Another fresh instance will handle the next task.

Rules:
- Pick the FIRST unchecked task (- [ ]) from TASKS.md.
- Implement that single task only.
- Check off that one task (- [x]) in TASKS.md.
- Update STATUS.md with what you changed and what the next task should be.
- Keep STATUS.md concrete, short, and truthful.
- Record any implementation notes, spec gaps, decisions, tradeoffs, or notable deviations you had to make in STATUS.md.
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

export const SKIP = Symbol("skip");

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
  try {
    const content = readFileSync(join(target, "TASKS.md"), "utf-8");
    const tasks = content.split("\n").filter((line) => /^- \[[ x]\]/.test(line));
    if (tasks.length === 0) return true;
    return tasks.every((line) => line.startsWith("- [x]"));
  } catch {
    return true;
  }
}

function isGitRepo(target: string): boolean {
  const check = Bun.spawnSync(["git", "-C", target, "rev-parse", "--is-inside-work-tree"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return check.exitCode === 0;
}

export async function autoCommit(target: string, loop: number, canCommit = isGitRepo(target)) {
  // Only commit if target is a git repo
  const isGitRepo = canCommit;
  if (!isGitRepo) return;

  // Stage all changes
  const add = Bun.spawnSync(["git", "-C", target, "add", "-A"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (add.exitCode !== 0) {
    const output = commandOutput(add);
    err(`git add failed${output ? `: ${output}` : ""}`);
    return;
  }

  // Check if there's anything to commit
  const diff = Bun.spawnSync(["git", "-C", target, "diff", "--cached", "--quiet"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (diff.exitCode === 0) return; // nothing staged
  if (diff.exitCode !== 1) {
    const output = commandOutput(diff);
    err(`git diff --cached failed${output ? `: ${output}` : ""}`);
    return;
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
  } else {
    const output = [stderr, stdout].map((text) => text.trim()).filter(Boolean).join("\n");
    err(`git commit failed${output ? `: ${output}` : ""}`);
  }
}

function first120Lines(file: string): string {
  try {
    const content = readFileSync(file, "utf-8");
    return content.split("\n").slice(0, 120).join("\n");
  } catch {
    return "";
  }
}

export type LoopContext = {
  provider: Provider;
  target: string;
  maxLoops: number;
  maxReviewLoops: number;
  checkCmd: string;
  checkDisabled: boolean;
  canAutoCommit: boolean;
  loopStart: number;
};

export type LoopState = {
  loop: number;
  retries: number;
  lastFailedOutput: string;
};

type IterationResult =
  | { completed: true }
  | { completed: false; retryable: true; lastFailedOutput: string }
  | { completed: false; retryable: false };

type AutoReviewGateResult = { approved: true } | { approved: false };

type AutoReviewGateDeps = {
  captureProviderFn?: typeof captureProvider;
  invokeProviderFn?: typeof invokeProvider;
  captureIterationReviewScopeFn?: typeof captureIterationReviewScope;
  logFn?: typeof log;
  errFn?: typeof err;
  startSpinnerFn?: typeof startSpinner;
};

function combineOutput(stdout: string, stderr: string): string {
  return [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n");
}

function writeAutoReviewAttemptArtifacts(
  target: string,
  loop: number,
  attempt: number,
  prompt: string,
  rawOutput: string,
  result: AutoReviewResult
) {
  const base = join(target, ".ralph", `iteration-${loop}-auto-review-${attempt}`);
  writeFileSync(`${base}-prompt.txt`, prompt, { mode: 0o600 });
  writeFileSync(`${base}-output.txt`, rawOutput ? `${rawOutput}\n` : "", { mode: 0o600 });
  writeFileSync(`${base}-result.json`, JSON.stringify(result, null, 2) + "\n", {
    mode: 0o600,
  });
}

function writeAutoReviewFixPromptArtifact(
  target: string,
  loop: number,
  attempt: number,
  prompt: string
) {
  writeFileSync(
    join(target, ".ralph", `iteration-${loop}-auto-review-fix-${attempt}.prompt.txt`),
    prompt,
    { mode: 0o600 }
  );
}

function writeAutoReviewSummary(
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

export async function runAutoReviewGate(
  ctx: LoopContext,
  state: LoopState,
  gitBaseline: ReturnType<typeof captureIterationGitBaseline>,
  deps: AutoReviewGateDeps = {}
): Promise<AutoReviewGateResult> {
  const captureProviderFn = deps.captureProviderFn ?? captureProvider;
  const invokeProviderFn = deps.invokeProviderFn ?? invokeProvider;
  const captureIterationReviewScopeFn =
    deps.captureIterationReviewScopeFn ?? captureIterationReviewScope;
  const logFn = deps.logFn ?? log;
  const errFn = deps.errFn ?? err;
  const startSpinnerFn = deps.startSpinnerFn ?? startSpinner;

  if (!gitBaseline) {
    logFn("auto-review skipped · git scope unavailable");
    return { approved: true };
  }

  for (let attempt = 1; attempt <= ctx.maxReviewLoops; attempt++) {
    const reviewScope = captureIterationReviewScopeFn(ctx.target, gitBaseline);

    const reviewPrompt = makeAutoReviewPrompt(ctx.target, state.loop, reviewScope);
    const stopReview = startSpinnerFn(
      `🔎 auto-review · attempt ${attempt}/${ctx.maxReviewLoops}`
    );
    let reviewOutput = "";
    let reviewResult: AutoReviewResult;
    try {
      const captured = await captureProviderFn(
        ctx.provider,
        ctx.target,
        reviewPrompt,
        process.env.RALPH_MODEL
      );
      reviewOutput = combineOutput(captured.stdout, captured.stderr);
      reviewResult = parseAutoReviewResult(reviewOutput);
      writeAutoReviewAttemptArtifacts(
        ctx.target,
        state.loop,
        attempt,
        reviewPrompt,
        reviewOutput,
        reviewResult
      );
      if (captured.code !== 0) {
        errFn(`${ctx.provider} auto-review exited with code ${captured.code}`);
      }
    } catch (e) {
      stopReview();
      const summary = `Auto-review: FAIL
Reason: failed to run reviewer: ${e instanceof Error ? e.message : e}`;
      writeAutoReviewSummary(ctx.target, state.loop, summary, true);
      errFn(summary);
      return { approved: false };
    }
    stopReview();

    if (isAutoReviewApproved(reviewResult)) {
      const summary = `Auto-review: PASS
Attempts: ${attempt}/${ctx.maxReviewLoops}`;
      writeAutoReviewSummary(ctx.target, state.loop, summary);
      logFn(`✅ auto-review approved · attempt ${attempt}/${ctx.maxReviewLoops}`);
      return { approved: true };
    }

    if (reviewResult.status === "invalid") {
      const summary = `Auto-review: FAIL
Reason: invalid reviewer output (${reviewResult.reason})
Message: ${reviewResult.message}
Artifact: .ralph/iteration-${state.loop}-auto-review-${attempt}-output.txt`;
      writeAutoReviewSummary(ctx.target, state.loop, summary, true);
      errFn(`auto-review blocked · invalid reviewer output (${reviewResult.reason})`);
      return { approved: false };
    }

    if (attempt >= ctx.maxReviewLoops) {
      const summary = `Auto-review: FAIL
Reason: exhausted review loop after ${ctx.maxReviewLoops} attempts
Artifact: .ralph/iteration-${state.loop}-auto-review-${attempt}-result.json`;
      writeAutoReviewSummary(ctx.target, state.loop, summary, true);
      errFn(`auto-review blocked · exhausted after ${ctx.maxReviewLoops} attempts`);
      return { approved: false };
    }

    logFn(
      `auto-review requested ${reviewResult.changes.length} blocker${reviewResult.changes.length === 1 ? "" : "s"}`
    );
    const fixPrompt = makeAutoReviewFixPrompt(
      ctx.target,
      state.loop,
      reviewScope,
      reviewResult
    );
    writeAutoReviewFixPromptArtifact(ctx.target, state.loop, attempt, fixPrompt);

    const stopFix = startSpinnerFn(
      `🛠️ ${ctx.provider} is addressing auto-review blockers · pass ${attempt}/${ctx.maxReviewLoops - 1}`
    );
    try {
      const providerCode = await invokeProviderFn(
        ctx.provider,
        ctx.target,
        fixPrompt,
        process.env.RALPH_MODEL
      );
      if (providerCode !== 0) errFn(`${ctx.provider} exited with code ${providerCode}`);
    } catch (e) {
      errFn(`failed to run ${ctx.provider}: ${e instanceof Error ? e.message : e}`);
    }
    stopFix();
  }

  return { approved: false };
}

async function runIteration(ctx: LoopContext, state: LoopState): Promise<IterationResult> {
  const iterationStart = Date.now();
  const total = formatDuration(Date.now() - ctx.loopStart);
  log(`loop ${state.loop} (${ctx.provider}) · total ${total}${state.retries > 0 ? ` · retry ${state.retries}/${ctx.maxLoops}` : ""}`);

  const prompt = makePrompt(ctx.target, ctx.checkCmd, state.loop, state.lastFailedOutput, ctx.checkDisabled);
  const gitBaseline = captureIterationGitBaseline(ctx.target, state.loop, ctx.canAutoCommit);

  const stopProvider = startSpinner(`🌀 ${ctx.provider} is working · loop ${state.loop}`);
  try {
    const providerCode = await invokeProvider(ctx.provider, ctx.target, prompt, process.env.RALPH_MODEL);
    if (providerCode !== 0) err(`${ctx.provider} exited with code ${providerCode}`);
  } catch (e) {
    err(`failed to run ${ctx.provider}: ${e instanceof Error ? e.message : e}`);
  }
  stopProvider();

  const autoReview = await runAutoReviewGate(ctx, state, gitBaseline);
  if (!autoReview.approved) return { completed: false, retryable: false };

  const summaryFile = join(ctx.target, ".ralph", "check-summary.txt");
  const checkOut = join(ctx.target, ".ralph", "check-output.txt");

  const stopCheck = startSpinner(
    ctx.checkDisabled ? "verification disabled by --no-check" : `verifying · ${ctx.checkCmd || "no check cmd"}`
  );
  const code = await runCheck(ctx.target, ctx.checkCmd, checkOut, ctx.checkDisabled);
  stopCheck();

  const output = first120Lines(checkOut);
  const iterTime = formatDuration(Date.now() - iterationStart);
  let summary: string;
  if (code === SKIP) {
    summary = "Verification: SKIPPED\n" + output;
    log(`${ctx.checkDisabled ? "verification disabled by --no-check" : "no check command"} · ${iterTime}`);
  } else if (code === 0) {
    summary = "Verification: PASS\n";
    if (ctx.checkCmd) summary += `Command: ${ctx.checkCmd}\n\n`;
    summary += output;
    log(`✅ checks passed · ${iterTime}`);
  } else {
    summary = "Verification: FAIL\n";
    if (ctx.checkCmd) summary += `Command: ${ctx.checkCmd}\n\n`;
    summary += output;
    log(`⚠️ checks failed · ${iterTime}`);
  }

  writeFileSync(summaryFile, summary, { mode: 0o600 });
  updateRunnerBlock(join(ctx.target, "STATUS.md"), summary);

  if (code === 0 || code === SKIP) {
    await autoCommit(ctx.target, state.loop, ctx.canAutoCommit);
    return { completed: true };
  }
  return {
    completed: false,
    retryable: true,
    lastFailedOutput: readFileSync(checkOut, "utf-8"),
  };
}

async function drainTasks(ctx: LoopContext, state: LoopState): Promise<number> {
  while (!allTasksComplete(ctx.target)) {
    state.loop++;
    const result = await runIteration(ctx, state);
    if (result.completed) {
      state.retries = 0;
      state.lastFailedOutput = "";
      continue;
    }
    if (!result.retryable) return 1;
    state.lastFailedOutput = result.lastFailedOutput;
    state.retries++;
    if (state.retries >= ctx.maxLoops) {
      const total = formatDuration(Date.now() - ctx.loopStart);
      err(`⚠️ ${state.retries} consecutive failures on the same task — giving up after ${total}`);
      return 1;
    }
  }
  return 0;
}

export async function mainLoop(
  provider: Provider,
  target: string,
  maxLoops: number,
  maxReviewLoops: number,
  checkCmd: string,
  dryRun: boolean,
  checkDisabled = false
): Promise<number> {
  ensureTemplates(target);

  if (dryRun) {
    log("dry run, not invoking " + provider);
    console.log(makePrompt(target, checkCmd, 1, "", checkDisabled));
    return 0;
  }

  const ctx: LoopContext = {
    provider,
    target,
    maxLoops,
    maxReviewLoops,
    checkCmd,
    checkDisabled,
    canAutoCommit: isGitRepo(target),
    loopStart: Date.now(),
  };
  const state: LoopState = { loop: 0, retries: 0, lastFailedOutput: "" };

  const initialCode = await drainTasks(ctx, state);
  if (initialCode !== 0) return initialCode;

  const total = formatDuration(Date.now() - ctx.loopStart);
  log(`all tasks complete in ${state.loop} loops (${total})`);
  return 0;
}
