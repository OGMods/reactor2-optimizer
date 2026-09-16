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

/** Index `n` represents 10^(3n). Exported so the table itself is testable. */
export const SUFFIXES = buildSuffixes();

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
  /*
   * NaN is tested before the infinity branch, because it is neither finite nor
   * greater than zero and would otherwise be spelled "-∞" — a figure that is
   * merely unknown reported as one that is known and enormous.
   */
  if (Number.isNaN(n)) return "NaN";
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
 * The same figure, spelled for a filename. Both writers of one use it — the
 * app naming a saved picture, and the CLI naming the blueprint it writes into
 * `solves/` — so the same board saved from either sorts beside itself.
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
 *   fraction becomes a second whole tier after a hyphen. That also makes
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
// Parsing
// ---------------------------------------------------------------------------
const SUFFIX_INDEX: Record<string, number> = Object.fromEntries(
  SUFFIXES.map((suffix, idx) => [suffix, idx]),
);

/**
 * The inverse of `formatNumber`, for figures typed or pasted by a person:
 * a plain number, e-notation, or the game's own suffix ladder.
 *
 *   "1.5e30" → 1.5e30
 *   "20K"    → 20000
 *   "1.5AA"  → 1.5e15
 *
 * Returns `NaN` for anything it cannot read, so callers test the result rather
 * than catching. The suffix is matched case-insensitively because the ladder
 * is upper-case and nobody types it that way.
 */
export function parseHugeNumber(input: string | number): number {
  if (typeof input === "number") return input;

  const s = String(input).trim().toUpperCase();
  if (!s || s === "NAN") return NaN;

  // A plain float or standard e-notation. `Number` accepts leading/trailing
  // space and rejects an empty string, both of which are already handled.
  const plain = Number(s);
  if (!Number.isNaN(plain)) return plain;

  const match = /^(-?[\d.]+)\s*([A-Z]+)$/.exec(s);
  if (!match) return NaN;

  const num = Number(match[1]);
  if (Number.isNaN(num)) return NaN;

  const idx = SUFFIX_INDEX[match[2]];
  if (idx === undefined) return NaN;

  return num * Math.pow(10, idx * 3);
}
