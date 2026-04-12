import { describe, expect, test, spyOn, afterEach } from "bun:test";
import { log, err, startSpinner, cleanup, escapeAppleScript } from "../src/ui";

describe("log", () => {
  test("prints to stdout with [ralph] prefix", () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    log("hello");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain("[ralph]");
    expect(spy.mock.calls[0][0]).toContain("hello");
    spy.mockRestore();
  });
});

describe("err", () => {
  test("prints to stderr with [ralph] ERROR prefix", () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    err("bad thing");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain("[ralph] ERROR:");
    expect(spy.mock.calls[0][0]).toContain("bad thing");
    spy.mockRestore();
  });
});

describe("startSpinner", () => {
  afterEach(() => cleanup());

  test("returns a stop function", () => {
    const stop = startSpinner("working");
    expect(typeof stop).toBe("function");
    stop();
  });

  test("stop clears the spinner", () => {
    const stop = startSpinner("working");
    stop();
    // calling stop again should be safe (no-op)
    stop();
  });
});

describe("cleanup", () => {
  test("is safe to call without active spinner", () => {
    expect(() => cleanup()).not.toThrow();
  });

  test("clears active spinner", () => {
    startSpinner("working");
    expect(() => cleanup()).not.toThrow();
  });
});

describe("escapeAppleScript", () => {
  test("escapes double quotes", () => {
    expect(escapeAppleScript('say "hi"')).toBe('say \\"hi\\"');
  });

  test("escapes backslashes", () => {
    expect(escapeAppleScript("path\\to\\file")).toBe("path\\\\to\\\\file");
  });

  test("escapes both", () => {
    expect(escapeAppleScript('"\\test"')).toBe('\\"\\\\test\\"');
  });

  test("returns plain string unchanged", () => {
    expect(escapeAppleScript("hello world")).toBe("hello world");
  });
});
