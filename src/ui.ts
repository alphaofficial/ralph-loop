const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";
const CLEAR_LINE = "\x1b[K";

let activeTimer: ReturnType<typeof setInterval> | null = null;

export function log(msg: string) {
  console.log(`${DIM}[ralph]${RESET} ${msg}`);
}

export function err(msg: string) {
  console.error(`${RED}[ralph] ERROR:${RESET} ${msg}`);
}

export function startSpinner(msg: string): () => void {
  if (activeTimer) clearInterval(activeTimer);
  let frame = 0;
  const start = Date.now();
  activeTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    process.stderr.write(
      `\r${DIM}[ralph]${RESET} ${FRAMES[frame % FRAMES.length]} ${msg} (${elapsed}s)  ${CLEAR_LINE}`
    );
    frame++;
  }, 100);

  return () => {
    if (activeTimer) {
      clearInterval(activeTimer);
      activeTimer = null;
    }
    process.stderr.write(`\r${CLEAR_LINE}`);
  };
}

export function cleanup() {
  if (activeTimer) {
    clearInterval(activeTimer);
    activeTimer = null;
  }
  process.stderr.write(`\r${CLEAR_LINE}`);
}

export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function detectTerminalBundleId(): string {
  const term = process.env.TERM_PROGRAM ?? "";
  const bundleIds: Record<string, string> = {
    "Apple_Terminal": "com.apple.Terminal",
    "iTerm.app": "com.googlecode.iterm2",
    "WezTerm": "com.github.wez.wezterm",
    "Ghostty": "com.mitchellh.ghostty",
    "Alacritty": "org.alacritty",
    "kitty": "net.kovidgoyal.kitty",
    "vscode": "com.microsoft.VSCode",
    "cursor": "com.todesktop.230313mzl4w4u92",
  };
  return bundleIds[term] || "com.apple.Terminal";
}

export async function notify(title: string, message: string) {
  try {
    if (process.platform === "darwin") {
      // Prefer terminal-notifier — clicking the notification activates the terminal
      const which = Bun.spawnSync(["which", "terminal-notifier"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (which.exitCode === 0) {
        const bundleId = detectTerminalBundleId();
        const proc = Bun.spawn([
          "terminal-notifier",
          "-title", title,
          "-message", message,
          "-sound", "Glass",
          "-activate", bundleId,
          "-sender", bundleId,
          "-group", "ralph",
        ]);
        await proc.exited;
      } else {
        const proc = Bun.spawn([
          "osascript",
          "-e",
          `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}" sound name "Glass"`,
        ]);
        await proc.exited;
      }
    } else {
      const proc = Bun.spawn(["notify-send", title, message]);
      await proc.exited;
    }
  } catch {
    // silently ignore if notifications unavailable
  }
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

export { GREEN, RED, DIM, RESET };
