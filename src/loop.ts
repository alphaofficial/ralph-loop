import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { log, err, startSpinner, formatDuration } from "./ui";
import { ensureTemplates, updateRunnerBlock } from "./files";
import {
  captureReviewScopeBaseline,
  type ReviewScopeBaseline,
} from "./review-scope";
import { createMachine } from "./state-machine";
import { invokeProvider, type Provider } from "./providers";
import { makePrompt } from "./prompt";
import {
  SKIP,
  allTasksComplete,
  autoCommit,
  isGitRepo,
  readCheckOutputSummary,
  runCheck,
} from "./helpers";
import { runAutoReviewGate } from "./auto-review-gate";

type LoopRuntime = {
  provider: Provider;
  target: string;
  maxLoops: number;
  maxReviewLoops: number;
  checkCmd: string;
  checkDisabled: boolean;
  canAutoCommit: boolean;
  loopStart: number;
};

type LoopProgress = {
  loop: number;
  retries: number;
  lastFailedOutput: string;
};

const loopFlow = {
  initialState: "run_provider",
  states: {
    run_provider: { provider_finished: "auto_review" },
    auto_review: { review_approved: "verify", review_failed: "failed" },
    verify: { verification_passed: "commit", verification_failed: "retry_task" },
    commit: { commit_finished: "completed" },
    completed: {},
    retry_task: {},
    failed: {},
  },
} as const;

async function runProviderAttempt(runtime: LoopRuntime, progress: LoopProgress): Promise<void> {
  const total = formatDuration(Date.now() - runtime.loopStart);
  log(`loop ${progress.loop} (${runtime.provider}) · total ${total}${progress.retries > 0 ? ` · retry ${progress.retries}/${runtime.maxLoops}` : ""}`);

  const prompt = makePrompt(runtime.target, runtime.checkCmd, progress.loop, progress.lastFailedOutput, runtime.checkDisabled);
  const stopProvider = startSpinner(`🌀 ${runtime.provider} is working · loop ${progress.loop}`);
  try {
    const providerCode = await invokeProvider(runtime.provider, runtime.target, prompt, process.env.RALPH_MODEL);
    if (providerCode !== 0) err(`${runtime.provider} exited with code ${providerCode}`);
  } catch (e) {
    err(`failed to run ${runtime.provider}: ${e instanceof Error ? e.message : e}`);
  }
  stopProvider();
}

async function runVerification(
  runtime: LoopRuntime,
  iterationStart: number
) {
  const summaryFile = join(runtime.target, ".ralph", "check-summary.txt");
  const checkOut = join(runtime.target, ".ralph", "check-output.txt");

  const stopCheck = startSpinner(
    runtime.checkDisabled ? "verification disabled by --no-check" : `verifying · ${runtime.checkCmd || "no check cmd"}`
  );
  const code = await runCheck(runtime.target, runtime.checkCmd, checkOut, runtime.checkDisabled);
  stopCheck();

  const output = readCheckOutputSummary(checkOut);
  const iterTime = formatDuration(Date.now() - iterationStart);
  let summary: string;
  if (code === SKIP) {
    summary = "Verification: SKIPPED\n" + output;
    log(`${runtime.checkDisabled ? "verification disabled by --no-check" : "no check command"} · ${iterTime}`);
  } else if (code === 0) {
    summary = "Verification: PASS\n";
    if (runtime.checkCmd) summary += `Command: ${runtime.checkCmd}\n\n`;
    summary += output;
    log(`✅ checks passed · ${iterTime}`);
  } else {
    summary = "Verification: FAIL\n";
    if (runtime.checkCmd) summary += `Command: ${runtime.checkCmd}\n\n`;
    summary += output;
    log(`⚠️ checks failed · ${iterTime}`);
  }

  writeFileSync(summaryFile, summary, { mode: 0o600 });
  updateRunnerBlock(join(runtime.target, "STATUS.md"), summary);

  if (code === 0 || code === SKIP) {
    return { event: "verification_passed" } as const;
  }
  return {
    event: "verification_failed",
    retryFeedback: readFileSync(checkOut, "utf-8"),
  } as const;
}

async function runIteration(runtime: LoopRuntime, progress: LoopProgress) {
  const iterationStart = Date.now();
  const machine = createMachine(loopFlow);
  let reviewScopeBaseline: ReviewScopeBaseline | null = null;
  let retryFeedback = "";

  while (true) {
    switch (machine.value) {
      case "run_provider": {
        reviewScopeBaseline = captureReviewScopeBaseline(
          runtime.target,
          progress.loop,
          runtime.canAutoCommit
        );
        await runProviderAttempt(runtime, progress);
        machine.transition("provider_finished");
        break;
      }

      case "auto_review": {
        const event = await runAutoReviewGate(runtime, progress, reviewScopeBaseline);
        machine.transition(event);
        break;
      }

      case "verify": {
        const result = await runVerification(runtime, iterationStart);
        if (result.event === "verification_failed") {
          retryFeedback = result.retryFeedback;
        }
        machine.transition(result.event);
        break;
      }

      case "commit":
        await autoCommit(runtime.target, progress.loop, runtime.canAutoCommit);
        machine.transition("commit_finished");
        break;

      case "completed":
        return { state: "completed" } as const;

      case "retry_task":
        return { state: "retry_task", retryFeedback } as const;

      case "failed":
        return { state: "failed" } as const;
    }
  }
}

async function drainTasks(runtime: LoopRuntime, progress: LoopProgress): Promise<number> {
  while (!allTasksComplete(runtime.target)) {
    progress.loop++;
    const result = await runIteration(runtime, progress);
    if (result.state === "completed") {
      progress.retries = 0;
      progress.lastFailedOutput = "";
      continue;
    }
    if (result.state === "failed") return 1;
    progress.lastFailedOutput = result.retryFeedback;
    progress.retries++;
    if (progress.retries >= runtime.maxLoops) {
      const total = formatDuration(Date.now() - runtime.loopStart);
      err(`⚠️ ${progress.retries} consecutive failures on the same task — giving up after ${total}`);
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

  const runtime: LoopRuntime = {
    provider,
    target,
    maxLoops,
    maxReviewLoops,
    checkCmd,
    checkDisabled,
    canAutoCommit: isGitRepo(target),
    loopStart: Date.now(),
  };
  const progress: LoopProgress = { loop: 0, retries: 0, lastFailedOutput: "" };

  const initialCode = await drainTasks(runtime, progress);
  if (initialCode !== 0) return initialCode;

  const total = formatDuration(Date.now() - runtime.loopStart);
  log(`all tasks complete in ${progress.loop} loops (${total})`);
  return 0;
}
