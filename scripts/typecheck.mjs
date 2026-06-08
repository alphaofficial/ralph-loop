#!/usr/bin/env node
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const tscPath = findTsc();

if (!tscPath) {
  console.error("Unable to locate a cached TypeScript compiler for typecheck.");
  process.exit(1);
}

const result = spawnSync(process.execPath, [tscPath, "--noEmit"], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);

function findTsc() {
  const candidates = [
    join(process.cwd(), "node_modules", "typescript", "lib", "tsc.js"),
    ...cachedBunCompilers(),
    ...cachedNpmCompilers(),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function cachedBunCompilers() {
  const cacheDir = join(process.env.HOME ?? "", ".bun", "install", "cache");
  return cachedCompilerPaths(cacheDir, "typescript@", ["lib", "tsc.js"]);
}

function cachedNpmCompilers() {
  const cacheDir = join(process.env.HOME ?? "", ".npm", "_npx");
  const roots = safeListDirs(cacheDir);
  const candidates = roots.flatMap((root) =>
    [
      join(cacheDir, root, "node_modules", "typescript", "lib", "tsc.js"),
      join(cacheDir, root, "node_modules", "tsc", "bin", "tsc.js"),
    ].filter((candidate) => existsSync(candidate))
  );

  return candidates.sort().reverse();
}

function cachedCompilerPaths(rootDir, prefix, tail) {
  return safeListDirs(rootDir)
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse()
    .map((name) => join(rootDir, name, ...tail))
    .filter((candidate) => existsSync(candidate));
}

function safeListDirs(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
