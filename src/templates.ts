export const PRD_TEMPLATE = `# Goal
Describe what done looks like.

## Requirements
- requirement 1
- requirement 2
- requirement 3

## Implementation details
- exact implementation approach
- affected modules, interfaces, APIs, CLI flags, file formats, events, and data contracts
- file-level responsibilities
- error handling, integration, migration, compatibility, security, and performance requirements

## Files to touch
- src/
  - example.ts M
  - new-file.ts C
- README.md M

## Test cases
- required test or verification check 1
- required test or verification check 2

## Guardrails
- do not invent product behavior, architecture, files, dependencies, abstractions, or tests.
- do not write spurious tests.

## Constraints
- constraint 1
- constraint 2

## Definition of done
- tests/build pass
- behavior is implemented
`;

export const TASKS_TEMPLATE = `- [ ] Update the documented behavior for the first specified change.
  - Files: README.md M
  - Expectation: README.md documents the behavior exactly as described in PRD.md.
  - Test Cases: Verify README.md matches the PRD requirements, verify no unlisted files changed

- [ ] Implement the first specified change.
  - Files: src/example.ts M, src/new-file.ts C
  - Expectation: The specified behavior is implemented exactly as described in PRD.md.
  - Test Cases: Run the listed project verification for this change
`;

export const STATUS_TEMPLATE = `# Current status
Not started.

# Last attempt
N/A

# Known issues
None yet.

# Next step
Read PRD.md and start with the first task.

<!-- RALPH_REVIEW_FEEDBACK:START -->
{"status":"approved","changes":[]}
<!-- RALPH_REVIEW_FEEDBACK:END -->

<!-- RALPH_STATIC_GUARD:START -->
Static guard: PASS
<!-- RALPH_STATIC_GUARD:END -->

<!-- RALPH_RUNNER:START -->
No automated verification has run yet.
<!-- RALPH_RUNNER:END -->
`;
