import { readProjectFile } from "./files";

export const MAX_CLARIFYING_QUESTIONS = 5;

export type ReviewScope = {
  diff: string;
  touchedFiles: string[];
};

export function makeClarifyingQuestionsPrompt(description: string) {
  return `Generate clarifying questions for creating Ralph project planning files.

The user wants to build: ${description}

Look at the existing codebase context, then return only a JSON array of 1 to ${MAX_CLARIFYING_QUESTIONS} concise, request-specific questions. Do not include markdown, prose, or answers.`;
}

export function makeGeneratePrompt(description: string, clarifications = "") {
  return `You are generating project files for a Ralph loop.

The user wants to build: ${description}

${clarifications ? `Interactive clarification answers collected by Ralph CLI:
${clarifications}

` : ""}Generate exactly three files. Write each file to disk:

1. PRD.md — Product requirements document with these sections:
   # Goal
   (what done looks like, 1-2 sentences)

   ## Requirements
   (bulleted list of specific requirements)

   ## Technical requirements
   (usually 3-7 concise bullets covering relevant interfaces/APIs/CLI flags/file formats/events/data contracts, affected modules/systems, high-level implementation strategy, and any integration/migration/compatibility/security/performance constraints; brief pseudocode or examples are okay when they clarify a contract or flow; avoid code-heavy detail, lengthy pseudocode, and low-level minutiae; use a short TBD/open question bullet if uncertain)

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

   # Decisions made
   None yet.

   # Tradeoffs and deviations
   None yet.

   # Known issues
   None.

   # Next step
   (what the first iteration should do)

   <!-- RALPH_REVIEW_FEEDBACK:START -->
   {"status":"approved","changes":[]}
   <!-- RALPH_REVIEW_FEEDBACK:END -->

Rules:
- Be specific and actionable, not vague.
- Keep PRD.md concise. The Technical requirements section should clarify implementation-relevant shape without bloating the PRD: usually 3-7 short bullets; brief pseudocode or examples are okay when they clarify a contract or flow; no code blocks, code-heavy detail, lengthy pseudocode, or low-level minutiae.
- Tasks should be small enough for one AI iteration each.
- Tasks should be flat, no hierarchy, no titles or sections in TASKS.md. Just a simple checklist.
- Look at the existing codebase to inform requirements and constraints.
- Write all three files to the project root directory. Overwrite them completely if they already exist.
- In STATUS.md, keep the decisions/tradeoffs sections so future loop runs have an explicit place to record spec gaps, non-spec decisions, and notable deviations.
- Existing entries under "# Decisions made" and "# Tradeoffs and deviations" are append-only. Do not rewrite those sections; add new information as markdown list items.
- Add requirement that before each step is done, there are test coverage for new changes, and all tests pass.
- Add requirement that after all steps are done, it is properly tested or verified before declaring the work complete.
- Do NOT create any other files.
- NEVER run git write commands (git add, git commit, git push). Only git read commands are permitted (git log, git diff, git show).
`;
}

export function makeLoopPrompt(
  target: string,
  checkCmd: string,
  loopNo: number,
  checkDisabled = false
) {
  const prd = readProjectFile(target, "PRD.md");
  const tasks = readProjectFile(target, "TASKS.md");
  const status = readProjectFile(target, "STATUS.md");

  return `You are running one iteration of a Ralph loop inside this project.

The project planning files are embedded below. Use these embedded copies instead of reading PRD.md, TASKS.md, or STATUS.md via tool calls.

<PRD>
${prd}
</PRD>

<TASKS>
${tasks}
</TASKS>

<STATUS>
${status}
</STATUS>

CRITICAL: You must complete exactly ONE unchecked task from TASKS.md, then stop.
Do NOT attempt multiple tasks. Another fresh instance will handle the next task.

Rules:
- Pick the FIRST unchecked task (- [ ]) from TASKS.md.
- Implement that single task only.
- Inspect the JSON inside the STATUS.md block delimited by "<!-- RALPH_REVIEW_FEEDBACK:START -->" and "<!-- RALPH_REVIEW_FEEDBACK:END -->". If it has "status":"changes_requested", address those requested changes as part of this iteration.
- Do not modify the RALPH_REVIEW_FEEDBACK block in STATUS.md. Ralph manages that block.
- Check off that one task (- [x]) in TASKS.md.
- Update STATUS.md with what you changed and what the next task should be.
- Keep STATUS.md concrete, short, and truthful.
- Record any implementation notes, spec gaps, decisions, tradeoffs, or notable deviations you had to make in STATUS.md.
- Treat "# Decisions made" and "# Tradeoffs and deviations" as append-only logs. Preserve all existing entries exactly. If you add to either section, add only new "- ..." markdown list items below the existing content.
- Do not touch other unchecked tasks.
- If you encounter any code or test issues, fix them and update STATUS.md with what you did to fix them.
- Do not add tests which simply restate the implementation. These provide zero confidence. Avoid spurious tests. 
- Do not leave known issues unfixed before checking off the task.

Iteration number: ${loopNo}
Verification command after your run: ${checkDisabled ? "<disabled by --no-check>" : checkCmd || "<none auto-detected>"}

Write a one-line commit message describing what you changed to .ralph/commit-msg.txt.
Ensure you follow the project's existing commit message style. Use git log to see project commit messsage format and follow it strictly.

IMPORTANT: ensure the generated commit message is concise, specific and no more than 48 charaters.

IMPORTANT: NEVER run git write commands (git add, git commit, git push, git stash, git reset, git checkout, git revert). Only git read commands are permitted (git log, git diff, git show, git status, git blame). The ralph runner handles all commits automatically.

If you need to leave notes for the next fresh instance, put them in STATUS.md.

IMPORTANT: Do not mark the task complete while any tests are failing. All tests must pass first, even if the failures look unrelated or pre-existing.
`;
}

export function makeAutoReviewFeedbackPrompt(
  target: string,
  loop: number,
  scope: ReviewScope
): string {
  return `You are reviewing Ralph loop iteration ${loop}.

Your job is to do an adversarial review of the work completed in this iteration after auto-commit.

Review rules:
- Scope is limited to the project planning context below and the touched files from this iteration.
- Focus on blockers only. Ignore nits, style comments, speculative refactors, and unrelated improvements.
- Check whether the touched-file changes fully satisfy the task and acceptance criteria.
- Check whether the touched-file changes are internally consistent with the surrounding code they directly affect.
- Do not request changes in untouched files. Every requested change must target one of the touched files listed below.
- Look out for implementation correctness in the scoe
- Look out for spurious tests. 
    - we should NEVER assert mock behavior
    - we should NEVER add test-only methods to production classes
    - we should NEVER mock without understanding dependencies
    - we should NEVER write tests for non-application behaviour

Output contract:
- Return ONLY valid JSON.
- Return exactly one compact JSON object and nothing else.
- Do not include Markdown fences, prose outside JSON, comments, headings, code blocks, or trailing text.
- If there are no blocking changes, return: {"status":"approved","changes":[]}
- If there are blocking changes, return: {"status":"changes_requested","changes":[{"file":"relative/path","line":123,"requested_change":"Concrete blocker to fix."}]}

Touched files:
${formatTouchedFiles(scope.touchedFiles)}

Iteration diff:
\`\`\`diff
${scope.diff || "# No iteration diff was captured."}
\`\`\`

Project planning artifacts are embedded below. Use these embedded copies instead of reading PRD.md, TASKS.md, or STATUS.md via tool calls.

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

function formatTouchedFiles(files: string[]): string {
  if (files.length === 0) return "- none captured";
  return files.map((file) => `- ${file}`).join("\n");
}
