import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GENERATION_PROVIDERS, LOOP_PROVIDERS, invokeProvider, providerCommand } from "../src/providers";

describe("providers", () => {
  test("generation providers include gemini", () => {
    expect(GENERATION_PROVIDERS).toContain("gemini");
  });

  test("loop providers include gemini", () => {
    expect(LOOP_PROVIDERS).toContain("gemini");
  });

  test("generation providers include hermes", () => {
    expect(GENERATION_PROVIDERS).toContain("hermes");
  });

  test("loop providers include hermes", () => {
    expect(LOOP_PROVIDERS).toContain("hermes");
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

  test("invokeProvider still uses Gemini prompt mode when interactive flag is requested", async () => {
    const target = mkdtempSync(join(tmpdir(), "ralph-providers-"));

    const spawn = spyOn(Bun, "spawn").mockReturnValue({
      exited: Promise.resolve(0),
    } as ReturnType<typeof Bun.spawn>);

    try {
      const code = await invokeProvider("gemini", target, "Start by clarifying.", undefined, true);

      expect(code).toBe(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0]?.[0]).toEqual(["gemini", "-p", "Start by clarifying."]);
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

  test("providerCommand uses Hermes single-query mode", () => {
    const prompt = "Generate clarifying questions";
    const command = providerCommand(
      "hermes" as unknown as Parameters<typeof providerCommand>[0],
      "/tmp/project",
      prompt,
      "model-name"
    );

    expect(command.args).toEqual(["hermes", "chat", "-q", prompt, "--model", "model-name"]);
    expect(command.args.filter((arg) => arg === prompt)).toHaveLength(1);
    expect(command.args).not.toContain("interactive");
    expect(command.args).not.toContain("session");
    expect(command.stdin).toBeUndefined();
  });

  test("invokeProvider keeps Hermes headless when interactive flag is requested", async () => {
    const target = mkdtempSync(join(tmpdir(), "ralph-providers-"));

    const spawn = spyOn(Bun, "spawn").mockReturnValue({
      exited: Promise.resolve(0),
    } as ReturnType<typeof Bun.spawn>);

    try {
      const code = await invokeProvider(
        "hermes" as unknown as Parameters<typeof invokeProvider>[0],
        target,
        "Start by clarifying.",
        undefined,
        true
      );

      expect(code).toBe(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0]?.[0]).toEqual(["hermes", "chat", "-q", "Start by clarifying."]);
      expect(spawn.mock.calls[0]?.[1]).toMatchObject({
        cwd: target,
        stdout: "inherit",
        stderr: "inherit",
      });
      expect((spawn.mock.calls[0]?.[1] as { stdin?: unknown } | undefined)?.stdin).not.toBe("inherit");
    } finally {
      spawn.mockRestore();
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("providerCommand uses Pi print mode", () => {
    const prompt = "Generate clarifying questions";
    const command = providerCommand(
      "pi" as unknown as Parameters<typeof providerCommand>[0],
      "/tmp/project",
      prompt,
      "pi-small"
    );

    expect(command.args).toEqual(["pi", "-p", prompt, "--model", "pi-small"]);
    expect(command.args.filter((arg) => arg === prompt)).toHaveLength(1);
    expect(command.args).not.toContain("chat");
    expect(command.args).not.toContain("interactive");
    expect(command.args).not.toContain("session");
    expect(command.stdin).toBeUndefined();
  });

  test("invokeProvider keeps Pi headless when interactive flag is requested", async () => {
    const target = mkdtempSync(join(tmpdir(), "ralph-providers-"));

    const spawn = spyOn(Bun, "spawn").mockReturnValue({
      exited: Promise.resolve(0),
    } as ReturnType<typeof Bun.spawn>);

    try {
      const code = await invokeProvider(
        "pi" as unknown as Parameters<typeof invokeProvider>[0],
        target,
        "Start by clarifying.",
        undefined,
        true
      );

      expect(code).toBe(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0]?.[0]).toEqual(["pi", "-p", "Start by clarifying."]);
      expect(spawn.mock.calls[0]?.[1]).toMatchObject({
        cwd: target,
        stdout: "inherit",
        stderr: "inherit",
      });
      expect((spawn.mock.calls[0]?.[1] as { stdin?: unknown } | undefined)?.stdin).not.toBe("inherit");
    } finally {
      spawn.mockRestore();
      rmSync(target, { recursive: true, force: true });
    }
  });

  test.each(GENERATION_PROVIDERS)("invokeProvider keeps %s in one-shot mode when interactive flag is requested", async (provider) => {
    const target = mkdtempSync(join(tmpdir(), "ralph-providers-"));

    const spawn = spyOn(Bun, "spawn").mockReturnValue({
      exited: Promise.resolve(0),
    } as ReturnType<typeof Bun.spawn>);

    try {
      await invokeProvider(provider, target, "Start by clarifying.", undefined, true);

      const args = spawn.mock.calls[0]?.[0] as string[];
      const options = spawn.mock.calls[0]?.[1] as { stdin?: unknown } | undefined;
      if (provider === "claude") {
        expect(args).toContain("-p");
      } else {
        expect(args).toContain("Start by clarifying.");
      }
      expect(options?.stdin).not.toBe("inherit");
    } finally {
      spawn.mockRestore();
      rmSync(target, { recursive: true, force: true });
    }
  });

  test.each(GENERATION_PROVIDERS)("providerCommand keeps %s in one-shot prompt mode for captured helper calls", (provider) => {
    const command = providerCommand(provider, "/tmp/project", "Generate clarifying questions", "model-name");

    expect(command.args).not.toContain("interactive");
    switch (provider) {
      case "claude":
        expect(command.args).not.toContain("chat");
        expect(command.args).toContain("-p");
        expect(command.stdin).toBeInstanceOf(Blob);
        break;
      case "copilot":
        expect(command.args).not.toContain("chat");
        expect(command.args).toContain("-p");
        expect(command.args).toContain("Generate clarifying questions");
        expect(command.stdin).toBeUndefined();
        break;
      case "codex":
        expect(command.args).not.toContain("chat");
        expect(command.args).toContain("exec");
        expect(command.args).toContain("Generate clarifying questions");
        expect(command.stdin).toBeUndefined();
        break;
      case "gemini":
        expect(command.args).not.toContain("chat");
        expect(command.args).toContain("-p");
        expect(command.args).toContain("Generate clarifying questions");
        expect(command.stdin).toBeUndefined();
        break;
      case "hermes":
        expect(command.args).toContain("chat");
        expect(command.args).toContain("-q");
        expect(command.args).toContain("Generate clarifying questions");
        expect(command.stdin).toBeUndefined();
        break;
      case "opencode":
        expect(command.args).not.toContain("chat");
        expect(command.args).toContain("run");
        expect(command.args).toContain("Generate clarifying questions");
        expect(command.stdin).toBeUndefined();
        break;
    }
  });
});
