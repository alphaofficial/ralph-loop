import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  cleanupAutoReviewArtifacts,
  combineOutput,
  formatAutoReviewFeedback,
  isAutoReviewApproved,
  parseAutoReviewResult,
  type AutoReviewResult,
  writeAutoReviewOutputArtifact,
  writeAutoReviewResultArtifact,
  writeAutoReviewSummary,
} from "./helpers";
import {
  captureReviewScope,
  type ReviewScopeBaseline,
} from "./review-scope";
import { makeAutoReviewPrompt, makeLoopPrompt } from "./prompts";
import { invokeProvider, type Provider } from "./providers";
import { err, log, startSpinner } from "./ui";

export type AutoReviewGateConfig = {
  provider: Provider;
  target: string;
  maxReviewLoops: number;
  checkCmd: string;
  checkDisabled: boolean;
};

export type AutoReviewGateProgress = {
  loop: number;
};

type AutoReviewGateDeps = {
  captureAutoReviewProviderFn?: typeof captureAutoReviewProvider;
  invokeProviderFn?: typeof invokeProvider;
  captureReviewScopeFn?: typeof captureReviewScope;
  logFn?: typeof log;
  errFn?: typeof err;
  startSpinnerFn?: typeof startSpinner;
};

function autoReviewOutputSchemaPath(target: string): string {
  return join(target, ".ralph", "auto-review-output-schema.json");
}

function readAutoReviewOutputSchema(target: string): string {
  return readFileSync(autoReviewOutputSchemaPath(target), "utf-8");
}

export async function runAutoReviewGate(
  config: AutoReviewGateConfig,
  progress: AutoReviewGateProgress,
  reviewScopeBaseline: ReviewScopeBaseline | null,
  deps: AutoReviewGateDeps = {}
): Promise<"review_approved" | "review_failed"> {
  const captureAutoReviewProviderFn =
    deps.captureAutoReviewProviderFn ?? captureAutoReviewProvider;
  const invokeProviderFn = deps.invokeProviderFn ?? invokeProvider;
  const captureReviewScopeFn =
    deps.captureReviewScopeFn ?? captureReviewScope;
  const logFn = deps.logFn ?? log;
  const errFn = deps.errFn ?? err;
  const startSpinnerFn = deps.startSpinnerFn ?? startSpinner;

  if (!reviewScopeBaseline) {
    logFn("auto-review skipped · review scope unavailable");
    return "review_approved";
  }

  const debugArtifactPaths: string[] = [];

  for (let attempt = 1; attempt <= config.maxReviewLoops; attempt++) {
    const reviewScope = captureReviewScopeFn(config.target, reviewScopeBaseline);

    const reviewPrompt = makeAutoReviewPrompt(config.target, progress.loop, reviewScope);
    const stopReview = startSpinnerFn(
      `🔎 auto-review · attempt ${attempt}/${config.maxReviewLoops}`
    );
    let reviewOutput = "";
    let reviewDiagnosticOutput = "";
    let reviewResult: AutoReviewResult;
    try {
      const captured = await captureAutoReviewProviderFn(
        config.provider,
        config.target,
        reviewPrompt,
        process.env.RALPH_MODEL
      );
      reviewDiagnosticOutput = combineOutput(captured.stdout, captured.stderr);
      reviewOutput = captured.stdout.trim()
        ? captured.stdout
        : reviewDiagnosticOutput;
      reviewResult = parseAutoReviewResult(reviewOutput);
      if (captured.code !== 0) {
        errFn(`${config.provider} auto-review exited with code ${captured.code}`);
      }
    } catch (e) {
      stopReview();
      const summary = `Auto-review: FAIL
Reason: failed to run reviewer: ${e instanceof Error ? e.message : e}`;
      writeAutoReviewSummary(config.target, progress.loop, summary, true);
      errFn(summary);
      return "review_failed";
    }
    stopReview();

    if (isAutoReviewApproved(reviewResult)) {
      cleanupAutoReviewArtifacts(debugArtifactPaths);
      const summary = `Auto-review: PASS
Attempts: ${attempt}/${config.maxReviewLoops}`;
      writeAutoReviewSummary(config.target, progress.loop, summary);
      logFn(`✅ auto-review approved · attempt ${attempt}/${config.maxReviewLoops}`);
      return "review_approved";
    }

    if (reviewResult.status === "invalid") {
      const outputArtifact = writeAutoReviewOutputArtifact(
        config.target,
        progress.loop,
        attempt,
        reviewDiagnosticOutput
      );
      debugArtifactPaths.push(outputArtifact);
      debugArtifactPaths.push(
        writeAutoReviewResultArtifact(config.target, progress.loop, attempt, reviewResult)
      );
      const summary = `Auto-review: FAIL
Reason: invalid reviewer output (${reviewResult.reason})
Message: ${reviewResult.message}
Artifact: .ralph/iteration-${progress.loop}-auto-review-${attempt}-output.txt`;
      writeAutoReviewSummary(config.target, progress.loop, summary, true);
      errFn(`auto-review blocked · invalid reviewer output (${reviewResult.reason})`);
      return "review_failed";
    }

    uncheckCurrentTask(config.target);

    if (attempt >= config.maxReviewLoops) {
      debugArtifactPaths.push(
        writeAutoReviewResultArtifact(config.target, progress.loop, attempt, reviewResult)
      );
      const summary = `Auto-review: FAIL
Reason: exhausted review loop after ${config.maxReviewLoops} attempts
Artifact: .ralph/iteration-${progress.loop}-auto-review-${attempt}-result.json`;
      writeAutoReviewSummary(config.target, progress.loop, summary, true);
      errFn(`auto-review blocked · exhausted after ${config.maxReviewLoops} attempts`);
      return "review_failed";
    }

    logFn(
      `auto-review requested ${reviewResult.changes.length} blocker${reviewResult.changes.length === 1 ? "" : "s"}`
    );
    const retryPrompt = makeLoopPrompt(
      config.target,
      config.checkCmd,
      progress.loop,
      formatAutoReviewFeedback(reviewResult),
      config.checkDisabled
    );

    const stopFix = startSpinnerFn(
      `🛠️ ${config.provider} is addressing auto-review blockers · pass ${attempt}/${config.maxReviewLoops - 1}`
    );
    try {
      const providerCode = await invokeProviderFn(
        config.provider,
        config.target,
        retryPrompt,
        process.env.RALPH_MODEL
      );
      if (providerCode !== 0) errFn(`${config.provider} exited with code ${providerCode}`);
    } catch (e) {
      errFn(`failed to run ${config.provider}: ${e instanceof Error ? e.message : e}`);
    }
    stopFix();
  }

  return "review_failed";
}

function uncheckCurrentTask(target: string) {
  const tasksFile = join(target, "TASKS.md");
  let tasks: string;
  try {
    tasks = readFileSync(tasksFile, "utf-8");
  } catch {
    return;
  }

  const lines = tasks.split("\n");
  const taskLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^- \[[ x]\] /.test(line));
  const currentTask = taskLines
    .toReversed()
    .find(({ line }) => line.startsWith("- [x] "));
  if (!currentTask) return;

  lines[currentTask.index] = currentTask.line.replace("- [x] ", "- [ ] ");
  writeFileSync(tasksFile, lines.join("\n"));
}

export async function captureAutoReviewProvider(
  provider: Provider,
  target: string,
  prompt: string,
  model?: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (provider === "codex") {
    return captureCodexAutoReviewProvider(target, prompt, model);
  }

  const command = autoReviewProviderCommand(provider, target, prompt, model);
  const proc = Bun.spawn(command.args, {
    cwd: target,
    env: command.env,
    stdin: command.stdin,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    code,
    stdout: normalizeAutoReviewProviderStdout(provider, stdout),
    stderr,
  };
}

function autoReviewProviderCommand(
  provider: Provider,
  target: string,
  prompt: string,
  model?: string
): {
  args: string[];
  stdin?: Blob;
  env?: Record<string, string | undefined>;
} {
  switch (provider) {
    case "claude": {
      const args = [
        providerBinary("claude"),
        "-p",
        "--dangerously-skip-permissions",
        "--add-dir",
        target,
        "--output-format",
        "json",
        "--json-schema",
        readAutoReviewOutputSchema(target),
      ];
      if (model) args.push("--model", model);
      return { args, stdin: new Blob([prompt]), env: { ...process.env } };
    }

    case "codex": {
      throw new Error("codex auto-review capture must use captureCodexAutoReviewProvider");
    }

    case "opencode": {
      const args = [
        providerBinary("opencode"),
        "run",
        "--dangerously-skip-permissions",
        "--format",
        "json",
      ];
      if (model) args.push("--model", model);
      args.push(prompt);
      return { args };
    }

    case "copilot": {
      const args = [providerBinary("copilot"), "-p", prompt, "--allow-all", "-s"];
      if (model) args.push("--model", model);
      return { args };
    }

    case "gemini": {
      const args = [providerBinary("gemini"), "-p", prompt, "--output-format", "json"];
      if (model) args.push("--model", model);
      return { args };
    }

    case "hermes": {
      const args = [providerBinary("hermes"), "--oneshot", prompt];
      if (model) args.push("--model", model);
      return { args };
    }

    case "pi": {
      const args = [providerBinary("pi"), "-p", prompt, "--no-session"];
      if (model) args.push("--model", model);
      return { args };
    }
  }
}

async function captureCodexAutoReviewProvider(
  target: string,
  prompt: string,
  model: string | undefined
): Promise<{ code: number; stdout: string; stderr: string }> {
  const artifactDir = join(target, ".ralph");
  mkdirSync(artifactDir, { recursive: true, mode: 0o700 });

  const artifactBase = join(
    artifactDir,
    `auto-review-provider-${process.pid}-${Date.now()}`
  );
  const outputLastMessageFile = `${artifactBase}-last-message.json`;
  const outputSchemaFile = autoReviewOutputSchemaPath(target);

  const args = [
    providerBinary("codex"),
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "--output-schema",
    outputSchemaFile,
    "--output-last-message",
    outputLastMessageFile,
  ];
  if (model) args.push("--model", model);
  args.push(prompt);

  const proc = Bun.spawn(args, {
    cwd: target,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [terminalStdout, terminalStderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  let finalMessage = "";
  try {
    finalMessage = readFileSync(outputLastMessageFile, "utf-8");
  } catch {
    finalMessage = "";
  }

  rmSync(outputLastMessageFile, { force: true });

  if (finalMessage) {
    return { code, stdout: finalMessage, stderr: "" };
  }
  return { code, stdout: terminalStdout, stderr: terminalStderr };
}

function providerBinary(provider: Provider): string {
  const envName = `RALPH_${provider.toUpperCase()}_BIN`;
  return process.env[envName] ?? provider;
}

function normalizeAutoReviewProviderStdout(provider: Provider, stdout: string): string {
  switch (provider) {
    case "claude":
      return extractClaudeAutoReviewOutput(stdout);
    case "gemini":
      return extractGeminiAutoReviewOutput(stdout);
    case "opencode":
      return extractOpencodeAutoReviewOutput(stdout);
    default:
      return stdout;
  }
}

function extractClaudeAutoReviewOutput(stdout: string): string {
  const parsed = parseJsonObject(stdout);
  if (!parsed) return stdout;

  if ("structured_output" in parsed && parsed.structured_output !== undefined) {
    return JSON.stringify(parsed.structured_output);
  }
  if (typeof parsed.result === "string") return parsed.result;
  return stdout;
}

function extractGeminiAutoReviewOutput(stdout: string): string {
  const parsed = parseJsonObject(stdout);
  if (!parsed) return stdout;

  if (typeof parsed.response === "string") return parsed.response;
  return stdout;
}

function extractOpencodeAutoReviewOutput(stdout: string): string {
  const textParts: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parseJsonObject(line);
    if (
      parsed?.type === "text" &&
      parsed.part &&
      typeof parsed.part === "object" &&
      !Array.isArray(parsed.part) &&
      typeof (parsed.part as Record<string, unknown>).text === "string"
    ) {
      textParts.push((parsed.part as Record<string, string>).text);
    }
  }

  return textParts.length > 0 ? textParts.join("") : stdout;
}

function parseJsonObject(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
