import { EPS } from "./constants";
import {
  generatorEnergyRatio,
  generatorPowerAndWaste,
  generatorWasteRatio,
  wasteIsCovered,
} from "./physics";
import { buildIslandContext, type IslandContext } from "./context";
import { Pacer, type IslandProgress } from "./pacer";
import { AlternateCollector, isDistinctLayout, powerTies } from "./alternates";
import { Rng, randomSeed } from "./rng";
import { simulateIsland, type SimPlacedBuilding } from "./simulate";
import type {
  AnomalyDefinition,
  EffectiveBuilding,
  IslandLayout,
  IslandSubGrid,
  PlacedBuilding,
  Placement,
  SearchHooks,
} from "./types";

/**
 * Placement search for a single island:
 *
 *   seed -> repair -> composition retarget -> (annealing -> repair)* -> pruning
 *     -> right-sizing
 *
 * The `annealing -> repair` pair repeats until the deadline. Repair's slice is
 * reserved before the layout it will run on exists, and on a post-anneal layout
 * it almost always converges in one fruitless sweep, so whatever it hands back
 * becomes another short walk rather than idle time at the end of the budget.
 *
 * Seed construction lays out self-sufficient "hubs" — one generator plus
 * exactly the reactors and coolers it needs on its own. That is a good starting
 * shape but a systematically incomplete one: real layouts do better by letting
 * neighbouring hubs SHARE, one cooler absorbing waste from two generators or
 * one reactor feeding two, which frees tiles for more producers. Nothing in
 * seed construction can express that, and on the 67-tile map 1 island it caps
 * out 7% below the best known layout.
 *
 * The two stages around it exist to cover that blind spot from different sides:
 *
 * - `greedyPolish` is steepest ascent over single-tile changes. Annealing alone
 *   was supposed to find these, and does on small islands, but on a large
 *   packed island almost every single-tile change costs several percent, so the
 *   walk drifts downhill and rarely climbs back — measured there, only 1
 *   evaluation in 26,000 beat its own starting layout while 20 stable improving
 *   moves sat a single move away.
 * - `targetCompositions` / `arrangeComposition` attack the other half. Deciding
 *   WHAT to build is a counting problem with an exact answer, so it is computed
 *   directly rather than searched for; the search is then left with the
 *   genuinely hard part, which is where to put it.
 *
 * Annealing keeps its place between them for the moves neither can make: it can
 * cross a barrier that no single change improves upon.
 *
 * Right-sizing is the odd one out: it is not part of the search and cannot find
 * a better layout. It runs once the layout is final and swaps each building for
 * the smallest tier that still carries the load that layout gives it, because
 * power is blind to the difference between a cooler running flat out and one
 * running at 2% — and the player is not.
 *
 * **The stability rule.** A solved layout must be fully stable: every generator
 * and direct producer it places has to actually run. A layout can score higher
 * by parking reactor heat in a generator that is never cooled — nothing then
 * has to cool that share of the waste — and it is still the wrong answer, so
 * only stable layouts are ever recorded as best. "Pruning never reduces power"
 * is NOT a valid invariant here; "the returned layout is stable" is.
 */

const MAX_TOP_REACTOR_COPIES = 3;
const MAX_SECOND_REACTOR_COPIES = 3;

/** How many reactor tiers the local-repair pass considers per tile. */
const POLISH_REACTOR_TIERS = 3;
/** Share of the time budget reserved for repair before and after annealing. */
const POLISH_SHARE = 0.3;
/** How many candidate compositions to try arranging, best-scoring first. */
const COMPOSITION_TARGETS = 3;
/** Share of the time budget spent arranging those compositions. */
const COMPOSITION_SHARE = 0.2;
/** Max Chebyshev distance between two tiles considered for an arrangement swap. */
const SWAP_RADIUS = 2;
/**
 * The closing repair is reserved a share of the budget up front, then handed
 * back whatever it does not use (see `solveIsland`). These bound the handback:
 * the repair is left twice its measured cost as headroom, but never more than
 * half of what is left — on a big island one sweep costs seconds, and reserving
 * twice that would strand more time than it protects. A reclaimed round shorter
 * than the floor is not worth its own setup.
 */
const RECLAIM_POLISH_MARGIN = 2.0;
const RECLAIM_MAX_RESERVE_FRACTION = 0.5;
const RECLAIM_MIN_ROUND_SHARE = 0.01;
const RECLAIM_MIN_ROUND_MS = 50;

export interface IslandSolution extends IslandLayout {
  /**
   * Other layouts this island's search finished tied with, best-power-first
   * and never including the primary. Empty when the search found no second
   * arrangement at the same power. See `alternates.ts` — they are gathered by
   * watching the walk, and every one of them is stable and pruned exactly as
   * the primary is.
   */
  alternates?: IslandLayout[];
}

// ---------------------------------------------------------------------------
// Placement helpers
// ---------------------------------------------------------------------------

function emptyPlacement(n: number): Placement {
  return new Array<EffectiveBuilding | null>(n).fill(null);
}

/**
 * Writes a building onto a tile, rated for that tile.
 *
 * The one way a building enters a placement, so that a terrain bonus cannot be
 * missed at one of three dozen sites — and a miss would be silent, since the
 * layout would simply be worth less than it is. `ctx.rate` is the identity
 * under every rule but a terrain bonus, and idempotent under that one, so this
 * is equally correct for a fresh placement, a swap between two tiles, and the
 * restore that undoes a rejected move.
 *
 * Clearing a tile stays a plain `= null`: a null carries no rating, so there is
 * nothing to resolve and nothing to get wrong.
 */
function put(
  placement: Placement,
  ctx: IslandContext,
  tile: number,
  building: EffectiveBuilding | null,
): void {
  placement[tile] = building === null ? null : ctx.rate(tile, building);
}

function copyInto(dst: Placement, src: Placement): void {
  for (let i = 0; i < dst.length; i++) dst[i] = src[i];
}

function isReactor(b: EffectiveBuilding): boolean {
  return b.type === "reactor";
}

function isDirectProducer(b: EffectiveBuilding): boolean {
  return b.type === "direct_producer";
}

/** Scratch for `generatorPowerAndWaste`, reused for the same reason as in `simulate.ts`. */
const conversion = { power: 0.0, waste: 0.0 };

function chebyshev(ctx: IslandContext, a: number, b: number): number {
  return Math.max(
    Math.abs(ctx.xs[a] - ctx.xs[b]),
    Math.abs(ctx.ys[a] - ctx.ys[b]),
  );
}

/** The tile's Chebyshev-adjacent buildable neighbors that are still unclaimed. */
function availableNeighbors(
  tile: number,
  available: Uint8Array,
  ctx: IslandContext,
): number[] {
  const out: number[] = [];
  const nb = ctx.neighbors[tile];
  for (let k = 0; k < nb.length; k++) {
    if (available[nb[k]]) out.push(nb[k]);
  }
  return out;
}

function toPlacedBuildings(rows: SimPlacedBuilding[]): PlacedBuilding[] {
  return rows.map((r) => ({
    x: r.x,
    y: r.y,
    buildingId: r.buildingId,
    baseValue: r.baseValue,
    powerGenerated: r.powerGenerated,
    heatProduced: r.heatProduced,
    heatConsumed: r.heatConsumed,
    wasteHeatGenerated: r.wasteHeatGenerated,
    coolingProvided: r.coolingProvided,
    coolingReceived: r.coolingReceived,
  }));
}

// ---------------------------------------------------------------------------
// Stability
// ---------------------------------------------------------------------------

/**
 * Tiles holding a generator or direct producer that generates no power —
 * either because it is overheating (waste above the cooling routed to it) or
 * because it never received any heat at all.
 *
 * A layout containing one of these is not a valid answer: the goal is a fully
 * stable grid where every producer runs, so these tiles are wasted at best and
 * represent an overheating building at worst.
 */
function offlineProducers(
  placement: Placement,
  rows: SimPlacedBuilding[],
): number[] {
  const offline: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const p = rows[i];
    const building = placement[p.idx];
    if (building === null) continue;
    const producer =
      building.type === "generator" || isDirectProducer(building);
    if (producer && p.powerGenerated <= EPS) offline.push(p.idx);
  }
  return offline;
}

/** Allocation-free `offlineProducers(...).length > 0`, for the search's inner loops. */
function anyOfflineProducer(
  placement: Placement,
  rows: SimPlacedBuilding[],
): boolean {
  for (let i = 0; i < rows.length; i++) {
    const p = rows[i];
    const building = placement[p.idx];
    if (building === null) continue;
    const producer =
      building.type === "generator" || isDirectProducer(building);
    if (producer && p.powerGenerated <= EPS) return true;
  }
  return false;
}

interface StableLayout {
  placement: Placement;
  power: number;
  rows: SimPlacedBuilding[];
}

/**
 * Drops producers that generate no power until every remaining one is online.
 *
 * This has to iterate rather than delete them all in one pass: removing an
 * offline generator hands the heat it was absorbing to its neighbours, which
 * can push THEIR waste past what their coolers cover and take them offline in
 * turn. Power can legitimately fall as a result — a layout that only scores
 * well by parking heat in an overheating building is not a layout we want.
 */
function stabilize(placement: Placement, ctx: IslandContext): StableLayout {
  const current = placement.slice();
  let sim = simulateIsland(current, ctx);

  for (;;) {
    const offline = offlineProducers(current, sim.placements);
    if (offline.length === 0) {
      return {
        placement: current,
        power: sim.totalPower,
        rows: sim.placements,
      };
    }
    for (const tile of offline) current[tile] = null;
    sim = simulateIsland(current, ctx);
  }
}

// ---------------------------------------------------------------------------
// Seed construction
// ---------------------------------------------------------------------------

interface HubFit {
  generator: EffectiveBuilding;
  reactor: EffectiveBuilding;
  r: number;
  c: number;
  power: number;
}

function bestHubFit(
  availableSlots: number,
  generators: EffectiveBuilding[],
  reactors: EffectiveBuilding[],
  cooler: EffectiveBuilding,
): HubFit | null {
  let best: HubFit | null = null;
  for (const generator of generators) {
    for (const reactor of reactors) {
      const maxR = Math.min(
        availableSlots,
        Math.ceil(generator.effectiveValue / reactor.effectiveValue),
      );
      for (let r = 1; r <= maxR; r++) {
        const hIn = Math.min(
          generator.effectiveValue,
          r * reactor.effectiveValue,
        );
        generatorPowerAndWaste(generator, hIn, conversion);
        const waste = conversion.waste;
        const c =
          cooler.effectiveValue > 0
            ? Math.ceil(waste / cooler.effectiveValue)
            : 0;
        if (r + c <= availableSlots) {
          const power = conversion.power;
          if (best === null || power > best.power) {
            best = { generator, reactor, r, c, power };
          }
        }
        if (hIn >= generator.effectiveValue - EPS) break;
      }
    }
  }
  return best;
}

interface DpFit {
  dp: EffectiveBuilding;
  c: number;
  power: number;
}

function bestDpFit(
  availableSlots: number,
  directProducers: EffectiveBuilding[],
  cooler: EffectiveBuilding,
): DpFit | null {
  let best: DpFit | null = null;
  for (const dp of directProducers) {
    const waste = dp.waste;
    const c =
      cooler.effectiveValue > 0 ? Math.ceil(waste / cooler.effectiveValue) : 0;
    if (c > availableSlots) continue;
    const power = dp.energy;
    if (best === null || power > best.power) best = { dp, c, power };
  }
  return best;
}

/** `itertools.combinations` over a list, in the same lexicographic order. */
function* combinations(pool: number[], k: number): Generator<number[]> {
  const n = pool.length;
  if (k > n || k < 0) return;
  const idx = new Array<number>(k);
  for (let i = 0; i < k; i++) idx[i] = i;
  for (;;) {
    const out = new Array<number>(k);
    for (let i = 0; i < k; i++) out[i] = pool[idx[i]];
    yield out;

    let i = k - 1;
    while (i >= 0 && idx[i] === i + n - k) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

interface SharedFit {
  power: number;
  reactorTiles: number[];
  reactorTiers: EffectiveBuilding[];
  genPositions: number[];
  coolerPositions: number[];
}

/**
 * A multi-generator arrangement around one reactor tile, for rosters where a
 * single top-tier reactor overfills a generator: the surplus heat is only
 * usable if two or more generators share that reactor, which the plain hub fit
 * can never express.
 */
function bestSharedReactorFit(
  tile: number,
  neighbors: number[],
  reactors: EffectiveBuilding[],
  generator: EffectiveBuilding,
  cooler: EffectiveBuilding,
  ctx: IslandContext,
  scratch: Placement,
): SharedFit | null {
  if (reactors.length === 0) return null;
  const topReactor = reactors[0];
  const secondReactor = reactors.length > 1 ? reactors[1] : null;

  const connectivity = new Map<number, number>();
  for (const n of neighbors) {
    let count = 0;
    for (const m of neighbors) {
      if (m !== n && chebyshev(ctx, n, m) <= 1) count++;
    }
    connectivity.set(n, count);
  }
  // Ascending tile index is ascending spatial key, so this is
  // `(connectivity, spatial_key)` exactly.
  const byConnectivityAsc = [...neighbors].sort(
    (a, b) => connectivity.get(a)! - connectivity.get(b)! || a - b,
  );

  let best: SharedFit | null = null;
  const maxK1 = Math.min(MAX_TOP_REACTOR_COPIES, 1 + neighbors.length);

  for (let k1 = 1; k1 <= maxK1; k1++) {
    const extraTopNeeded = k1 - 1;
    const maxK2 =
      secondReactor !== null
        ? Math.min(MAX_SECOND_REACTOR_COPIES, neighbors.length - extraTopNeeded)
        : 0;

    for (let k2 = 0; k2 <= maxK2; k2++) {
      const nExtraReactors = extraTopNeeded + k2;
      if (nExtraReactors > neighbors.length) continue;

      let totalValue = k1 * topReactor.effectiveValue;
      if (k2 && secondReactor) totalValue += k2 * secondReactor.effectiveValue;

      const g = Math.ceil(totalValue / generator.effectiveValue);
      if (g < 2 || nExtraReactors + g + 1 > neighbors.length) continue;

      const absorbed = Math.min(totalValue, g * generator.effectiveValue);
      const wasteTotal = absorbed * generatorWasteRatio(generator);
      const c =
        cooler.effectiveValue > 0
          ? Math.ceil(wasteTotal / cooler.effectiveValue)
          : 0;
      if (nExtraReactors + g + c > neighbors.length) continue;

      const extraPositions = byConnectivityAsc.slice(0, nExtraReactors);
      const extraTopPositions = extraPositions.slice(0, extraTopNeeded);
      const extraSecondPositions = extraPositions.slice(
        extraTopNeeded,
        nExtraReactors,
      );
      const extraSet = new Set(extraPositions);
      const pool = neighbors.filter((n) => !extraSet.has(n));

      for (const genPositions of combinations(pool, g)) {
        const genSet = new Set(genPositions);
        const leftover = pool.filter((n) => !genSet.has(n));
        leftover.sort((a, b) => {
          let adjA = 0;
          let adjB = 0;
          for (const gpos of genPositions) {
            if (chebyshev(ctx, a, gpos) <= 1) adjA++;
            if (chebyshev(ctx, b, gpos) <= 1) adjB++;
          }
          return adjB - adjA || a - b;
        });
        const coolerPositions = leftover.slice(0, c);

        const touched: number[] = [];
        put(scratch, ctx, tile, topReactor);
        touched.push(tile);
        for (const n of extraTopPositions) {
          put(scratch, ctx, n, topReactor);
          touched.push(n);
        }
        for (const n of extraSecondPositions) {
          put(scratch, ctx, n, secondReactor);
          touched.push(n);
        }
        for (const n of genPositions) {
          put(scratch, ctx, n, generator);
          touched.push(n);
        }
        for (const n of coolerPositions) {
          put(scratch, ctx, n, cooler);
          touched.push(n);
        }

        const { totalPower } = simulateIsland(scratch, ctx);
        for (const n of touched) scratch[n] = null;

        if (totalPower > EPS && (best === null || totalPower > best.power)) {
          const reactorTiles = [
            tile,
            ...extraTopPositions,
            ...extraSecondPositions,
          ];
          const reactorTiers: EffectiveBuilding[] = [
            topReactor,
            ...extraTopPositions.map(() => topReactor),
            ...extraSecondPositions.map(() => secondReactor!),
          ];
          best = {
            power: totalPower,
            reactorTiles,
            reactorTiers,
            genPositions,
            coolerPositions,
          };
        }
      }
    }
  }

  return best;
}

interface CandidateEntry {
  /**
   * Power PER TILE CLAIMED, which is what candidates are ranked by — not raw
   * power. A candidate that spends more tiles (e.g. a multi-reactor "shared"
   * setup) can have higher raw power than a compact one-reactor hub while
   * actually being a worse use of the island's limited tiles: it wins a single
   * greedy round yet leaves the *rest* of the island worse off, since those
   * extra tiles are no longer available for other, more efficient hubs.
   * Ranking by power/tile keeps the greedy choice locally optimal in the
   * currency that is actually scarce.
   */
  powerPerTile: number;
  kind: "hub" | "dp" | "shared";
  tile: number;
  neighbors: number[];
  hub?: HubFit;
  dp?: DpFit;
  shared?: SharedFit;
}

function constructSeed(
  buildableOrder: number[],
  ctx: IslandContext,
  reactors: EffectiveBuilding[],
  generators: EffectiveBuilding[],
  coolers: EffectiveBuilding[],
  directProducers: EffectiveBuilding[],
  deadlineMs: number,
): Placement {
  const placement = emptyPlacement(ctx.n);
  const available = new Uint8Array(ctx.n);
  for (const tile of buildableOrder) available[tile] = 1;
  let numAvailable = buildableOrder.length;

  const topReactor = reactors.length > 0 ? reactors[0] : null;
  const topGenerator = generators.length > 0 ? generators[0] : null;
  const topCooler = coolers.length > 0 ? coolers[0] : null;
  const canHub =
    topReactor !== null && topGenerator !== null && topCooler !== null;
  const canDp = directProducers.length > 0 && topCooler !== null;
  const trySharedReactor =
    canHub &&
    Math.ceil(topReactor!.effectiveValue / topGenerator!.effectiveValue) >= 2;

  const hubFitCache = new Map<number, HubFit | null>();
  const dpFitCache = new Map<number, DpFit | null>();
  const sharedScratch = emptyPlacement(ctx.n);

  const hubFit = (slots: number): HubFit | null => {
    let fit = hubFitCache.get(slots);
    if (fit === undefined) {
      fit = canHub ? bestHubFit(slots, generators, reactors, topCooler!) : null;
      hubFitCache.set(slots, fit);
    }
    return fit;
  };

  const dpFit = (slots: number): DpFit | null => {
    let fit = dpFitCache.get(slots);
    if (fit === undefined) {
      fit = canDp ? bestDpFit(slots, directProducers, topCooler!) : null;
      dpFitCache.set(slots, fit);
    }
    return fit;
  };

  const candidateCache = new Array<CandidateEntry | null>(ctx.n).fill(null);
  const stale = new Uint8Array(ctx.n);
  for (const tile of buildableOrder) stale[tile] = 1;

  while (numAvailable > 0) {
    if (performance.now() >= deadlineMs) break;

    const staleList = buildableOrder.filter((tile) => stale[tile] === 1);
    for (const tile of staleList) {
      if (performance.now() >= deadlineMs) break;

      const neighbors = availableNeighbors(tile, available, ctx);
      let entry: CandidateEntry | null = null;
      const consider = (candidate: CandidateEntry) => {
        if (entry === null || candidate.powerPerTile > entry.powerPerTile)
          entry = candidate;
      };

      const hub = hubFit(neighbors.length);
      if (hub !== null) {
        const tilesUsed = 1 + hub.r + hub.c;
        if (hub.power > EPS && tilesUsed > 0) {
          consider({
            powerPerTile: hub.power / tilesUsed,
            kind: "hub",
            tile,
            neighbors,
            hub,
          });
        }
      }

      const dp = dpFit(neighbors.length);
      if (dp !== null) {
        const tilesUsed = 1 + dp.c;
        if (dp.power > EPS && tilesUsed > 0) {
          consider({
            powerPerTile: dp.power / tilesUsed,
            kind: "dp",
            tile,
            neighbors,
            dp,
          });
        }
      }

      if (trySharedReactor && neighbors.length >= 3) {
        const shared = bestSharedReactorFit(
          tile,
          neighbors,
          reactors,
          topGenerator!,
          topCooler!,
          ctx,
          sharedScratch,
        );
        if (shared !== null) {
          const tilesUsed =
            shared.reactorTiles.length +
            shared.genPositions.length +
            shared.coolerPositions.length;
          if (tilesUsed > 0) {
            consider({
              powerPerTile: shared.power / tilesUsed,
              kind: "shared",
              tile,
              neighbors,
              shared,
            });
          }
        }
      }

      candidateCache[tile] = entry;
    }

    stale.fill(0);

    let best: CandidateEntry | null = null;
    for (const tile of buildableOrder) {
      if (!available[tile]) continue;
      const entry = candidateCache[tile];
      if (
        entry !== null &&
        (best === null || entry.powerPerTile > best.powerPerTile)
      ) {
        best = entry;
      }
    }
    if (best === null) break;

    const claimed: number[] = [];
    if (best.kind === "hub") {
      const { generator, reactor, r, c } = best.hub!;
      put(placement, ctx, best.tile, generator);
      claimed.push(best.tile);
      for (let i = 0; i < r; i++) {
        put(placement, ctx, best.neighbors[i], reactor);
        claimed.push(best.neighbors[i]);
      }
      for (let i = r; i < r + c; i++) {
        put(placement, ctx, best.neighbors[i], topCooler);
        claimed.push(best.neighbors[i]);
      }
    } else if (best.kind === "shared") {
      const shared = best.shared!;
      for (let i = 0; i < shared.reactorTiles.length; i++) {
        put(placement, ctx, shared.reactorTiles[i], shared.reactorTiers[i]);
        claimed.push(shared.reactorTiles[i]);
      }
      for (const n of shared.genPositions) {
        put(placement, ctx, n, topGenerator);
        claimed.push(n);
      }
      for (const n of shared.coolerPositions) {
        put(placement, ctx, n, topCooler);
        claimed.push(n);
      }
    } else {
      const { dp, c } = best.dp!;
      put(placement, ctx, best.tile, dp);
      claimed.push(best.tile);
      for (let i = 0; i < c; i++) {
        put(placement, ctx, best.neighbors[i], topCooler);
        claimed.push(best.neighbors[i]);
      }
    }

    for (const tile of claimed) {
      if (available[tile]) {
        available[tile] = 0;
        numAvailable--;
      }
      candidateCache[tile] = null;
    }
    for (const tile of claimed) {
      const nb = ctx.neighbors[tile];
      for (let k = 0; k < nb.length; k++) {
        if (available[nb[k]]) stale[nb[k]] = 1;
      }
    }
  }

  return placement;
}

function constructMultiStartSeed(
  ctx: IslandContext,
  reactors: EffectiveBuilding[],
  generators: EffectiveBuilding[],
  coolers: EffectiveBuilding[],
  directProducers: EffectiveBuilding[],
  deadlineMs: number,
): Placement {
  const buildable = Array.from(ctx.tiles);

  let bestSeed = constructSeed(
    buildable,
    ctx,
    reactors,
    generators,
    coolers,
    directProducers,
    deadlineMs,
  );
  let bestPower = simulateIsland(bestSeed, ctx).totalPower;

  if (bestPower <= EPS) {
    // The deadline elapsed mid-construction and left a seed that powers
    // nothing. One full greedy pass costs ~2ms even on the largest island in
    // the game, so finish it: refining a degenerate seed wastes the whole
    // budget and can return an empty layout for a solvable island.
    bestSeed = constructSeed(
      buildable,
      ctx,
      reactors,
      generators,
      coolers,
      directProducers,
      performance.now() + 1000,
    );
    bestPower = simulateIsland(bestSeed, ctx).totalPower;
  }

  if (performance.now() >= deadlineMs - 50 || buildable.length < 6)
    return bestSeed;

  const reversed = [...buildable].reverse();
  const seedRev = constructSeed(
    reversed,
    ctx,
    reactors,
    generators,
    coolers,
    directProducers,
    deadlineMs,
  );
  const powerRev = simulateIsland(seedRev, ctx).totalPower;
  if (powerRev > bestPower + EPS) {
    bestPower = powerRev;
    bestSeed = seedRev;
  }

  if (performance.now() < deadlineMs - 50) {
    const rng = new Rng(42);
    const shuffled = [...buildable];
    rng.shuffle(shuffled);
    const seedRand = constructSeed(
      shuffled,
      ctx,
      reactors,
      generators,
      coolers,
      directProducers,
      deadlineMs,
    );
    const powerRand = simulateIsland(seedRand, ctx).totalPower;
    if (powerRand > bestPower + EPS) bestSeed = seedRand;
  }

  return bestSeed;
}

// ---------------------------------------------------------------------------
// Annealing
// ---------------------------------------------------------------------------

function randomCandidate(
  pools: EffectiveBuilding[][],
  rng: Rng,
): EffectiveBuilding | null {
  if (pools.length === 0 || rng.random() < 0.15) return null;
  const pool = rng.choice(pools);
  if (pool.length === 1 || rng.random() < 0.7) return pool[0];
  return rng.choice(pool);
}

/**
 * `maxSteps` caps the walk by iteration count and, when set, drives the
 * temperature schedule by `step / maxSteps` instead of elapsed time. With a
 * fixed `Rng` and a `timeBudgetMs` generous enough that the deadline never
 * fires first, the walk is then fully deterministic: same seed, same result,
 * bit for bit. That is what the golden fixtures stand on. The solve pipeline
 * itself never sets it — wall time is the right budget in production, where
 * per-step cost varies by island.
 */
async function hillClimb(
  seed: Placement,
  ctx: IslandContext,
  reactors: EffectiveBuilding[],
  generators: EffectiveBuilding[],
  coolers: EffectiveBuilding[],
  directProducers: EffectiveBuilding[],
  timeBudgetMs: number,
  rng: Rng,
  pacer: Pacer,
  maxSteps?: number,
  collector?: AlternateCollector,
): Promise<Placement> {
  if (timeBudgetMs <= 0 || ctx.n === 0) return seed;

  const current = seed.slice();
  let sim = simulateIsland(current, ctx);
  let currentPower = sim.totalPower;
  let currentPlacements = sim.placements;

  // The walk itself is free to pass through layouts containing overheating
  // buildings — they are often one move away from good ones — but only a STABLE
  // layout may be recorded as the best. Raw power alone would happily settle on
  // a layout that parks heat in a permanently offline generator, which then has
  // to be dismantled at the end, ending up worse than the best stable layout
  // the search already walked past.
  const initial = stabilize(current, ctx);
  let bestPlacement = initial.placement;
  let bestPower = initial.power;
  // The layout the walk starts from is itself an answer at this power, and the
  // shortlist has to hold one before it can recognise a tie with it.
  collector?.offer(initial.power, initial.placement);
  // Highest raw score seen so far, used only to decide when an unstable layout
  // is promising enough to be worth stabilizing and re-scoring.
  let bestRawPower = currentPower;
  let stall = 0;

  const recordIfBest = (
    power: number,
    snapshot: Placement,
    rows: SimPlacedBuilding[],
  ): void => {
    if (power <= bestPower + EPS) {
      // Not an improvement — but a layout that *ties* the best is a second
      // answer worth offering the user, so it goes on the shortlist. The
      // checks are ordered by what they cost: `full` is a size comparison,
      // `accepts` reads the layout's tiles, and only then does the stability
      // test walk every row. A converged walk ties its best constantly and
      // nearly all of those are near copies of a layout already held, so
      // `accepts` is what keeps this off the hot path once the shortlist has
      // stopped growing.
      if (
        collector !== undefined &&
        !collector.full &&
        powerTies(power, collector.power) &&
        collector.accepts(snapshot) &&
        !anyOfflineProducer(snapshot, rows)
      ) {
        collector.offer(power, snapshot);
      }
      return;
    }

    if (!anyOfflineProducer(snapshot, rows)) {
      bestPower = power;
      bestPlacement = snapshot.slice();
      collector?.offer(power, snapshot);
      stall = 0;
      return;
    }

    // Unstable. Only worth the extra simulations when it is a new raw
    // high-water mark — otherwise the walk would re-stabilize the same
    // unreachable peak on every visit.
    if (power > bestRawPower + EPS) {
      bestRawPower = power;
      const stabilized = stabilize(snapshot, ctx);
      if (stabilized.power > bestPower + EPS) {
        bestPower = stabilized.power;
        bestPlacement = stabilized.placement;
        collector?.offer(stabilized.power, stabilized.placement);
        stall = 0;
      }
    }
  };

  const topCooler = coolers.length > 0 ? coolers[0] : null;
  const topGenerator = generators.length > 0 ? generators[0] : null;
  const pools = [reactors, generators, coolers, directProducers].filter(
    (p) => p.length > 0,
  );

  const startMs = performance.now();
  const deadlineMs = startMs + timeBudgetMs;

  // Temperature is scaled to the size of one MOVE, not to the island's total
  // output. Changing a single tile is worth roughly one generator's power
  // wherever it happens, so scaling by total power made large islands run far
  // too hot: on the 67-tile map 1 island, ~23% of moves that each cost 7% of
  // the layout were being accepted, and the walk never climbed back.
  const moveScale =
    generators.length > 0
      ? generators[0].effectiveValue * generatorEnergyRatio(generators[0])
      : 1.0;
  const tStart = Math.max(moveScale * 0.1, 1.0);
  const tMin = 1e-4;
  let temperature = tStart;

  // Snap back to the best layout after a long run of no improvement. Without
  // this, one unlucky sequence of accepted downhill moves strands the walk in a
  // region it cannot climb out of for the rest of the budget.
  const stallLimit = Math.max(2000, ctx.n * 200);

  let step = 0;
  const batchMask = 127;

  /** Accepts or rolls back a trial move, Metropolis-style. */
  const accept = (power: number, rows: SimPlacedBuilding[]): boolean => {
    const delta = power - currentPower;
    const exponent = temperature > 0 ? delta / temperature : -100.0;
    if (
      delta > EPS ||
      (exponent > -50.0 && rng.random() < Math.exp(exponent))
    ) {
      currentPower = power;
      currentPlacements = rows;
      recordIfBest(power, current, rows);
      return true;
    }
    return false;
  };

  for (;;) {
    if (maxSteps !== undefined && step >= maxSteps) break;

    if ((step & batchMask) === 0) {
      const now = performance.now();
      if (now >= deadlineMs) break;

      if (pacer.due(now)) {
        await pacer.pump(now, () => islandProgress(bestPlacement, ctx));
        if (pacer.stopRequested) break;
      }

      const progress =
        maxSteps !== undefined
          ? Math.min(1.0, step / maxSteps)
          : Math.min(1.0, Math.max(0.0, (now - startMs) / timeBudgetMs));
      temperature = tStart * Math.pow(tMin / tStart, progress);

      if (stall >= stallLimit) {
        copyInto(current, bestPlacement);
        sim = simulateIsland(current, ctx);
        currentPower = sim.totalPower;
        currentPlacements = sim.placements;
        stall = 0;
      }
    }

    step += 1;
    stall += 1;
    const moveType = rng.random();

    if (moveType < 0.15 && currentPlacements.length > 0) {
      const uncooled: SimPlacedBuilding[] = [];
      const wastedReactors: SimPlacedBuilding[] = [];
      for (const p of currentPlacements) {
        if (
          p.wasteHeatGenerated > EPS &&
          !wasteIsCovered(p.wasteHeatGenerated, p.coolingReceived)
        ) {
          uncooled.push(p);
        }
        if (p.heatProduced > EPS && p.heatProduced < p.baseValue - EPS) {
          wastedReactors.push(p);
        }
      }

      if (uncooled.length > 0 && topCooler !== null && rng.random() < 0.6) {
        const target = rng.choice(uncooled);
        const adj = ctx.neighbors[target.idx];
        if (adj.length > 0) {
          const tile = adj[rng.int(adj.length)];
          const old = current[tile];
          if (old !== topCooler) {
            put(current, ctx, tile, topCooler);
            const trial = simulateIsland(current, ctx);
            if (!accept(trial.totalPower, trial.placements))
              put(current, ctx, tile, old);
            continue;
          }
        }
      } else if (
        wastedReactors.length > 0 &&
        topGenerator !== null &&
        rng.random() < 0.6
      ) {
        const target = rng.choice(wastedReactors);
        const adj = ctx.neighbors[target.idx];
        if (adj.length > 0) {
          const tile = adj[rng.int(adj.length)];
          const old = current[tile];
          if (old !== topGenerator) {
            put(current, ctx, tile, topGenerator);
            const trial = simulateIsland(current, ctx);
            if (!accept(trial.totalPower, trial.placements))
              put(current, ctx, tile, old);
            continue;
          }
        }
      }
    }

    if (moveType < 0.5 && ctx.n >= 2) {
      const tile1 = rng.int(ctx.n);
      const adj = ctx.neighbors[tile1];
      let tile2: number;
      if (adj.length > 0 && rng.random() < 0.7) {
        tile2 = adj[rng.int(adj.length)];
      } else {
        tile2 = rng.int(ctx.n);
        while (tile2 === tile1) tile2 = rng.int(ctx.n);
      }

      const val1 = current[tile1];
      const val2 = current[tile2];
      if (val1 === val2) continue;

      put(current, ctx, tile1, val2);
      put(current, ctx, tile2, val1);

      const trial = simulateIsland(current, ctx);
      if (!accept(trial.totalPower, trial.placements)) {
        put(current, ctx, tile1, val1);
        put(current, ctx, tile2, val2);
      }
      continue;
    }

    const tile = rng.int(ctx.n);
    const old = current[tile];
    const replacement = randomCandidate(pools, rng);
    if (replacement === old) continue;

    put(current, ctx, tile, replacement);
    const trial = simulateIsland(current, ctx);
    if (!accept(trial.totalPower, trial.placements)) current[tile] = old;
  }

  return bestPlacement;
}

// ---------------------------------------------------------------------------
// Composition retargeting
// ---------------------------------------------------------------------------

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
function targetCompositions(
  tileCount: number,
  reactors: EffectiveBuilding[],
  generators: EffectiveBuilding[],
  coolers: EffectiveBuilding[],
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
  const scored: ScoredComposition[] = [];

  for (let nGen = 1; nGen < tileCount - 1; nGen++) {
    for (let nCool = 1; nCool < tileCount - nGen; nCool++) {
      const nReact = tileCount - nGen - nCool;
      if (nReact < 1) continue;

      // Most heat this many generators, and this much cooling, can carry.
      const wasteRatio = generatorWasteRatio(generator);
      if (wasteRatio <= 0) continue;
      const budget = Math.min(
        nGen * generator.effectiveValue,
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
        if (power > EPS) {
          const composition = fill.slice();
          for (let i = 0; i < nGen; i++) composition.push(generator);
          for (let i = 0; i < nCool; i++) composition.push(cooler);
          scored.push({ power, composition });
        }
      }
    }
  }

  // Stable sort, so equal-scoring compositions keep the order they were
  // enumerated in and the walk is reproducible.
  scored.sort((a, b) => b.power - a.power);
  return scored.slice(0, topK);
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
async function arrangeComposition(
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
      // Swapping identical buildings changes nothing.
      if (current[a] === current[b]) continue;

      const valA = current[a];
      const valB = current[b];
      put(current, ctx, a, valB);
      put(current, ctx, b, valA);

      const trial = simulateIsland(current, ctx);
      if (
        trial.totalPower - basePower > bestGain &&
        !anyOfflineProducer(current, trial.placements)
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

// ---------------------------------------------------------------------------
// Local repair and pruning
// ---------------------------------------------------------------------------

/**
 * The lean set of buildings worth trying on a tile during local repair.
 *
 * Generators and coolers jump 400x-4100x per tier, so only their top tier can
 * ever appear in a good layout. Reactors only jump ~8x, which is small enough
 * that a weaker one is genuinely useful for topping up a generator's spare heat
 * capacity when there is leftover cooling, so a few reactor tiers are kept.
 * Every extra candidate costs another full pass over the island.
 */
function polishCandidates(
  reactors: EffectiveBuilding[],
  generators: EffectiveBuilding[],
  coolers: EffectiveBuilding[],
  directProducers: EffectiveBuilding[],
): (EffectiveBuilding | null)[] {
  const candidates: (EffectiveBuilding | null)[] = reactors.slice(
    0,
    POLISH_REACTOR_TIERS,
  );
  if (generators.length > 0) candidates.push(generators[0]);
  if (coolers.length > 0) candidates.push(coolers[0]);
  if (directProducers.length > 0) candidates.push(directProducers[0]);
  // Leaving the tile empty is a real option.
  candidates.push(null);
  return candidates;
}

/**
 * Steepest-ascent repair: repeatedly applies the single-tile change that raises
 * power the most, considering only stable layouts, until no single change
 * helps.
 *
 * The annealing walk handles small islands well, but on a large, fully packed
 * one nearly every single-tile change costs several percent, so the walk drifts
 * downhill and rarely climbs back: measured on a 67-tile island, only 1
 * evaluation in 26,000 beat its own starting layout, while 20 stable improving
 * moves sat a single move away. A full sweep here costs |tiles| x |candidates|
 * simulations and finds them directly.
 */
async function greedyPolish(
  placement: Placement,
  ctx: IslandContext,
  candidates: (EffectiveBuilding | null)[],
  deadlineMs: number,
  pacer: Pacer,
): Promise<{ placement: Placement; power: number }> {
  let current = placement.slice();
  const sim = simulateIsland(current, ctx);
  let bestPower = sim.totalPower;
  if (anyOfflineProducer(current, sim.placements)) {
    const stabilized = stabilize(current, ctx);
    current = stabilized.placement;
    bestPower = stabilized.power;
  }

  while (performance.now() < deadlineMs && !pacer.stopRequested) {
    let bestGain = 0.0;
    let bestTile = -1;
    let bestBuilding: EffectiveBuilding | null = null;

    for (let tile = 0; tile < ctx.n; tile++) {
      const now = performance.now();
      if (now >= deadlineMs) break;
      if (pacer.due(now)) {
        await pacer.pump(now, () => islandProgress(current, ctx));
        if (pacer.stopRequested) break;
      }

      const held = current[tile];
      for (const building of candidates) {
        if (building === held) continue;

        put(current, ctx, tile, building);
        const trial = simulateIsland(current, ctx);
        if (
          trial.totalPower - bestPower > bestGain &&
          !anyOfflineProducer(current, trial.placements)
        ) {
          bestGain = trial.totalPower - bestPower;
          bestTile = tile;
          bestBuilding = building;
        }
        put(current, ctx, tile, held);
      }
    }

    if (bestTile < 0) break;
    put(current, ctx, bestTile, bestBuilding);
    bestPower += bestGain;
  }

  return { placement: current, power: bestPower };
}

/**
 * Post-search cleanup:
 * 1. Drops every producer generating 0 power, repeating until none remain.
 * 2. Sequentially tests removing reactors/coolers to eliminate redundant
 *    support structures.
 * 3. Guarantees a stable layout — every returned producer is online — with a
 *    minimal active tile footprint.
 *
 * Step 1 is unconditional: an overheating building is never acceptable, even
 * when keeping it would score higher (see `stabilize`). Step 2 is guarded,
 * since removing support can only ever cost power.
 */
function pruneDeadWeight(
  placement: Placement,
  ctx: IslandContext,
): { rows: SimPlacedBuilding[]; power: number } {
  let anyOccupied = false;
  for (let tile = 0; tile < ctx.n; tile++) {
    if (placement[tile] !== null) {
      anyOccupied = true;
      break;
    }
  }
  if (!anyOccupied) return { rows: [], power: 0.0 };

  // 1. Remove producers that generate no power (cascading).
  const stabilized = stabilize(placement, ctx);
  const current = stabilized.placement;
  let bestPower = stabilized.power;
  let rows = stabilized.rows;

  // 2. Greedy backward sweep: test removing support buildings (reactors & coolers).
  const support: number[] = [];
  for (let tile = 0; tile < ctx.n; tile++) {
    const b = current[tile];
    if (b === null) continue;
    if (b.type === "cooler" || isReactor(b)) support.push(tile);
  }

  for (const tile of support) {
    const held = current[tile];
    if (held === null) continue;

    current[tile] = null;
    const trial = simulateIsland(current, ctx);

    // Power alone is not enough to accept a removal. Dropping a reactor can
    // starve one generator to zero while handing its heat to another that had
    // spare capacity, leaving total power unchanged but stranding an idle
    // generator on the board.
    if (
      trial.totalPower >= bestPower - EPS &&
      !anyOfflineProducer(current, trial.placements)
    ) {
      bestPower = trial.totalPower;
      rows = trial.placements;
    } else {
      put(current, ctx, tile, held);
    }
  }

  return { rows, power: bestPower };
}

// ---------------------------------------------------------------------------
// Right-sizing the finished layout
// ---------------------------------------------------------------------------

/**
 * The roles a finished layout can be re-tiered in. A direct producer always
 * runs flat out on its own, so there is no slack in one to give back — a
 * smaller tier is simply less power, and the power guard below would reject it
 * anyway. The other three are sized against a load the finished layout fixes,
 * and any capacity above that load is money spent on a building that never
 * uses it.
 */
const DOWNGRADE_ROLES: ReadonlySet<string> = new Set([
  "cooler",
  "reactor",
  "generator",
]);

/**
 * True when `capacity` meets `load` at the game's own relative tolerance.
 *
 * This is `wasteIsCovered`, whose parameters are named for the cooling case it
 * was written for; the tolerance has to be relative here for the same reason it
 * does there — at 1e18 one ULP is already ~1e2, so an absolute epsilon would
 * reject a tier that is exactly big enough.
 */
function covers(capacity: number, load: number): boolean {
  return wasteIsCovered(load, capacity);
}

/**
 * What a placed building is actually doing, in the units its tier is sized in.
 *
 * Cooling sent for a cooler, heat sent for a reactor, heat absorbed for a
 * generator — the figure a replacement tier has to be able to match for the
 * rest of the layout to keep behaving the same way.
 */
function tileLoad(building: EffectiveBuilding, row: SimPlacedBuilding): number {
  if (building.type === "cooler") return row.coolingProvided;
  if (isReactor(building)) return row.heatProduced;
  return row.heatConsumed;
}

/** Each downgradable role's roster entries, smallest capacity first. */
function downgradeTiers(
  effectiveBuildings: EffectiveBuilding[],
): Map<string, EffectiveBuilding[]> {
  const tiers = new Map<string, EffectiveBuilding[]>();
  for (const role of DOWNGRADE_ROLES) {
    tiers.set(
      role,
      effectiveBuildings
        .filter((b) => b.type === role)
        .sort((a, b) => a.effectiveValue - b.effectiveValue),
    );
  }
  return tiers;
}

/**
 * Final pass: replace every building with the smallest tier that still does the
 * job the finished layout gives it. Port of `_downgrade_oversized`.
 *
 * The search maximizes power, and power cannot tell a cooler running flat out
 * from one running at 2%: both keep the same generators online, so both score
 * identically and the search has no reason to prefer either. It therefore
 * leaves the roster's top tier on tiles that need a twentieth of it, which
 * costs the player real money for capacity that never runs. This is why the
 * pass belongs after the search rather than inside it — only once the layout
 * stops moving is the load on each tile settled enough to size against.
 *
 * Covering the tile's current load is what makes a candidate plausible, not
 * what makes it safe: shrinking a supplier changes the FairShare split, and the
 * split is what decides which producers clear their cooling. So every swap is
 * re-simulated and accepted only under the test `pruneDeadWeight` applies to a
 * removal — no power lost against the layout handed in, and no producer left
 * offline. Power is defended against the figure this pass started from rather
 * than against the running total, so a sequence of swaps cannot drift down one
 * tolerance at a time.
 *
 * The sweep repeats to a fixpoint: downgrading a generator changes the waste
 * its cooler has to absorb, which can free a cooler this sweep already walked
 * past. It terminates because every accepted swap strictly lowers one tile's
 * capacity and the ladders are finite.
 *
 * Tiles are visited in ascending index order, which is the game's own spatial
 * order — see `context.ts`.
 */
export function downgradeOversized(
  rows: SimPlacedBuilding[],
  power: number,
  effectiveBuildings: EffectiveBuilding[],
  ctx: IslandContext,
): { rows: SimPlacedBuilding[]; power: number } {
  if (rows.length === 0) return { rows, power };

  const byId = new Map(effectiveBuildings.map((b) => [b.id, b]));
  const current = emptyPlacement(ctx.n);
  const occupied: number[] = [];
  for (const row of rows) {
    const building = byId.get(row.buildingId);
    // Everything the search places comes from this roster; a layout holding
    // anything else is not one this pass can reason about.
    if (building === undefined) return { rows, power };
    put(current, ctx, row.idx, building);
    occupied.push(row.idx);
  }
  occupied.sort((a, b) => a - b);

  const tiers = downgradeTiers(effectiveBuildings);
  const rowAt = new Map(rows.map((r) => [r.idx, r]));
  const floor = power;

  for (let changed = true; changed;) {
    changed = false;

    for (const tile of occupied) {
      const building = current[tile]!;
      const ladder = tiers.get(building.type);
      if (ladder === undefined || ladder.length === 0) continue;

      const load = tileLoad(building, rowAt.get(tile)!);

      for (const candidate of ladder) {
        // Rated for this tile before it is compared to anything: `building` is
        // what the tile is running and `load` is what the layout measured it
        // doing, both in this tile's units, and the ladder is the plain roster.
        // Ascending order survives the rating, since one tile scales every
        // candidate by the same factor.
        const rated = ctx.rate(tile, candidate);
        // Ascending, so nothing smaller is left to try.
        if (rated.effectiveValue >= building.effectiveValue) break;
        if (!covers(rated.effectiveValue, load)) continue;

        put(current, ctx, tile, rated);
        const trial = simulateIsland(current, ctx);

        if (
          covers(trial.totalPower, floor) &&
          !anyOfflineProducer(current, trial.placements)
        ) {
          power = trial.totalPower;
          rows = trial.placements;
          rowAt.clear();
          for (const r of rows) rowAt.set(r.idx, r);
          changed = true;
          break;
        }

        put(current, ctx, tile, building);
      }
    }
  }

  return { rows, power };
}

/**
 * Turns the walk's shortlist into finished alternates.
 *
 * Every collected layout goes through the same closing prune the primary does,
 * because an alternate the user can pick has to be the same *kind* of answer:
 * stable, with nothing dead left on the board. Pruning can move a layout's
 * power, so anything that no longer ties afterwards is dropped rather than
 * offered as an equal — and so is anything that pruned down to the primary's
 * own shape, which is not an alternative to anything.
 *
 * They are right-sized the same way too, and for a reason the primary does not
 * have: the shortlist exists so the player can compare layouts that tie on
 * power, and two entries agreeing on power while disagreeing on cost would make
 * that comparison meaningless. It also collapses entries that differed only in
 * an oversized tier, which were never two boards to choose between.
 *
 * The distance rule is re-applied here rather than trusted from the collector,
 * because both of those passes rewrite the board: pruning and right-sizing can
 * pull two layouts that were `MIN_ALTERNATE_DISTANCE` apart during the walk
 * onto the same handful of tiles. This is the gate that actually holds — it is
 * the last place the layouts change shape.
 */
function finalizeAlternates(
  collector: AlternateCollector,
  primaryRows: PlacedBuilding[],
  primaryPower: number,
  effectiveBuildings: EffectiveBuilding[],
  ctx: IslandContext,
): IslandLayout[] {
  const kept: PlacedBuilding[][] = [primaryRows];
  const out: IslandLayout[] = [];

  for (const layout of collector.layouts()) {
    const pruned = pruneDeadWeight(layout, ctx);
    const sized = downgradeOversized(
      pruned.rows,
      pruned.power,
      effectiveBuildings,
      ctx,
    );
    if (!powerTies(sized.power, primaryPower)) continue;

    const rows = toPlacedBuildings(sized.rows);
    if (!isDistinctLayout(rows, kept)) continue;
    kept.push(rows);
    out.push({ placements: rows, powerOutput: sized.power });
  }

  return out;
}

function islandProgress(
  placement: Placement,
  ctx: IslandContext,
): IslandProgress {
  const pruned = pruneDeadWeight(placement, ctx);
  return {
    placements: toPlacedBuildings(pruned.rows),
    powerOutput: pruned.power,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Solves one island.
 *
 * `rngSeed` fixes the random stream of the annealing walk. Same seed, same move
 * sequence — but stage deadlines are wall-clock, so where each stage stops (and
 * the temperature at a given step) still varies slightly between runs; seeding
 * narrows run-to-run variance rather than eliminating it. Omitting it draws a
 * fresh seed, preserving the stochastic default.
 */
/**
 * Deterministic replay of `solveIsland`'s reproducible stages, for the golden
 * fixture harness. Not used in production.
 *
 * `solveIsland` is wall-clock budgeted at every stage, so a fixed seed narrows
 * run-to-run variance without eliminating it — it can never reproduce a golden
 * fixture. This runs the subset that CAN be replayed step-for-step: seed
 * construction, `hillClimb` driven by `maxSteps` rather than a deadline, then
 * pruning. Every deadline handed to that path is set far enough out that it
 * cannot fire, so step count alone decides where the walk stops.
 *
 * The composition-retarget and greedy-polish stages are deliberately omitted:
 * they are deadline loops with no step cap, so there is no deterministic way to
 * replay them. `scripts/exportFixtures.ts` writes the fixtures through this
 * same function, so the two cannot disagree about which stages ran.
 */
export async function replayIslandDeterministic(
  island: IslandSubGrid,
  effectiveBuildings: EffectiveBuilding[],
  rngSeed: number,
  maxSteps: number,
): Promise<IslandSolution> {
  // No anomaly, and never one: the fixtures are a determinism harness for the
  // search itself, and a rule change is a different question asked of it.
  const ctx = buildIslandContext(
    island.grid,
    island.buildable,
    undefined,
    island.waterAdjacent,
  );
  if (ctx.n === 0) return { placements: [], powerOutput: 0.0 };

  const reactors = effectiveBuildings
    .filter(isReactor)
    .sort((a, b) => b.effectiveValue - a.effectiveValue);
  const generators = effectiveBuildings
    .filter((b) => b.type === "generator")
    .sort((a, b) => b.effectiveValue - a.effectiveValue);
  const coolers = effectiveBuildings
    .filter((b) => b.type === "cooler")
    .sort((a, b) => b.effectiveValue - a.effectiveValue);
  const directProducers = effectiveBuildings
    .filter(isDirectProducer)
    .sort((a, b) => b.energy - a.energy);

  const canHub = reactors.length > 0 && generators.length > 0;
  const canDp = directProducers.length > 0;
  if (coolers.length === 0 || !(canHub || canDp)) {
    return { placements: [], powerOutput: 0.0 };
  }

  // Far enough out that no deadline can fire: step count alone stops the walk.
  const unreachableMs = 1e9;
  const pacer = new Pacer();

  const seed = constructMultiStartSeed(
    ctx,
    reactors,
    generators,
    coolers,
    directProducers,
    performance.now() + unreachableMs,
  );

  const placement = await hillClimb(
    seed,
    ctx,
    reactors,
    generators,
    coolers,
    directProducers,
    unreachableMs,
    new Rng(rngSeed),
    pacer,
    maxSteps,
  );

  const pruned = pruneDeadWeight(placement, ctx);
  return {
    placements: toPlacedBuildings(pruned.rows),
    powerOutput: pruned.power,
  };
}

export async function solveIsland(
  island: IslandSubGrid,
  effectiveBuildings: EffectiveBuilding[],
  timeBudgetS: number,
  hooks?: SearchHooks,
  rngSeed?: number,
  anomaly?: AnomalyDefinition,
): Promise<IslandSolution> {
  const ctx = buildIslandContext(
    island.grid,
    island.buildable,
    anomaly,
    island.waterAdjacent,
  );
  if (ctx.n === 0) return { placements: [], powerOutput: 0.0 };

  const reactors = effectiveBuildings
    .filter(isReactor)
    .sort((a, b) => b.effectiveValue - a.effectiveValue);
  const generators = effectiveBuildings
    .filter((b) => b.type === "generator")
    .sort((a, b) => b.effectiveValue - a.effectiveValue);
  const coolers = effectiveBuildings
    .filter((b) => b.type === "cooler")
    .sort((a, b) => b.effectiveValue - a.effectiveValue);
  const directProducers = effectiveBuildings
    .filter(isDirectProducer)
    .sort((a, b) => b.energy - a.energy);

  const canHub = reactors.length > 0 && generators.length > 0;
  const canDp = directProducers.length > 0;
  if (coolers.length === 0 || !(canHub || canDp)) {
    return { placements: [], powerOutput: 0.0 };
  }

  const pacer = new Pacer(hooks);
  // Watches the walk for layouts that tie its best. Passive — see
  // `alternates.ts`; nothing it holds can change what the search does.
  const collector = new AlternateCollector();
  const timeBudgetMs = timeBudgetS * 1000;
  const deadlineMs = performance.now() + timeBudgetMs;

  const seed = constructMultiStartSeed(
    ctx,
    reactors,
    generators,
    coolers,
    directProducers,
    deadlineMs,
  );

  // Repair the seed before annealing, and again afterwards. Seed construction
  // lays out self-sufficient hubs, so it systematically misses layouts where
  // neighbouring hubs share a cooler or a reactor; repair finds those directly
  // instead of hoping the walk stumbles into them. Both passes stop as soon as
  // nothing improves, so on small islands they cost almost nothing.
  const candidates = polishCandidates(
    reactors,
    generators,
    coolers,
    directProducers,
  );
  const polishBudgetMs = timeBudgetMs * POLISH_SHARE;

  const polishStartedMs = performance.now();
  let polished = await greedyPolish(
    seed,
    ctx,
    candidates,
    Math.min(deadlineMs, polishStartedMs + polishBudgetMs),
    pacer,
  );
  let placement = polished.placement;
  let bestPower = polished.power;
  // How long a full repair actually took here, used below to reserve just
  // enough for the closing pass instead of a fixed (over-generous) share.
  const polishElapsedMs = performance.now() - polishStartedMs;

  // Composition-first attempt, BEFORE annealing so its result becomes the
  // walk's starting point rather than competing with it for time. What to build
  // is a counting problem with an exact answer, so solve that directly instead
  // of hoping the walk stumbles onto the right multiset. A target whose
  // perfect-arrangement power cannot beat the layout already in hand is
  // skipped, which costs nothing on islands where the search is already at the
  // bound.
  const compositionDeadlineMs = Math.min(
    deadlineMs,
    performance.now() + timeBudgetMs * COMPOSITION_SHARE,
  );
  for (const target of targetCompositions(
    ctx.n,
    reactors,
    generators,
    coolers,
  )) {
    if (
      performance.now() >= compositionDeadlineMs ||
      pacer.stopRequested ||
      target.power <= bestPower + EPS
    ) {
      break;
    }

    const arranged = await arrangeComposition(
      target.composition,
      placement,
      ctx,
      compositionDeadlineMs,
      pacer,
    );
    if (arranged === null) continue;

    const repaired = await greedyPolish(
      arranged,
      ctx,
      candidates,
      compositionDeadlineMs,
      pacer,
    );
    if (repaired.power > bestPower + EPS) {
      placement = repaired.placement;
      bestPower = repaired.power;
    }
  }

  // Give the walk everything except what the closing repair needs. Reserving
  // the full polish share left roughly a quarter of the budget unspent, since
  // repair converges long before its cap.
  const finalReserveMs = Math.min(
    polishBudgetMs,
    Math.max(polishElapsedMs, timeBudgetMs * 0.05),
  );
  let annealMs = deadlineMs - performance.now() - finalReserveMs;
  const rng = new Rng(rngSeed ?? randomSeed());

  // ...and then hand back whatever that repair did not use, as another round of
  // walk-then-repair. The reserve above is a guess made before the layout
  // exists; on a post-anneal layout the closing repair is usually one fruitless
  // sweep, so the guess left the tail of the budget unspent — a 30s solve
  // returned at 28.5s. Each further round is a fresh short anneal from the
  // layout in hand, which cannot lose power: `hillClimb` starts its best from
  // the (stabilized) layout it is given and only ever returns a stable layout
  // at least as good, and repair on a stable layout only climbs.
  //
  // The rounds shrink — each is what the previous round's repair handed back —
  // so this converges on the deadline rather than looping indefinitely.
  const minRoundMs = Math.max(
    RECLAIM_MIN_ROUND_MS,
    timeBudgetMs * RECLAIM_MIN_ROUND_SHARE,
  );
  for (;;) {
    if (annealMs > 0 && !pacer.stopRequested) {
      placement = await hillClimb(
        placement,
        ctx,
        reactors,
        generators,
        coolers,
        directProducers,
        annealMs,
        rng,
        pacer,
        undefined,
        collector,
      );
    }

    const closingStartedMs = performance.now();
    polished = await greedyPolish(
      placement,
      ctx,
      candidates,
      deadlineMs,
      pacer,
    );
    placement = polished.placement;
    const closingElapsedMs = performance.now() - closingStartedMs;

    if (annealMs <= 0 || pacer.stopRequested) break;

    // The repair is capped by the deadline, so being cut mid-sweep costs it
    // improvements but never validity — every move it applies was checked for
    // stability first. The reserve is therefore a tuning choice, not a
    // correctness one, which is why it may be squeezed.
    const remainingMs = deadlineMs - performance.now();
    const reserveMs = Math.min(
      Math.max(closingElapsedMs * RECLAIM_POLISH_MARGIN, RECLAIM_MIN_ROUND_MS),
      remainingMs * RECLAIM_MAX_RESERVE_FRACTION,
    );
    annealMs = remainingMs - reserveMs;
    if (annealMs < minRoundMs) break;
  }

  // Post-search cleanup pass...
  const pruned = pruneDeadWeight(placement, ctx);
  // ...and then right-size what survived. The search had no reason to prefer
  // the tier a tile actually needs over the biggest one in the roster, because
  // both score the same.
  const sized = downgradeOversized(
    pruned.rows,
    pruned.power,
    effectiveBuildings,
    ctx,
  );
  const placements = toPlacedBuildings(sized.rows);
  return {
    placements,
    powerOutput: sized.power,
    alternates: finalizeAlternates(
      collector,
      placements,
      sized.power,
      effectiveBuildings,
      ctx,
    ),
  };
}

/**
 * The stages the public entry points compose, exposed for the test suite.
 *
 * Every one of these is an internal step of `solveIsland`, and none of them is
 * safe to call from application code: they take an `IslandContext` the caller
 * would have to build correctly, they assume roster pools already sorted the
 * way `solveIsland` sorts them, and their contracts are the ones documented
 * beside each function rather than anything this module promises to keep.
 *
 * They are reachable at all because the reference solver's suite tested them
 * directly and those cases are worth keeping — `pruneDeadWeight`'s cascade and
 * `targetCompositions`' ceiling are exactly the kind of thing that breaks
 * quietly and shows up two stages later as "the solver got a bit worse". One
 * named export says that plainly; nine loose ones would read as API.

 */
export const internals = {
  DOWNGRADE_ROLES,
  constructMultiStartSeed,
  downgradeTiers,
  hillClimb,
  offlineProducers,
  pruneDeadWeight,
  targetCompositions,
  tileLoad,
} as const;
