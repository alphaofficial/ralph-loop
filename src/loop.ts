import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { log, err, startSpinner, notify } from "./ui";
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

  for (let loop = 1; loop <= maxLoops; loop++) {
    log(`loop ${loop} (${provider}) in ${target}`);

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

    if (code === SKIP) {
      let summary = "Verification: SKIPPED\n";
      summary += output;
      writeFileSync(summaryFile, summary, { mode: 0o600 });
      updateRunnerBlock(join(target, "STATUS.md"), summary);

      if (allTasksComplete(target)) {
        log("all tasks complete (no check command)");
        await notify("Ralph ✓", `All tasks complete after ${loop} loops`);
        return 0;
      }

      log("no check command, but unchecked tasks remain — continuing");
      continue;
    }

    if (code === 0) {
      let summary = "Verification: PASS\n";
      if (checkCmd) summary += `Command: ${checkCmd}\n\n`;
      summary += output;
      writeFileSync(summaryFile, summary, { mode: 0o600 });
      updateRunnerBlock(join(target, "STATUS.md"), summary);

      if (allTasksComplete(target)) {
        log("all tasks complete, checks passed");
        await notify("Ralph ✓", `All tasks complete after ${loop} loops`);
        return 0;
      }

      log("checks passed, but unchecked tasks remain — continuing");
      continue;
    }

    let summary = "Verification: FAIL\n";
    if (checkCmd) summary += `Command: ${checkCmd}\n\n`;
    summary += output;
    writeFileSync(summaryFile, summary);
    updateRunnerBlock(join(target, "STATUS.md"), summary);
    log("checks failed, continuing");
  }

  err("max loops reached");
  await notify("Ralph ✗", `Failed after ${maxLoops} loops`);
  return 1;
}
