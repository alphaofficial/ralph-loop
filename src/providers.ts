export const LOOP_PROVIDERS = ["claude", "copilot", "codex", "gemini", "hermes", "opencode", "pi"] as const;
export const GENERATION_PROVIDERS = ["claude", "copilot", "codex", "gemini", "hermes", "opencode", "pi"] as const;

export type Provider = (typeof LOOP_PROVIDERS)[number];

export function providerCommand(
  provider: Provider,
  target: string,
  prompt: string,
  model?: string
): {
  args: string[];
  stdin?: Blob;
  env?: Record<string, string | undefined>;
} {
  switch (provider) {
    case "claude": {
      const env = { ...process.env };
      const args = [
        providerBinary("claude"),
        "-p",
        "--dangerously-skip-permissions",
        "--add-dir",
        target,
      ];
      if (model) args.push("--model", model);
      return { args, stdin: new Blob([prompt]), env };
    }

    case "codex": {
      const args = [
        providerBinary("codex"),
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
      ];
      if (model) args.push("--model", model);
      args.push(prompt);
      return { args };
    }

    case "opencode": {
      const args = [
        providerBinary("opencode"),
        "run",
        "--dangerously-skip-permissions",
        "--dir",
        target,
      ];
      if (model) args.push("--model", model);
      args.push(prompt);
      return { args };
    }

    case "copilot": {
      const args = [
        providerBinary("copilot"),
        "-p",
        prompt,
        "--allow-all",
      ];
      if (model) args.push("--model", model);
      return { args };
    }

    case "gemini": {
      const args = [providerBinary("gemini"), "-p", prompt];
      if (model) args.push("--model", model);
      return { args };
    }

    case "hermes": {
      const args = [providerBinary("hermes"), "--oneshot", prompt];
      if (model) args.push("--model", model);
      return { args };
    }

    case "pi": {
      const args = [providerBinary("pi"), "-p", prompt];
      if (model) args.push("--model", model);
      return { args };
    }
  }
}

export async function invokeProvider(
  provider: Provider,
  target: string,
  prompt: string,
  model?: string,
  _interactive = false
): Promise<number> {
  const command = providerCommand(provider, target, prompt, model);
  const proc = Bun.spawn(command.args, {
    cwd: target,
    env: command.env,
    stdin: command.stdin,
    stdout: "inherit",
    stderr: "inherit",
  });

  return await proc.exited;
}

function providerBinary(provider: Provider): string {
  const envName = `RALPH_${provider.toUpperCase()}_BIN`;
  return process.env[envName] ?? provider;
}
