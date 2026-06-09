import { describe, expect, test } from "bun:test";
import { providerCommand, type Provider } from "./providers";

describe("providerCommand", () => {
  test("builds normal runtime commands without auto-review schema flags", () => {
    const commands = new Map<Provider, string[]>(
      ([
        ["claude", providerCommand("claude", "/tmp/project", "prompt", "model").args],
        ["codex", providerCommand("codex", "/tmp/project", "prompt", "model").args],
        ["copilot", providerCommand("copilot", "/tmp/project", "prompt", "model").args],
        ["gemini", providerCommand("gemini", "/tmp/project", "prompt", "model").args],
        ["hermes", providerCommand("hermes", "/tmp/project", "prompt", "model").args],
        ["opencode", providerCommand("opencode", "/tmp/project", "prompt", "model").args],
        ["pi", providerCommand("pi", "/tmp/project", "prompt", "model").args],
      ] satisfies Array<[Provider, string[]]>)
    );

    for (const args of commands.values()) {
      expect(args).not.toContain("--output-schema");
      expect(args).not.toContain("--output-last-message");
      expect(args).not.toContain("--json-schema");
    }

    expect(commands.get("claude")).not.toContain("--output-format");
    expect(commands.get("gemini")).not.toContain("--output-format");
    expect(commands.get("opencode")).not.toContain("--format");
    expect(commands.get("copilot")).not.toContain("-s");
    expect(commands.get("pi")).not.toContain("--no-session");
  });

  test("passes the target directory explicitly to OpenCode", () => {
    const args = providerCommand("opencode", "/tmp/project", "prompt", "model").args;

    expect(args).toContain("--dir");
    expect(args[args.indexOf("--dir") + 1]).toBe("/tmp/project");
  });

  test("passes model through normal runtime commands", () => {
    expect(providerCommand("codex", "/tmp/project", "prompt", "gpt-test").args).toContain(
      "gpt-test"
    );
    expect(providerCommand("gemini", "/tmp/project", "prompt", "gemini-test").args).toContain(
      "gemini-test"
    );
  });
});
