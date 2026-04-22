import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { ensureTemplates, updateRunnerBlock, ensureGitExcludes } from "../src/files";

const TMP = join(import.meta.dir, ".tmp-files");

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("ensureTemplates", () => {
  test("creates PRD.md, TASKS.md, STATUS.md", () => {
    ensureTemplates(TMP);
    expect(existsSync(join(TMP, "PRD.md"))).toBe(true);
    expect(existsSync(join(TMP, "TASKS.md"))).toBe(true);
    expect(existsSync(join(TMP, "STATUS.md"))).toBe(true);
  });

  test("creates .ralph directory with 0o700 permissions", () => {
    ensureTemplates(TMP);
    const dir = join(TMP, ".ralph");
    expect(existsSync(dir)).toBe(true);
    const mode = statSync(dir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test("does not overwrite existing files", () => {
    writeFileSync(join(TMP, "PRD.md"), "custom content");
    ensureTemplates(TMP);
    expect(readFileSync(join(TMP, "PRD.md"), "utf-8")).toBe("custom content");
  });

  test("creates missing files even if some exist", () => {
    writeFileSync(join(TMP, "PRD.md"), "custom");
    ensureTemplates(TMP);
    expect(readFileSync(join(TMP, "PRD.md"), "utf-8")).toBe("custom");
    expect(existsSync(join(TMP, "TASKS.md"))).toBe(true);
    expect(existsSync(join(TMP, "STATUS.md"))).toBe(true);
  });
});

describe("ensureGitExcludes", () => {
  test("does nothing for non-git directories", () => {
    expect(() => ensureGitExcludes(TMP)).not.toThrow();
  });

  test("adds patterns to .git/info/exclude", () => {
    // init a git repo
    Bun.spawnSync(["git", "init", TMP]);
    ensureGitExcludes(TMP);
    const content = readFileSync(
      join(TMP, ".git", "info", "exclude"),
      "utf-8"
    );
    expect(content).toContain("PRD.md");
    expect(content).toContain("TASKS.md");
    expect(content).toContain("STATUS.md");
    expect(content).toContain(".ralph/");
  });

  test("is idempotent", () => {
    Bun.spawnSync(["git", "init", TMP]);
    ensureGitExcludes(TMP);
    ensureGitExcludes(TMP);
    const content = readFileSync(
      join(TMP, ".git", "info", "exclude"),
      "utf-8"
    );
    const prdMatches = content.split("PRD.md").length - 1;
    expect(prdMatches).toBe(1);
  });

  test("appends on new line when file lacks trailing newline", () => {
    Bun.spawnSync(["git", "init", TMP]);
    const excludePath = join(TMP, ".git", "info", "exclude");
    // Create file with content that doesn't end in newline
    writeFileSync(excludePath, "existing-pattern");
    ensureGitExcludes(TMP);
    const content = readFileSync(excludePath, "utf-8");
    // Each pattern should be on its own line
    expect(content).toContain("existing-pattern\nPRD.md");
    expect(content).toContain("PRD.md\n");
    expect(content).toContain("TASKS.md\n");
    expect(content).toContain("STATUS.md\n");
    expect(content).toContain(".ralph/\n");
  });
});

describe("updateRunnerBlock", () => {
  test("replaces existing block", () => {
    const file = join(TMP, "status.md");
    writeFileSync(
      file,
      "# Status\n\n<!-- RALPH_RUNNER:START -->\nold\n<!-- RALPH_RUNNER:END -->\n"
    );
    updateRunnerBlock(file, "new content");
    const result = readFileSync(file, "utf-8");
    expect(result).toContain("new content");
    expect(result).not.toContain("old");
    expect(result).toContain("<!-- RALPH_RUNNER:START -->");
    expect(result).toContain("<!-- RALPH_RUNNER:END -->");
  });

  test("appends block to file without one", () => {
    const file = join(TMP, "status.md");
    writeFileSync(file, "# Status\nSome content\n");
    updateRunnerBlock(file, "verification output");
    const result = readFileSync(file, "utf-8");
    expect(result).toContain("# Status\nSome content\n");
    expect(result).toContain("<!-- RALPH_RUNNER:START -->");
    expect(result).toContain("verification output");
    expect(result).toContain("<!-- RALPH_RUNNER:END -->");
  });

  test("handles empty file without leading newline", () => {
    const file = join(TMP, "status.md");
    writeFileSync(file, "");
    updateRunnerBlock(file, "content");
    const result = readFileSync(file, "utf-8");
    expect(result).toBe(
      "<!-- RALPH_RUNNER:START -->\ncontent\n<!-- RALPH_RUNNER:END -->\n"
    );
  });

  test("handles nonexistent file", () => {
    const file = join(TMP, "new-status.md");
    updateRunnerBlock(file, "content");
    expect(existsSync(file)).toBe(true);
    const result = readFileSync(file, "utf-8");
    expect(result).toContain("content");
  });
});
