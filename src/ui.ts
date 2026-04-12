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

export function notify(title: string, message: string) {
  // Terminal bell — triggers dock bounce / tab badge in the user's terminal
  // Works in every terminal, no permissions needed, points to the right window
  process.stderr.write("\x07");
  log(`${title} — ${message}`);
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
