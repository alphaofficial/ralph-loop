import { describe, expect, test } from "bun:test";
import { GENERATION_PROVIDERS, LOOP_PROVIDERS } from "../src/providers";

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
});
