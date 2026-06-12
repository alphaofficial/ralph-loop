import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { log, startSpinner } from "./ui";
import { invokeProvider, providerCommand, type Provider } from "./providers";
import { ensureGitExcludes } from "./files";
import {
  MAX_CLARIFYING_QUESTIONS,
  makeClarifyingQuestionsPrompt,
  makeGeneratePrompt,
} from "./prompts";

export function parseQuestions(output: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw new Error("Provider did not return a JSON array of clarifying questions");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Provider did not return a JSON array of clarifying questions");
  }

  if (
    parsed.length < 1 ||
    parsed.length > MAX_CLARIFYING_QUESTIONS ||
    parsed.some((question) => typeof question !== "string" || question.trim().length === 0)
  ) {
    throw new Error("Provider returned invalid clarifying questions");
  }

  return parsed.map((question) => question.trim());
}

async function generateClarifyingQuestions(
  provider: Provider,
  target: string,
  description: string,
  model?: string
): Promise<string[]> {
  const command = providerCommand(provider, target, makeClarifyingQuestionsPrompt(description), model);
  const proc = Bun.spawn(command.args, {
    cwd: target,
    env: command.env,
    stdin: command.stdin,
    stdout: "pipe",
    stderr: "inherit",
  });

  const output = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${provider} exited with code ${code} while generating clarifying questions`);
  }

  return parseQuestions(output);
}

async function collectClarifications(questions: readonly string[]): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function readLine(): Promise<string> {
    while (!buffer.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }

    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex === -1) {
      const line = buffer;
      buffer = "";
      return line;
    }

    const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
    buffer = buffer.slice(newlineIndex + 1);
    return line;
  }

  try {
    const entries: string[] = [];
    for (const question of questions) {
      console.log(question);
      const answer = (await readLine()).trim() || "No answer provided.";
      entries.push(`${question}\n${answer}`);
    }
    return entries.join("\n\n");
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function generate(
  provider: Provider,
  target: string,
  description: string,
  model?: string,
  interactive = false
): Promise<void> {
  mkdirSync(join(target, ".ralph"), { recursive: true, mode: 0o700 });
  ensureGitExcludes(target);

  const clarifications = interactive
    ? await collectClarifications(await generateClarifyingQuestions(provider, target, description, model))
    : "";
  const promptFile = join(target, ".ralph", "prompt-gen.txt");
  const prompt = makeGeneratePrompt(description, clarifications);
  writeFileSync(promptFile, prompt, { mode: 0o600 });

  const stop = startSpinner(`🌀 Generating project files with ${provider}`);
  try {
    const code = await invokeProvider(provider, target, prompt, model, interactive);
    if (code !== 0) {
      throw new Error(`${provider} exited with code ${code}`);
    }
  } finally {
    stop();
  }

  // Verify files were created
  const files = ["PRD.md", "TASKS.md", "STATUS.md"];
  for (const file of files) {
    try {
      readFileSync(join(target, file));
    } catch {
      throw new Error(`${provider} did not create ${file}`);
    }
  }

  log("✅ Generated PRD.md, TASKS.md, STATUS.md");
}
