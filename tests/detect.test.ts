import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { packageManager, autoDetectCheck } from "../src/detect";

const TMP = join(import.meta.dir, ".tmp-detect");

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env.RALPH_CHECK_CMD;
});

describe("packageManager", () => {
  test("detects pnpm", () => {
    writeFileSync(join(TMP, "pnpm-lock.yaml"), "");
    expect(packageManager(TMP)).toBe("pnpm");
  });

  test("detects yarn", () => {
    writeFileSync(join(TMP, "yarn.lock"), "");
    expect(packageManager(TMP)).toBe("yarn");
  });

  test("detects bun via bun.lockb", () => {
    writeFileSync(join(TMP, "bun.lockb"), "");
    expect(packageManager(TMP)).toBe("bun");
  });

  test("detects bun via bun.lock", () => {
    writeFileSync(join(TMP, "bun.lock"), "");
    expect(packageManager(TMP)).toBe("bun");
  });

  test("defaults to npm", () => {
    expect(packageManager(TMP)).toBe("npm");
  });

  test("pnpm takes priority over yarn", () => {
    writeFileSync(join(TMP, "pnpm-lock.yaml"), "");
    writeFileSync(join(TMP, "yarn.lock"), "");
    expect(packageManager(TMP)).toBe("pnpm");
  });
});

describe("autoDetectCheck", () => {
  test("returns RALPH_CHECK_CMD if set", () => {
    process.env.RALPH_CHECK_CMD = "my-custom-check";
    expect(autoDetectCheck(TMP)).toBe("my-custom-check");
  });

  test("returns ./verify.sh if executable", () => {
    const script = join(TMP, "verify.sh");
    writeFileSync(script, "#!/bin/bash\nexit 0\n");
    chmodSync(script, 0o755);
    expect(autoDetectCheck(TMP)).toBe("./verify.sh");
  });

  test("returns make test if Makefile has test target", () => {
    writeFileSync(join(TMP, "Makefile"), "test:\n\techo ok\n");
    expect(autoDetectCheck(TMP)).toBe("make test");
  });

  test("skips Makefile without test target", () => {
    writeFileSync(join(TMP, "Makefile"), "build:\n\techo ok\n");
    expect(autoDetectCheck(TMP)).toBe("");
  });

  test("detects npm test from package.json", () => {
    writeFileSync(
      join(TMP, "package.json"),
      JSON.stringify({ scripts: { test: "jest" } })
    );
    expect(autoDetectCheck(TMP)).toBe("npm test");
  });

  test("detects npm run build from package.json", () => {
    writeFileSync(
      join(TMP, "package.json"),
      JSON.stringify({ scripts: { build: "tsc" } })
    );
    expect(autoDetectCheck(TMP)).toBe("npm run build");
  });

  test("detects npm run lint from package.json", () => {
    writeFileSync(
      join(TMP, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } })
    );
    expect(autoDetectCheck(TMP)).toBe("npm run lint");
  });

  test("test takes priority over build in package.json", () => {
    writeFileSync(
      join(TMP, "package.json"),
      JSON.stringify({ scripts: { test: "jest", build: "tsc" } })
    );
    expect(autoDetectCheck(TMP)).toBe("npm test");
  });

  test("uses correct package manager for package.json", () => {
    writeFileSync(join(TMP, "pnpm-lock.yaml"), "");
    writeFileSync(
      join(TMP, "package.json"),
      JSON.stringify({ scripts: { test: "jest" } })
    );
    expect(autoDetectCheck(TMP)).toBe("pnpm test");
  });

  test("detects cargo test", () => {
    writeFileSync(join(TMP, "Cargo.toml"), "");
    expect(autoDetectCheck(TMP)).toBe("cargo test");
  });

  test("detects go test", () => {
    writeFileSync(join(TMP, "go.mod"), "");
    expect(autoDetectCheck(TMP)).toBe("go test ./...");
  });

  test("returns empty string for empty directory", () => {
    expect(autoDetectCheck(TMP)).toBe("");
  });
});
