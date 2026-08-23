/**
 * Python ↔ TypeScript parity: replays the golden fixtures exported by
 * `py_solver/parity/export_fixtures.py` and asserts this tree reproduces them.
 *
 * Fixtures live in `parity/fixtures/` at the repo root, written there directly
 * by the Python exporter. There is no second copy under `py_solver/` and this
 * test must never read one: pointing it into the Python tree would make a
 * Python checkout a build dependency of the web app. See docs/PARITY.md.
 *
 * Why this does not call `solve()`: every stage of `solveIsland` is wall-clock
 * budgeted, so a fixed seed narrows run-to-run variance without eliminating it
 * and can never reproduce a golden fixture. Both trees instead replay the
 * deterministic subset via `replayIslandDeterministic` -- seed construction,
 * `hillClimb` capped by `maxSteps`, then pruning. If you change which stages
 * that covers, change it on BOTH sides in the same commit.
 *
 * TWO LAYERS:
 *
 *   `expected` -- replayed with maxSteps = 0, i.e. annealing OFF. Seed
 *   construction, simulation, distribution, stabilize, prune, island splitting
 *   and remapping are pure +-*\/ on doubles, so they are bit-identical across
 *   the two languages. Asserted EXACTLY.
 *
 *   `annealed` -- replayed with the fixture's maxSteps, i.e. annealing ON.
 *   The walk is the only part of the solver that calls transcendentals
 *   (`Math.pow` for the temperature, `Math.exp` in the Metropolis test), and
 *   IEEE-754 does not require those to be correctly rounded. CPython's libm and
 *   V8 disagree by 1 ULP on values this solver actually reaches, which is
 *   enough to flip one acceptance and permanently diverge the walk. Asserted on
 *   INVARIANTS and a relative power tolerance only -- never bit-for-bit.
 *
 * If you find yourself loosening an `expected` assertion, stop: that layer has
 * no float excuse, so a failure there is a real mis-port.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BUILDINGS } from "../data/buildings";
import { decodeBlueprint } from "../encoding/blueprint";
import {
  replayIslandDeterministic,
  type IslandSolution,
} from "./placementSearch";
import { buildOptimizationResult, planSolve } from "./solver";

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../parity/fixtures",
);

interface Fixture {
  name: string;
  seed: number;
  max_steps: number;
  grid: { width: number; height: number; code: string };
  unlocked_upgrades: Record<string, number>;
  buildable_tiles: number;
  expected: Layer;
  annealed: Layer;
}

interface Layer {
  placements: { x: number; y: number; building_id: string }[];
  power_output: number;
  island_count: number;
}

function loadFixtures(): Fixture[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map(
      (f) => JSON.parse(readFileSync(join(FIXTURES_DIR, f), "utf8")) as Fixture,
    );
}

const FIXTURES = loadFixtures();

/** Canonical order: ascending flat tile index, matching the exporter. */
function canonical(
  placements: { x: number; y: number; buildingId: string }[],
  width: number,
): { x: number; y: number; building_id: string }[] {
  return [...placements]
    .sort((a, b) => a.y * width + a.x - (b.y * width + b.x))
    .map((p) => ({ x: p.x, y: p.y, building_id: p.buildingId }));
}

/**
 * Power values reach ~1e22, where an absolute 1e-9 tolerance is far below one
 * ULP. Compare relatively instead.
 */
function expectPowerClose(actual: number, expected: number): void {
  if (expected === 0) {
    expect(actual).toBe(0);
    return;
  }
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(1e-9);
}

/** Relative comparison with an explicit tolerance. */
function expectPowerWithin(
  actual: number,
  expected: number,
  tolerance: number,
): void {
  if (expected === 0) {
    expect(actual).toBe(0);
    return;
  }
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(
    tolerance,
  );
}

async function replayFixture(fixture: Fixture) {
  const { grid } = await decodeBlueprint(fixture.grid.code);
  // planSolve takes a mutable array; BUILDINGS is readonly, so copy it.
  const plan = planSolve(
    grid,
    [...BUILDINGS],
    fixture.unlocked_upgrades,
    1.0,
    fixture.seed,
  );
  return { grid, plan };
}

/** Replays every island of a fixture at the given step cap. */
async function replayAll(
  plan: NonNullable<ReturnType<typeof planSolve>>,
  maxSteps: number,
) {
  const results: IslandSolution[] = [];
  for (let i = 0; i < plan.islands.length; i++) {
    results.push(
      await replayIslandDeterministic(
        plan.islands[i],
        plan.effectiveBuildings,
        plan.seeds[i]!,
        maxSteps,
      ),
    );
  }
  return results;
}

describe("python parity fixtures", () => {
  it("finds the fixtures the exporter produced", () => {
    expect(FIXTURES.length).toBeGreaterThan(0);
    expect(FIXTURES.map((f) => f.name)).toContain("two_island_seed7");
  });

  for (const fixture of FIXTURES) {
    describe(fixture.name, () => {
      it("decodes to the grid the exporter recorded", async () => {
        const { grid, plan } = await replayFixture(fixture);
        expect(grid.length).toBe(fixture.grid.height);
        expect(grid[0]?.length ?? 0).toBe(fixture.grid.width);
        expect(plan?.islands.length ?? 0).toBe(fixture.expected.island_count);
      });

      it("derives per-island seeds as (root + index) >>> 0", async () => {
        const { plan } = await replayFixture(fixture);
        if (!plan) return;
        // The coordinator farms islands out to workers using exactly these
        // seeds; Python uses (seed + i) & 0xFFFFFFFF. They must agree.
        expect(plan.seeds).toEqual(
          plan.islands.map((_, i) => (fixture.seed + i) >>> 0),
        );
      });

      // --- exact layer: annealing off, no transcendentals, no excuses --------
      it("reproduces the recorded layout exactly with annealing off", async () => {
        const { plan } = await replayFixture(fixture);

        if (!plan) {
          expect(fixture.expected.placements).toEqual([]);
          expect(fixture.expected.power_output).toBe(0);
          expect(fixture.expected.island_count).toBe(0);
          return;
        }

        const result = buildOptimizationResult(plan, await replayAll(plan, 0));

        expect(canonical(result.placements, fixture.grid.width)).toEqual(
          fixture.expected.placements,
        );
        expectPowerClose(result.totalPower, fixture.expected.power_output);
        expect(result.activeTilesCount).toBe(
          fixture.expected.placements.length,
        );
        expect(plan.totalGrassTiles).toBe(fixture.buildable_tiles);
      });

      it("merges island results independently of completion order", async () => {
        const { plan } = await replayFixture(fixture);
        if (!plan || plan.islands.length < 2) return;

        const inOrder = await replayAll(plan, 0);
        // Workers finish in arbitrary order. buildOptimizationResult indexes by
        // island, so refilling the array back-to-front must change nothing --
        // this is the coordinator's merge risk, minus the worker plumbing.
        const reversed = new Array<IslandSolution>(plan.islands.length);
        for (let i = plan.islands.length - 1; i >= 0; i--)
          reversed[i] = inOrder[i];

        const a = buildOptimizationResult(plan, inOrder);
        const b = buildOptimizationResult(plan, reversed);
        expect(b.placements).toEqual(a.placements);
        expect(b.totalPower).toBe(a.totalPower);
      });

      // --- annealed layer: invariants + tolerance only ----------------------
      it("anneals to a stable layout within tolerance of the Python walk", async () => {
        const { plan } = await replayFixture(fixture);
        if (!plan) {
          expect(fixture.annealed.power_output).toBe(0);
          return;
        }

        const result = buildOptimizationResult(
          plan,
          await replayAll(plan, fixture.max_steps),
        );

        // Stability rule: every producer placed must actually run. This holds
        // regardless of which side of a 1-ULP coin flip the walk landed on.
        for (const p of result.placements) {
          const isProducer = p.heatProduced > 0 || p.wasteHeatGenerated > 0;
          if (isProducer && p.wasteHeatGenerated > 0) {
            expect(p.powerGenerated).toBeGreaterThan(0);
          }
        }

        expect(result.placements.length).toBeLessThanOrEqual(
          fixture.buildable_tiles,
        );
        // Loose on purpose -- see the header. Tight enough to catch a walk that
        // was mis-ported, loose enough to survive libm-vs-V8 drift.
        expectPowerWithin(
          result.totalPower,
          fixture.annealed.power_output,
          0.05,
        );
      });
    });
  }
});
