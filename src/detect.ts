import { existsSync, readFileSync, accessSync, constants } from "node:fs";
import { join } from "node:path";

export function packageManager(target: string): string {
  if (existsSync(join(target, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(target, "yarn.lock"))) return "yarn";
  if (
    existsSync(join(target, "bun.lockb")) ||
    existsSync(join(target, "bun.lock"))
  )
    return "bun";
  return "npm";
}

function jsonHasScript(target: string, name: string): boolean {
  try {
    const pkg = JSON.parse(
      readFileSync(join(target, "package.json"), "utf-8")
    );
    return name in (pkg.scripts ?? {});
  } catch {
    return false;
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function makefileHasTest(target: string): boolean {
  try {
    const content = readFileSync(join(target, "Makefile"), "utf-8");
    return /^test:/m.test(content);
  } catch {
    return false;
  }
}

function commandExists(cmd: string): boolean {
  try {
    const proc = Bun.spawnSync(["which", cmd]);
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

export function autoDetectCheck(target: string): string {
  const envCmd = process.env.RALPH_CHECK_CMD;
  if (envCmd) return envCmd;

  if (isExecutable(join(target, "verify.sh"))) return "./verify.sh";

  if (makefileHasTest(target)) return "make test";

  if (existsSync(join(target, "package.json"))) {
    const pm = packageManager(target);
    if (jsonHasScript(target, "test")) return `${pm} test`;
    if (jsonHasScript(target, "build")) return `${pm} run build`;
    if (jsonHasScript(target, "lint")) return `${pm} run lint`;
  }

  if (existsSync(join(target, "pyproject.toml"))) {
    return commandExists("uv") ? "uv run pytest -q" : "pytest -q";
  }

  if (existsSync(join(target, "Cargo.toml"))) return "cargo test";
  if (existsSync(join(target, "go.mod"))) return "go test ./...";

  return "";
}
