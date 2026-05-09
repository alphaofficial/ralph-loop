import { describe, expect, test } from "bun:test";
import { parseQuestions } from "../src/generate";

describe("parseQuestions", () => {
  test("parses exactly three string questions from JSON output", () => {
    expect(parseQuestions('["One?", "Two?", "Three?"]')).toEqual(["One?", "Two?", "Three?"]);
  });

  test("rejects invalid JSON", () => {
    expect(() => parseQuestions("not json")).toThrow("Provider did not return a JSON array of clarifying questions");
  });

  test("rejects non-array JSON", () => {
    expect(() => parseQuestions('{"question":"One?"}')).toThrow("Provider did not return a JSON array of clarifying questions");
  });

  test("rejects JSON array with surrounding prose", () => {
    expect(() => parseQuestions('Here are questions:\n["One?", "Two?", "Three?"]')).toThrow(
      "Provider did not return a JSON array of clarifying questions"
    );
  });

  test("rejects mixed-type arrays", () => {
    expect(() => parseQuestions('["One?", 2, "Three?"]')).toThrow("Provider returned invalid clarifying questions");
  });

  test("rejects empty questions", () => {
    expect(() => parseQuestions('["One?", "", "Three?"]')).toThrow("Provider returned invalid clarifying questions");
  });

  test("rejects wrong question count", () => {
    expect(() => parseQuestions('["One?", "Two?"]')).toThrow("Provider returned invalid clarifying questions");
  });
});
