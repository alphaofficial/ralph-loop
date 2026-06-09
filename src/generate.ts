import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { log, startSpinner } from "./ui";
import { invokeProvider, type Provider } from "./providers";
import { ensureGitExcludes, ensureTemplates } from "./files";
import { collectClarifications, generateClarifyingQuestions } from "./clarifications";
import { makeGeneratePrompt } from "./prompts";

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

  ensureTemplates(target);

  log("✅ Generated PRD.md, TASKS.md, STATUS.md");
}
