/**
 * Surveys how far the search lands from the upper bound, island by island.
 *
 *     npm run survey                                  (from the repo root)
 *     npm run survey -- --time 30 --runs 5
 *     npm run survey -- --map 3 --map 7 --anomaly cryo_nexus
 *     npm run survey -- --json solves/survey.json
 *
 * Every shipped map is solved under every anomaly, `--runs` times each, and
 * every island's best is set against its own share of the bound. The report
 * ranks the islands by how much of their map's bound they leave on the table,
 * which is where search work would pay off — or where the bound is loose, which
 * this cannot tell apart on its own. The run spread is the hint: an island
 * whose runs disagree is short of time or luck, one that lands on the same
 * figure every run is either stuck in one basin or already at the true optimum
 * of a bound that is not tight.
 *
 * Islands are solved one task each through the CLI's own worker pool, with
 * the slice of `--time` `planSolve` gives them — the same budget a real run
 * spends on that island — so a figure here is a figure the app would get.
 *
 * **Every map is surveyed with its obstacles cleared.** Rocks, trees and ponds
 * are removable in the game and become grass here; water and the transformer
 * stay. Obstacles are scenery the player buys away, so the open board is the
 * one whose gap says something about the search rather than about the clutter.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WorkerPool } from "../bin/pool";
import { MAPS, MAPS_BY_NUM, type CliMap } from "../bin/maps";
import { ANOMALIES, getAnomaly } from "../src/data/anomalies";
import { BUILDINGS, allUpgradesUnlocked } from "../src/data/buildings";
import { decodeBlueprint } from "../src/encoding/blueprint";
import { estimateTotalMaxPower } from "../src/solver/island";
import { planSolve, type IslandPlan } from "../src/solver/solver";
import type {
  AnomalyId,
  IslandLayout,
  Tile,
  TileType,
} from "../src/solver/types";
import { formatNumber } from "../src/utils/formatters";

const WORKER_URL = new URL("../bin/worker.ts", import.meta.url);

/** The removable scenery. A pond is one of them, not water: see `docs/game-logic.md`. */
const OBSTACLES: ReadonlySet<TileType> = new Set([
  "rock",
  "tree1",
  "tree2",
  "pond",
]);

function clearObstacles(grid: Tile[][]): Tile[][] {
  return grid.map((row) =>
    row.map((tile) =>
      OBSTACLES.has(tile.type) ? { ...tile, type: "grass" } : tile,
    ),
  );
}

const DEFAULT_TIME_S = 15;
const DEFAULT_RUNS = 3;
const DEFAULT_TOP = 15;
const SEED_STRIDE = 100003;

/** At or above this share of its bound an island counts as solved. */
const AT_BOUND = 0.9995;

interface Args {
  maps: number[];
  anomalies: AnomalyId[];
  timeS: number;
  runs: number;
  top: number;
  workers: number;
  seed: number;
  json: string | undefined;
}

interface IslandRow {
  map: CliMap;
  anomalyId: AnomalyId;
  index: number;
  /** Top-left buildable tile on the full board, so an island can be found. */
  x: number;
  y: number;
  tiles: number;
  budgetS: number;
  bound: number;
  powers: number[];
}

interface Case {
  map: CliMap;
  anomalyId: AnomalyId;
  plan: IslandPlan;
  rows: IslandRow[];
}

const USAGE = `usage: survey [--map NUM]... [--anomaly ID]... [--time S] [--runs N]
              [--top K] [--workers N] [--seed SEED] [--json PATH]

Solve every map under every anomaly and report each island's gap to its bound.

options:
  --map NUM      map to survey (repeatable; default: every map but the blank one)
  --anomaly ID   anomaly to survey (repeatable; default: every current one,
                 so a pre-nerf variant runs only when named here).
                 One of: ${ANOMALIES.map((a) => a.id).join(", ")}
  --time S       per-map budget, split across islands as a real run splits it
                 (default: ${DEFAULT_TIME_S})
  --runs N       solves per map and anomaly; each island keeps its best (default: ${DEFAULT_RUNS})
  --top K        how many islands the ranking lists (default: ${DEFAULT_TOP})
  --workers N    islands solved at once (default: every core, ${os.cpus().length} here)
  --seed SEED    base seed (default: 1)
  --json PATH    also write every island's figures to PATH`;

function parseArgs(argv: string[]): Args | null {
  const args: Args = {
    maps: [],
    anomalies: [],
    timeS: DEFAULT_TIME_S,
    runs: DEFAULT_RUNS,
    top: DEFAULT_TOP,
    workers: os.cpus().length,
    seed: 1,
    json: undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "-h" || flag === "--help") {
      console.log(USAGE);
      return null;
    }
    const raw = argv[++i];
    if (raw === undefined) throw new Error(`${flag} expects a value`);
    const num = (): number => {
      const n = Number(raw);
      if (!Number.isFinite(n))
        throw new Error(`${flag}: '${raw}' is not a number`);
      return n;
    };

    switch (flag) {
      case "--map":
        if (!MAPS_BY_NUM.has(num())) throw new Error(`unknown map ${raw}`);
        args.maps.push(num());
        break;
      case "--anomaly": {
        const match = ANOMALIES.find((a) => a.id === raw);
        if (!match) throw new Error(`unknown anomaly '${raw}'`);
        args.anomalies.push(match.id);
        break;
      }
      case "--time":
        args.timeS = num();
        break;
      case "--runs":
        args.runs = Math.max(1, Math.floor(num()));
        break;
      case "--top":
        args.top = Math.max(1, Math.floor(num()));
        break;
      case "--workers":
        args.workers = Math.max(1, Math.floor(num()));
        break;
      case "--seed":
        args.seed = Math.floor(num());
        break;
      case "--json":
        args.json = raw;
        break;
      default:
        throw new Error(`unrecognized argument: ${flag}`);
    }
  }
  return args;
}

function topLeft(plan: IslandPlan, index: number): { x: number; y: number } {
  const island = plan.islands[index];
  let first = Infinity;
  for (let t = 0; t < island.buildable.length; t++)
    if (island.buildable[t])
      first = Math.min(first, island.originalTileIndices[t]);
  return {
    x: first % plan.originalWidth,
    y: Math.floor(first / plan.originalWidth),
  };
}

async function buildCases(args: Args): Promise<Case[]> {
  const maps = args.maps.length
    ? args.maps.map((n) => MAPS_BY_NUM.get(n)!)
    : MAPS.filter((m) => m.num !== 0);
  const anomalies = args.anomalies.length
    ? args.anomalies
    : // An older build of an anomaly (Tidal's pre-nerf build) is the same
      // rule at a different number — surveying it by default would be a
      // duplicate row reading as a second anomaly.
      ANOMALIES.filter((a) => !a.variantOf).map((a) => a.id);
  const unlocks = allUpgradesUnlocked();

  const cases: Case[] = [];
  for (const map of maps) {
    const grid = clearObstacles((await decodeBlueprint(map.code)).grid);
    for (const anomalyId of anomalies) {
      const plan = planSolve(
        grid,
        [...BUILDINGS],
        unlocks,
        args.timeS,
        undefined,
        anomalyId,
      );
      if (!plan) continue;
      const rows = plan.islands.map((island, index) => ({
        map,
        anomalyId,
        index,
        ...topLeft(plan, index),
        tiles: island.tileCount,
        budgetS: plan.budgetsS[index],
        // One island at a time through the same function the plan's total
        // comes from, so the rows sum to `plan.theoreticalMaxPower`.
        bound: estimateTotalMaxPower(
          [island],
          plan.effectiveBuildings,
          plan.anomaly,
        ),
        powers: [],
      }));
      cases.push({ map, anomalyId, plan, rows });
    }
  }
  return cases;
}

async function solveAll(cases: Case[], args: Args): Promise<void> {
  // The pool posts `meta` through the worker and back, so it comes home a
  // structured clone: an index into `rows`, never the row itself.
  const rows = cases.flatMap((c) => c.rows);
  const tasks = [];
  for (const c of cases)
    for (let run = 0; run < args.runs; run++)
      for (const row of c.rows)
        tasks.push({
          meta: rows.indexOf(row),
          payload: {
            kind: "island" as const,
            island: c.plan.islands[row.index],
            effectiveBuildings: c.plan.effectiveBuildings,
            budgetS: row.budgetS,
            seed: (args.seed + run * SEED_STRIDE + row.index) >>> 0,
            anomaly: c.plan.anomaly,
          },
        });

  // Longest first, so the pool does not end on one big island and idle cores.
  tasks.sort((a, b) => b.payload.budgetS - a.payload.budgetS);

  const totalS = tasks.reduce((s, t) => s + t.payload.budgetS, 0);
  console.log(
    `${tasks.length} island solves, ${totalS.toFixed(0)}s of search on ` +
      `${args.workers} workers (~${Math.ceil(totalS / args.workers / 60)} min)\n`,
  );

  let done = 0;
  const pool = new WorkerPool(WORKER_URL, args.workers);
  try {
    await pool.run(tasks, (i, result) => {
      rows[i].powers.push((result as IslandLayout).powerOutput);
      done++;
      if (process.stdout.isTTY)
        process.stdout.write(`\r  ${done}/${tasks.length} solved`);
    });
  } finally {
    await pool.terminate();
  }
  if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");
}

const best = (row: IslandRow): number => Math.max(...row.powers);
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const share = (power: number, bound: number): number =>
  bound > 0 ? power / bound : 1;

/** Tidal's two builds share a name, so a row names its multiplier too. */
function anomalyName(id: AnomalyId): string {
  const { name, variantLabel } = getAnomaly(id);
  return variantLabel ? `${name} ${variantLabel}` : name;
}

function pad(s: string, width: number, right = false): string {
  if (s.length >= width) return s;
  const fill = " ".repeat(width - s.length);
  return right ? fill + s : s + fill;
}

function printTable(header: string[], rows: string[][], rightFrom = 2): void {
  const widths = header.map((h, c) =>
    Math.max(h.length, ...rows.map((r) => r[c].length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, c) => pad(cell, widths[c], c >= rightFrom)).join("  ");
  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
  console.log();
}

function report(cases: Case[], args: Args): void {
  console.log(
    "Per map and anomaly, obstacles cleared (sum of each island's best run)\n",
  );
  printTable(
    ["Map", "Anomaly", "Best", "Bound", "Eff", "Lost", "Islands at bound"],
    cases.map((c) => {
      const power = c.rows.reduce((s, r) => s + best(r), 0);
      const bound = c.plan.theoreticalMaxPower;
      const atBound = c.rows.filter(
        (r) => share(best(r), r.bound) >= AT_BOUND,
      ).length;
      return [
        `${c.map.num} ${c.map.name}`,
        anomalyName(c.anomalyId),
        formatNumber(power),
        formatNumber(bound),
        pct(share(power, bound)),
        formatNumber(Math.max(0, bound - power)),
        `${atBound}/${c.rows.length}`,
      ];
    }),
  );

  // Ranked by the share of the *map's* bound an island gives up: a 2-tile
  // scrap at 50% matters less than a main landmass at 97%.
  const ranked = cases
    .flatMap((c) =>
      c.rows.map((row) => ({
        row,
        lostOfMap: (row.bound - best(row)) / (c.plan.theoreticalMaxPower || 1),
      })),
    )
    .filter(({ row }) => share(best(row), row.bound) < AT_BOUND)
    .sort((a, b) => b.lostOfMap - a.lostOfMap)
    .slice(0, args.top);

  console.log(
    `Largest gaps — the ${args.top} islands giving up the most of their map's bound\n`,
  );
  if (!ranked.length) {
    console.log("Every island reached its bound.\n");
    return;
  }
  printTable(
    [
      "Map",
      "Anomaly",
      "Island",
      "Tiles",
      "Budget",
      "Best",
      "Bound",
      "Eff",
      "Of map",
      "Run spread",
    ],
    ranked.map(({ row, lostOfMap }) => {
      const lo = Math.min(...row.powers);
      const hi = best(row);
      return [
        `${row.map.num} ${row.map.name}`,
        anomalyName(row.anomalyId),
        `#${row.index} @${row.x},${row.y}`,
        String(row.tiles),
        `${row.budgetS.toFixed(1)}s`,
        formatNumber(hi),
        formatNumber(row.bound),
        pct(share(hi, row.bound)),
        `-${pct(lostOfMap)}`,
        hi > 0 && lo < hi ? `${pct((hi - lo) / hi)}` : "none",
      ];
    }),
    3,
  );
  console.log(
    "Run spread is how far the worst run fell below the best. A spread means\n" +
      "more time or more restarts would help; none means every run found the\n" +
      "same figure — a stuck search, or a bound that is not tight there.\n",
  );
}

function writeJson(file: string, cases: Case[], args: Args): void {
  const out = {
    timeS: args.timeS,
    runs: args.runs,
    seed: args.seed,
    cases: cases.map((c) => ({
      map: c.map.num,
      name: c.map.name,
      anomaly: c.anomalyId,
      bound: c.plan.theoreticalMaxPower,
      islands: c.rows.map((r) => ({
        index: r.index,
        x: r.x,
        y: r.y,
        tiles: r.tiles,
        budgetS: r.budgetS,
        bound: r.bound,
        powers: r.powers,
      })),
    })),
  };
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${file}`);
}

async function main(argv: string[]): Promise<number> {
  let args: Args | null;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`survey: error: ${(err as Error).message}`);
    return 2;
  }
  if (!args) return 0;

  const cases = await buildCases(args);
  await solveAll(cases, args);
  report(cases, args);
  if (args.json) writeJson(args.json, cases, args);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
