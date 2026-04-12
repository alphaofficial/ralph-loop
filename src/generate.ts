import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { log, startSpinner } from "./ui";
import { invokeProvider, type Provider } from "./providers";
import { ensureGitExcludes } from "./files";

const GEN_PROMPT = (description: string) => `You are generating project files for a Ralph loop.

The user wants to build: ${description}

Generate exactly three files. Write each file to disk:

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
- Look at the existing codebase to inform requirements and constraints.
- Write all three files to the project root directory.
- Add requirement that before each step is done, there are test coverage for new changes, and all tests pass.
- Add requirement that after all steps are done, it is properly tested or verified before declaring the work complete.
- Do NOT create any other files.
`;

export async function generate(
  provider: Provider,
  target: string,
  description: string,
  model?: string
): Promise<void> {
  mkdirSync(join(target, ".ralph"), { recursive: true, mode: 0o700 });
  ensureGitExcludes(target);

  const promptFile = join(target, ".ralph", "prompt-gen.txt");
  writeFileSync(promptFile, GEN_PROMPT(description), { mode: 0o600 });

  const stop = startSpinner(`generating project files with ${provider}`);
  try {
    const code = await invokeProvider(provider, target, promptFile, model);
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

  log("generated PRD.md, TASKS.md, STATUS.md");
}
