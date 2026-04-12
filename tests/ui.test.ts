import { describe, expect, test, spyOn, afterEach } from "bun:test";
import { log, err, startSpinner, cleanup, escapeAppleScript, formatDuration } from "../src/ui";

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

describe("formatDuration", () => {
  test("formats seconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(59000)).toBe("59s");
  });

  test("formats minutes and seconds", () => {
    expect(formatDuration(60000)).toBe("1m 0s");
    expect(formatDuration(90000)).toBe("1m 30s");
    expect(formatDuration(3599000)).toBe("59m 59s");
  });

  test("formats hours and minutes", () => {
    expect(formatDuration(3600000)).toBe("1h 0m");
    expect(formatDuration(5400000)).toBe("1h 30m");
    expect(formatDuration(7260000)).toBe("2h 1m");
  });
});
