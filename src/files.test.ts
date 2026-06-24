import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ensureTemplates } from "./files";
import { STATUS_TEMPLATE } from "./templates";

describe("ensureTemplates", () => {
  test("resets STATUS.md when requested without overwriting PRD.md or TASKS.md", () => {
    const target = mkdtempSync(join(tmpdir(), "ralph-files-test-"));
    try {
      writeFileSync(join(target, "PRD.md"), "# Existing PRD\n");
      writeFileSync(join(target, "TASKS.md"), "- [ ] Existing task.\n");
      writeFileSync(join(target, "STATUS.md"), "# Current status\nDirty state.\n");

      ensureTemplates(target, { resetStatus: true });

      expect(readFileSync(join(target, "PRD.md"), "utf-8")).toBe("# Existing PRD\n");
      expect(readFileSync(join(target, "TASKS.md"), "utf-8")).toBe("- [ ] Existing task.\n");
      expect(readFileSync(join(target, "STATUS.md"), "utf-8")).toBe(STATUS_TEMPLATE);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
