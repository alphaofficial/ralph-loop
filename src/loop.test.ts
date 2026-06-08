import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureIterationGitBaseline } from "./iteration-git";
import { runAutoReviewGate, type LoopContext, type LoopState } from "./loop";
import type { AutoReviewChangesRequested } from "./auto-review";

const TASKS_TEXT = `- [x] Define auto-review result parsing/validation and failure behavior.
- [x] Add iteration touched-file/diff capture for git targets.
- [x] Build the adversarial auto-review prompt scoped to current task, acceptance criteria, and touched files.
- [x] Insert a bounded auto-review/fix loop before verification and auto-commit.
- [ ] Add focused tests or smoke coverage for approved, changes-requested, invalid-output, and exhausted-loop paths.
- [ ] Run typecheck/build and a disposable tmp smoke test.
`;

const PRD_TEXT = `# Goal
Add an auto-review gate inside each Ralph task iteration before verification and auto-commit.

## Definition of done
- Approved review path proceeds to verification and auto-commit as before.
- Changes-requested path runs focused fix attempts and only proceeds after approval.
- Invalid review output and exhausted review loop fail safely without verification/commit.
`;

const STATUS_TEXT = `# Current status
Auto-review gate is implemented.
`;

const noopStop = () => {};
const noopSpinner = () => noopStop;
const noopLog = () => {};

const cleanupTargets: string[] = [];

afterEach(() => {
  while (cleanupTargets.length > 0) {
    rmSync(cleanupTargets.pop()!, { recursive: true, force: true });
  }
});

function createAutoReviewProject(loop = 1) {
  const target = mkdtempSync(join(tmpdir(), "ralph-loop-"));
  cleanupTargets.push(target);

  mkdirSync(join(target, ".ralph"), { recursive: true });
  mkdirSync(join(target, "src"), { recursive: true });

  writeFileSync(join(target, "PRD.md"), PRD_TEXT);
  writeFileSync(join(target, "TASKS.md"), TASKS_TEXT);
  writeFileSync(join(target, "STATUS.md"), STATUS_TEXT);
  writeFileSync(join(target, "src", "feature.ts"), "export const value = 1;\n");

  const baseline = captureIterationGitBaseline(target, loop, true);
  if (!baseline) throw new Error("expected git baseline for auto-review test");

  writeFileSync(join(target, "src", "feature.ts"), "export const value = 2;\n");

  return { target, baseline };
}

function makeCtx(target: string, maxReviewLoops = 3): LoopContext {
  return {
    provider: "codex",
    target,
    maxLoops: 1,
    maxReviewLoops,
    checkCmd: "",
    checkDisabled: false,
    canAutoCommit: false,
    loopStart: Date.now(),
  };
}

function makeState(loop = 1): LoopState {
  return { loop, retries: 0, lastFailedOutput: "" };
}

function readSummary(target: string, loop = 1): string {
  return readFileSync(
    join(target, ".ralph", `iteration-${loop}-auto-review-summary.txt`),
    "utf-8"
  );
}

function autoReviewArtifacts(target: string): string[] {
  return readdirSync(join(target, ".ralph"))
    .filter((name) => name.includes("auto-review"))
    .sort();
}

function expectNoScopeArtifacts(target: string, loop = 1) {
  expect(existsSync(join(target, ".ralph", `iteration-${loop}-touched-files.txt`))).toBe(false);
  expect(existsSync(join(target, ".ralph", `iteration-${loop}-diff.patch`))).toBe(false);
  expect(existsSync(join(target, ".ralph", `iteration-${loop}-git.json`))).toBe(false);
}

function requestedChange(file = "src/feature.ts"): AutoReviewChangesRequested {
  return {
    status: "changes_requested",
    changes: [
      {
        file,
        line: 1,
        requested_change: "Keep the iteration blocked until approval.",
      },
    ],
  };
}

describe("runAutoReviewGate", () => {
  test("approves on the first pass and skips the fix loop", async () => {
    const { target, baseline } = createAutoReviewProject();
    let reviewCalls = 0;
    let fixCalls = 0;

    const result = await runAutoReviewGate(makeCtx(target), makeState(), baseline, {
      captureProviderFn: async () => {
        reviewCalls++;
        return { code: 0, stdout: `{"status":"approved","changes":[]}`, stderr: "" };
      },
      invokeProviderFn: async () => {
        fixCalls++;
        return 0;
      },
      logFn: noopLog,
      errFn: noopLog,
      startSpinnerFn: noopSpinner,
    });

    expect(result).toEqual({ approved: true });
    expect(reviewCalls).toBe(1);
    expect(fixCalls).toBe(0);
    expect(readSummary(target)).toContain("Auto-review: PASS");
    expect(autoReviewArtifacts(target)).toEqual(["iteration-1-auto-review-summary.txt"]);
    expectNoScopeArtifacts(target);
  });

  test("requests focused fixes and re-reviews before approving", async () => {
    const { target, baseline } = createAutoReviewProject();
    const prompts: string[] = [];
    let reviewCalls = 0;
    let fixCalls = 0;

    const result = await runAutoReviewGate(makeCtx(target), makeState(), baseline, {
      captureProviderFn: async () => {
        reviewCalls++;
        if (reviewCalls === 1) {
          return {
            code: 0,
            stdout: JSON.stringify(requestedChange()),
            stderr: "",
          };
        }
        return { code: 0, stdout: `{"status":"approved","changes":[]}`, stderr: "" };
      },
      invokeProviderFn: async (_provider, _target, prompt) => {
        fixCalls++;
        prompts.push(prompt);
        return 0;
      },
      logFn: noopLog,
      errFn: noopLog,
      startSpinnerFn: noopSpinner,
    });

    expect(result).toEqual({ approved: true });
    expect(reviewCalls).toBe(2);
    expect(fixCalls).toBe(1);
    expect(prompts[0]).toContain("Blocking changes requested by auto-review");
    expect(prompts[0]).toContain("Keep the iteration blocked until approval.");
    expect(readSummary(target)).toContain("Attempts: 2/3");
    expect(autoReviewArtifacts(target)).toEqual(["iteration-1-auto-review-summary.txt"]);
    expectNoScopeArtifacts(target);
  });

  test("fails closed on invalid reviewer output", async () => {
    const { target, baseline } = createAutoReviewProject();
    let fixCalls = 0;

    const result = await runAutoReviewGate(makeCtx(target), makeState(), baseline, {
      captureProviderFn: async () => ({
        code: 0,
        stdout: "review looks good to me",
        stderr: "",
      }),
      invokeProviderFn: async () => {
        fixCalls++;
        return 0;
      },
      logFn: noopLog,
      errFn: noopLog,
      startSpinnerFn: noopSpinner,
    });

    expect(result).toEqual({ approved: false });
    expect(fixCalls).toBe(0);
    expect(readSummary(target)).toContain("invalid reviewer output (missing_json)");
    expect(readFileSync(join(target, "STATUS.md"), "utf-8")).toContain("Auto-review: FAIL");
    expect(autoReviewArtifacts(target)).toEqual([
      "iteration-1-auto-review-1-output.txt",
      "iteration-1-auto-review-1-result.json",
      "iteration-1-auto-review-summary.txt",
    ]);
    expectNoScopeArtifacts(target);
  });

  test("stops after the review loop bound is exhausted", async () => {
    const { target, baseline } = createAutoReviewProject();
    let reviewCalls = 0;
    let fixCalls = 0;

    const result = await runAutoReviewGate(makeCtx(target, 2), makeState(), baseline, {
      captureProviderFn: async () => {
        reviewCalls++;
        return {
          code: 0,
          stdout: JSON.stringify(requestedChange()),
          stderr: "",
        };
      },
      invokeProviderFn: async () => {
        fixCalls++;
        return 0;
      },
      logFn: noopLog,
      errFn: noopLog,
      startSpinnerFn: noopSpinner,
    });

    expect(result).toEqual({ approved: false });
    expect(reviewCalls).toBe(2);
    expect(fixCalls).toBe(1);
    expect(readSummary(target)).toContain("exhausted review loop after 2 attempts");
    expect(
      readFileSync(join(target, ".ralph", "iteration-1-auto-review-2-result.json"), "utf-8")
    ).toContain(`"status": "changes_requested"`);
    expect(autoReviewArtifacts(target)).toEqual([
      "iteration-1-auto-review-2-result.json",
      "iteration-1-auto-review-fix-1.prompt.txt",
      "iteration-1-auto-review-summary.txt",
    ]);
    expectNoScopeArtifacts(target);
  });
});
