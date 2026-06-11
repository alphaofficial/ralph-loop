import { captureProvider, type Provider } from "./providers";
import { join } from "node:path";
import { updateReviewFeedbackBlock } from "./files";
import {
  makeAutoReviewFeedbackPrompt,
  type ReviewScope,
} from "./prompts";
import { err, log, startSpinner } from "./ui";

export async function runAutoReviewFeedback(
  provider: Provider,
  target: string,
  loop: number,
  scope: ReviewScope,
  model?: string
): Promise<boolean> {
  const stop = startSpinner(`🔎 auto reviewing loop ${loop}`);
  try {
    const result = await captureProvider(
      provider,
      target,
      makeAutoReviewFeedbackPrompt(target, loop, scope),
      model
    );
    if (result.code !== 0) {
      err(`${provider} auto review exited with code ${result.code}`);
      return failAutoReview(
        target,
        JSON.stringify({
          status: "unavailable",
          reason: `reviewer exited with code ${result.code}`,
        })
      );
    }

    const output = result.stdout.trim();
    if (!output) {
      return failAutoReview(
        target,
        JSON.stringify({ status: "unavailable", reason: "empty review output" })
      );
    }

    writeReviewFeedbackStatus(target, output);
    log("📝 auto review feedback written to STATUS.md");
    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    err(`auto review failed: ${message}`);
    return failAutoReview(
      target,
      JSON.stringify({ status: "unavailable", reason: message })
    );
  } finally {
    stop();
  }
}

function failAutoReview(target: string, feedback: string): boolean {
  if (revertLastCommit(target)) {
    log("reverted commit after failed auto review");
  }
  writeReviewFeedbackStatus(target, feedback);
  return false;
}

function writeReviewFeedbackStatus(target: string, feedback: string) {
  updateReviewFeedbackBlock(join(target, "STATUS.md"), feedback);
}

function revertLastCommit(target: string): boolean {
  const proc = Bun.spawnSync(["git", "reset", "--hard", "HEAD^"], {
    cwd: target,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode === 0) return true;

  const output = commandOutput(proc);
  err(`failed to revert commit${output ? `: ${output}` : ""}`);
  return false;
}

export function lastCommitReviewScope(target: string): ReviewScope {
  const head = gitOutput(target, ["rev-parse", "--verify", "HEAD"]);
  if (!head) return { diff: "", touchedFiles: [] };

  const hasParent = !!gitOutput(target, ["rev-parse", "--verify", "HEAD^"]);
  const diffArgs = hasParent
    ? ["diff", "--no-ext-diff", "--binary", "HEAD^", "HEAD"]
    : ["show", "--format=", "--no-ext-diff", "--binary", "--root", "HEAD"];
  const filesArgs = hasParent
    ? ["diff", "--name-only", "HEAD^", "HEAD"]
    : ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "HEAD"];

  return {
    diff: gitOutput(target, diffArgs) ?? "",
    touchedFiles: gitOutput(target, filesArgs)?.split("\n").filter(Boolean) ?? [],
  };
}

function gitOutput(target: string, args: string[]): string | null {
  try {
    const proc = Bun.spawnSync(["git", ...args], {
      cwd: target,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return null;
    const output = new TextDecoder().decode(proc.stdout).trim();
    return output || null;
  } catch {
    return null;
  }
}

function commandOutput(proc: { stdout?: Uint8Array; stderr?: Uint8Array }): string {
  const decoder = new TextDecoder();
  return [proc.stderr, proc.stdout]
    .filter((output): output is Uint8Array => !!output && output.length > 0)
    .map((output) => decoder.decode(output).trim())
    .filter(Boolean)
    .join("\n");
}
