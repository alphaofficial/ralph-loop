import { captureProvider, invokeProvider, type Provider } from "./providers";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readProjectFile } from "./files";
import { log, startSpinner } from "./ui";

export const REVIEW_PROMPT = `OK we made it. Now we need to fix it up. Sometimes it's hard to see architecture simplification and optimizations when the branch is in a transitional state. As the dust settles, it becomes easier to spot, notice, and see opportunities for simplifications and alignment, so we need to review for simplification. Now that we are in a situation where the branch movement has settled and things are green, I want you to take a deep breath and then go back and say anything that was good enough. Let's now that it's settled do a full suite re-review of this and figure out: - Are there shape simplicities we can push for? - Shape congruencies we can align? - Type alignments? - Code reductions? - File deletions? - Helper functions deletions? Let's challenge all of these to the point where we can say, "Okay, we have the functionality we want, and it appears like it was designed by a person who doesn't write spaghetti code, who doesn't iterate their way to the solution. Instead it looks like it was mapped all out and designed the most beautiful solution from day one." That's the review I'm sort of looking for.

Check the implementation against the PRD, TASKS, and STATUS context. Call out deviations from the plan or requirements and say whether they look like justified improvements or risky departures.

While reviewing, look for:
- missing or incomplete functionality
- edge cases or error handling gaps
- security, performance, or scalability concerns
- type or contract mismatches
- test gaps, especially where tests miss real behavior
- backward-compatibility, migration, or documentation gaps when relevant

Categorize findings by actual severity instead of treating everything as equally urgent.
Include a short strengths section before issues.
Use concrete file references when possible.
For each important issue, explain what is wrong, why it matters, and what should change.
End with a clear readiness assessment.`;

const REVIEW_TASK_CONTRACT = `If you identify concrete follow-up implementation tasks, include them exactly in this format:
<RALPH_REVIEW_TASKS>
- [ ] Task description
</RALPH_REVIEW_TASKS>
Only include unchecked top-level markdown task bullets in that block.`;

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

export async function runCapturedReview(
  provider: Provider,
  target: string,
  model?: string
): Promise<number> {
  const stop = startSpinner(`🔎 Reviewing project with ${provider}`);
  try {
    const result = await captureProvider(provider, target, makeReviewPrompt(target), model);
    const stdout = sanitizeReviewOutput(result.stdout);
    const raw = stdout + (result.stderr ? `\n${result.stderr}` : "");
    const outputPath = join(target, ".ralph", "review-output.md");
    mkdirSync(join(target, ".ralph"), { recursive: true });
    writeFileSync(outputPath, raw, { mode: 0o600 });

    if (result.code === 0) {
      const appended = appendReviewFollowups(target, parseReviewTasks(stdout));
      log("✅ Review complete");
      log(`📄 Saved review output to ${outputPath}`);
      if (appended > 0) {
        log(`📝 Added ${appended} review follow-up task${appended === 1 ? "" : "s"}`);
      }
    }

    return result.code;
  } finally {
    stop();
  }
}

export function sanitizeReviewOutput(output: string): string {
  const normalized = normalizeReviewTaskBlockFormatting(output);
  const lastReviewTaskEnd = normalized.lastIndexOf("</RALPH_REVIEW_TASKS>");
  if (lastReviewTaskEnd === -1) return normalized;
  return `${normalized.slice(0, lastReviewTaskEnd + "</RALPH_REVIEW_TASKS>".length).trimEnd()}\n`;
}

export function normalizeReviewTaskBlockFormatting(output: string): string {
  return output
    .replace(/<RALPH_REVIEW_TASKS>([^\n])/g, "<RALPH_REVIEW_TASKS>\n$1")
    .replace(/([^\n])\s*<\/RALPH_REVIEW_TASKS>/g, "$1\n</RALPH_REVIEW_TASKS>")
    .replace(
      /(<RALPH_REVIEW_TASKS>\n[\s\S]*?\n<\/RALPH_REVIEW_TASKS>)/g,
      (block) => block.replace(/^(\s*)\[ \] /gm, "$1- [ ] ")
    );
}

export function parseReviewTasks(output: string): string[] {
  const seen = new Set<string>();
  const tasks: string[] = [];
  for (const match of output.matchAll(/<RALPH_REVIEW_TASKS>\s*([\s\S]*?)\s*<\/RALPH_REVIEW_TASKS>/g)) {
    for (const line of match[1].split("\n")) {
      const task = line.match(/^- \[ \] (\S.*)$/)?.[1]?.replace(/\s*<\/RALPH_REVIEW_TASKS>\s*$/, "").trim();
      if (task && !seen.has(task)) {
        seen.add(task);
        tasks.push(task);
      }
    }
  }
  return tasks;
}

export function appendReviewFollowups(target: string, tasks: string[]): number {
  if (tasks.length === 0) return 0;
  const file = join(target, "TASKS.md");
  const content = readFileSync(file, "utf-8");
  const existing = new Set(
    content.split("\n").map((line) => line.match(/^- \[[ x]\] (\S.*)$/)?.[1]?.trim()).filter(Boolean)
  );
  const unique = tasks.filter((task) => {
    if (existing.has(task)) return false;
    existing.add(task);
    return true;
  });
  if (unique.length === 0) return 0;

  const trimmed = content.trimEnd();
  const base = trimmed.includes("## Review follow-ups")
    ? trimmed.replace(/## Review follow-ups\n(?!\n)/, "## Review follow-ups\n\n")
    : `${trimmed}\n\n## Review follow-ups\n`;
  const appended = unique.map((task) => `- [ ] ${task}`).join("\n");
  writeFileSync(file, `${base}\n${appended}\n`);
  return unique.length;
}

function makeReviewPrompt(target: string): string {
  return `${REVIEW_PROMPT}

${REVIEW_TASK_CONTRACT}

${makeGitRangeSection(target)}

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

function makeGitRangeSection(target: string): string {
  const range = gitRangeToReview(target);
  if (!range) return "";
  const { base, head } = range;
  return `## Git Range to Review

**Base:** ${base}
**Head:** ${head}

\`\`\`bash
git diff --stat ${base}..${head}
git diff ${base}..${head}
\`\`\`
`;
}

function gitRangeToReview(target: string): { base: string; head: string } | null {
  const head = gitOutput(target, ["rev-parse", "HEAD"]);
  if (!head) return null;

  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    const refSha = gitOutput(target, ["rev-parse", "--verify", ref]);
    if (!refSha || refSha === head) continue;
    const base = gitOutput(target, ["merge-base", "HEAD", ref]);
    if (base && base !== head) return { base, head };
  }

  const root = gitOutput(target, ["rev-list", "--max-parents=0", "HEAD"])?.split("\n")[0]?.trim();
  if (root && root !== head) return { base: root, head };

  return null;
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
