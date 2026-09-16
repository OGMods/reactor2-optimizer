/**
 * A status block rewritten in place, not a log.
 *
 * Rows, not lines — a blueprint code is longer than any terminal is wide and
 * wraps onto several, so the next redraw has to move back over rows to land
 * where it started. Off a TTY the lines simply scroll, which is what a session
 * piped to `tee` wants.
 */

const ERASE_TO_END = "\x1b[J";

let drawnRows = 0;

export function isTty(): boolean {
  return Boolean(process.stdout.isTTY);
}

function terminalWidth(fallback = 80): number {
  return Math.max(1, process.stdout.columns || fallback);
}

function rows(line: string, width: number): number {
  return Math.max(1, Math.ceil(line.length / width));
}

export function updateStatus(lines: string[]): void {
  if (!isTty()) {
    for (const line of lines) process.stdout.write(line + "\n");
    return;
  }

  let out = "";
  if (drawnRows) {
    if (drawnRows > 1) out += `\x1b[${drawnRows - 1}A`;
    out += "\r";
  }
  out += ERASE_TO_END + lines.join("\n");
  process.stdout.write(out);

  const width = terminalWidth();
  drawnRows = lines.reduce((sum, line) => sum + rows(line, width), 0);
}

export function clearStatus(): void {
  if (isTty() && drawnRows) {
    let out = "";
    if (drawnRows > 1) out += `\x1b[${drawnRows - 1}A`;
    out += "\r" + ERASE_TO_END;
    process.stdout.write(out);
  }
  drawnRows = 0;
}

export function updateProgress(message: string): void {
  updateStatus([message]);
}

export function clearProgress(): void {
  clearStatus();
}

/** `93.4` -> `1m 33s`. Whole seconds: a solve budget has no finer detail. */
export function formatDurationS(seconds: number): string {
  const total = Math.round(Math.max(0, seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours)
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(secs).padStart(2, "0")}s`;
  if (minutes) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}
