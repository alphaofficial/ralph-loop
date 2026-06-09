import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureTemplates } from "./files";
import {
  SKIP,
  allTasksComplete,
  cleanupAutoReviewArtifacts,
  combineOutput,
  formatAutoReviewFeedback,
  isAutoReviewApproved,
  parseAutoReviewResult,
  readCheckOutputSummary,
  runCheck,
  writeAutoReviewOutputArtifact,
  writeAutoReviewResultArtifact,
  writeAutoReviewSummary,
} from "./helpers";

const cleanupTargets: string[] = [];

afterEach(() => {
  while (cleanupTargets.length > 0) {
    rmSync(cleanupTargets.pop()!, { recursive: true, force: true });
  }
});

function tmpProject() {
  const target = mkdtempSync(join(tmpdir(), "ralph-helpers-"));
  cleanupTargets.push(target);
  mkdirSync(join(target, ".ralph"), { recursive: true });
  return target;
}

describe("ensureTemplates", () => {
  test("writes the auto-review output schema under .ralph", () => {
    const target = tmpProject();

    ensureTemplates(target);

    expect(
      JSON.parse(
        readFileSync(
          join(target, ".ralph", "auto-review-output-schema.json"),
          "utf-8"
        )
      )
    ).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["status", "changes"],
      properties: {
        status: {
          type: "string",
          enum: ["approved", "changes_requested"],
        },
        changes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["file", "line", "requested_change"],
            properties: {
              file: { type: "string" },
              line: { type: "integer" },
              requested_change: { type: "string" },
            },
          },
        },
      },
    });
  });
});

describe("allTasksComplete", () => {
  test("returns false while any task is unchecked", () => {
    const target = tmpProject();
    writeFileSync(join(target, "TASKS.md"), "- [x] Done\n- [ ] Still pending\n");

    expect(allTasksComplete(target)).toBe(false);
  });

  test("returns true when all task checkboxes are complete", () => {
    const target = tmpProject();
    writeFileSync(join(target, "TASKS.md"), "- [x] Done\n- [x] Also done\n");

    expect(allTasksComplete(target)).toBe(true);
  });

  test("returns true when TASKS.md is missing", () => {
    expect(allTasksComplete(tmpProject())).toBe(true);
  });
});

describe("runCheck", () => {
  test("skips and writes a no-command message when no check command exists", async () => {
    const target = tmpProject();
    const outFile = join(target, ".ralph", "check-output.txt");

    const result = await runCheck(target, "", outFile);

    expect(result).toBe(SKIP);
    expect(readFileSync(outFile, "utf-8")).toBe("No verification command detected.\n");
  });

  test("skips and writes the disabled message when checks are disabled", async () => {
    const target = tmpProject();
    const outFile = join(target, ".ralph", "check-output.txt");

    const result = await runCheck(target, "", outFile, true);

    expect(result).toBe(SKIP);
    expect(readFileSync(outFile, "utf-8")).toBe(
      "Runner-managed verification disabled by --no-check.\n"
    );
  });

  test("runs the command and writes stdout followed by stderr", async () => {
    const target = tmpProject();
    const outFile = join(target, ".ralph", "check-output.txt");

    const result = await runCheck(
      target,
      "printf 'stdout line\\n'; printf 'stderr line\\n' >&2",
      outFile
    );

    expect(result).toBe(0);
    expect(readFileSync(outFile, "utf-8")).toBe("stdout line\nstderr line\n");
  });
});

describe("readCheckOutputSummary", () => {
  test("returns only the first 120 lines for status summaries", () => {
    const target = tmpProject();
    const outFile = join(target, ".ralph", "check-output.txt");
    const lines = Array.from({ length: 125 }, (_, index) => `line ${index + 1}`);
    writeFileSync(outFile, lines.join("\n"));

    const summary = readCheckOutputSummary(outFile).split("\n");

    expect(summary).toHaveLength(120);
    expect(summary[0]).toBe("line 1");
    expect(summary[119]).toBe("line 120");
  });

  test("returns an empty string when the output file is missing", () => {
    expect(readCheckOutputSummary(join(tmpProject(), ".ralph", "missing.txt"))).toBe("");
  });
});

describe("auto-review helpers", () => {
  test("accepts approved JSON output", () => {
    const result = parseAutoReviewResult(`{"status":"approved","changes":[]}`);

    expect(result).toEqual({ status: "approved", changes: [] });
    expect(isAutoReviewApproved(result)).toBe(true);
  });

  test("rejects fenced JSON output", () => {
    const result = parseAutoReviewResult(`
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
      status: "invalid",
      reason: "missing_json",
      message: "review output did not contain a JSON object",
    });
  });

  test("rejects JSON followed by CLI transcript text", () => {
    const result = parseAutoReviewResult(`{"status":"approved","changes":[]}
Reading additional input from stdin...`);

    expect(result).toEqual({
      status: "invalid",
      reason: "invalid_json",
      message: "review output contained invalid JSON",
    });
  });

  test("rejects output that does not validate against the auto-review schema", () => {
    const result = parseAutoReviewResult(`{"status":"changes_requested"}`);

    expect(result).toEqual({
      status: "invalid",
      reason: "schema_validation_failed",
      message: "data must have required property 'changes'",
    });
    expect(isAutoReviewApproved(result)).toBe(false);
  });

  test("rejects changes_requested output with an empty changes array", () => {
    const result = parseAutoReviewResult(`{"status":"changes_requested","changes":[]}`);

    expect(result).toEqual({
      status: "invalid",
      reason: "missing_changes",
      message:
        'changes_requested review output must include a non-empty "changes" array',
    });
  });

  test("rejects malformed change objects", () => {
    const result = parseAutoReviewResult(`{
      "status": "changes_requested",
      "changes": [
        {
          "file": "src/loop.ts",
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

  test("combines non-empty captured stdout and stderr", () => {
    expect(combineOutput("review stdout\n", "review stderr\n")).toBe(
      "review stdout\nreview stderr"
    );
    expect(combineOutput("", "review stderr\n")).toBe("review stderr");
  });

  test("writes and cleans up auto-review artifacts", () => {
    const target = tmpProject();

    const outputPath = writeAutoReviewOutputArtifact(target, 2, 3, "raw review");
    const resultPath = writeAutoReviewResultArtifact(target, 2, 3, {
      status: "approved",
      changes: [],
    });
    writeAutoReviewSummary(target, 2, "Auto-review: PASS\nAttempts: 1/3");

    expect(readFileSync(outputPath, "utf-8")).toBe("raw review\n");
    expect(JSON.parse(readFileSync(resultPath, "utf-8"))).toEqual({
      status: "approved",
      changes: [],
    });
    expect(
      readFileSync(join(target, ".ralph", "iteration-2-auto-review-summary.txt"), "utf-8")
    ).toBe("Auto-review: PASS\nAttempts: 1/3");

    cleanupAutoReviewArtifacts([outputPath, resultPath]);

    expect(existsSync(outputPath)).toBe(false);
    expect(existsSync(resultPath)).toBe(false);
  });

  test("formats changes-requested feedback for the normal iteration prompt", () => {
    const feedback = formatAutoReviewFeedback({
      status: "changes_requested",
      changes: [
        {
          file: "src/loop.ts",
          line: 42,
          requested_change: "Keep verification blocked until review approval.",
        },
      ],
    });

    expect(feedback).toContain("Auto-review blocked this attempt before verification.");
    expect(feedback).toContain("- file: src/loop.ts\n  line: 42");
    expect(feedback).toContain(
      "requested_change: Keep verification blocked until review approval."
    );
  });
});
