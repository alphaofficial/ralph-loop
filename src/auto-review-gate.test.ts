import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
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
import {
  captureAutoReviewProvider,
  runAutoReviewGate,
  type AutoReviewGateConfig,
  type AutoReviewGateProgress,
} from "./auto-review-gate";
import { ensureTemplates } from "./files";
import { captureReviewScopeBaseline } from "./review-scope";
import { makeLoopPrompt } from "./prompts";
import type { AutoReviewChangesRequested } from "./helpers";

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
const providerBinEnvNames = [
  "RALPH_CLAUDE_BIN",
  "RALPH_COPILOT_BIN",
  "RALPH_CODEX_BIN",
  "RALPH_GEMINI_BIN",
  "RALPH_HERMES_BIN",
  "RALPH_OPENCODE_BIN",
  "RALPH_PI_BIN",
] as const;
const originalProviderBins = new Map(
  providerBinEnvNames.map((name) => [name, process.env[name]])
);

afterEach(() => {
  for (const name of providerBinEnvNames) {
    const original = originalProviderBins.get(name);
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }
  while (cleanupTargets.length > 0) {
    rmSync(cleanupTargets.pop()!, { recursive: true, force: true });
  }
});

function tmpProject() {
  const target = mkdtempSync(join(tmpdir(), "ralph-auto-review-provider-"));
  cleanupTargets.push(target);
  ensureTemplates(target);
  return target;
}

function createAutoReviewProject(loop = 1) {
  const target = mkdtempSync(join(tmpdir(), "ralph-loop-"));
  cleanupTargets.push(target);

  ensureTemplates(target);
  mkdirSync(join(target, "src"), { recursive: true });

  writeFileSync(join(target, "PRD.md"), PRD_TEXT);
  writeFileSync(join(target, "TASKS.md"), TASKS_TEXT);
  writeFileSync(join(target, "STATUS.md"), STATUS_TEXT);
  writeFileSync(join(target, "src", "feature.ts"), "export const value = 1;\n");

  const baseline = captureReviewScopeBaseline(target, loop, true);
  if (!baseline) throw new Error("expected git baseline for auto-review test");

  writeFileSync(join(target, "src", "feature.ts"), "export const value = 2;\n");

  return { target, baseline };
}

function makeConfig(target: string, maxReviewLoops = 3): AutoReviewGateConfig {
  return {
    provider: "codex",
    target,
    maxReviewLoops,
    checkCmd: "",
    checkDisabled: false,
  };
}

function makeProgress(loop = 1): AutoReviewGateProgress {
  return { loop };
}

function readSummary(target: string, loop = 1): string {
  return readFileSync(
    join(target, ".ralph", `iteration-${loop}-auto-review-summary.txt`),
    "utf-8"
  );
}

function autoReviewArtifacts(target: string): string[] {
  return readdirSync(join(target, ".ralph"))
    .filter(
      (name) =>
        name.includes("auto-review") &&
        name !== "auto-review-output-schema.json"
    )
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

function taskCompletionDiff(task: string): string {
  return `diff --git a/TASKS.md b/TASKS.md
--- a/TASKS.md
+++ b/TASKS.md
@@ -1,1 +1,1 @@
-- [ ] ${task}
+- [x] ${task}`;
}

function fakeProvider(name: string, script: string): string {
  const fakeBin = mkdtempSync(join(tmpdir(), "ralph-provider-bin-"));
  cleanupTargets.push(fakeBin);
  const fakePath = join(fakeBin, name);
  writeFileSync(fakePath, script, { mode: 0o755 });
  chmodSync(fakePath, 0o755);
  return fakePath;
}

describe("runAutoReviewGate", () => {
  test("approves on the first pass and skips the fix loop", async () => {
    const { target, baseline } = createAutoReviewProject();
    let reviewCalls = 0;
    let fixCalls = 0;

    const result = await runAutoReviewGate(makeConfig(target), makeProgress(), baseline, {
      captureAutoReviewProviderFn: async () => {
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

    expect(result).toBe("review_approved");
    expect(reviewCalls).toBe(1);
    expect(fixCalls).toBe(0);
    expect(readSummary(target)).toContain("Auto-review: PASS");
    expect(autoReviewArtifacts(target)).toEqual(["iteration-1-auto-review-summary.txt"]);
    expectNoScopeArtifacts(target);
  });

  test("fails closed on fenced reviewer JSON", async () => {
    const { target, baseline } = createAutoReviewProject();
    let fixCalls = 0;

    const result = await runAutoReviewGate(makeConfig(target), makeProgress(), baseline, {
      captureAutoReviewProviderFn: async () => ({
        code: 0,
        stdout: `\`\`\`json
{"status":"approved","changes":[]}
\`\`\`
`,
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

    expect(result).toBe("review_failed");
    expect(fixCalls).toBe(0);
    expect(readSummary(target)).toContain("invalid reviewer output (missing_json)");
    expect(autoReviewArtifacts(target)).toEqual([
      "iteration-1-auto-review-1-output.txt",
      "iteration-1-auto-review-1-result.json",
      "iteration-1-auto-review-summary.txt",
    ]);
    expectNoScopeArtifacts(target);
  });

  test("does not reject valid reviewer stdout because the provider logged to stderr", async () => {
    const { target, baseline } = createAutoReviewProject();

    const result = await runAutoReviewGate(makeConfig(target), makeProgress(), baseline, {
      captureAutoReviewProviderFn: async () => ({
        code: 0,
        stdout: `{"status":"approved","changes":[]}`,
        stderr: "provider transcript log on stderr\n",
      }),
      invokeProviderFn: async () => 0,
      logFn: noopLog,
      errFn: noopLog,
      startSpinnerFn: noopSpinner,
    });

    expect(result).toBe("review_approved");
    expect(readSummary(target)).toContain("Auto-review: PASS");
    expect(autoReviewArtifacts(target)).toEqual(["iteration-1-auto-review-summary.txt"]);
    expectNoScopeArtifacts(target);
  });

  test("requests changes through the main iteration prompt path before re-reviewing", async () => {
    const { target, baseline } = createAutoReviewProject();
    const task =
      "Add focused tests or smoke coverage for approved, changes-requested, invalid-output, and exhausted-loop paths.";
    const prompts: string[] = [];
    let expectedPrompt = "";
    let reviewCalls = 0;
    let fixCalls = 0;
    const expectedFeedback = `Auto-review blocked this attempt before verification.
Treat this feedback as blocking context for the same task and fix it through the normal Ralph iteration prompt path.

Auto-review requested changes:
- file: src/feature.ts
  line: 1
  requested_change: Keep the iteration blocked until approval.

Fix the requested changes before proceeding. Keep scope limited to the current task, acceptance criteria, and touched files.`;
    writeFileSync(
      join(target, "TASKS.md"),
      TASKS_TEXT.replace(`- [ ] ${task}`, `- [x] ${task}`)
    );

    const result = await runAutoReviewGate(makeConfig(target), makeProgress(), baseline, {
      captureReviewScopeFn: () => ({
        diff: taskCompletionDiff(task),
        touchedFiles: ["TASKS.md", "src/feature.ts"],
      }),
      captureAutoReviewProviderFn: async () => {
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
        expect(readFileSync(join(target, "TASKS.md"), "utf-8")).toContain(
          `- [ ] ${task}`
        );
        expectedPrompt = makeLoopPrompt(target, "", 1, expectedFeedback);
        prompts.push(prompt);
        writeFileSync(
          join(target, "TASKS.md"),
          TASKS_TEXT.replace(`- [ ] ${task}`, `- [x] ${task}`)
        );
        return 0;
      },
      logFn: noopLog,
      errFn: noopLog,
      startSpinnerFn: noopSpinner,
    });

    expect(result).toBe("review_approved");
    expect(reviewCalls).toBe(2);
    expect(fixCalls).toBe(1);
    expect(prompts[0]).toBe(expectedPrompt);
    expect(readSummary(target)).toContain("Attempts: 2/3");
    expect(readFileSync(join(target, "TASKS.md"), "utf-8")).toContain(
      `- [x] ${task}`
    );
    expect(autoReviewArtifacts(target)).toEqual(["iteration-1-auto-review-summary.txt"]);
    expectNoScopeArtifacts(target);
  });

  test("fails closed on invalid reviewer output", async () => {
    const { target, baseline } = createAutoReviewProject();
    let fixCalls = 0;

    const result = await runAutoReviewGate(makeConfig(target), makeProgress(), baseline, {
      captureAutoReviewProviderFn: async () => ({
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

    expect(result).toBe("review_failed");
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
    const task =
      "Add focused tests or smoke coverage for approved, changes-requested, invalid-output, and exhausted-loop paths.";
    let reviewCalls = 0;
    let fixCalls = 0;
    writeFileSync(
      join(target, "TASKS.md"),
      TASKS_TEXT.replace(`- [ ] ${task}`, `- [x] ${task}`)
    );

    const result = await runAutoReviewGate(makeConfig(target, 2), makeProgress(), baseline, {
      captureReviewScopeFn: () => ({
        diff: taskCompletionDiff(task),
        touchedFiles: ["TASKS.md", "src/feature.ts"],
      }),
      captureAutoReviewProviderFn: async () => {
        reviewCalls++;
        return {
          code: 0,
          stdout: JSON.stringify(requestedChange()),
          stderr: "",
        };
      },
      invokeProviderFn: async () => {
        fixCalls++;
        expect(readFileSync(join(target, "TASKS.md"), "utf-8")).toContain(
          `- [ ] ${task}`
        );
        return 0;
      },
      logFn: noopLog,
      errFn: noopLog,
      startSpinnerFn: noopSpinner,
    });

    expect(result).toBe("review_failed");
    expect(reviewCalls).toBe(2);
    expect(fixCalls).toBe(1);
    expect(readSummary(target)).toContain("exhausted review loop after 2 attempts");
    expect(readFileSync(join(target, "TASKS.md"), "utf-8")).toContain(
      `- [ ] ${task}`
    );
    expect(
      readFileSync(join(target, ".ralph", "iteration-1-auto-review-2-result.json"), "utf-8")
    ).toContain(`"status": "changes_requested"`);
    expect(autoReviewArtifacts(target)).toEqual([
      "iteration-1-auto-review-2-result.json",
      "iteration-1-auto-review-summary.txt",
    ]);
    expectNoScopeArtifacts(target);
  });
});

describe("captureAutoReviewProvider", () => {
  test("captures Codex final-message output instead of terminal transcript", async () => {
    const target = tmpProject();
    const fakeCodex = fakeProvider(
      "codex",
      `#!/bin/sh
output_file=""
schema_file=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-last-message)
      output_file="$2"
      shift 2
      ;;
    --output-schema)
      schema_file="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [ ! -f "$schema_file" ]; then
  exit 12
fi

printf '{"status":"approved","changes":[]}' > "$output_file"
printf 'OpenAI Codex transcript on stdout\\n'
printf 'OpenAI Codex transcript on stderr\\n' >&2
`
    );
    process.env.RALPH_CODEX_BIN = fakeCodex;

    const result = await captureAutoReviewProvider("codex", target, "prompt");

    expect(result).toEqual({
      code: 0,
      stdout: '{"status":"approved","changes":[]}',
      stderr: "",
    });
    expect(
      readdirSync(join(target, ".ralph")).filter((name) =>
        name.startsWith("auto-review-provider-")
      )
    ).toEqual([]);
  });

  test("extracts Claude structured output from the JSON result envelope", async () => {
    const target = tmpProject();
    const fakeClaude = fakeProvider(
      "claude",
      `#!/bin/sh
printf '{"structured_output":{"status":"approved","changes":[]},"result":"ignored"}'
`
    );
    process.env.RALPH_CLAUDE_BIN = fakeClaude;

    const result = await captureAutoReviewProvider("claude", target, "prompt");

    expect(result.stdout).toBe('{"status":"approved","changes":[]}');
  });

  test("extracts Gemini response text from the JSON result envelope", async () => {
    const target = tmpProject();
    const fakeGemini = fakeProvider(
      "gemini",
      `#!/bin/sh
cat <<'JSON'
{"response":"{\\"status\\":\\"approved\\",\\"changes\\":[]}","stats":{}}
JSON
`
    );
    process.env.RALPH_GEMINI_BIN = fakeGemini;

    const result = await captureAutoReviewProvider("gemini", target, "prompt");

    expect(result.stdout).toBe('{"status":"approved","changes":[]}');
  });

  test("extracts OpenCode text events from JSONL capture output", async () => {
    const target = tmpProject();
    const fakeOpencode = fakeProvider(
      "opencode",
      `#!/bin/sh
printf '%s\\n' '{"type":"step_start","part":{"type":"step-start"}}'
printf '%s\\n' '{"type":"text","part":{"type":"text","text":"{\\"status\\":\\"approved\\",\\"changes\\":[]}"}}'
printf '%s\\n' '{"type":"step_finish","part":{"reason":"stop"}}'
`
    );
    process.env.RALPH_OPENCODE_BIN = fakeOpencode;

    const result = await captureAutoReviewProvider("opencode", target, "prompt");

    expect(result.stdout).toBe('{"status":"approved","changes":[]}');
  });
});
