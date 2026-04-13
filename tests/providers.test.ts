import { describe, expect, test } from "bun:test";
import { buildOpenCodeArgs } from "../src/providers";

describe("buildOpenCodeArgs", () => {
  test("passes prompt as positional arg without model", () => {
    const args = buildOpenCodeArgs("test prompt content");
    expect(args).toEqual(["opencode", "test prompt content"]);
  });

  test("passes --model flag before prompt when model is provided", () => {
    const args = buildOpenCodeArgs("do the thing", "openai/gpt-4o");
    expect(args).toEqual(["opencode", "--model", "openai/gpt-4o", "do the thing"]);
  });

  test("does not include run subcommand", () => {
    const args = buildOpenCodeArgs("hello");
    expect(args).not.toContain("run");
  });

  test("does not include --dangerously-skip-permissions flag", () => {
    const args = buildOpenCodeArgs("hello");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  test("prompt is always the last element", () => {
    const args = buildOpenCodeArgs("final arg", "some/model");
    expect(args[args.length - 1]).toBe("final arg");
  });
});