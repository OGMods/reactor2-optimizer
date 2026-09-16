/**
 * Exports the golden fixtures `tests/fixtures.test.ts` replays.
 *
 *     npm run fixtures                    (from the repo root)
 *     npm run fixtures -w @reactor2/solver
 *
 * Each case is written to `packages/solver/fixtures/<name>.json`. Re-running
 * against an unchanged solver reproduces every file byte for byte; that
 * property is what makes a diff in `fixtures/` a trustworthy signal that solver
 * behaviour moved, rather than noise to be squinted at.
 *
 * Terrain is carried as a blueprint code — the same format the maps and the
 * app's share codes use. The suite decodes the code and never re-encodes to
 * compare strings, which matters: DEFLATE is only required to round-trip, so
 * two implementations may spell the same board differently. See the "codes are
 * not comparable, payloads are" note in `encoding/blueprint.ts`.
 *
 * WHY THIS DOES NOT CALL solve()
 * ------------------------------
 * `solve()` is wall-clock budgeted at every stage, so a fixed seed narrows
 * run-to-run variance without eliminating it: the same seed and grid produce a
 * different layout depending on how many steps fit in the budget on the day.
 * That is correct for production and useless for a golden fixture.
 *
 * So the fixtures replay the deterministic core instead — seed construction,
 * then the annealing walk driven by `maxSteps` rather than a deadline with a
 * fixed `Rng`, then the standard prune. That is `replayIslandDeterministic`,
 * which mirrors `solveIsland`'s stage order for the stages it can replay and
 * deliberately omits the composition-retarget and right-sizing stages: those
 * are `while (now < deadline)` loops with no step cap, and there is no way to
 * replay them deterministically without changing the solver.
 *
 * TWO EXPECTATION LAYERS, AND WHY
 * -------------------------------
 * `expected` is exported with the annealing walk DISABLED (`maxSteps = 0`) and
 * is asserted exactly. `annealed` runs the walk and is asserted only within a
 * relative tolerance.
 *
 * The split was originally forced by a cross-language float difference: these
 * fixtures were produced by a Python reference solver, and CPython's libm and
 * V8 disagree by 1 ULP on the `pow`/`exp` the Metropolis test calls — enough to
 * flip a single acceptance, after which the two walks diverge permanently.
 * That reference is retired and both sides are now V8, so the layers could in
 * principle both be exact. The tolerance stays because the same argument still
 * applies across *V8 versions*: nothing in IEEE-754 requires `pow` or `exp` to
 * be correctly rounded, and a Node upgrade is free to move one by an ULP.
 *
 * The rest of the solver — seed construction, `simulateIsland`,
 * `runDistribution`, `stabilize`, pruning, island splitting and placement
 * remapping — is pure arithmetic and comparison on doubles, which is
 * bit-identical everywhere. That is exactly the set `maxSteps = 0` exercises,
 * which is why `expected` is pinned exactly and must stay that way.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BUILDINGS, allUpgradesUnlocked } from "../src/data/buildings";
import { decodeBlueprint, encodeBlueprint } from "../src/encoding/blueprint";
import { TILE_CHAR_MAP, makeGrid } from "../src/grid";
import { countGrassTiles } from "../src/solver/island";
import { replayIslandDeterministic } from "../src/solver/placementSearch";
import { buildOptimizationResult, planSolve } from "../src/solver/solver";
import type { TileType } from "../src/solver/types";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures",
);

/** Floats are rounded to this many decimals so the JSON is platform-stable. */
const FLOAT_PRECISION = 9;

const CHAR_BY_TILE_TYPE = Object.fromEntries(
  Object.entries(TILE_CHAR_MAP).map(([char, type]) => [type, char]),
) as Record<TileType, string>;

interface FixtureCase {
  name: string;
  why: string;
  rows: string[];
  seed: number;
  maxSteps: number;
}

const CASES: FixtureCase[] = [
  {
    name: "single_tile",
    why: "Degenerate island; catches empty-result and off-by-one handling",
    rows: ["G"],
    seed: 42,
    maxSteps: 200,
  },
  {
    name: "small_grid_seed42",
    why: "Baseline; one island, small enough to diff by hand",
    rows: ["GGG", "GGG", "GGG"],
    seed: 42,
    maxSteps: 2000,
  },
  {
    name: "two_island_seed7",
    why: "Exercises remapPlacements -- the highest-risk port surface",
    rows: ["GGG.GGG", "GGG.GGG", "GGG.GGG"],
    seed: 7,
    maxSteps: 2000,
  },
  {
    name: "three_island_uneven",
    why: "Islands of very different sizes; catches per-island seed derivation",
    rows: ["GG.GGGG.GGGGG", "GG.GGGG.GGGGG", "...GGGG.GGGGG", "....GG..GGGGG"],
    seed: 13,
    maxSteps: 2000,
  },
  {
    name: "no_buildable_tiles",
    why: "All-water grid; must produce the empty result, not an error",
    rows: ["....", "....", "...."],
    seed: 1,
    maxSteps: 200,
  },
  {
    name: "full_upgrades_seed1",
    why: "Largest single island and longest walk; pins max level explicitly",
    rows: ["GGGG", "GGGG", "GGGG", "GGGG"],
    seed: 1,
    maxSteps: 3000,
  },
];

function round(n: number): number {
  const factor = Math.pow(10, FLOAT_PRECISION);
  return Math.round(n * factor) / factor;
}

interface Layer {
  placements: { x: number; y: number; building_id: string }[];
  power_output: number;
  island_count: number;
}

async function buildFixture(testCase: FixtureCase) {
  const unlocked = allUpgradesUnlocked();
  const width = testCase.rows[0].length;
  const grid = makeGrid(testCase.rows);
  const code = await encodeBlueprint(grid);

  /*
   * The code is the fixture's source of truth for terrain, so prove it decodes
   * back to the rows the case was authored with before anything depends on it.
   */
  const decoded = (await decodeBlueprint(code)).grid.map((row) =>
    row.map((tile) => CHAR_BY_TILE_TYPE[tile.type]).join(""),
  );
  if (decoded.join("\n") !== testCase.rows.join("\n")) {
    throw new Error(
      `${testCase.name}: blueprint round-trip failed: ${decoded.join("|")}`,
    );
  }

  const plan = planSolve(grid, [...BUILDINGS], unlocked, 1.0, testCase.seed);

  /*
   * Canonical order: flat tile index (y * width + x). Whatever order the search
   * produced is not reproducible and must never reach the file.
   */
  async function layer(maxSteps: number): Promise<Layer> {
    if (!plan) return { placements: [], power_output: 0, island_count: 0 };

    const solutions = [];
    for (let i = 0; i < plan.islands.length; i++) {
      solutions.push(
        await replayIslandDeterministic(
          plan.islands[i],
          plan.effectiveBuildings,
          plan.seeds[i]!,
          maxSteps,
        ),
      );
    }

    const result = buildOptimizationResult(plan, solutions);
    return {
      placements: [...result.placements]
        .sort((a, b) => a.y * width + a.x - (b.y * width + b.x))
        .map((p) => ({ x: p.x, y: p.y, building_id: p.buildingId })),
      power_output: round(result.totalPower),
      island_count: plan.islands.length,
    };
  }

  return {
    name: testCase.name,
    why: testCase.why,
    seed: testCase.seed,
    max_steps: testCase.maxSteps,
    grid: { width, height: testCase.rows.length, code },
    unlocked_upgrades: Object.fromEntries(
      Object.entries(unlocked).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
    buildable_tiles: countGrassTiles(grid),
    // Annealing disabled: pure arithmetic, asserted exactly by the suite.
    expected: await layer(0),
    // Annealing enabled: transcendental-dependent, tolerance-checked only.
    annealed: await layer(testCase.maxSteps),
  };
}

async function main(): Promise<void> {
  mkdirSync(FIXTURES_DIR, { recursive: true });

  for (const testCase of CASES) {
    const fixture = await buildFixture(testCase);
    /*
     * Key order is the documented schema order above and already deterministic,
     * so it is written as-is rather than sorted.
     */
    writeFileSync(
      join(FIXTURES_DIR, `${testCase.name}.json`),
      JSON.stringify(fixture, null, 2) + "\n",
      "utf8",
    );

    const { expected, annealed } = fixture;
    console.log(
      `${testCase.name.padEnd(22)} islands=${expected.island_count} ` +
        `exact=${expected.placements.length}/${fixture.buildable_tiles} ` +
        `power=${expected.power_output.toPrecision(6)}  ` +
        `annealed=${annealed.power_output.toPrecision(6)}`,
    );
  }
}

await main();
