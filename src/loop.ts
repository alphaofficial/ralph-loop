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
  const content = `You are running a Ralph loop iteration inside this project.

Read these files first:
- PRD.md
- TASKS.md
- STATUS.md

Rules:
- Do one focused iteration only.
- Make real file changes in the project when useful.
- Update TASKS.md to reflect progress.
- Update STATUS.md with what changed, what failed, and the next best step.
- Keep STATUS.md concrete, short, and truthful.
- Do not claim the task is done unless checks pass.
- Avoid huge refactors unless the PRD requires them.
- Prefer the smallest change that moves the task forward.
- Perform a code review after each iteration and fix any issues found before the next iteration.
- Perform a security review after each iteration and fix any issues found before the next iteration.

Iteration number: ${loopNo}
Verification command after your run: ${checkCmd || "<none auto-detected>"}

If you need to leave notes for the next fresh run, put them in STATUS.md, not in chat.
`;
  writeFileSync(promptFile, content, { mode: 0o600 });
}

export async function runCheck(
  target: string,
  checkCmd: string,
  outFile: string
): Promise<number> {
  if (!checkCmd) {
    writeFileSync(outFile, "No verification command detected.\n");
    return 2;
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

    if (code === 0) {
      let summary = "Verification: PASS\n";
      if (checkCmd) summary += `Command: ${checkCmd}\n\n`;
      summary += output;
      writeFileSync(summaryFile, summary, { mode: 0o600 });
      updateRunnerBlock(join(target, "STATUS.md"), summary);
      log("checks passed");
      await notify("Ralph ✓", `Checks passed on loop ${loop}`);
      return 0;
    }

    if (code === 2) {
      let summary = "Verification: SKIPPED\n";
      if (checkCmd) summary += `Command: ${checkCmd}\n\n`;
      summary += output;
      writeFileSync(summaryFile, summary, { mode: 0o600 });
      updateRunnerBlock(join(target, "STATUS.md"), summary);
      log("no check command detected, stopping after one loop");
      await notify("Ralph", "Completed 1 loop (no check command)");
      return 0;
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
