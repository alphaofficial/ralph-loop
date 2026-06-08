import { describe, expect, test } from "bun:test";
import { isAutoReviewApproved, parseAutoReviewResult } from "./auto-review";

describe("parseAutoReviewResult", () => {
  test("accepts approved JSON output", () => {
    const result = parseAutoReviewResult(`{"status":"approved","changes":[]}`);

    expect(result).toEqual({ status: "approved", changes: [] });
    expect(isAutoReviewApproved(result)).toBe(true);
  });

  test("accepts changes requested inside a fenced JSON block", () => {
    const result = parseAutoReviewResult(`
Reviewer notes:

\`\`\`json
{
  "status": "changes_requested",
  "changes": [
    {
      "file": "src/loop.ts",
      "line": 212,
      "requested_change": "Stop verification when the review gate is not approved."
    }
  ]
}
\`\`\`
`);

    expect(result).toEqual({
      status: "changes_requested",
      changes: [
        {
          file: "src/loop.ts",
          line: 212,
          requested_change:
            "Stop verification when the review gate is not approved.",
        },
      ],
    });
  });

  test("rejects changes_requested output without structured changes", () => {
    const result = parseAutoReviewResult(`{"status":"changes_requested"}`);

    expect(result).toEqual({
      status: "invalid",
      reason: "missing_changes",
      message:
        'changes_requested review output must include a non-empty "changes" array',
    });
    expect(isAutoReviewApproved(result)).toBe(false);
  });

  test("rejects malformed change objects", () => {
    const result = parseAutoReviewResult(`{
      "status": "changes_requested",
      "changes": [
        {
          "file": "src/review.ts",
          "line": 0,
          "requested_change": ""
        }
      ]
    }`);

    expect(result).toEqual({
      status: "invalid",
      reason: "invalid_change",
      message:
        "each requested change must include file, line, and requested_change",
    });
  });
});
