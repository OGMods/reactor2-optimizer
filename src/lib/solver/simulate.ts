import { EPS } from "./constants";
import type { IslandContext } from "./context";
import { runDistribution } from "./distribution";
import { generatorPowerAndWaste, wasteIsCovered } from "./physics";
import type { EffectiveBuilding, PlacedBuilding, Placement } from "./types";

/**
 * A `PlacedBuilding` carrying the island-local tile index it sits on, so the
 * search can map a report row back to its tile without re-deriving it from
 * (x, y). Stripped before the result leaves the solver.
 */
export interface SimPlacedBuilding extends PlacedBuilding {
  idx: number;
}

export interface SimulationResult {
  totalPower: number;
  placements: SimPlacedBuilding[];
}

/**
 * Reused by every generator conversion. `simulateIsland` runs millions of times
 * per solve and one worker only ever runs one at a time, so the alternative is
 * an allocation per generator per evaluation.
 */
const conversion = { power: 0.0, waste: 0.0 };

/**
 * Full placement evaluator with fast-path short-circuiting: given a fixed set
 * of buildings, runs the simulation described in `docs/game-logic.md` and returns
 * total online power plus one `PlacedBuilding` per occupied tile. Port of
 * `solver/simulate.py`.
 *
 * This is the hot path — the search calls it millions of times per solve. Note
 * it is *not* the bottleneck it looks like: on the Python reference, a
 * power-only variant and a lazy per-tile report bought 2-13% more evaluations
 * per second with **no** change in solve quality, because the search converges
 * well before it runs out of evaluations. Both were reverted. Don't re-attempt
 * this without first showing that a map is actually evaluation-starved.
 *
 * `fullReport` turns off the two short-circuits below. The search only cares
 * about power, so a layout that can produce none is worth no further work — but
 * a player looking at a board with no coolers on it still wants to see the heat
 * its reactors and generators are moving around, which is what the inspector
 * asks for. It changes no number that a short-circuited layout would otherwise
 * have reported; it only fills in the ones the search would have skipped.
 */
export function simulateIsland(
  placement: Placement,
  ctx: IslandContext,
  fullReport = false,
): SimulationResult {
  const n = ctx.n;
  const reactorTiles = ctx.reactorTiles;
  const generatorTiles = ctx.generatorTiles;
  const dpTiles = ctx.dpTiles;
  const coolerTiles = ctx.coolerTiles;

  let numReactors = 0;
  let numGenerators = 0;
  let numDps = 0;
  let numCoolers = 0;
  let numOccupied = 0;

  // Ascending tile index is the game's spatial processing order, so every list
  // built here is already sorted the way the distribution rules require.
  for (let t = 0; t < n; t++) {
    const b = placement[t];
    if (b === null) continue;
    numOccupied++;
    if (b.type === "generator") {
      generatorTiles[numGenerators++] = t;
    } else if (b.type === "cooler") {
      coolerTiles[numCoolers++] = t;
    } else if (b.type === "reactor") {
      reactorTiles[numReactors++] = t;
    } else {
      dpTiles[numDps++] = t;
    }
  }

  // Fast-Path 1: no power-producing buildings placed.
  // Fast-Path 2: zero coolers placed — every generator/DP makes waste heat and
  // needs 100% cooling to stay online, so 0 coolers means 0 online power.
  if (
    !fullReport &&
    ((numGenerators === 0 && numDps === 0) || numCoolers === 0)
  ) {
    return {
      totalPower: 0.0,
      placements: inertPlacements(placement, ctx, numOccupied),
    };
  }

  const d = ctx.dist;
  const heatIn = ctx.heatIn;
  const heatOut = ctx.heatOut;
  const wasteOf = ctx.wasteOf;
  const coolingIn = ctx.coolingIn;
  const powerOf = ctx.powerOf;

  // 1-3. Heat distribution: Reactor -> Generator
  for (let i = 0; i < numReactors; i++) heatOut[reactorTiles[i]] = 0.0;
  for (let j = 0; j < numGenerators; j++) heatIn[generatorTiles[j]] = 0.0;

  if (numReactors > 0 && numGenerators > 0) {
    for (let i = 0; i < numReactors; i++) {
      d.supplierCap[i] = placement[reactorTiles[i]]!.effectiveValue;
    }
    for (let j = 0; j < numGenerators; j++) {
      d.consumerCap[j] = placement[generatorTiles[j]]!.effectiveValue;
    }
    runDistribution(
      reactorTiles,
      numReactors,
      generatorTiles,
      numGenerators,
      ctx,
    );
    for (let i = 0; i < numReactors; i++)
      heatOut[reactorTiles[i]] = d.supplierSent[i];
    for (let j = 0; j < numGenerators; j++)
      heatIn[generatorTiles[j]] = d.consumerReceived[j];
  }

  // A generator scales its own authored energy and waste by how full it is —
  // the conversion is per tier and is not a fixed 75/25. See `physics.ts`.
  for (let j = 0; j < numGenerators; j++) {
    const t = generatorTiles[j];
    generatorPowerAndWaste(placement[t]!, heatIn[t], conversion);
    powerOf[t] = conversion.power;
    wasteOf[t] = conversion.waste;
  }

  // 4. Direct Producers — always at full load, so their authored figures apply
  // unscaled.
  for (let k = 0; k < numDps; k++) {
    const t = dpTiles[k];
    const b = placement[t]!;
    powerOf[t] = b.energy;
    wasteOf[t] = b.waste;
  }

  // 5. Cooling distribution: Cooler -> Generator/DirectProducer
  const wasteTiles = ctx.wasteTiles;
  let numWaste = 0;
  {
    // Merge the generator and DP tile lists back into ascending tile order.
    let g = 0;
    let k = 0;
    while (g < numGenerators || k < numDps) {
      const t =
        k >= numDps || (g < numGenerators && generatorTiles[g] < dpTiles[k])
          ? generatorTiles[g++]
          : dpTiles[k++];
      coolingIn[t] = 0.0;
      if (wasteOf[t] > EPS) wasteTiles[numWaste++] = t;
    }
  }

  for (let i = 0; i < numCoolers; i++) heatOut[coolerTiles[i]] = 0.0;

  if (numWaste > 0) {
    for (let i = 0; i < numCoolers; i++) {
      d.supplierCap[i] = placement[coolerTiles[i]]!.effectiveValue;
    }
    for (let j = 0; j < numWaste; j++) {
      d.consumerCap[j] = wasteOf[wasteTiles[j]];
    }
    runDistribution(coolerTiles, numCoolers, wasteTiles, numWaste, ctx);
    for (let i = 0; i < numCoolers; i++)
      heatOut[coolerTiles[i]] = d.supplierSent[i];
    for (let j = 0; j < numWaste; j++)
      coolingIn[wasteTiles[j]] = d.consumerReceived[j];
  }

  let totalPower = 0.0;
  const placements: SimPlacedBuilding[] = new Array(numOccupied);
  let out = 0;

  for (let i = 0; i < numReactors; i++) {
    const t = reactorTiles[i];
    const b = placement[t]!;
    placements[out++] = row(t, ctx, b, 0, heatOut[t], 0, 0, 0, 0);
  }

  for (let j = 0; j < numGenerators; j++) {
    const t = generatorTiles[j];
    const b = placement[t]!;
    const waste = wasteOf[t];
    const cooling = coolingIn[t];
    // All-or-nothing: a producer whose waste outruns the cooling routed to it
    // is offline entirely, not partially.
    const power = wasteIsCovered(waste, cooling) ? powerOf[t] : 0.0;
    totalPower += power;
    placements[out++] = row(t, ctx, b, power, 0, heatIn[t], waste, 0, cooling);
  }

  for (let k = 0; k < numDps; k++) {
    const t = dpTiles[k];
    const b = placement[t]!;
    const waste = wasteOf[t];
    const cooling = coolingIn[t];
    const power = wasteIsCovered(waste, cooling) ? powerOf[t] : 0.0;
    totalPower += power;
    placements[out++] = row(t, ctx, b, power, 0, 0, waste, 0, cooling);
  }

  for (let i = 0; i < numCoolers; i++) {
    const t = coolerTiles[i];
    const b = placement[t]!;
    placements[out++] = row(t, ctx, b, 0, 0, 0, 0, heatOut[t], 0);
  }

  return { totalPower, placements };
}

/** Report rows for a layout that produces nothing — every field but the base value is zero. */
function inertPlacements(
  placement: Placement,
  ctx: IslandContext,
  numOccupied: number,
): SimPlacedBuilding[] {
  const placements: SimPlacedBuilding[] = new Array(numOccupied);
  let out = 0;
  for (let t = 0; t < ctx.n; t++) {
    const b = placement[t];
    if (b !== null) placements[out++] = row(t, ctx, b, 0, 0, 0, 0, 0, 0);
  }
  return placements;
}

function row(
  t: number,
  ctx: IslandContext,
  b: EffectiveBuilding,
  powerGenerated: number,
  heatProduced: number,
  heatConsumed: number,
  wasteHeatGenerated: number,
  coolingProvided: number,
  coolingReceived: number,
): SimPlacedBuilding {
  return {
    idx: t,
    x: ctx.xs[t],
    y: ctx.ys[t],
    buildingId: b.id,
    baseValue: b.effectiveValue,
    powerGenerated,
    heatProduced,
    heatConsumed,
    wasteHeatGenerated,
    coolingProvided,
    coolingReceived,
  };
}
