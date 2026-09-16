/**
 * Console reporting: everything the CLI prints, and nothing the engine needs.
 */

import { formatNumber, formatNumberForFilename } from "../src/utils/formatters";
import type { OptimizationResult } from "../src/solver/types";
import { formatDurationS, isTty } from "./status";
import type { CliMap } from "./maps";

/**
 * The same two tiers `formatNumberForFilename` spells, with a space where a
 * filename needs a hyphen.
 *
 * Derived from the shipped function rather than re-deriving the tier split, so
 * a figure reads the same on a report line as in a filename beside it.
 */
function formatNumberPair(n: number): string {
  if (Number.isNaN(n)) return "NaN";
  if (!isFinite(n)) return n > 0 ? "∞" : "-∞";
  if (n === 0) return "0";
  const body = formatNumberForFilename(Math.abs(n)).replace(/[-_]/, " ");
  return n < 0 ? `-${body}` : body;
}

function efficiency(power: number, ceiling: number): number {
  return ceiling > 0 ? (power / ceiling) * 100 : 0;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

export function printSummary(
  result: OptimizationResult,
  solveTimeS?: number,
): void {
  const pMax = result.theoreticalMaxPower;
  const totalTiles = result.activeTilesCount + result.unusedTilesCount;

  if (solveTimeS !== undefined)
    console.log(`Solve time:             ${solveTimeS.toFixed(2)}s`);
  console.log(`Total power:            ${formatNumber(result.totalPower)}`);
  console.log(`Theoretical max power:  ${formatNumber(pMax)}`);
  console.log(
    `Layout efficiency:      ${efficiency(result.totalPower, pMax).toFixed(1)}%`,
  );
  console.log(
    `Tiles:                  ${result.activeTilesCount}/${totalTiles}\n`,
  );
}

export interface SolveRun {
  runNum: number;
  result: OptimizationResult;
  elapsedS: number;
  code: string;
}

export function printRunComparison(
  sessionId: number,
  mapNum: number,
  runs: SolveRun[],
): void {
  const powers = runs.map((r) => r.result.totalPower);
  const bestPower = Math.max(...powers);
  const worstPower = Math.min(...powers);
  const spread = bestPower - worstPower;

  console.log("=".repeat(70));
  console.log(`RUN COMPARISON REPORT (ID: ${sessionId}, Map: ${mapNum})`);
  console.log("=".repeat(70));
  console.log(
    `${pad("Run #", 6)} | ${pad("Total Power", 16)} | ${pad("Active Tiles", 12)} | ${pad("Time (s)", 10)} | Status`,
  );
  console.log("-".repeat(70));

  for (const run of runs) {
    const { result } = run;
    const status =
      result.totalPower >= bestPower
        ? "[BEST]"
        : `-${formatNumber(bestPower - result.totalPower)}`;
    console.log(
      `Run ${pad(String(run.runNum), 2)} | ${pad(formatNumber(result.totalPower), 16)} | ` +
        `${pad(String(result.activeTilesCount), 12)} | ${pad(run.elapsedS.toFixed(2), 10)} | ${status}`,
    );
  }

  console.log("-".repeat(70));
  console.log(`Best Power Output : ${formatNumber(bestPower)}`);
  const pct = worstPower ? (spread / worstPower) * 100 : 0;
  console.log(
    `Max Power Delta   : ${formatNumber(spread)} (${pct.toFixed(2)}% diff)`,
  );
  console.log("=".repeat(70) + "\n");
}

// --- Batch sessions ------------------------------------------------------

export interface Candidate {
  power: number;
  attempt: number;
  activeTiles: number;
  code: string;
  key: string;
}

export interface SessionReport {
  gameMap: CliMap;
  attemptsRequested: number;
  timeLimitS: number;
  estimatedMaxPower: number;
  topN: number;
  workers: number;
  powers: number[];
  top: Candidate[];
  elapsedS: number;
  interrupted: boolean;
}

export function sessionHeader(report: SessionReport): string {
  const { gameMap, attemptsRequested: attempts } = report;
  const plan =
    `${attempts} attempt${attempts === 1 ? "" : "s"} at a ` +
    `${formatDurationS(report.timeLimitS)} budget, ${report.workers} at a time`;
  const projected = (attempts * report.timeLimitS) / report.workers;
  return (
    `Map ${gameMap.num} (${gameMap.name}): ${plan}, top ${report.topN} kept.\n` +
    `Roughly ${formatDurationS(projected)}. Ctrl-C stops and reports.\n`
  );
}

export function statusBlock(
  report: SessionReport,
  best: Candidate | undefined,
  startedMs: number,
): string[] {
  const last = report.powers.length
    ? report.powers[report.powers.length - 1]
    : 0;
  const done = report.powers.length;
  // Measured, not multiplied out: mean seconds per completed attempt already
  // has the worker count and the pool's startup cost in it.
  const eta =
    done === 0
      ? "--"
      : formatDurationS(
          ((Date.now() - startedMs) / 1000 / done) *
            (report.attemptsRequested - done),
        );

  const bestFragment = best
    ? `best ${formatNumberPair(best.power)} (${efficiency(best.power, report.estimatedMaxPower).toFixed(1)}%)`
    : "best --";

  // "done", because attempts land out of order: the count is how many have
  // finished, never which one just did.
  const lines = [
    `[${String(done).padStart(4)}/${report.attemptsRequested} done] ` +
      `last ${formatNumberPair(last)} | ${bestFragment} | eta ${eta}`,
  ];

  if (best && isTty())
    lines.push(
      `  attempt ${best.attempt}, ${best.activeTiles} tiles: ${best.code}`,
    );

  return lines;
}

export function printSessionReport(report: SessionReport): void {
  const rule = "=".repeat(78);

  console.log(rule);
  console.log(
    `SESSION REPORT -- map ${report.gameMap.num} (${report.gameMap.name})` +
      (report.interrupted ? "  [interrupted]" : ""),
  );
  console.log(rule);
  console.log(`Estimated max: ${formatNumberPair(report.estimatedMaxPower)}`);

  if (!report.top.length) {
    console.log("\nNo attempts completed.\n");
    return;
  }

  for (const entry of report.top) {
    console.log(`\n${formatNumberPair(entry.power)}`);
    console.log(entry.code);
  }

  console.log();
}
