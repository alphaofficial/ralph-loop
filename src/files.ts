import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { AutoReviewOutputSchema } from "./auto-review-schema";
import { PRD_TEMPLATE, TASKS_TEMPLATE, STATUS_TEMPLATE } from "./templates";

export function readProjectFile(target: string, filename: string): string {
  try {
    return readFileSync(join(target, filename), "utf-8").trimEnd();
  } catch {
    return `${filename} could not be read.`;
  }
}

export function ensureGitExcludes(target: string) {
  const result = Bun.spawnSync(["git", "-C", target, "rev-parse", "--is-inside-work-tree"]);
  if (result.exitCode !== 0) return;

  const excludeFile = join(target, ".git", "info", "exclude");
  mkdirSync(dirname(excludeFile), { recursive: true });

  if (!existsSync(excludeFile)) writeFileSync(excludeFile, "");

  const content = readFileSync(excludeFile, "utf-8");
  const lines = content.split("\n");

  let needsNewline = content.length > 0 && !content.endsWith("\n");
  for (const pattern of ["PRD.md", "TASKS.md", "STATUS.md", ".ralph/"]) {
    if (!lines.includes(pattern)) {
      appendFileSync(excludeFile, `${needsNewline ? "\n" : ""}${pattern}\n`);
      needsNewline = false;
    }
  }
}

export function ensureTemplates(target: string) {
  mkdirSync(join(target, ".ralph"), { recursive: true, mode: 0o700 });

  const files: [string, string][] = [
    [join(target, "PRD.md"), PRD_TEMPLATE],
    [join(target, "TASKS.md"), TASKS_TEMPLATE],
    [join(target, "STATUS.md"), STATUS_TEMPLATE],
  ];

  for (const [path, template] of files) {
    if (!existsSync(path)) writeFileSync(path, template);
  }

  const autoReviewOutputSchemaFile = join(
    target,
    ".ralph",
    "auto-review-output-schema.json"
  );
  const autoReviewOutputSchemaContent =
    JSON.stringify(AutoReviewOutputSchema) + "\n";
  writeFileSync(autoReviewOutputSchemaFile, autoReviewOutputSchemaContent, {
    mode: 0o600,
  });

  ensureGitExcludes(target);
}

export function updateRunnerBlock(statusFile: string, content: string) {
  const START = "<!-- RALPH_RUNNER:START -->";
  const END = "<!-- RALPH_RUNNER:END -->";
  const block = `${START}\n${content.trimEnd()}\n${END}`;

  let text = existsSync(statusFile) ? readFileSync(statusFile, "utf-8") : "";

  const pattern = new RegExp(
    `${escapeRegex(START)}[\\s\\S]*?${escapeRegex(END)}`
  );

  if (pattern.test(text)) {
    text = text.replace(pattern, block);
  } else {
    if (text && !text.endsWith("\n")) text += "\n";
    text += (text ? "\n" : "") + block + "\n";
  }

  writeFileSync(statusFile, text);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
