import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
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

export function ensureTemplates(target: string, options: { resetStatus?: boolean } = {}) {
  mkdirSync(join(target, ".ralph"), { recursive: true, mode: 0o700 });

  const files: [string, string][] = [
    [join(target, "PRD.md"), PRD_TEMPLATE],
    [join(target, "TASKS.md"), TASKS_TEMPLATE],
    [join(target, "STATUS.md"), STATUS_TEMPLATE],
  ];

  for (const [path, template] of files) {
    if (!existsSync(path)) writeFileSync(path, template);
  }
  if (options.resetStatus) writeFileSync(join(target, "STATUS.md"), STATUS_TEMPLATE);

  ensureGitExcludes(target);
}

export function updateRunnerBlock(statusFile: string, content: string) {
  const START = "<!-- RALPH_RUNNER:START -->";
  const END = "<!-- RALPH_RUNNER:END -->";
  updateManagedBlock(statusFile, START, END, content);
}

export function updateReviewFeedbackBlock(statusFile: string, content: string) {
  const START = "<!-- RALPH_REVIEW_FEEDBACK:START -->";
  const END = "<!-- RALPH_REVIEW_FEEDBACK:END -->";
  updateManagedBlock(statusFile, START, END, content);
}

export function updateStaticGuardBlock(statusFile: string, content: string) {
  const START = "<!-- RALPH_STATIC_GUARD:START -->";
  const END = "<!-- RALPH_STATIC_GUARD:END -->";
  updateManagedBlock(statusFile, START, END, content);
}

export function updateStatusNextStep(statusFile: string, content: string) {
  const heading = "# Next step";
  const replacement = `${heading}\n${content.trimEnd()}`;
  let text = existsSync(statusFile) ? readFileSync(statusFile, "utf-8") : "";
  const pattern = /# Next step\n[\s\S]*?(?=\n# |\n<!-- RALPH_|$)/;

  if (pattern.test(text)) {
    text = text.replace(pattern, replacement);
  } else {
    if (text && !text.endsWith("\n")) text += "\n";
    text += `${text ? "\n" : ""}${replacement}\n`;
  }

  writeFileSync(statusFile, text);
}

export function extractGoalSection(prd: string): string {
  const lines = prd.split("\n");
  const goalIndex = lines.findIndex((l) => l.trim().toLowerCase() === "# goal");
  if (goalIndex === -1) return "";

  const endIndex = lines.findIndex((l, i) => i > goalIndex && /^##\s+/.test(l));
  return lines.slice(goalIndex, endIndex === -1 ? undefined : endIndex).join("\n");
}

function updateManagedBlock(statusFile: string, start: string, end: string, content: string) {
  const block = `${start}\n${content.trimEnd()}\n${end}`;

  let text = existsSync(statusFile) ? readFileSync(statusFile, "utf-8") : "";

  const pattern = new RegExp(
    `${escapeRegex(start)}[\\s\\S]*?${escapeRegex(end)}`
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
