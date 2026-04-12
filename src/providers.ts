import { readFileSync } from "node:fs";

export type Provider = "claude" | "codex" | "opencode" | "copilot";

export async function invokeProvider(
  provider: Provider,
  target: string,
  promptFile: string,
  model?: string
): Promise<number> {
  const prompt = readFileSync(promptFile, "utf-8");

  let proc;

  switch (provider) {
    case "claude": {
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;

      const args = [
        "claude",
        "-p",
        "--dangerously-skip-permissions",
        "--add-dir",
        target,
      ];
      if (model) args.push("--model", model);

      proc = Bun.spawn(args, {
        cwd: target,
        env,
        stdin: new Blob([prompt]),
        stdout: "inherit",
        stderr: "inherit",
      });
      break;
    }

    case "codex": {
      const args = [
        "codex",
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
      ];
      if (model) args.push("--model", model);
      args.push(prompt);

      proc = Bun.spawn(args, {
        cwd: target,
        stdout: "inherit",
        stderr: "inherit",
      });
      break;
    }

    case "opencode": {
      const args = ["opencode", "run"];
      if (model) args.push("--model", model);
      args.push(prompt);

      proc = Bun.spawn(args, {
        cwd: target,
        stdout: "inherit",
        stderr: "inherit",
      });
      break;
    }

    case "copilot": {
      const args = [
        "copilot",
        "-p",
        prompt,
        "--allow-all",
      ];
      if (model) args.push("--model", model);

      proc = Bun.spawn(args, {
        cwd: target,
        stdout: "inherit",
        stderr: "inherit",
      });
      break;
    }
  }

  return await proc.exited;
}
