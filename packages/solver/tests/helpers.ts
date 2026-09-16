/**
 * Shared fixtures: building factories, board builders and float assertions.
 *
 * Ported from the Python reference's `tests/helpers.py`. The factories are
 * unchanged in spirit — a `reactor(100)` means the same thing here — but the
 * board builders differ, because the two trees address tiles differently: the
 * reference kept placements in a `{(x, y): building}` dict, while a `Placement`
 * here is a dense array indexed by the tile's position in an `IslandContext`.
 * `placeOn` is what bridges the two, so a test can still be written as a
 * picture.
 */
import { expect } from "vitest";
import {
  GENERATOR_ENERGY_RATIO,
  GENERATOR_WASTE_RATIO,
} from "../src/solver/constants";
import type { IslandContext } from "../src/solver/context";
import { makeGrid } from "../src/grid";
import type {
  BuildingDefinition,
  EffectiveBuilding,
  Placement,
  Tile,
} from "../src/solver/types";

// --- Building factories ---------------------------------------------------
// Ids default to something descriptive so failures name the building.

/** A pure heat source: heat out, no power and nothing to cool. */
export function reactor(value: number, id = "reactor"): EffectiveBuilding {
  return { id, type: "reactor", effectiveValue: value, energy: 0, waste: 0 };
}

/** Converts reactor heat to power; `value` is its max heat input H_max. */
export function generator(value: number, id = "generator"): EffectiveBuilding {
  return {
    id,
    type: "generator",
    effectiveValue: value,
    energy: value * GENERATOR_ENERGY_RATIO,
    waste: value * GENERATOR_WASTE_RATIO,
  };
}

export function cooler(value: number, id = "cooler"): EffectiveBuilding {
  return { id, type: "cooler", effectiveValue: value, energy: 0, waste: 0 };
}

/**
 * A self-contained producer: runs flat out, needs only cooling.
 *
 * Takes a ratio rather than the two numbers because that is how these fixtures
 * read — "a producer that wastes a fifth of what it makes".
 */
export function directProducer(
  value: number,
  wasteRatio: number,
  id = "dp",
): EffectiveBuilding {
  return {
    id,
    type: "direct_producer",
    effectiveValue: value,
    energy: value * (1 - wasteRatio),
    waste: value * wasteRatio,
  };
}

export interface RosterOptions {
  reactorValue?: number;
  generatorValue?: number;
  coolerValue?: number;
  /** Omitted means no direct producer in the roster at all. */
  dpValue?: number;
  dpWasteRatio?: number;
}

export function basicRoster({
  reactorValue = 100,
  generatorValue = 100,
  coolerValue = 100,
  dpValue,
  dpWasteRatio = 0.2,
}: RosterOptions = {}): EffectiveBuilding[] {
  const roster = [
    reactor(reactorValue),
    generator(generatorValue),
    cooler(coolerValue),
  ];
  if (dpValue !== undefined) {
    roster.push(directProducer(dpValue, dpWasteRatio));
  }
  return roster;
}

/**
 * The same three buildings as `basicRoster`, spelled as catalogue definitions.
 *
 * `solve()` takes the roster the player *owns* — definitions plus unlock levels
 * — and resolves it itself, where the stages below it take an already-resolved
 * `EffectiveBuilding[]`. So a pipeline test needs this shape and a stage test
 * needs the other one; they describe the same three buildings, and
 * `getEffectiveBuildings(basicCatalogue().buildings, ...unlocks)` returns
 * exactly what `basicRoster()` returns.
 */
export function basicCatalogue(): {
  buildings: BuildingDefinition[];
  unlocks: Record<string, number>;
} {
  const buildings: BuildingDefinition[] = [
    {
      id: "reactor",
      name: "reactor",
      price: 1,
      displayIndex: 0,
      type: "reactor",
      levels: [{ heat: 100 }],
    },
    {
      id: "generator",
      name: "generator",
      price: 1,
      displayIndex: 1,
      type: "generator",
      levels: [{ heat: 100, energy: 75, waste: 25 }],
    },
    {
      id: "cooler",
      name: "cooler",
      price: 1,
      displayIndex: 2,
      type: "cooler",
      levels: [{ cooling: 100 }],
    },
  ];
  return {
    buildings,
    unlocks: { reactor: 0, generator: 0, cooler: 0 },
  };
}

// --- Board builders -------------------------------------------------------

export { makeGrid };

/** An all-grass rectangle, the board most of these cases want. */
export function grassGrid(width: number, height: number): Tile[][] {
  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x): Tile => ({ x, y, type: "grass" })),
  );
}

/** The tile index of an (x, y) on this island; throws if it is not buildable. */
function tileAt(ctx: IslandContext, x: number, y: number): number {
  for (let i = 0; i < ctx.n; i++) {
    if (ctx.xs[i] === x && ctx.ys[i] === y) return i;
  }
  throw new Error(`no buildable tile at ${x},${y}`);
}

/**
 * Builds a placement from an ASCII picture, one string per row (y), with `.`
 * or a space meaning "empty tile".
 *
 *     placeOn(ctx, ["RGC"], { R: reactor(100), G: generator(100), C: cooler(25) })
 *
 * puts a reactor at (0,0), a generator at (1,0) and a cooler at (2,0).
 */
export function placeOn(
  ctx: IslandContext,
  rows: readonly string[],
  legend: Record<string, EffectiveBuilding>,
): Placement {
  const placement: Placement = new Array(ctx.n).fill(null);
  rows.forEach((row, y) => {
    [...row].forEach((char, x) => {
      if (char === "." || char === " ") return;
      const building = legend[char];
      if (building === undefined) {
        throw new Error(`'${char}' is missing from the legend`);
      }
      placement[tileAt(ctx, x, y)] = building;
    });
  });
  return placement;
}

export function placementsByPos<T extends { x: number; y: number }>(
  placements: readonly T[],
): Map<string, T> {
  return new Map(placements.map((p) => [`${p.x},${p.y}`, p]));
}

// --- Float assertions -----------------------------------------------------

/**
 * Relative-tolerance comparison, exact for zero.
 *
 * The figures here run to 1e22, where `toBeCloseTo`'s absolute tolerance is
 * meaningless — it passes for anything. Every comparison in this suite that is
 * not deliberately exact goes through here.
 */
export function expectClose(
  actual: number,
  expected: number,
  rel = 1e-9,
): void {
  if (expected === 0) {
    expect(actual).toBeCloseTo(0, 9);
    return;
  }
  const tolerance = Math.abs(expected) * rel;
  expect(
    Math.abs(actual - expected),
    `expected ${expected}, got ${actual} (tolerance ${tolerance})`,
  ).toBeLessThanOrEqual(tolerance);
}

/** Compares a distribution result tile by tile, with a useful failure message. */
export function expectAllocation(
  actual: ReadonlyMap<string, number>,
  expected: Readonly<Record<string, number>>,
  rel = 1e-9,
): void {
  expect([...actual.keys()].sort()).toEqual(Object.keys(expected).sort());
  for (const [pos, want] of Object.entries(expected)) {
    expectClose(actual.get(pos)!, want, rel);
  }
}
