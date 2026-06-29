import { readProjectFile } from "./files";
import { extractGoalSection } from "./files";
import type { CurrentTask } from "./task-state";

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

1. PRD.md - Product requirements document and implementation contract.
   PRD.md is the source of truth for the entire implementation. It must be detailed enough that future providers implement from the spec only, without inventing product behavior, architecture, files, dependencies, abstractions, or tests.

   Use exactly these sections:
   # Goal
   (what done looks like, 1-2 sentences)

   ## Requirements
   (bulleted list of specific requirements)

   ## Implementation details
   (full technical requirements: exact implementation approach, affected modules, interfaces/APIs/CLI flags/file formats/events/data contracts, file-level responsibilities, error handling, compatibility/security/performance constraints, integration/migration notes, and any required pseudocode or examples)

   ## Files to touch
   (complete implementation allowlist for the whole change, formatted as a nested Markdown list; directory rows end with /).
   Example:
   - src/
     - feature.ts
     - existing.ts
   - README.md


   ## Test cases
   (bulleted list of all required tests or verification checks for the whole change)

   ## Guardrails
   (strict rules providers must follow)

   ## Constraints
   (bulleted list of constraints — e.g. use existing patterns, keep changes small)

   ## Definition of done
   (bulleted list of success criteria — e.g. tests pass, behavior works)

2. TASKS.md - Ordered checklist of tasks.
   Each task must use this format with comma-separated Files and Test Cases:

   - [ ] Task description.
     - Files: path/to/file.ts M, path/to/new-file.ts C
     - Expectation: One concise completion expectation aligned to PRD.md.
     - Test Cases: comma separated list of tests or verification checks for this task. Each entry should be derived from or traceable to PRD.md ## Test cases, but it may be narrower or more specific to the current iteration; it does not need to exactly match PRD test-case wording.

   Break the work into small, focused tasks, one per iteration. Each task's Files entries must be a subset of PRD.md ## Files to touch. The task's Files line owns the per-iteration C/M/D markers, so a file listed as C in PRD.md may be listed as M by a later task that modifies it. Each task's Test Cases entries must map to the intent of PRD.md ## Test cases without requiring a 1:1 exact string match.
   Task Files lines must list only implementation files, or N/A for verification-only tasks. Do not list PRD.md, TASKS.md, STATUS.md, or .ralph/* in any task Files line.

3. STATUS.md — Initial status:
   # Current status
   Not started.

   # Last attempt
   N/A

   # Known issues
   None.

   # Next step
   (what the first iteration should do)

   <!-- RALPH_REVIEW_FEEDBACK:START -->
   {"status":"approved","changes":[]}
   <!-- RALPH_REVIEW_FEEDBACK:END -->

   <!-- RALPH_STATIC_GUARD:START -->
   Static guard: PASS
   <!-- RALPH_STATIC_GUARD:END -->

Rules:
- Be specific, detailed, and actionable. Do not leave implementation choices to future providers.
- PRD.md is the source of truth. TASKS.md must slice that source of truth into per-iteration work without adding new scope.
- PRD.md and TASKS.md must be final and implementation-ready. Do not encode uncertainty, research, discovery, clarification, external reference inspection, or PRD refinement as tasks.
- If interactive clarification is enabled, ask clarifying questions before writing files. If interactive clarification is not enabled, make the best complete implementation contract from the provided description and existing codebase context without uncertain placeholders.
- Do not write uncertain placeholders such as TBD, confirm, investigate, inspect, determine, narrow, or "exact behavior to be checked".
- TASKS.md must contain only executable implementation or verification tasks derived from the finalized PRD.
- Providers using these files must not do independent product or architecture thinking. Give them enough implementation detail to execute the spec only.
- Tasks should be small enough for one AI iteration each.
- Tasks should be flat, no hierarchy, no titles or sections in TASKS.md. Use only checklist items and their Files, Expectation, and Test Cases lines.
- Look at the existing codebase to inform requirements and constraints.
- Write all three files to the project root directory. Overwrite them completely if they already exist.
- STATUS.md must only include Current status, Last attempt, Known issues, Next step, and Ralph managed blocks. PRD.md is authoritative; record blocking spec gaps under Known issues instead of making non-spec choices.
- Add requirement that before each step is done, there are test coverage for new changes, and all tests pass.
- Add requirement that after all steps are done, it is properly tested or verified before declaring the work complete.
- Do NOT create any other files.
- NEVER run git write commands (git add, git commit, git push). Only git read commands are permitted (git log, git diff, git show).


IMPORTANT:
The Files to touch  section in PRD is very key to the entire process as we have a static guard that will halt the program if files listed here is not accurate or not aligned with each task. Be very thorough with the files to touch and the tasks.md Files list. Ensure that executable task and the changes it will create will touch exactly the files listed. And the files listed aligns with the broader files tree in Files to touch. We do not want the loop halting because of this misalignment.
`;
}

export function makeLoopPrompt(
  target: string,
  checkCmd: string,
  loopNo: number,
  currentTask: CurrentTask | null,
  lastFailedOutput = "",
  checkDisabled = false
) {
  const prd = readProjectFile(target, "PRD.md");
  const status = readProjectFile(target, "STATUS.md");

  let content = `You are running one iteration of a Ralph loop inside this project.

The project planning context is embedded below. Use these embedded copies instead of reading PRD.md, TASKS.md, or STATUS.md via tool calls.

<PRD>
${prd}
</PRD>

<STATUS>
${status}
</STATUS>

${formatCurrentTask(currentTask)}

CRITICAL: You must complete exactly ONE Ralph-selected current task, then stop.
Do NOT attempt multiple tasks. Another fresh instance will handle the next task.

PRD.md is the source-of-truth implementation contract. Implement only what PRD.md and the selected task explicitly specify. Do not invent product behavior, architecture, files, dependencies, abstractions, or tests. Use code inspection only to locate the specified implementation points and follow existing style.

Rules:
- Ralph has already selected the current task. Do not choose a task from TASKS.md.
- The selected task must include Files:, Expectation:, and Test Cases: lines.
- Before editing, identify the PRD sections and selected task contract lines that authorize the work.
- Implement that single task only.
- Inspect the JSON inside the STATUS.md block delimited by "<!-- RALPH_REVIEW_FEEDBACK:START -->" and "<!-- RALPH_REVIEW_FEEDBACK:END -->". If it has "status":"changes_requested", address those requested changes as part of this iteration.
- Do not modify the RALPH_REVIEW_FEEDBACK block in STATUS.md. Ralph manages that block.
- Inspect the STATUS.md block delimited by "<!-- RALPH_STATIC_GUARD:START -->" and "<!-- RALPH_STATIC_GUARD:END -->". If it reports "Static guard: FAIL", resolve those failures as part of the selected task.
- Do not modify the RALPH_STATIC_GUARD block in STATUS.md. Ralph manages that block.
- Touch only implementation files listed in the selected task's Files.
- Touch operational Ralph files like STATUS.md and .ralph/ files as needed, but do not touch PRD.md or TASKS.md.
- Every implementation file in the selected task's Files: line must also appear in PRD.md ## Files to touch. The selected task's Files line owns the per-iteration C/M/D marker.
- Do not modify PRD.md during implementation.
- Do not reinterpret, simplify, or expand the spec.
- If an unlisted file or unspecified behavior appears necessary, do not implement it. Update STATUS.md with the spec gap and leave the task unchecked.
- Implement only the checks listed in the selected task's Test Cases: line, except for direct equivalents required by the target project's test framework.
- Do not edit TASKS.md. The Ralph runner owns checking and unchecking the selected task.
- Update STATUS.md with what you changed, but do not choose or rewrite the next task. Ralph owns task progression.
- Keep STATUS.md concrete, short, and truthful.
- Do not add rationale or departure sections to STATUS.md. PRD.md is authoritative. If the spec blocks implementation, record the blocking spec gap under Known issues and leave the task unchecked.
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

  if (lastFailedOutput.trim()) {
    content += `
Your previous attempt FAILED verification. Here is the raw output:

${lastFailedOutput.trimEnd()}

Fix the issue before proceeding.
`;
  }

  return content;
}

function formatCurrentTask(currentTask: CurrentTask | null): string {
  if (!currentTask) {
    return `<CURRENT_TASK>
None selected.
</CURRENT_TASK>`;
  }

  return `<CURRENT_TASK>
Description: ${currentTask.description}
Files:
${currentTask.files.map((file) => `- ${file.path} ${file.op}`).join("\n")}
Expectation: ${currentTask.expectation}
Test Cases:
${currentTask.testCases.map((testCase) => `- ${testCase}`).join("\n")}
</CURRENT_TASK>`;
}

export function makeAutoReviewFeedbackPrompt(
  target: string,
  loop: number,
  currentTask: CurrentTask | null,
  scope: ReviewScope
): string {
  return `You are reviewing Ralph loop iteration ${loop}.

Your job is to do an adversarial review of the work completed in this iteration after auto-commit.

Review rules:
- Scope is limited to the selected current task Files list and the PRD below.
- Touched files outside the selected current task Files list are scope violations.
- Do not request edits to files outside the selected current task Files list, even if they appear in the diff.
- Focus on blockers only. Ignore nits, style comments, speculative refactors, and unrelated improvements.
- Check whether the changes fully satisfy the selected task and acceptance criteria.
- Check whether the changes are internally consistent with the surrounding code they directly affect.
- Every requested change must target a file listed in the selected current task Files list.
- Look out for implementation correctness in scope
- Look out for spurious tests. 
    - we should NEVER assert mock behavior
    - we should NEVER add test-only methods to production classes
    - we should NEVER mock without understanding dependencies
    - we should NEVER write tests for non-application behaviour

Output contract:
- Return ONLY the specified format. {"status":"changes_requested | approved","changes":[{"file":"relative/path","line":123,"requested_change":"Concrete blocker to fix."}]}
- Return exactly one compact object and nothing else.
- Do not include text, prose outside the specified format, comments, headings, code blocks, or trailing text or bullet points.
- If there are no blocking changes, return: {"status":"approved","changes":[]}
- If there are blocking changes, return: {"status":"changes_requested","changes":[{"file":"relative/path","line":123,"requested_change":"Concrete blocker to fix."}]}

Touched files:
${formatTouchedFiles(scope.touchedFiles)}

${formatCurrentTask(currentTask)}

Iteration diff:
\`\`\`diff
${scope.diff || "# No iteration diff was captured."}
\`\`\`

The PRD is embedded below. Use this embedded copy and the selected current task instead of reading PRD.md, TASKS.md, or STATUS.md via tool calls.

<PRD>
${readProjectFile(target, "PRD.md")}
</PRD>`;
}

function formatTouchedFiles(files: string[]): string {
  if (files.length === 0) return "- none captured";
  return files.map((file) => `- ${file}`).join("\n");
}
export function generateQAPrompt(target: string): string {
  const prd = readProjectFile(target, "PRD.md");

  return `You are performing QA for Ralph.

## Your Task
Compare the code implementation against the Goal statement in PRD.md. 
If there are gaps between what the Goal describes and what is implemented, generate tasks to fill those gaps.

## PRD.md Goal Section
${extractGoalSection(prd)}

## Instructions
1. Read the implementation files in this project
2. Compare code implementation against the Goal section
3. Review implementation for correctness, slop, cruft and deviations from the goal
4. Check that code implementation actually works.
5. If gaps exist, write "GOAL_CHECK_TASKS_ADDED" followed by the new tasks, then append tasks to TASKS.md with this format:
   - [ ] {task description}
     - Files: {file path that exists in files to touch} {C|M}
     - Expectation: {what should be implemented}
     - Test Cases: goal check verification
6. If no gaps, write "GOAL_CHECK_PASSED" to stdout and exit

## Ensure you do these as a checklist before confirming it actually works
- Manually verify that implementation works, based on verified evidenece and facts. Ensure to clean up your verification artifacts or processes. For example: if goal is to implement an upload. Verify that you are able to actually upload a file. Another example: if implementation is to be able to record on click of a button, run the app and verify that it works. That is the kind of evidence based manual verification we are looking for!
- Do not add or make any changes to the codebase. If you need to write scripts to verify some functionality, do it outside of the codebase or in a tmp directory or in memory and ensure to clean up.
- If project has UI check that UI is functional, check buttons work as expected, check forms work

## Important notes
- Only append tasks, do not modify existing checked tasks
- Do not write uncertain placeholders such as TBD, confirm, investigate, inspect, determine, narrow, or "exact behavior to be checked".
- Each task must be an executable implementation or verification tasks based on the gaps and following existing patterns.
- Do NOT touch any other files.
- NEVER run git write commands (git add, git commit, git push). Only git read commands are permitted (git log, git diff, git show).
- Do NOT rely on tests to confirm if code implementation works. Instead manually verify if implementation works. 
- If necessary run the app and verify functionality manually or using playwright where necessary. 
- Trace the implementation to deeply understand how its working
`;
}
