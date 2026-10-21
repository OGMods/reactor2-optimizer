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
 *   Each island still gets its own slice of the budget, so this
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

import { ANOMALIES, DEFAULT_ANOMALY_ID } from "../src/data/anomalies";
import {
  BUILDINGS,
  allUpgradesUnlocked,
  findBuilding,
} from "../src/data/buildings";
import { getEffectiveBuildings } from "../src/data/effectiveBuildings";
import {
  MAX_UPGRADE_STEPS,
  resolveUpgradePlan,
  type UpgradeStep,
} from "../src/data/upgradePlan";
import { prestigeScales } from "../src/data/prestige";
import {
  blueprintKey,
  blueprintRules,
  decodeBlueprint,
  encodeBlueprint,
  placementTiers,
} from "../src/encoding/blueprint";
import { verify } from "../src/solver/report";
import {
  buildOptimizationResult,
  fitBudgetsToPool,
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
  anomalyLine,
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

// The optional tail is the anomaly tag `anomalyTag` appends. It has to be
// matched here rather than left to a looser pattern elsewhere: this regex is what
// finds the previous ids, so a tagged filename it could not see would restart
// numbering at 1 and overwrite an untagged run.
const TEST_FILENAME_RE = /^test_(\d+)(?:_[a-z_]+)?\.txt$/;
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

/**
 * What the player holds beyond the unlocked tiers: Time Lab research and an
 * upgrade plan. Carried as one value so each solve path takes one more
 * argument rather than two.
 */
interface Progress {
  /** Research levels, keyed and indexed like the player's own record. */
  research: Record<string, number>;
  /** The plan's rosters before its target, today's first — `resolveUpgradePlan`'s `along`. */
  upgradePlan: Record<string, number>[];
}

// --- Solving -------------------------------------------------------------

/**
 * One solve, with the islands farmed out to `pool` when there is more than one.
 *
 * Islands never interact, so each one gets its own slice of the budget
 * (`islandBudgetsS`) either way. Not the same search, though: when every island
 * has a worker the pooled run stretches the slices until the largest is the
 * whole budget (`fitBudgetsToPool`), while the serial fallback — one island, or
 * a pool of one — keeps them summing to it. So on a board of several islands
 * the core count decides how long each one is searched.
 */
async function solveWithPool(
  grid: Tile[][],
  unlockedUpgrades: Record<string, number>,
  timeBudgetS: number,
  seed: number | undefined,
  anomalyId: AnomalyId | undefined,
  progress: Progress,
  pool: WorkerPool | null,
): Promise<OptimizationResult> {
  const plan = planSolve(
    grid,
    [...BUILDINGS],
    unlockedUpgrades,
    timeBudgetS,
    seed,
    anomalyId,
    prestigeScales(progress.research),
    progress.upgradePlan,
  );
  if (!plan || plan.islands.length < 2 || !pool || pool.size < 2)
    return solve(
      grid,
      [...BUILDINGS],
      unlockedUpgrades,
      timeBudgetS,
      {
        anomalyId,
        prestige: prestigeScales(progress.research),
        upgradePlan: progress.upgradePlan,
      },
      seed,
    );

  const results: IslandLayout[] = plan.islands.map(() => ({
    placements: [],
    powerOutput: 0,
  }));
  // When every island has a worker of its own the run lasts as long as its
  // largest slice, so the app's Quick rule stretches them to the budget;
  // `fitBudgetsToPool` checks that and leaves a run that queues alone.
  const budgetsS = fitBudgetsToPool(plan.budgetsS, timeBudgetS, 1, pool.size);

  await pool.run(
    plan.islands.map((island, i) => ({
      meta: i,
      payload: {
        kind: "island" as const,
        island,
        effectiveBuildings: plan.effectiveBuildings,
        budgetS: budgetsS[i],
        seed: plan.seeds[i],
        // The resolved definition rather than the id: the plan has already
        // resolved it, and a worker re-resolving would be a second reading of
        // the same string.
        anomaly: plan.anomaly,
        upgradeSteps: plan.upgradeSteps,
      },
    })),
    (i, result) => {
      results[i] = result as IslandLayout;
    },
  );

  return buildOptimizationResult(plan, results);
}

/**
 * A run's blueprint code — the one code writer all three CLI paths go through.
 *
 * It states the rules as well as the tiers, which a share code must: a code with
 * no rules section decodes as "rules unknown", and the app's preview then rates
 * the board under *no* anomaly and no research. A coast-hugging Tidal layout
 * would come back at roughly its baseline figure with nothing on screen saying
 * why.
 *
 * The research table is the one the run solved under — a `--code` board's own,
 * otherwise **empty rather than absent**, which is a truthful statement and not
 * the same claim: "the author had no research" is exactly what the CLI knows
 * about a shipped map. `DEFAULT_ANOMALY_ID` spells the absence of `--anomaly`
 * for the same reason — "no anomaly" is a real choice, and stating it is what
 * keeps a reader off their own.
 */
async function codeFor(
  grid: Tile[][],
  result: OptimizationResult,
  anomalyId: AnomalyId | undefined,
  research: Record<string, number>,
): Promise<string> {
  return encodeBlueprint(
    grid,
    result.placements,
    placementTiers(result.placements),
    blueprintRules(anomalyId ?? DEFAULT_ANOMALY_ID, research),
  );
}

/**
 * The anomaly marked into a filename, or nothing under the base rules.
 *
 * The same argument `anomalyLine` makes about a header, applied to the artifact:
 * `solves/` accumulates across runs and a code says nothing from the outside, so
 * a directory of three timelines is unreadable without opening every file. The
 * precedent is `formatNumberForFilename` and the app's `layoutImageFilename` —
 * the figure that identifies an artifact belongs in its name.
 *
 * The full id rather than an abbreviation of it: there is no second table to
 * keep in step, and it is what `--anomaly` takes, so a filename can be pasted
 * back into the flag that produced it. Empty under `none`, so every existing
 * filename is unchanged.
 */
function anomalyTag(anomalyId: AnomalyId | undefined): string {
  return !anomalyId || anomalyId === DEFAULT_ANOMALY_ID ? "" : `_${anomalyId}`;
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
  progress: Progress,
  pool: WorkerPool | null,
): Promise<SolveRun[]> {
  const { grid } = await decodeBlueprint(gameMap.code);
  const roster = getEffectiveBuildings(
    BUILDINGS,
    unlockedUpgrades,
    prestigeScales(progress.research),
  );
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
      progress,
      pool,
    );
    results.push({
      runNum,
      result,
      elapsedS: (Date.now() - started) / 1000,
      code: await codeFor(grid, result, anomalyId, progress.research),
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
  progress: Progress,
  pool: WorkerPool | null,
): Promise<void> {
  const testId = nextOutputId(TEST_FILENAME_RE);
  const filename = `test_${testId}${anomalyTag(anomalyId)}.txt`;
  const runs = await solveMap(
    gameMap,
    unlockedUpgrades,
    1,
    timeLimitS,
    `Solving map ${gameMap.num} (test ID: ${testId})`,
    () => filename,
    seed,
    anomalyId,
    progress,
    pool,
  );

  const run = runs[0];
  const rules = anomalyLine(anomalyId);
  if (rules) console.log(rules);
  printSummary(run.result, run.elapsedS);
  console.log(`Blueprint: ${run.code}`);
  console.log(`Test output written to: ${path.join(SOLVES_DIR, filename)}\n`);
}

async function runComparison(
  gameMaps: CliMap[],
  unlockedUpgrades: Record<string, number>,
  runs: number,
  timeLimitS: number,
  seed: number | undefined,
  anomalyId: AnomalyId | undefined,
  progress: Progress,
  pool: WorkerPool | null,
): Promise<void> {
  const sessionId = nextOutputId(ISLAND_FILENAME_RE);
  const tag = anomalyTag(anomalyId);

  for (let idx = 0; idx < gameMaps.length; idx++) {
    const gameMap = gameMaps[idx];
    const filenameFor = (run: SolveRun, bestPower: number): string => {
      if (run.result.totalPower >= bestPower)
        return `${sessionId}_island_${gameMap.num}_${run.runNum}_${formatNumberForFilename(bestPower)}${tag}.txt`;
      const diff = formatNumberForFilename(bestPower - run.result.totalPower);
      return `${sessionId}_island_${gameMap.num}_${run.runNum}_minus_${diff}${tag}.txt`;
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
      progress,
      pool,
    );

    printRunComparison(sessionId, gameMap.num, mapRuns, anomalyId);
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
  progress: Progress,
  args: Args,
): Promise<SessionReport> {
  const { grid } = await decodeBlueprint(gameMap.code);
  const roster = getEffectiveBuildings(
    BUILDINGS,
    unlockedUpgrades,
    prestigeScales(progress.research),
  );
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
    anomalyId: args.anomalyId,
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
        prestige: prestigeScales(progress.research),
        upgradePlan: progress.upgradePlan,
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
          code: await codeFor(grid, result, args.anomalyId, progress.research),
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
  progress: Progress,
  args: Args,
): Promise<number> {
  for (const gameMap of gameMaps) {
    const report = await runSession(gameMap, unlockedUpgrades, progress, args);
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
  /** Tiers held below the last, 0-based like `unlockedUpgrades`. */
  tiers: Record<string, number>;
  /** The upgrade plan, in buying order. */
  plan: UpgradeStep[];
  /** A pasted board to solve instead of a shipped map. */
  code: string | undefined;
}

const USAGE = `usage: solve [-h] [--map NUM] [--all] [--runs RUNS] [--time TIME_LIMIT_S]
             [--attempts N] [--top K] [--workers N] [--seed SEED]
             [--anomaly ID] [--tier ID=LEVEL] [--plan ID=LEVEL]
             [--code BLUEPRINT]

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
  --tier ID=LEVEL
                 hold a building below its last tier (repeatable). LEVEL counts
                 from 1, like the app's tier buttons; every building not named
                 is fully upgraded
  --plan ID=LEVEL
                 one step of an upgrade plan (repeatable, in buying order, at
                 most ${MAX_UPGRADE_STEPS}): the run scores at the tiers after the last
                 step and keeps only layouts that also run at --tier's tiers
                 and after each step, exactly as the app's upgrade plan does
  --code BLUEPRINT
                 solve a pasted board instead of a shipped map. Its rules
                 section, when it has one, supplies the anomaly (unless
                 --anomaly is given) and the Time Lab research; placements
                 on it are ignored

This renders no picture. Each run writes its blueprint code to solves/, named
after what it found and after the anomaly it found it under; paste one into the
app's Import to see the board. The code states its tiers and its anomaly, so the
app rates the layout the way this run did.`;

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
    tiers: {},
    plan: [],
    code: undefined,
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

  // `ID=LEVEL`, with LEVEL 1-based as typed and 0-based as carried.
  const asUpgradeStep = (flag: string, raw: string): UpgradeStep => {
    const [buildingId, levelRaw] = raw.split("=");
    const def = findBuilding(buildingId);
    if (!def || levelRaw === undefined)
      throw new Error(`argument ${flag}: expected ID=LEVEL, got '${raw}'`);
    const level = asInt(flag, levelRaw);
    if (level < 1 || level > def.levels.length)
      throw new Error(
        `argument ${flag}: ${buildingId} has levels 1-${def.levels.length}, got ${level}`,
      );
    return { buildingId, level: level - 1 };
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
      case "--code":
        [raw, i] = takeValue(flag, inline, i);
        args.code = raw;
        break;
      case "--tier":
      case "--plan": {
        [raw, i] = takeValue(flag, inline, i);
        const step = asUpgradeStep(flag, raw);
        if (flag === "--tier") args.tiers[step.buildingId] = step.level;
        else args.plan.push(step);
        break;
      }
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
  let research: Record<string, number> = {};
  if (args.code !== undefined) {
    let rules;
    try {
      ({ rules } = await decodeBlueprint(args.code));
    } catch (err) {
      console.error(`--code: ${(err as Error).message}`);
      return 1;
    }
    selected = [{ num: -1, name: "pasted board", code: args.code }];
    if (rules) {
      research = rules.research;
      args.anomalyId ??= ANOMALIES.find((a) => a.id === rules.anomalyId)?.id;
    }
  } else if (args.all) {
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

  if (args.plan.length > MAX_UPGRADE_STEPS) {
    console.error(`--plan takes at most ${MAX_UPGRADE_STEPS} steps`);
    return 1;
  }
  const { target: unlockedUpgrades, along: upgradePlan } = resolveUpgradePlan(
    BUILDINGS,
    { ...allUpgradesUnlocked(), ...args.tiers },
    args.plan,
  );
  if (args.plan.length && upgradePlan.length === 0) {
    console.error("--plan raises nothing: no step is above its --tier");
    return 1;
  }
  const progress: Progress = { research, upgradePlan };
  if (Object.keys(research).length)
    console.log(
      `Research: ${Object.entries(research)
        .map(([id, level]) => `${id} ${level + 1}`)
        .join(", ")}`,
    );
  if (upgradePlan.length)
    console.log(
      `Upgrade plan: ${args.plan.map((s) => `${s.buildingId} -> ${s.level + 1}`).join(", ")}\n`,
    );

  if (args.attempts !== undefined) {
    if (args.attempts < 1) {
      console.error("--attempts must be at least 1");
      return 1;
    }
    if (args.workers !== undefined && args.workers < 1) {
      console.error("--workers must be at least 1");
      return 1;
    }
    return runSessions(selected, unlockedUpgrades, progress, args);
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
        progress,
        pool,
      );
    else
      await runSingle(
        selected[0],
        unlockedUpgrades,
        args.timeLimitS,
        args.seed,
        args.anomalyId,
        progress,
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
