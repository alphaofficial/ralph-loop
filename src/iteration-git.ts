import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

type IterationGitBaseline = {
  head: string | null;
  compareTrackedBySnapshot: boolean;
  snapshotDir: string;
  trackedBefore: Set<string>;
  untrackedBefore: Set<string>;
};

export type IterationGitArtifacts = {
  diff: string;
  diffPath: string;
  metadataPath: string;
  touchedFiles: string[];
  touchedFilesPath: string;
};

export function captureIterationGitBaseline(
  target: string,
  loop: number,
  enabled: boolean
): IterationGitBaseline | null {
  if (!enabled) return null;

  const head = gitOutput(target, ["rev-parse", "--verify", "HEAD"]);
  const compareTrackedBySnapshot = !head;
  const trackedBefore = new Set(
    compareTrackedBySnapshot
      ? gitPaths(target, ["ls-files", "-z", "--cached"])
      : gitPaths(target, ["diff", "--name-only", "-z", "HEAD", "--"])
  );
  const untrackedBefore = new Set(
    gitPaths(target, ["ls-files", "--others", "--exclude-standard", "-z"])
  );

  const snapshotDir = join(target, ".ralph", `iteration-${loop}-baseline`);
  rmSync(snapshotDir, { recursive: true, force: true });
  mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });

  for (const file of new Set([...trackedBefore, ...untrackedBefore])) {
    snapshotFile(target, snapshotDir, file);
  }

  return {
    head,
    compareTrackedBySnapshot,
    snapshotDir,
    trackedBefore,
    untrackedBefore,
  };
}

export function writeIterationGitArtifacts(
  target: string,
  loop: number,
  baseline: IterationGitBaseline | null
): IterationGitArtifacts | null {
  if (!baseline) return null;

  const trackedAfter = new Set(
    baseline.compareTrackedBySnapshot
      ? gitPaths(target, ["ls-files", "-z", "--cached"])
      : gitPaths(target, ["diff", "--name-only", "-z", "HEAD", "--"])
  );
  const untrackedAfter = new Set(
    gitPaths(target, ["ls-files", "--others", "--exclude-standard", "-z"])
  );

  const touchedFiles = new Set<string>();
  const diffParts: string[] = [];

  for (const file of [...trackedAfter].sort()) {
    if (baseline.compareTrackedBySnapshot) {
      if (!snapshotChanged(target, baseline.snapshotDir, file)) continue;
      touchedFiles.add(file);
      const patch = diffAgainstSnapshot(target, baseline.snapshotDir, file);
      if (patch) diffParts.push(patch);
      continue;
    }

    if (!baseline.trackedBefore.has(file) && !baseline.untrackedBefore.has(file)) {
      touchedFiles.add(file);
      const patch = diffAgainstHead(target, baseline.head, file);
      if (patch) diffParts.push(patch);
      continue;
    }

    if (!snapshotChanged(target, baseline.snapshotDir, file)) continue;
    touchedFiles.add(file);
    const patch = diffAgainstSnapshot(target, baseline.snapshotDir, file);
    if (patch) diffParts.push(patch);
  }

  for (const file of [...untrackedAfter].sort()) {
    if (!baseline.trackedBefore.has(file) && !baseline.untrackedBefore.has(file)) {
      touchedFiles.add(file);
      const patch = diffAgainstEmpty(target, file);
      if (patch) diffParts.push(patch);
      continue;
    }

    if (!snapshotChanged(target, baseline.snapshotDir, file)) continue;
    touchedFiles.add(file);
    const patch = diffAgainstSnapshot(target, baseline.snapshotDir, file);
    if (patch) diffParts.push(patch);
  }

  const touched = [...touchedFiles].sort();
  const diff = diffParts.join(diffParts.length > 0 ? "\n" : "");
  const touchedFilesPath = join(target, ".ralph", `iteration-${loop}-touched-files.txt`);
  const diffPath = join(target, ".ralph", `iteration-${loop}-diff.patch`);
  const metadataPath = join(target, ".ralph", `iteration-${loop}-git.json`);

  writeFileSync(touchedFilesPath, touched.join("\n") + (touched.length > 0 ? "\n" : ""), {
    mode: 0o600,
  });
  writeFileSync(diffPath, diff, { mode: 0o600 });
  writeFileSync(
    metadataPath,
    JSON.stringify(
      {
        loop,
        head: baseline.head,
        touched_files: touched,
        touched_files_path: relative(target, touchedFilesPath),
        diff_path: relative(target, diffPath),
      },
      null,
      2
    ) + "\n",
    { mode: 0o600 }
  );

  return {
    diff,
    diffPath,
    metadataPath,
    touchedFiles: touched,
    touchedFilesPath,
  };
}

function snapshotFile(target: string, snapshotDir: string, relativePath: string) {
  const source = join(target, relativePath);
  if (!existsSync(source)) return;

  const destination = join(snapshotDir, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function snapshotChanged(target: string, snapshotDir: string, relativePath: string): boolean {
  const snapshotPath = join(snapshotDir, relativePath);
  const currentPath = join(target, relativePath);

  if (!existsSync(snapshotPath)) return existsSync(currentPath);
  if (!existsSync(currentPath)) return true;

  return fileHash(snapshotPath) !== fileHash(currentPath);
}

function diffAgainstHead(target: string, head: string | null, relativePath: string): string {
  if (!head) return diffAgainstSnapshot(target, join(target, ".ralph", "missing-baseline"), relativePath);

  const proc = Bun.spawnSync(
    ["git", "-C", target, "diff", "--no-ext-diff", "--binary", head, "--", relativePath],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  if (proc.exitCode !== 0) return "";
  return new TextDecoder().decode(proc.stdout).trimEnd();
}

function diffAgainstSnapshot(
  target: string,
  snapshotDir: string,
  relativePath: string
): string {
  const snapshotPath = join(snapshotDir, relativePath);
  const currentPath = join(target, relativePath);
  const beforePath = existsSync(snapshotPath) ? snapshotPath : "/dev/null";
  const afterPath = existsSync(currentPath) ? currentPath : "/dev/null";
  return diffNoIndex(beforePath, afterPath, snapshotPath, currentPath, relativePath);
}

function diffAgainstEmpty(target: string, relativePath: string): string {
  const currentPath = join(target, relativePath);
  return diffNoIndex("/dev/null", currentPath, "/dev/null", currentPath, relativePath);
}

function diffNoIndex(
  beforePath: string,
  afterPath: string,
  replaceBefore: string,
  replaceAfter: string,
  relativePath: string
): string {
  const proc = Bun.spawnSync(
    ["git", "diff", "--no-index", "--binary", "--no-ext-diff", "--", beforePath, afterPath],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  if (proc.exitCode > 1) return "";

  const output = new TextDecoder().decode(proc.stdout).trimEnd();
  if (!output) return "";

  return output
    .split(replaceBefore)
    .join(relativePath)
    .split(replaceAfter)
    .join(relativePath);
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function gitPaths(target: string, args: string[]): string[] {
  const output = gitOutputRaw(target, args);
  if (!output) return [];
  return output
    .split("\0")
    .filter((path) => path.length > 0);
}

function gitOutput(target: string, args: string[]): string | null {
  const output = gitOutputRaw(target, args);
  if (!output) return null;
  const text = output.trim();
  return text ? text : null;
}

function gitOutputRaw(target: string, args: string[]): string | null {
  try {
    const proc = Bun.spawnSync(["git", "-C", target, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return null;
    return new TextDecoder().decode(proc.stdout);
  } catch {
    return null;
  }
}
