import { readProjectFile } from "./files";

export const MAX_CLARIFYING_QUESTIONS = 5;

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

Rules:
- Be specific and actionable, not vague.
- Keep PRD.md concise. The Technical requirements section should clarify implementation-relevant shape without bloating the PRD: usually 3-7 short bullets; brief pseudocode or examples are okay when they clarify a contract or flow; no code blocks, code-heavy detail, lengthy pseudocode, or low-level minutiae.
- Tasks should be small enough for one AI iteration each.
- Tasks should be flat, no hierarchy, no titles or sections in TASKS.md. Just a simple checklist.
- Look at the existing codebase to inform requirements and constraints.
- Write all three files to the project root directory. Overwrite them completely if they already exist.
- In STATUS.md, keep the decisions/tradeoffs sections so future loop runs have an explicit place to record spec gaps, non-spec decisions, and notable deviations.
- Add requirement that before each step is done, there are test coverage for new changes, and all tests pass.
- Add requirement that after all steps are done, it is properly tested or verified before declaring the work complete.
- Do NOT create any other files.
- NEVER run git write commands (git add, git commit, git push). Only git read commands are permitted (git log, git diff, git show).
`;
}

export function makePrompt(
  target: string,
  checkCmd: string,
  loopNo: number,
  lastAttemptFeedback = "",
  checkDisabled = false
) {
  const prd = readProjectFile(target, "PRD.md");
  const tasks = readProjectFile(target, "TASKS.md");
  const status = readProjectFile(target, "STATUS.md");

  let content = `You are running one iteration of a Ralph loop inside this project.

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
- Check off that one task (- [x]) in TASKS.md.
- Update STATUS.md with what you changed and what the next task should be.
- Keep STATUS.md concrete, short, and truthful.
- Record any implementation notes, spec gaps, decisions, tradeoffs, or notable deviations you had to make in STATUS.md.
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

  if (lastAttemptFeedback.trim()) {
    content += `
Your previous implementation attempt has blocking feedback:

${lastAttemptFeedback.trimEnd()}

Fix the issue before proceeding.
`;
  }

  return content;
}
