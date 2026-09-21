/**
 * Solve a board from the terminal.
 *
 *     npm run solve                             # one 30s run on island 1
 *     npm run solve -- --map 3 --time 60        # one 60s run on island 3
 *     npm run solve -- --all --runs 3           # 3 runs on every island
 *     npm run solve -- --map 7 --attempts 100 --time 20
 *     npm run solve -- --help
 *
 * This is the argument surface the retired Python reference's `main.py` had,
 * run against the engine this package ships. It renders nothing: there is no
 * headless peer of the app's renderer, and a picture is the one form of a
 * layout you cannot paste back into anything. Each run writes its **blueprint
 * code** to `solves/` instead, under the same filename scheme the reference
 * used for its PNGs (`3_island_7_2_91AC-296AB.txt`). Paste one into the app's
 * Import to see the board.
 *
 * Cores are spent on two axes, and which one depends on the flags:
 *
 * - **A run** (`--runs`, or no flags) farms its islands out to a worker pool.
 *   Each island still gets its own proportional slice of the budget, so this
 *   changes wall clock and not the search. On the shipped maps it buys little —
 *   most are one large landmass plus a few 2-3 tile scraps, so one island holds
 *   ~95% of the budget.
 * - **A session** (`--attempts`) runs whole attempts in the pool with islands
 *   serial inside each. The pool already owns the cores, and a nested pool per
 *   island would oversubscribe the machine.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ANOMALIES,
  DEFAULT_ANOMALY_ID,
  getAnomaly,
} from "../src/data/anomalies";
import { BUILDINGS, allUpgradesUnlocked } from "../src/data/buildings";
import { getEffectiveBuildings } from "../src/data/effectiveBuildings";
import {
  blueprintKey,
  decodeBlueprint,
  encodeBlueprint,
  placementTiers,
} from "../src/encoding/blueprint";
import { verify } from "../src/solver/report";
import {
  buildOptimizationResult,
  planSolve,
  solve,
} from "../src/solver/solver";
import type {
  AnomalyId,
  IslandLayout,
  OptimizationResult,
  Tile,
} from "../src/solver/types";
import { formatNumberForFilename } from "../src/utils/formatters";
import { Leaderboard } from "./leaderboard";
import { DEFAULT_MAP_NUM, MAPS, MAPS_BY_NUM, type CliMap } from "./maps";
import { WorkerPool } from "./pool";
import {
  printRunComparison,
  printSessionReport,
  printSummary,
  sessionHeader,
  statusBlock,
  type Candidate,
  type SessionReport,
  type SolveRun,
} from "./report";
import {
  clearProgress,
  clearStatus,
  updateProgress,
  updateStatus,
} from "./status";

/**
 * Where a run's blueprint code lands: `solves/` under whatever directory the
 * CLI was invoked from.
 *
 * Relative to the *caller*, not to this file. Resolved against the module the
 * built package would write into its own `dist/`, and an installed one into
 * somebody's `node_modules`.
 */
const SOLVES_DIR = path.join(process.cwd(), "solves");

/**
 * Bundling rewrites this module's extension but not a string inside it, so the
 * worker is named from whichever form is running: `.ts` from source, `.js`
 * from `dist/`.
 */
const WORKER_URL = new URL(
  import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js",
  import.meta.url,
);

const DEFAULT_TIME_LIMIT_S = 30.0;
const DEFAULT_TOP_N = 3;

/**
 * Stride between per-run and per-attempt seeds. Each stays individually
 * reproducible under `--seed` without being a copy of its neighbour, and the
 * gap clears the per-island `+i` offsets `planSolve` applies inside one solve.
 */
const SEED_STRIDE = 100003;

const TEST_FILENAME_RE = /^test_(\d+)\.txt$/;
const ISLAND_FILENAME_RE = /^(\d+)_island_\d+_\d+.*\.txt$/;

function nextOutputId(pattern: RegExp): number {
  if (!fs.existsSync(SOLVES_DIR)) return 1;
  const ids = fs
    .readdirSync(SOLVES_DIR)
    .map((name) => pattern.exec(name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
  return ids.length ? Math.max(...ids) + 1 : 1;
}

function writeArtifact(filename: string, code: string): string {
  fs.mkdirSync(SOLVES_DIR, { recursive: true });
  const target = path.join(SOLVES_DIR, filename);
  fs.writeFileSync(target, code + "\n");
  return target;
}

function offsetSeed(
  seed: number | undefined,
  index: number,
): number | undefined {
  if (seed === undefined) return undefined;
  return (seed + index * SEED_STRIDE) >>> 0;
}

// --- Solving -------------------------------------------------------------

/**
 * One solve, with the islands farmed out to `pool` when there is more than one.
 *
 * Islands never interact, so this is the same search either way — each island
 * still gets its own proportional slice of the budget. Only the wall clock
 * changes: concurrently it is ~max(slice) instead of the whole budget.
 */
async function solveWithPool(
  grid: Tile[][],
  unlockedUpgrades: Record<string, number>,
  timeBudgetS: number,
  seed: number | undefined,
  anomalyId: AnomalyId | undefined,
  pool: WorkerPool | null,
): Promise<OptimizationResult> {
  const plan = planSolve(
    grid,
    [...BUILDINGS],
    unlockedUpgrades,
    timeBudgetS,
    seed,
    anomalyId,
  );
  if (!plan || plan.islands.length < 2 || !pool || pool.size < 2)
    return solve(
      grid,
      [...BUILDINGS],
      unlockedUpgrades,
      timeBudgetS,
      { anomalyId },
      seed,
    );

  const results: IslandLayout[] = plan.islands.map(() => ({
    placements: [],
    powerOutput: 0,
  }));

  await pool.run(
    plan.islands.map((island, i) => ({
      meta: i,
      payload: {
        kind: "island" as const,
        island,
        effectiveBuildings: plan.effectiveBuildings,
        budgetS: plan.budgetsS[i],
        seed: plan.seeds[i],
        // The resolved definition rather than the id: the plan has already
        // resolved it, and a worker re-resolving would be a second reading of
        // the same string.
        anomaly: plan.anomaly,
      },
    })),
    (i, result) => {
      results[i] = result as IslandLayout;
    },
  );

  return buildOptimizationResult(plan, results);
}

async function codeFor(
  grid: Tile[][],
  result: OptimizationResult,
): Promise<string> {
  return encodeBlueprint(
    grid,
    result.placements,
    placementTiers(result.placements),
  );
}

async function solveMap(
  gameMap: CliMap,
  unlockedUpgrades: Record<string, number>,
  runs: number,
  timeLimitS: number,
  label: string,
  filenameFor: (run: SolveRun, bestPower: number) => string,
  seed: number | undefined,
  anomalyId: AnomalyId | undefined,
  pool: WorkerPool | null,
): Promise<SolveRun[]> {
  const { grid } = await decodeBlueprint(gameMap.code);
  const roster = getEffectiveBuildings(BUILDINGS, unlockedUpgrades);
  const results: SolveRun[] = [];

  for (let runNum = 1; runNum <= runs; runNum++) {
    updateProgress(`${label} | Run ${runNum}/${runs}...`);
    const started = Date.now();
    const result = await solveWithPool(
      grid,
      unlockedUpgrades,
      timeLimitS,
      offsetSeed(seed, runNum - 1),
      anomalyId,
      pool,
    );
    results.push({
      runNum,
      result,
      elapsedS: (Date.now() - started) / 1000,
      code: await codeFor(grid, result),
    });
  }

  const bestPower = Math.max(...results.map((r) => r.result.totalPower));
  for (const run of results)
    writeArtifact(filenameFor(run, bestPower), run.code);
  clearProgress();

  const best = results.reduce((a, b) =>
    b.result.totalPower > a.result.totalPower ? b : a,
  );
  verify(grid, roster, best.result);
  return results;
}

async function runSingle(
  gameMap: CliMap,
  unlockedUpgrades: Record<string, number>,
  timeLimitS: number,
  seed: number | undefined,
  anomalyId: AnomalyId | undefined,
  pool: WorkerPool | null,
): Promise<void> {
  const testId = nextOutputId(TEST_FILENAME_RE);
  const runs = await solveMap(
    gameMap,
    unlockedUpgrades,
    1,
    timeLimitS,
    `Solving map ${gameMap.num} (test ID: ${testId})`,
    () => `test_${testId}.txt`,
    seed,
    anomalyId,
    pool,
  );

  const run = runs[0];
  // Named only when there is one, so the ordinary line-up is unchanged. The
  // power figures mean something different under each set of rules, and a
  // `solves/` directory of codes solved under three timelines otherwise says
  // nothing about which is which.
  if (anomalyId && anomalyId !== DEFAULT_ANOMALY_ID)
    console.log(`Anomaly:                ${getAnomaly(anomalyId).name}`);
  printSummary(run.result, run.elapsedS);
  console.log(`Blueprint: ${run.code}`);
  console.log(
    `Test output written to: ${path.join(SOLVES_DIR, `test_${testId}.txt`)}\n`,
  );
}

async function runComparison(
  gameMaps: CliMap[],
  unlockedUpgrades: Record<string, number>,
  runs: number,
  timeLimitS: number,
  seed: number | undefined,
  anomalyId: AnomalyId | undefined,
  pool: WorkerPool | null,
): Promise<void> {
  const sessionId = nextOutputId(ISLAND_FILENAME_RE);

  for (let idx = 0; idx < gameMaps.length; idx++) {
    const gameMap = gameMaps[idx];
    const filenameFor = (run: SolveRun, bestPower: number): string => {
      if (run.result.totalPower >= bestPower)
        return `${sessionId}_island_${gameMap.num}_${run.runNum}_${formatNumberForFilename(bestPower)}.txt`;
      const diff = formatNumberForFilename(bestPower - run.result.totalPower);
      return `${sessionId}_island_${gameMap.num}_${run.runNum}_minus_${diff}.txt`;
    };

    const mapRuns = await solveMap(
      gameMap,
      unlockedUpgrades,
      runs,
      timeLimitS,
      `Map ${gameMap.num} [${idx + 1}/${gameMaps.length}]`,
      filenameFor,
      seed,
      anomalyId,
      pool,
    );

    printRunComparison(sessionId, gameMap.num, mapRuns);
    const best = mapRuns.reduce((a, b) =>
      b.result.totalPower > a.result.totalPower ? b : a,
    );
    printSummary(best.result, best.elapsedS);
  }
}

// --- Batch sessions ------------------------------------------------------

function workerCount(attempts: number, requested?: number): number {
  const available = requested ?? os.cpus().length ?? 1;
  return Math.max(1, Math.min(attempts, available));
}

async function runSession(
  gameMap: CliMap,
  unlockedUpgrades: Record<string, number>,
  args: Args,
): Promise<SessionReport> {
  const { grid } = await decodeBlueprint(gameMap.code);
  const roster = getEffectiveBuildings(BUILDINGS, unlockedUpgrades);
  const attempts = args.attempts!;
  const inFlight = workerCount(attempts, args.workers);
  const board = new Leaderboard(args.top);

  const report: SessionReport = {
    gameMap,
    attemptsRequested: attempts,
    timeLimitS: args.timeLimitS,
    estimatedMaxPower: 0,
    topN: args.top,
    workers: inFlight,
    powers: [],
    top: [],
    elapsedS: 0,
    interrupted: false,
  };

  console.log(sessionHeader(report));

  const pool = new WorkerPool(WORKER_URL, inFlight);
  const onSigint = () => {
    report.interrupted = true;
    pool.stop();
  };
  process.on("SIGINT", onSigint);

  const startedMs = Date.now();
  // `encodeBlueprint` is async and the result callback is not, so each landed
  // layout is filed through a promise chain: the board stays live for the
  // status line without two attempts encoding into it at once.
  let filing: Promise<void> = Promise.resolve();

  await pool.run(
    Array.from({ length: attempts }, (_, i) => ({
      meta: i + 1,
      payload: {
        kind: "attempt" as const,
        grid,
        unlockedUpgrades,
        timeLimitS: args.timeLimitS,
        seed: offsetSeed(args.seed, i),
        anomalyId: args.anomalyId,
      },
    })),
    (attempt, raw) => {
      const result = raw as OptimizationResult;
      verify(grid, roster, result);
      report.powers.push(result.totalPower);
      // A true upper bound for this grid and roster, so it is the same number
      // every attempt; taking the max just avoids trusting that.
      report.estimatedMaxPower = Math.max(
        report.estimatedMaxPower,
        result.theoreticalMaxPower,
      );

      filing = filing.then(async () => {
        const candidate: Candidate = {
          power: result.totalPower,
          attempt,
          activeTiles: result.activeTilesCount,
          code: await codeFor(grid, result),
          key: blueprintKey(grid, result.placements),
        };
        board.offer(candidate);
        updateStatus(statusBlock(report, board.best, startedMs));
      });
    },
  );

  process.off("SIGINT", onSigint);
  await pool.terminate();
  await filing;
  clearStatus();

  if (report.interrupted)
    console.log("Stopped. Reporting what the session found so far.\n");

  report.elapsedS = (Date.now() - startedMs) / 1000;
  report.top = board.entries;
  return report;
}

async function runSessions(
  gameMaps: CliMap[],
  unlockedUpgrades: Record<string, number>,
  args: Args,
): Promise<number> {
  for (const gameMap of gameMaps) {
    const report = await runSession(gameMap, unlockedUpgrades, args);
    printSessionReport(report);
    // Ctrl-C stops the session it was pressed in; it does not mean "move on to
    // the next map", which on `--all` would be another half hour away.
    if (report.interrupted) return 130;
  }
  return 0;
}

// --- CLI -----------------------------------------------------------------

interface Args {
  maps: number[];
  all: boolean;
  runs: number;
  timeLimitS: number;
  attempts: number | undefined;
  top: number;
  workers: number | undefined;
  seed: number | undefined;
  anomalyId: AnomalyId | undefined;
}

const USAGE = `usage: solve [-h] [--map NUM] [--all] [--runs RUNS] [--time TIME_LIMIT_S]
             [--attempts N] [--top K] [--workers N] [--seed SEED]
             [--anomaly ID]

Decode a map, solve it, and report on the result.

options:
  -h, --help     show this help message and exit
  --map NUM      map number to solve (repeatable). Available: ${MAPS.map((m) => m.num).join(", ")}
  --all          solve every map
  --runs RUNS    runs per map; more than one prints a best-of comparison (default: 1)
  --time TIME    time budget per run in seconds (default: ${DEFAULT_TIME_LIMIT_S})
  --attempts N   run a batch session instead: N solves per map, and a
                 leaderboard of blueprint codes at the end
  --top K        how many distinct layouts a batch session reports (default: ${DEFAULT_TOP_N})
  --workers N    how many attempts a batch session runs at once
                 (default: every core, ${os.cpus().length} here)
  --seed SEED    base seed for the search's random stream; narrows run-to-run
                 variance for debugging (stage deadlines remain wall-clock, so
                 runs are not bit-identical)
  --anomaly ID   the timeline's anomaly (default: ${DEFAULT_ANOMALY_ID}).
                 One of: ${ANOMALIES.map((a) => a.id).join(", ")}.
                 Only the rules the solver implements take effect; the rest are
                 accepted and ignored, exactly as in the app.

This renders no picture. Each run writes its blueprint code to solves/, named
after what it found; paste one into the app's Import to see the board.`;

function parseArgs(argv: string[]): Args | null {
  const args: Args = {
    maps: [],
    all: false,
    runs: 1,
    timeLimitS: DEFAULT_TIME_LIMIT_S,
    attempts: undefined,
    top: DEFAULT_TOP_N,
    workers: undefined,
    seed: undefined,
    anomalyId: undefined,
  };

  const takeValue = (
    flag: string,
    inline: string | undefined,
    i: number,
  ): [string, number] => {
    if (inline !== undefined) return [inline, i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`argument ${flag}: expected one argument`);
    return [value, i + 1];
  };

  const asInt = (flag: string, raw: string): number => {
    const n = Number(raw);
    if (!Number.isInteger(n))
      throw new Error(`argument ${flag}: invalid int value: '${raw}'`);
    return n;
  };

  const asFloat = (flag: string, raw: string): number => {
    const n = Number(raw);
    if (!Number.isFinite(n))
      throw new Error(`argument ${flag}: invalid float value: '${raw}'`);
    return n;
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    let raw: string;

    switch (flag) {
      case "-h":
      case "--help":
        console.log(USAGE);
        return null;
      case "--all":
        args.all = true;
        break;
      case "--map":
        [raw, i] = takeValue(flag, inline, i);
        args.maps.push(asInt(flag, raw));
        break;
      case "--runs":
        [raw, i] = takeValue(flag, inline, i);
        args.runs = asInt(flag, raw);
        break;
      case "--time":
        [raw, i] = takeValue(flag, inline, i);
        args.timeLimitS = asFloat(flag, raw);
        break;
      case "--attempts":
        [raw, i] = takeValue(flag, inline, i);
        args.attempts = asInt(flag, raw);
        break;
      case "--top":
        [raw, i] = takeValue(flag, inline, i);
        args.top = asInt(flag, raw);
        break;
      case "--workers":
        [raw, i] = takeValue(flag, inline, i);
        args.workers = asInt(flag, raw);
        break;
      case "--seed":
        [raw, i] = takeValue(flag, inline, i);
        args.seed = asInt(flag, raw);
        break;
      case "--anomaly":
        [raw, i] = takeValue(flag, inline, i);
        // Checked here rather than left to `getAnomaly`, which is total and
        // would silently run the base rules on a typo — fine for an id off
        // localStorage, useless for one a person just typed.
        {
          const match = ANOMALIES.find((a) => a.id === raw);
          if (!match) {
            throw new Error(
              `unknown anomaly '${raw}'. One of: ${ANOMALIES.map((a) => a.id).join(", ")}`,
            );
          }
          // Taken off the table entry rather than off the argument, so what is
          // carried is an `AnomalyId` and not a string that happens to match.
          args.anomalyId = match.id;
        }
        break;
      default:
        throw new Error(`unrecognized arguments: ${token}`);
    }
  }

  return args;
}

export async function main(argv: string[]): Promise<number> {
  let args: Args | null;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`solve: error: ${(err as Error).message}`);
    return 2;
  }
  if (!args) return 0;

  let selected: CliMap[];
  if (args.all) {
    selected = MAPS;
  } else if (args.maps.length) {
    const unknown = args.maps.filter((n) => !MAPS_BY_NUM.has(n));
    if (unknown.length) {
      console.error(
        `Unknown map(s): [${unknown.join(", ")}]. Available: [${MAPS.map((m) => m.num).join(", ")}]`,
      );
      return 1;
    }
    selected = args.maps.map((n) => MAPS_BY_NUM.get(n)!);
  } else {
    selected = [MAPS_BY_NUM.get(DEFAULT_MAP_NUM)!];
  }

  const unlockedUpgrades = allUpgradesUnlocked();

  if (args.attempts !== undefined) {
    if (args.attempts < 1) {
      console.error("--attempts must be at least 1");
      return 1;
    }
    if (args.workers !== undefined && args.workers < 1) {
      console.error("--workers must be at least 1");
      return 1;
    }
    return runSessions(selected, unlockedUpgrades, args);
  }

  const pool = new WorkerPool(WORKER_URL, os.cpus().length);
  try {
    if (args.runs > 1 || selected.length > 1)
      await runComparison(
        selected,
        unlockedUpgrades,
        args.runs,
        args.timeLimitS,
        args.seed,
        args.anomalyId,
        pool,
      );
    else
      await runSingle(
        selected[0],
        unlockedUpgrades,
        args.timeLimitS,
        args.seed,
        args.anomalyId,
        pool,
      );
  } finally {
    await pool.terminate();
  }

  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
