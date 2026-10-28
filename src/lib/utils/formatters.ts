/**
 * Formatting helpers the interface needs and the solver does not.
 *
 * The game's own number ladder (`formatNumber`, `formatNumberForFilename`)
 * lives in `@reactor2/solver/formatters`, because the headless solver prints
 * the same figures and the two must spell them the same way. What is left here
 * is about the screen: how long a run took, how long ago it finished, and where
 * a tile is in the coordinates the game states.
 */

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------
/**
 * A solve's running time, as something a person reads at a glance:
 *
 *   940      → "0.9s"
 *   12480    → "12.5s"
 *   184000   → "3m 04s"
 *
 * Tenths below a minute because the clock ticks live and a whole-second
 * readout looks stalled; whole seconds above it, where tenths are noise.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;

  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}m ${secs.toString().padStart(2, "0")}s`;
}

/**
 * Rough "how long ago", for a solve restored from a previous session:
 * "just now", "6m ago", "3h ago", "2d ago".
 */
export function formatTimeAgo(
  epochMs: number,
  now: number = Date.now(),
): string {
  const seconds = Math.max(0, (now - epochMs) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * A span of game time, to its two largest units: "13d 4h", "4h 17m",
 * "4m 02s", "37s". For timeline lengths and countdowns, where the game itself
 * reads in days and hours and a countdown in minutes needs its seconds.
 */
export function formatSpan(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec.toString().padStart(2, "0")}s`;
  return `${sec}s`;
}

/**
 * A moment ahead, as a player would say it: "today 23:45", "tomorrow 06:10",
 * "Fri 14:00" within the week, then "Oct 30 14:00". In the device's own locale
 * and time zone, so the clock reads the way the phone beside it does.
 */
export function formatClockTime(
  epochMs: number,
  now: number = Date.now(),
): string {
  const at = new Date(epochMs);
  // Past the range a Date can hold it is "Invalid Date", not a moment.
  if (Number.isNaN(at.getTime())) return "—";
  const time = at.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const midnight = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(at) - midnight(new Date(now))) / 86400000);
  if (days <= 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days < 7) {
    return `${at.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  }
  const date = at.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${date} ${time}`;
}

// ---------------------------------------------------------------------------
// Tile coordinates
// ---------------------------------------------------------------------------
/**
 * A tile's position the way the *game* states it: `[x, height - y]`.
 *
 * The grid's own `y` runs downward from the top row, which is what every
 * array index in this codebase means. The game counts rows upward from the
 * bottom, so anything shown to the player is flipped here — and only here, so
 * the two conventions never mix inside the model.
 */
export function formatTileCoords(
  x: number,
  y: number,
  gridHeight: number,
): string {
  return `[${x + 1}, ${gridHeight - y}]`;
}
