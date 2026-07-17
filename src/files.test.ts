import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { PRD_FILE, STATUS_FILE, TASKS_FILE, ensureTemplates, projectFilePath } from "./files";
import { STATUS_TEMPLATE } from "./templates";

describe("ensureTemplates", () => {
  test("resets STATUS.md when requested without overwriting PRD.md or TASKS.md", () => {
    const target = mkdtempSync(join(tmpdir(), "ralph-files-test-"));
    try {
      ensureTemplates(target);
      writeFileSync(projectFilePath(target, PRD_FILE), "# Existing PRD\n");
      writeFileSync(projectFilePath(target, TASKS_FILE), "- [ ] Existing task.\n");
      writeFileSync(projectFilePath(target, STATUS_FILE), "# Current status\nDirty state.\n");

      ensureTemplates(target, { resetStatus: true });

      expect(readFileSync(projectFilePath(target, PRD_FILE), "utf-8")).toBe("# Existing PRD\n");
      expect(readFileSync(projectFilePath(target, TASKS_FILE), "utf-8")).toBe("- [ ] Existing task.\n");
      expect(readFileSync(projectFilePath(target, STATUS_FILE), "utf-8")).toBe(STATUS_TEMPLATE);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
