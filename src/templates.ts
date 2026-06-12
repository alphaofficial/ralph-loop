export const PRD_TEMPLATE = `# Goal
Describe what done looks like.

## Requirements
- requirement 1
- requirement 2
- requirement 3

## Technical requirements
- interfaces/APIs/CLI flags/file formats/events/data contracts impacted
- affected modules or systems
- high-level implementation approach and relevant integration/migration/compatibility/security/performance constraints

## Constraints
- constraint 1
- constraint 2

## Definition of done
- tests/build pass
- behavior is implemented
`;

export const TASKS_TEMPLATE = `- [ ] inspect the existing code and relevant files
- [ ] implement the next highest-value change
- [ ] verify the result
- [ ] update STATUS.md with what changed and what remains
`;

export const STATUS_TEMPLATE = `# Current status
Not started.

# Last attempt
N/A

# Decisions made
None yet.

# Tradeoffs and deviations
None yet.

# Known issues
None yet.

# Next step
Read PRD.md and start with the first task.

<!-- RALPH_REVIEW_FEEDBACK:START -->
{"status":"approved","changes":[]}
<!-- RALPH_REVIEW_FEEDBACK:END -->

<!-- RALPH_RUNNER:START -->
No automated verification has run yet.
<!-- RALPH_RUNNER:END -->
`;
