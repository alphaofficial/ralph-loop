import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GENERATION_PROVIDERS, LOOP_PROVIDERS, invokeProvider } from "../src/providers";

describe("providers", () => {
  test("generation providers include gemini", () => {
    expect(GENERATION_PROVIDERS).toContain("gemini");
  });

  test("loop providers include gemini", () => {
    expect(LOOP_PROVIDERS).toContain("gemini");
  });

  test("generation and loop providers stay aligned", () => {
    expect(GENERATION_PROVIDERS).toEqual(LOOP_PROVIDERS);
  });

  test("invokeProvider uses Gemini CLI prompt mode", async () => {
    const target = mkdtempSync(join(tmpdir(), "ralph-providers-"));

    const spawn = spyOn(Bun, "spawn").mockReturnValue({
      exited: Promise.resolve(0),
    } as ReturnType<typeof Bun.spawn>);

    try {
      const code = await invokeProvider("gemini", target, "Use Gemini to build this.");

      expect(code).toBe(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0]?.[0]).toEqual(["gemini", "-p", "Use Gemini to build this."]);
      expect(spawn.mock.calls[0]?.[1]).toMatchObject({
        cwd: target,
        stdout: "inherit",
        stderr: "inherit",
      });
    } finally {
      spawn.mockRestore();
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("invokeProvider passes Gemini model overrides", async () => {
    const target = mkdtempSync(join(tmpdir(), "ralph-providers-"));

    const spawn = spyOn(Bun, "spawn").mockReturnValue({
      exited: Promise.resolve(0),
    } as ReturnType<typeof Bun.spawn>);

    try {
      await invokeProvider("gemini", target, "Use Gemini to build this.", "gemini-2.5-pro");

      expect(spawn.mock.calls[0]?.[0]).toEqual([
        "gemini",
        "-p",
        "Use Gemini to build this.",
        "--model",
        "gemini-2.5-pro",
      ]);
    } finally {
      spawn.mockRestore();
      rmSync(target, { recursive: true, force: true });
    }
  });
});
