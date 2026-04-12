import { describe, expect, test } from "bun:test";
import { PRD_TEMPLATE, TASKS_TEMPLATE, STATUS_TEMPLATE } from "../src/templates";

describe("templates", () => {
  test("PRD_TEMPLATE is non-empty", () => {
    expect(PRD_TEMPLATE.length).toBeGreaterThan(0);
  });

  test("PRD_TEMPLATE has expected sections", () => {
    expect(PRD_TEMPLATE).toContain("# Goal");
    expect(PRD_TEMPLATE).toContain("## Requirements");
    expect(PRD_TEMPLATE).toContain("## Constraints");
    expect(PRD_TEMPLATE).toContain("## Definition of done");
  });

  test("TASKS_TEMPLATE is non-empty with checkboxes", () => {
    expect(TASKS_TEMPLATE.length).toBeGreaterThan(0);
    expect(TASKS_TEMPLATE).toContain("- [ ]");
  });

  test("STATUS_TEMPLATE has expected sections", () => {
    expect(STATUS_TEMPLATE).toContain("# Current status");
    expect(STATUS_TEMPLATE).toContain("# Next step");
  });

  test("STATUS_TEMPLATE contains RALPH_RUNNER markers", () => {
    expect(STATUS_TEMPLATE).toContain("<!-- RALPH_RUNNER:START -->");
    expect(STATUS_TEMPLATE).toContain("<!-- RALPH_RUNNER:END -->");
  });
});
