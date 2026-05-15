import { invokeProvider, type Provider } from "./providers";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { log, startSpinner } from "./ui";

export const REVIEW_PROMPT = `OK we made it. Now we need to fix it up. Sometimes it's hard to see architecture simplification and optimizations when the branch is in a transitional state. As the dust settles, it becomes easier to spot, notice, and see opportunities for simplifications and alignment, so we need to review for simplification. Now that we are in a situation where the branch movement has settled and things are green, I want you to take a deep breath and then go back and say anything that was good enough. Let's now that it's settled do a full suite re-review of this and figure out: - Are there shape simplicities we can push for? - Shape congruencies we can align? - Type alignments? - Code reductions? - File deletions? - Helper functions deletions? Let's challenge all of these to the point where we can say, "Okay, we have the functionality we want, and it appears like it was designed by a person who doesn't write spaghetti code, who doesn't iterate their way to the solution. Instead it looks like it was mapped all out and designed the most beautiful solution from day one." That's the review I'm sort of looking for.`;

export async function review(
  provider: Provider,
  target: string,
  model?: string
): Promise<number> {
  const stop = startSpinner(`🔎 Reviewing project with ${provider}`);
  try {
    const code = await invokeProvider(provider, target, makeReviewPrompt(target), model);
    if (code === 0) log("✅ Review complete");
    return code;
  } finally {
    stop();
  }
}

function makeReviewPrompt(target: string): string {
  return `${REVIEW_PROMPT}

The project planning artifacts are embedded below. Use these embedded copies instead of reading PRD.md, TASKS.md, or STATUS.md via tool calls.

<PRD>
${readProjectFile(target, "PRD.md")}
</PRD>

<TASKS>
${readProjectFile(target, "TASKS.md")}
</TASKS>

<STATUS>
${readProjectFile(target, "STATUS.md")}
</STATUS>`;
}

function readProjectFile(target: string, filename: string): string {
  try {
    return readFileSync(join(target, filename), "utf-8").trimEnd();
  } catch {
    return `${filename} could not be read.`;
  }
}
