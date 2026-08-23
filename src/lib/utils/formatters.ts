/**
 * Number formatting utilities for Reactor 2 Optimizer.
 *
 * Supported suffixes (each tier = ×1000):
 *   '', K, M, B, T,
 *   AA, AB, ..., AZ,
 *   BA, BB, ..., ZZ   (676 double-letter tiers → covers up to ~1e(4+676*3) = 1e2032)
 *
 * The game uses values up to ~1e30+ so we are well covered.
 */

// ---------------------------------------------------------------------------
// Suffix table
// ---------------------------------------------------------------------------
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function buildSuffixes(): string[] {
  const list: string[] = ["", "K", "M", "B", "T"];
  for (let i = 0; i < LETTERS.length; i++) {
    for (let j = 0; j < LETTERS.length; j++) {
      list.push(LETTERS[i] + LETTERS[j]);
    }
  }
  return list;
}

const SUFFIXES = buildSuffixes(); // index n → represents 10^(3n)

/**
 * Formats a (possibly huge) number to a compact string like:
 *   0        → "0"
 *   1500     → "1.50K"
 *   1.5e15   → "1.50AA"
 *   1.23e30  → "1.23AF"
 *
 * Precision rules:
 *   value ≥ 100  → integer  (e.g. "123K")
 *   value ≥ 10   → 1 decimal (e.g. "12.3K")
 *   otherwise    → 2 decimals (e.g. "1.23K")
 */
export function formatNumber(n: number): string {
  if (n === 0) return "0";
  if (!isFinite(n)) return n > 0 ? "∞" : "-∞";

  const neg = n < 0;
  const abs = Math.abs(n);

  // Tier index: each tier is 1000× the previous
  const tierIdx = Math.floor(Math.log10(abs) / 3);
  const clamped = Math.max(0, Math.min(tierIdx, SUFFIXES.length - 1));

  if (clamped === 0) {
    // Show raw value for numbers < 1000
    const raw = Math.round(abs * 100) / 100;
    return (neg ? "-" : "") + raw.toString();
  }

  const divisor = Math.pow(10, clamped * 3);
  const val = abs / divisor;

  let formatted: string;
  if (val >= 100) {
    formatted = Math.round(val).toString();
  } else if (val >= 10) {
    formatted = (Math.round(val * 10) / 10).toFixed(1);
  } else {
    formatted = (Math.round(val * 100) / 100).toFixed(2);
  }

  return (neg ? "-" : "") + formatted + SUFFIXES[clamped];
}

/**
 * The same figure, spelled for a filename. Peer: `format_for_filename` in
 * `py_solver/formatters.py`, which names every render the Python reference
 * writes into `py_solver/solves/` — this is the port, and the two must agree
 * so a board saved from the app sorts beside one rendered by the reference.
 *
 *   1500      → "1K-500"
 *   1234567   → "1M-234K"
 *   5e6       → "5M"
 *   1.23456e16 → "12AA-345T"
 *
 * Two things separate it from `formatNumber`, and both are about the medium
 * rather than the number:
 *
 * - **No `.`** — a dot in a filename reads as an extension separator, so the
 *   fraction becomes a second whole tier after an underscore. That also makes
 *   it *more* precise than the display figure rather than less: `12AA-345T`
 *   carries six digits where `12.3AA` carries three.
 * - **The minor tier is dropped when it is zero**, so a round figure is
 *   `5M` rather than `5M-0` — the trailing part only ever appears when it says
 *   something.
 *
 * Nothing below 1 has a name here: a board putting out nothing is `"0"`, and
 * so is a negative or non-finite figure, because a filename is no place to
 * start explaining one.
 */
export function formatNumberForFilename(n: number): string {
  if (!(n > 0) || !isFinite(n)) return "0";

  const tierIdx = Math.floor(Math.log10(n) / 3);
  const clamped = Math.max(0, Math.min(tierIdx, SUFFIXES.length - 1));

  const majorDivisor = Math.pow(10, clamped * 3);
  const majorVal = Math.floor(n / majorDivisor);
  const remainder = n - majorVal * majorDivisor;

  if (clamped === 0) {
    const minorVal = Math.floor(remainder);
    return minorVal > 0 ? `${majorVal}-${minorVal}` : `${majorVal}`;
  }

  const minorTier = clamped - 1;
  const minorVal = Math.floor(remainder / Math.pow(10, minorTier * 3));
  if (minorVal > 0)
    return `${majorVal}${SUFFIXES[clamped]}-${minorVal}${SUFFIXES[minorTier]}`;
  return `${majorVal}${SUFFIXES[clamped]}`;
}

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
