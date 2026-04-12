export const PRD_TEMPLATE = `# Goal
Describe what done looks like.

## Requirements
- requirement 1
- requirement 2
- requirement 3

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

# Known issues
None yet.

# Next step
Read PRD.md and start with the first task.

<!-- RALPH_RUNNER:START -->
No automated verification has run yet.
<!-- RALPH_RUNNER:END -->
`;
