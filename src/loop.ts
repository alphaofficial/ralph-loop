import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { log, err, startSpinner, formatDuration } from "./ui";
import { ensureTemplates, updateRunnerBlock } from "./files";
import { invokeProvider, type Provider } from "./providers";

export function makePrompt(
  provider: string,
  target: string,
  checkCmd: string,
  loopNo: number,
  promptFile: string
) {
  const content = `You are running one iteration of a Ralph loop inside this project.

Read these files first:
- PRD.md
- TASKS.md
- STATUS.md

CRITICAL: You must complete exactly ONE unchecked task from TASKS.md, then stop.
Do NOT attempt multiple tasks. Another fresh instance will handle the next task.

Rules:
- Pick the FIRST unchecked task (- [ ]) from TASKS.md.
- Implement that single task only.
- Check off that one task (- [x]) in TASKS.md.
- Update STATUS.md with what you changed and what the next task should be.
- Keep STATUS.md concrete, short, and truthful.
- Do not touch other unchecked tasks.
- Prefer the smallest change that moves the task forward.

Iteration number: ${loopNo}
Verification command after your run: ${checkCmd || "<none auto-detected>"}

Write a one-line commit message describing what you changed to .ralph/commit-msg.txt.
Ensure you follow the project's existing commit message style. Check git log to see examples.

IMPORTANT: NEVER run git write commands (git add, git commit, git push, git stash, git reset, git checkout, git revert). Only git read commands are permitted (git log, git diff, git show, git status, git blame). The ralph runner handles all commits automatically.

If you need to leave notes for the next fresh instance, put them in STATUS.md.
`;
  writeFileSync(promptFile, content, { mode: 0o600 });
}

export const SKIP = Symbol("skip");

export async function runCheck(
  target: string,
  checkCmd: string,
  outFile: string
): Promise<number | typeof SKIP> {
  if (!checkCmd) {
    writeFileSync(outFile, "No verification command detected.\n");
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

async function autoCommit(target: string, loop: number) {
  // Only commit if target is a git repo
  const check = Bun.spawnSync(["git", "-C", target, "rev-parse", "--is-inside-work-tree"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (check.exitCode !== 0) return;

  // Stage all changes
  const add = Bun.spawnSync(["git", "-C", target, "add", "-A"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (add.exitCode !== 0) return;

  // Check if there's anything to commit
  const diff = Bun.spawnSync(["git", "-C", target, "diff", "--cached", "--quiet"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (diff.exitCode === 0) return; // nothing staged

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
  await proc.exited;
  if (proc.exitCode === 0) {
    log(`committed: ${msg}`);
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

export async function mainLoop(
  provider: Provider,
  target: string,
  maxLoops: number,
  checkCmd: string,
  dryRun: boolean
): Promise<number> {
  ensureTemplates(target);

  const loopStart = Date.now();
  let loop = 0;
  let retries = 0;
  let iterationStart: number;
  while (!allTasksComplete(target)) {
    loop++;
    iterationStart = Date.now();
    const total = formatDuration(Date.now() - loopStart);
    log(`loop ${loop} (${provider}) · total ${total}${retries > 0 ? ` · retry ${retries}/${maxLoops}` : ""}`);

    const promptFile = join(target, ".ralph", `prompt-${provider}.txt`);
    makePrompt(provider, target, checkCmd, loop, promptFile);

    if (dryRun) {
      log("dry run, not invoking " + provider);
      console.log(readFileSync(promptFile, "utf-8"));
      return 0;
    }

    const stopProvider = startSpinner(
      `${provider} is working · loop ${loop}`
    );
    try {
      const providerCode = await invokeProvider(
        provider,
        target,
        promptFile,
        process.env.RALPH_MODEL
      );
      if (providerCode !== 0) {
        err(`${provider} exited with code ${providerCode}`);
      }
    } catch (e) {
      err(`failed to run ${provider}: ${e instanceof Error ? e.message : e}`);
    }
    stopProvider();

    const summaryFile = join(target, ".ralph", "check-summary.txt");
    const checkOut = join(target, ".ralph", "check-output.txt");

    const stopCheck = startSpinner(
      `verifying · ${checkCmd || "no check cmd"}`
    );
    const code = await runCheck(target, checkCmd, checkOut);
    stopCheck();

    const output = first120Lines(checkOut);

    const iterTime = formatDuration(Date.now() - iterationStart!);
    let summary: string;
    if (code === SKIP) {
      summary = "Verification: SKIPPED\n" + output;
      log(`no check command · ${iterTime}`);
    } else if (code === 0) {
      summary = "Verification: PASS\n";
      if (checkCmd) summary += `Command: ${checkCmd}\n\n`;
      summary += output;
      log(`checks passed · ${iterTime}`);
    } else {
      summary = "Verification: FAIL\n";
      if (checkCmd) summary += `Command: ${checkCmd}\n\n`;
      summary += output;
      log(`checks failed · ${iterTime}`);
    }

    writeFileSync(summaryFile, summary, { mode: 0o600 });
    updateRunnerBlock(join(target, "STATUS.md"), summary);

    // Only commit when checks pass — failed iterations retry on next loop
    if (code === 0 || code === SKIP) {
      await autoCommit(target, loop);
      retries = 0; // reset on success
    } else {
      retries++;
      if (retries >= maxLoops) {
        const total = formatDuration(Date.now() - loopStart);
        err(`${retries} consecutive failures on the same task — giving up after ${total}`);
        return 1;
      }
    }
  }

  const total = formatDuration(Date.now() - loopStart);
  log(`all tasks complete in ${loop} loops (${total})`);
  return 0;
}
