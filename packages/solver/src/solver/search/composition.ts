import { EPS } from "../constants";
import type { IslandContext } from "../context";
import { generatorCapacities, isolationRoom } from "../island";
import { Pacer } from "../pacer";
import { generatorEnergyRatio, generatorWasteRatio } from "../physics";
import { simulateIsland } from "../simulate";
import type { EffectiveBuilding, IslandSubGrid, Placement } from "../types";
import { chebyshev, put, ratedFor, SWAP_RADIUS } from "./placement";
import { POLISH_REACTOR_TIERS } from "./repair";
import { anyOfflineProducer, planHolds } from "./stability";

/**
 * Composition retargeting: deciding WHAT to build is a counting problem, so it
 * is computed directly, and the search is left with where to put it.
 */

/** How many candidate compositions to try arranging, best-scoring first. */
const COMPOSITION_TARGETS = 3;

interface ScoredComposition {
  power: number;
  composition: EffectiveBuilding[];
}

/**
 * The best MULTISETS of buildings for an island of this size, ignoring where
 * they go — highest theoretical power first.
 *
 * Which buildings to use is a tiny counting problem, not a search problem. For
 * counts (nReactor, nGenerator, nCooler) summing to the tile budget, the layout
 * can convert at most `min(reactor output, nGenerator * H_max, nCooler * C /
 * WASTE_RATIO)` of heat, so enumerating the O(tiles^2) splits and greedily
 * filling the reactor tiles with the largest tiers that stay inside that budget
 * gives the exact best composition. On the 67-tile map 1 island this returns
 * 13 neuro + 1 sauron_eye + 14 generator6 + 39 cooler6 — the known optimum — in
 * a few milliseconds, where the search alone plateaued 1.6% below it.
 *
 * Placement can still make a composition unachievable (a generator can only be
 * fed by ADJACENT reactors), which is why several are returned, each with the
 * power it would reach if it could be arranged perfectly: the caller tries them
 * in order, and can skip any that could not beat what it already has.
 */
export function targetCompositions(
  tileCount: number,
  reactors: EffectiveBuilding[],
  generators: EffectiveBuilding[],
  coolers: EffectiveBuilding[],
  generatorCapacity: Float64Array | null,
  topK = COMPOSITION_TARGETS,
): ScoredComposition[] {
  if (
    reactors.length === 0 ||
    generators.length === 0 ||
    coolers.length === 0 ||
    tileCount < 3
  ) {
    return [];
  }

  const generator = generators[0];
  const cooler = coolers[0];
  // Only the `topK` best are kept as they are found, and a composition's
  // array is built only once it has earned a place. Materialising all
  // O(tiles^2) of them and sorting afterwards cost 80-130ms on the largest
  // shipped islands, nearly all of it allocation. Insertion goes after every
  // entry of equal power, which is exactly what the stable descending sort it
  // replaces produced: equal scores in enumeration order.
  const scored: ScoredComposition[] = [];
  const earnsPlace = (power: number): boolean =>
    scored.length < topK || power > scored[scored.length - 1].power;
  const keep = (entry: ScoredComposition): void => {
    let at = scored.length;
    while (at > 0 && scored[at - 1].power < entry.power) at--;
    scored.splice(at, 0, entry);
    if (scored.length > topK) scored.pop();
  };

  for (let nGen = 1; nGen < tileCount - 1; nGen++) {
    for (let nCool = 1; nCool < tileCount - nGen; nCool++) {
      const nReact = tileCount - nGen - nCool;
      if (nReact < 1) continue;

      // Most heat this many generators, and this much cooling, can carry.
      const wasteRatio = generatorWasteRatio(generator);
      if (wasteRatio <= 0) continue;
      const budget = Math.min(
        generatorCapacity === null
          ? nGen * generator.effectiveValue
          : generatorCapacity[nGen],
        (nCool * cooler.effectiveValue) / wasteRatio,
      );

      // Two ways to fill the reactor tiles, and which one wins depends on what
      // is actually binding.
      //
      // Packing them with the largest tier maximizes heat. Overshooting the
      // budget costs nothing — surplus heat is simply never absorbed and power
      // stays capped — so this is what to do when generator or cooling capacity
      // is the limit.
      //
      // Stepping down through tiers to land just under the budget instead
      // matters when COOLING is the limit: the all-or-nothing rule shuts a
      // generator down entirely if its waste outruns the cooling reaching it,
      // so a smaller top-up reactor can be worth more than a larger one.
      const fills: EffectiveBuilding[][] = [
        new Array<EffectiveBuilding>(nReact).fill(reactors[0]),
      ];

      let heat = 0.0;
      const mix: EffectiveBuilding[] = [];
      for (const tier of reactors.slice(0, POLISH_REACTOR_TIERS)) {
        if (tier.effectiveValue <= 0) continue;
        const take = Math.min(
          nReact - mix.length,
          Math.floor((budget - heat) / tier.effectiveValue),
        );
        if (take > 0) {
          heat += take * tier.effectiveValue;
          for (let i = 0; i < take; i++) mix.push(tier);
        }
      }
      if (mix.length === nReact && !sameFill(mix, fills[0])) fills.push(mix);

      for (const fill of fills) {
        let fillHeat = 0.0;
        for (const b of fill) fillHeat += b.effectiveValue;
        const absorbed = Math.min(fillHeat, budget);
        const power = absorbed * generatorEnergyRatio(generator);
        if (power > EPS && earnsPlace(power)) {
          const composition = fill.slice();
          for (let i = 0; i < nGen; i++) composition.push(generator);
          for (let i = 0; i < nCool; i++) composition.push(cooler);
          keep({ power, composition });
        }
      }
    }
  }

  return scored;
}

/**
 * How much heat `nGen` generator tiles on THIS island can take in, or null
 * under every rule that leaves the count alone.
 *
 * `targetCompositions` decides what to build by counting, and the count it
 * wants is a function of what a generator is worth. Under a role isolation
 * that is two numbers rather than one — a generator with no generator beside
 * it takes 4x, one with 0.8x — and which a tile gets is decided by the
 * layout, so neither belongs in the pool the stage draws on. The roster cannot
 * express it; the island can, and `isolationRoom` is how much of the bonus its
 * shape has room for.
 *
 * Both halves are load-bearing. Sizing at the bonus alone asks Gale Hills at
 * generator7 tier 1 for 20 generators on an island that can keep 15 apart, and
 * `arrangeComposition` cannot spread that many without most of them touching.
 * With the room folded in it asks for 16, and over ten runs at 15s the mean
 * goes 44.6AC to 46.2AC; the best either reaches is 49.8AC, fifteen generators
 * every one isolated. Over three seeds it is worth +12-14% on maps 7 and 8 and
 * costs 1-4% on maps 2, 5 and 6 — a net gain, not a uniform one.
 *
 * The same table the bound runs on (`island.ts`), and deliberately so — one
 * reading of what a board has room for, rather than a second one here to drift
 * against it. It is built from the island's own ratings rather than the
 * capped figures the bound uses: a bound may relax adjacency away, a target
 * has to be something the board can hold.
 */
export function generatorCapacityTable(
  island: IslandSubGrid,
  ctx: IslandContext,
  generator: EffectiveBuilding | undefined,
): Float64Array | null {
  if (generator === undefined) return null;

  const isolated = ctx.rateIsolated(generator, false).effectiveValue;
  const crowded = ctx.rateIsolated(generator, true).effectiveValue;
  // Equal under every other rule, and under one that rates a crowded building
  // no lower there is no ceiling to respect: the count is linear again.
  if (crowded >= isolated) return null;

  return generatorCapacities(ctx.n, isolated, {
    gTake: crowded,
    room: isolationRoom(island),
  });
}

/**
 * The largest factor anything on this island can be rated at — 1 under the rules
 * that leave the roster alone.
 *
 * `targetCompositions` scores a target from the plain roster, and it is right to:
 * which buildings to use is a counting problem over the roster, and the counting
 * is the same whatever the tiles are worth. But the layout the caller compares it
 * against has been rated tile by tile, so the two figures are in different units,
 * and a target's ceiling read as-is says "this cannot beat what I have" about
 * every target on the list. The gate is a `break`, so the whole stage goes with
 * it — silently, and hardest under the anomaly that most needs it: on island3
 * under Tidal a 0.6s run already returns 1.68e23 against a top target of
 * 1.49e23, so the stage never ran at any realistic budget.
 *
 * Scaling the target by one island-wide factor is the move `estimateTotalMaxPower`
 * makes to keep its bound a bound wherever its mask cannot say which tiles carry
 * the factor (`islandMaxScale`), and it is sound for the same reason: a
 * composition's power is positively homogeneous of degree 1 in
 * the roster's figures, so rating the whole island at its best tile is an upper
 * bound on rating each tile at its own. Loose where only part of an island
 * qualifies, which is the right way to be wrong here — a ceiling that is too low
 * skips a stage that would have helped, while one that is too high costs a few
 * arrangement attempts that fail to beat the layout in hand.
 *
 * It is asked of the context rather than read off the anomaly so that a rule
 * resolved per tile (`rate`) and one resolved per layout (`rateIsolated`) are
 * both answered by the code that actually applies them, and a fifth rule shape
 * needs nothing here at all.
 */
export function islandRatingCeiling(
  ctx: IslandContext,
  probes: readonly EffectiveBuilding[],
  sizedByIsolation: boolean,
): number {
  if (ctx.uniformRating && (ctx.isolation === null || sizedByIsolation))
    return 1;

  let ceiling = 1;
  const consider = (factor: number): void => {
    if (factor > ceiling) ceiling = factor;
  };

  for (const probe of probes) {
    if (probe.effectiveValue <= 0) continue;
    if (!ctx.uniformRating) {
      for (let tile = 0; tile < ctx.n; tile++) {
        consider(ctx.rate(tile, probe).effectiveValue / probe.effectiveValue);
      }
    }
    if (ctx.isolation !== null && !sizedByIsolation) {
      // Both variants, because which one a tile gets is a function of the
      // layout: a search free to keep generators apart rates every one of them
      // at the bonus. The same reasoning `islandMaxScale` carries.
      consider(
        ctx.rateIsolated(probe, false).effectiveValue / probe.effectiveValue,
      );
      consider(
        ctx.rateIsolated(probe, true).effectiveValue / probe.effectiveValue,
      );
    }
  }
  return ceiling;
}

/**
 * Whether a composition target could still beat the layout in hand, which is what
 * decides whether the retarget stage runs at all.
 *
 * `target.power` is the power a perfect arrangement of the target would reach at
 * the PLAIN roster's figures and `bestPower` is what a rated layout actually
 * scored, so the ceiling is what puts the two in the same units — see
 * `islandRatingCeiling`. The caller's gate is a `break` over a descending list,
 * so answering `false` once ends the stage: a named function so the reading can
 * be pinned, since it is the difference between a stage that runs and one that is
 * silently never entered.
 */
export function targetCanBeat(
  target: ScoredComposition,
  bestPower: number,
  ratingCeiling: number,
): boolean {
  return target.power * ratingCeiling > bestPower + EPS;
}

function sameFill(a: EffectiveBuilding[], b: EffectiveBuilding[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function countById(
  buildings: Iterable<EffectiveBuilding>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const b of buildings) counts.set(b.id, (counts.get(b.id) ?? 0) + 1);
  return counts;
}

function countPlacement(placement: Placement): Map<string, number> {
  const counts = new Map<string, number>();
  for (const b of placement) {
    if (b !== null) counts.set(b.id, (counts.get(b.id) ?? 0) + 1);
  }
  return counts;
}

function sameCounts(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, n] of a) if (b.get(id) !== n) return false;
  return true;
}

/**
 * Places a fixed multiset of buildings, then improves the ARRANGEMENT only.
 *
 * Starting from `reference` (the best layout found so far), tiles are converted
 * to match the target counts, choosing at each step the change that costs least
 * power. The result is then improved with swaps, which move buildings around
 * without changing what is on the board — so every candidate keeps the target's
 * global heat/cooling budget and the search is over arrangements alone.
 */
export async function arrangeComposition(
  composition: EffectiveBuilding[],
  reference: Placement,
  ctx: IslandContext,
  deadlineMs: number,
  pacer: Pacer,
): Promise<Placement | null> {
  if (composition.length > ctx.n) return null;

  const wanted = countById(composition);
  const byId = new Map<string, EffectiveBuilding>();
  for (const b of composition) byId.set(b.id, b);
  const current = reference.slice();

  // 1. Reconcile counts with the target, cheapest change first.
  while (performance.now() < deadlineMs && !pacer.stopRequested) {
    const have = countPlacement(current);
    const surplus = new Set<string>();
    for (const [id, n] of have) {
      if (n > (wanted.get(id) ?? 0)) surplus.add(id);
    }

    let targetId: string | null = null;
    for (const [id, n] of wanted) {
      if (n > (have.get(id) ?? 0)) {
        targetId = id;
        break;
      }
    }

    let bestMove = -1;
    let bestPower = -1.0;

    if (targetId === null) {
      // Too many buildings overall: drop the least useful surplus tile.
      if (surplus.size === 0) break;
      for (let tile = 0; tile < ctx.n; tile++) {
        const held = current[tile];
        if (held === null || !surplus.has(held.id)) continue;
        current[tile] = null;
        const power = simulateIsland(current, ctx).totalPower;
        put(current, ctx, tile, held);
        if (power > bestPower) {
          bestPower = power;
          bestMove = tile;
        }
      }
      if (bestMove < 0) break;
      current[bestMove] = null;
    } else {
      const building = byId.get(targetId)!;
      for (let tile = 0; tile < ctx.n; tile++) {
        if (current[tile] !== null) continue;
        put(current, ctx, tile, building);
        const power = simulateIsland(current, ctx).totalPower;
        current[tile] = null;
        if (power > bestPower) {
          bestPower = power;
          bestMove = tile;
        }
      }
      if (bestMove < 0) {
        for (let tile = 0; tile < ctx.n; tile++) {
          const held = current[tile];
          if (held === null || !surplus.has(held.id)) continue;
          put(current, ctx, tile, building);
          const power = simulateIsland(current, ctx).totalPower;
          put(current, ctx, tile, held);
          if (power > bestPower) {
            bestPower = power;
            bestMove = tile;
          }
        }
      }
      if (bestMove < 0) return null;
      put(current, ctx, bestMove, building);
    }

    const now = performance.now();
    if (pacer.due(now)) await pacer.pump(now);
  }

  if (!sameCounts(countPlacement(current), wanted)) return null;

  // 2. Improve the arrangement with swaps, which preserve the composition.
  // Only nearby pairs are tried: swapping two buildings changes the layout
  // solely through who they are adjacent to, so a swap between opposite ends of
  // the island is two independent local changes and is better found as two
  // separate moves. Restricting to Chebyshev distance 2 cuts the pairs to a
  // fraction of all-pairs on a large island.
  const occupied: number[] = [];
  for (let tile = 0; tile < ctx.n; tile++) {
    if (current[tile] !== null) occupied.push(tile);
  }
  // Plain ascending (x, y) order, which is NOT the tile index order
  // (ascending X, DESCENDING Y). The fixtures pin this pairing exactly.
  occupied.sort((a, b) => ctx.xs[a] - ctx.xs[b] || ctx.ys[a] - ctx.ys[b]);

  const pairs: [number, number][] = [];
  for (let i = 0; i < occupied.length; i++) {
    for (let j = i + 1; j < occupied.length; j++) {
      if (chebyshev(ctx, occupied[i], occupied[j]) <= SWAP_RADIUS) {
        pairs.push([occupied[i], occupied[j]]);
      }
    }
  }

  while (performance.now() < deadlineMs && !pacer.stopRequested) {
    const basePower = simulateIsland(current, ctx).totalPower;
    let bestGain = 0.0;
    let bestSwap: [number, number] | null = null;

    for (let index = 0; index < pairs.length; index++) {
      if ((index & 63) === 0) {
        const now = performance.now();
        if (now >= deadlineMs) break;
        if (pacer.due(now)) {
          await pacer.pump(now);
          if (pacer.stopRequested) break;
        }
      }

      const [a, b] = pairs[index];
      const valA = current[a];
      const valB = current[b];
      // Swapping identical buildings changes nothing — asked in each tile's own
      // units, so two scale classes holding the same roster entry still count
      // as identical. See `ratedFor`.
      if (ratedFor(ctx, a, valB) === valA && ratedFor(ctx, b, valA) === valB) {
        continue;
      }

      put(current, ctx, a, valB);
      put(current, ctx, b, valA);

      const trial = simulateIsland(current, ctx);
      if (
        trial.totalPower - basePower > bestGain &&
        !anyOfflineProducer(current, trial.placements) &&
        planHolds(current, ctx)
      ) {
        bestGain = trial.totalPower - basePower;
        bestSwap = [a, b];
      }

      put(current, ctx, a, valA);
      put(current, ctx, b, valB);
    }

    if (bestSwap === null) break;
    const [a, b] = bestSwap;
    const held = current[a];
    put(current, ctx, a, current[b]);
    put(current, ctx, b, held);
  }

  return current;
}
