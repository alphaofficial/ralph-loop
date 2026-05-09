import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { log, startSpinner } from "./ui";
import { invokeProvider, providerCommand, type Provider } from "./providers";
import { ensureGitExcludes } from "./files";

const QUESTION_PROMPT = (description: string) => `Generate clarifying questions for creating Ralph project planning files.

The user wants to build: ${description}

Look at the existing codebase context if useful, then return only a JSON array of 3 concise, request-specific questions. Do not include markdown, prose, or answers.`;

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
    parsed.length !== 3 ||
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
  const command = providerCommand(provider, target, QUESTION_PROMPT(description), model);
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

const GEN_PROMPT = (description: string, clarifications = "") => `You are generating project files for a Ralph loop.

The user wants to build: ${description}

${clarifications ? `Interactive clarification answers collected by Ralph CLI:
${clarifications}

` : ""}Generate exactly three files. Write each file to disk:

1. PRD.md — Product requirements document with these sections:
   # Goal
   (what done looks like, 1-2 sentences)

   ## Requirements
   (bulleted list of specific requirements)

   ## Constraints
   (bulleted list of constraints — e.g. use existing patterns, keep changes small)

   ## Definition of done
   (bulleted list of success criteria — e.g. tests pass, behavior works)

2. TASKS.md — Ordered checklist of tasks:
   - [ ] task 1
   - [ ] task 2
   (break the work into small, focused tasks — one per iteration)

3. STATUS.md — Initial status:
   # Current status
   Not started.

   # Last attempt
   N/A

   # Known issues
   None.

   # Next step
   (what the first iteration should do)

Rules:
- Be specific and actionable, not vague.
- Tasks should be small enough for one AI iteration each.
- Tasks should be flat, no hierarchy, no titles or sections in TASKS.md. Just a simple checklist.
- Look at the existing codebase to inform requirements and constraints.
- Write all three files to the project root directory. Overwrite them completely if they already exist.
- Add requirement that before each step is done, there are test coverage for new changes, and all tests pass.
- Add requirement that after all steps are done, it is properly tested or verified before declaring the work complete.
- Do NOT create any other files.
- NEVER run git write commands (git add, git commit, git push). Only git read commands are permitted (git log, git diff, git show).
`;

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
  const prompt = GEN_PROMPT(description, clarifications);
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
