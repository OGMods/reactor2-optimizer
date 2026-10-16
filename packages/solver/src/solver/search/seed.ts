import { CHEBYSHEV_DIRECTIONS, EPS } from "../constants";
import type { IslandContext } from "../context";
import {
  generatorPowerAndWaste,
  generatorWasteRatio,
  wasteIsCovered,
} from "../physics";
import { Rng } from "../rng";
import { simulateIsland } from "../simulate";
import type { EffectiveBuilding, Placement } from "../types";
import {
  availableNeighbors,
  chebyshev,
  emptyPlacement,
  put,
} from "./placement";

/**
 * Seed construction: self-sufficient hubs claimed greedily by power per tile,
 * in three tile orders, the strongest of which starts the search.
 */

const MAX_TOP_REACTOR_COPIES = 3;
const MAX_SECOND_REACTOR_COPIES = 3;
/**
 * The cooling a pooled seed sizes its hubs against: cooling from nowhere, so
 * that no hub ever needs a cooler beside it. It has to be `Infinity` and not
 * merely large — a fit counts `ceil(waste / cooling)` coolers, and any finite
 * figure makes that one, not none. `snapToAuthoredPrecision` passes it through
 * and the pool's `factor` compares with `<`, so the scratch simulation the
 * shared fit runs against it is sound. Never written onto a real placement.
 */
const POOL_COOLER_VALUE = Infinity;

/** Scratch for `generatorPowerAndWaste`, reused for the same reason as in `simulate.ts`. */
const conversion = { power: 0.0, waste: 0.0 };

interface HubFit {
  generator: EffectiveBuilding;
  reactor: EffectiveBuilding;
  r: number;
  c: number;
  power: number;
  /** The waste the hub makes at that fill — what a pooled seed charges for. */
  waste: number;
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
            best = { generator, reactor, r, c, power, waste };
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
  waste: number;
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
    if (best === null || power > best.power) best = { dp, c, power, waste };
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
  waste: number;
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
  pooled = false,
): SharedFit | null {
  if (reactors.length === 0) return null;
  const topReactor = reactors[0];
  const secondReactor = reactors.length > 1 ? reactors[1] : null;

  // Under a pool `cooler` is the phantom and `c` is 0, so the arrangement is
  // simulated with no cooler beside it — and a coolerless board is offline.
  // The pool is stood in for by the phantom on any tile outside the
  // neighbourhood; where the island has none, the arrangement cannot be
  // measured and is not offered.
  let poolTile = -1;
  if (pooled) {
    const local = new Set(neighbors);
    for (let t = 0; t < ctx.n; t++) {
      if (t !== tile && !local.has(t)) {
        poolTile = t;
        break;
      }
    }
    if (poolTile < 0) return null;
  }

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
        if (pooled) {
          put(scratch, ctx, poolTile, cooler);
          touched.push(poolTile);
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
            waste: wasteTotal,
          };
        }
      }
    }
  }

  return best;
}

/** A `SharedFit` with every tile spelled as a direction from its centre. */
interface RelativeSharedFit {
  power: number;
  waste: number;
  /** Direction index per reactor, or -1 for the centre tile itself. */
  reactorDirections: number[];
  reactorTiers: EffectiveBuilding[];
  genDirections: number[];
  coolerDirections: number[];
}

/**
 * The shape of a tile's free neighbourhood: a bit per `CHEBYSHEV_DIRECTIONS`
 * entry that holds a free tile, with the maps between tile and direction.
 */
function neighbourhoodShape(
  ctx: IslandContext,
  tile: number,
  neighbors: number[],
): {
  mask: number;
  directionOf: Map<number, number>;
  tileAt: Int32Array;
} {
  let mask = 0;
  const directionOf = new Map<number, number>();
  const tileAt = new Int32Array(CHEBYSHEV_DIRECTIONS.length).fill(-1);
  for (const n of neighbors) {
    const dx = ctx.xs[n] - ctx.xs[tile];
    const dy = ctx.ys[n] - ctx.ys[tile];
    for (let d = 0; d < CHEBYSHEV_DIRECTIONS.length; d++) {
      if (
        CHEBYSHEV_DIRECTIONS[d][0] === dx &&
        CHEBYSHEV_DIRECTIONS[d][1] === dy
      ) {
        mask |= 1 << d;
        directionOf.set(n, d);
        tileAt[d] = n;
        break;
      }
    }
  }
  return { mask, directionOf, tileAt };
}

function toRelativeFit(
  fit: SharedFit,
  directionOf: Map<number, number>,
): RelativeSharedFit {
  const direction = (t: number): number => directionOf.get(t) ?? -1;
  return {
    power: fit.power,
    waste: fit.waste,
    reactorDirections: fit.reactorTiles.map(direction),
    reactorTiers: fit.reactorTiers,
    genDirections: fit.genPositions.map(direction),
    coolerDirections: fit.coolerPositions.map(direction),
  };
}

function fromRelativeFit(
  fit: RelativeSharedFit,
  tile: number,
  tileAt: Int32Array,
): SharedFit {
  const at = (d: number): number => (d < 0 ? tile : tileAt[d]);
  return {
    power: fit.power,
    waste: fit.waste,
    reactorTiles: fit.reactorDirections.map(at),
    reactorTiers: fit.reactorTiers,
    genPositions: fit.genDirections.map(at),
    coolerPositions: fit.coolerDirections.map(at),
  };
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
  pooled = false,
  sizeByIsolation = true,
): Placement {
  const placement = emptyPlacement(ctx.n);
  const available = new Uint8Array(ctx.n);
  for (const tile of buildableOrder) available[tile] = 1;
  let numAvailable = buildableOrder.length;

  const topReactor = reactors.length > 0 ? reactors[0] : null;
  const topGenerator = generators.length > 0 ? generators[0] : null;
  const topCooler = coolers.length > 0 ? coolers[0] : null;

  // Under a generator isolation a hub is sized with its generator at the
  // ISOLATED rating, and no hub's generator is put beside another. Sized from
  // the plain roster, a full-unlock hub is one ecto reactor filling one
  // generator and the "shared" fit stands three generators round one reactor
  // — every one of them crowded, on a board where an isolated generator takes
  // two reactors and makes four times the power. That seed scored 32% of the
  // Singularity bound on Event Horizon where the base seed scores 60% of its
  // own (`npm run profile`), and the first repair had to double it. The fit
  // is sized from the rated figure and the plain entry is what is written, so
  // `simulateIsland` rates the tile from its neighbours as it always does.
  // Off under every other rule, so the fixtures reproduce byte for byte.
  //
  // Measured with the survey (`--anomaly singularity_isolation --seed 1`):
  // after the first repair the seed reads 78-88% of the bound on the eight
  // largest islands against the plain one's 50-64%. At 15s x 5 runs that is
  // a wash, -1.5% to +2.2% per map and every map inside its band; at 5s x 3
  // runs, where the budget binds, Event Horizon gains 14% and Shadowspire
  // 18%, four maps 2-4%, Ash Bay and Magma Rift read 4% and 1% lower inside
  // their bands. With generator7 at tier 3 — the roster where the bonus is
  // worth most — every map is inside 0.8%.
  const isolation = ctx.isolation;
  const isolatedSeed =
    sizeByIsolation &&
    isolation !== null &&
    isolation.role === "generator" &&
    topGenerator !== null &&
    ctx.rateIsolated(topGenerator, true).effectiveValue <
      ctx.rateIsolated(topGenerator, false).effectiveValue;
  const fitGenerators = isolatedSeed
    ? generators.map((g) => ctx.rateIsolated(g, false))
    : generators;
  const fitGenerator = fitGenerators.length > 0 ? fitGenerators[0] : null;
  const plainOf = new Map<EffectiveBuilding, EffectiveBuilding>();
  for (let i = 0; i < generators.length; i++)
    plainOf.set(fitGenerators[i], generators[i]);
  /** Whether a generator written on `tile` would crowd, or be crowded by, one. */
  const besideGenerator = (tile: number): boolean => {
    const nb = ctx.neighbors[tile];
    for (let k = 0; k < nb.length; k++) {
      const b = placement[nb[k]];
      if (b !== null && b.type === "generator") return true;
    }
    return false;
  };

  const canHub =
    topReactor !== null && topGenerator !== null && topCooler !== null;
  const canDp = directProducers.length > 0 && topCooler !== null;
  const trySharedReactor =
    canHub &&
    Math.ceil(topReactor!.effectiveValue / fitGenerator!.effectiveValue) >= 2;

  // Under a cooling pool a hub is sized with a phantom cooler that covers any
  // waste from nowhere, so every neighbour slot goes to reactors and no cooler
  // is written beside a hub. The cooling it really needs is charged as a
  // board-wide debt instead: counted into each candidate's rank as the
  // fractional tiles it will cost, reserved out of the free tiles so a hub can
  // never crowd out the coolers that keep it online, and paid off after the
  // hubs are down onto the least-connected free tiles — the scraps no hub can
  // use, which under the pool are worth exactly what a well-connected tile is.
  const fitCooler: EffectiveBuilding | null =
    pooled && topCooler !== null
      ? { ...topCooler, effectiveValue: POOL_COOLER_VALUE }
      : topCooler;
  const coolerValue =
    topCooler !== null ? ctx.rateRole(topCooler).effectiveValue : 0;
  /** Coolers the pool needs for `waste`, at the rated figure. */
  const coolersFor = (waste: number): number =>
    waste > EPS && coolerValue > 0 ? Math.ceil(waste / coolerValue) : 0;
  /** What the board's producers are owed so far, from the simulation. */
  let debt = 0;
  const actualWaste = (): number => {
    const rows = simulateIsland(placement, ctx, true).placements;
    let sum = 0;
    for (let i = 0; i < rows.length; i++) sum += rows[i].wasteHeatGenerated;
    return sum;
  };
  /** Whether claiming `tiles` still leaves room for the coolers `waste` needs. */
  const reserves = (tiles: number, waste: number): boolean =>
    !pooled || numAvailable - tiles >= coolersFor(debt + waste);
  /** Tiles a candidate charges for: its own, plus the pool's share under one. */
  const cost = (tiles: number, waste: number): number =>
    pooled ? tiles + waste / coolerValue : tiles;
  /** The tiles each claim took, newest last, for the pooled backstop. */
  const groups: number[][] = [];

  const hubFitCache = new Map<number, HubFit | null>();
  const dpFitCache = new Map<number, DpFit | null>();
  const sharedScratch = emptyPlacement(ctx.n);

  // A shared fit is simulated on an otherwise empty board, so it is a function
  // of the neighbourhood's *shape* alone — which of the eight directions hold a
  // free tile — as long as every tile rates a building the same: the tile
  // order the distribution runs in is the spatial order, which the same shape
  // reproduces wherever it sits. That is true under a uniform rating and under
  // a role scale, which rates every tile alike; a terrain bonus is per tile and
  // keeps the uncached path. Memoised by that shape, because this is the whole
  // cost of the seed: it used to re-simulate every generator combination for
  // every stale tile on every round, 0.5-0.8s on the largest shipped islands.
  const sharedFitByShape =
    ctx.uniformRating || ctx.anomaly.rule === "shared_cooling"
      ? new Map<number, RelativeSharedFit | null>()
      : null;
  const sharedFit = (tile: number, neighbors: number[]): SharedFit | null => {
    if (sharedFitByShape === null) {
      return bestSharedReactorFit(
        tile,
        neighbors,
        reactors,
        fitGenerator!,
        fitCooler!,
        ctx,
        sharedScratch,
        pooled,
      );
    }
    const shape = neighbourhoodShape(ctx, tile, neighbors);
    let relative = sharedFitByShape.get(shape.mask);
    if (relative === undefined) {
      const fit = bestSharedReactorFit(
        tile,
        neighbors,
        reactors,
        fitGenerator!,
        fitCooler!,
        ctx,
        sharedScratch,
        pooled,
      );
      relative = fit === null ? null : toRelativeFit(fit, shape.directionOf);
      sharedFitByShape.set(shape.mask, relative);
    }
    return relative === null
      ? null
      : fromRelativeFit(relative, tile, shape.tileAt);
  };

  const hubFit = (slots: number): HubFit | null => {
    let fit = hubFitCache.get(slots);
    if (fit === undefined) {
      fit = canHub
        ? bestHubFit(slots, fitGenerators, reactors, fitCooler!)
        : null;
      hubFitCache.set(slots, fit);
    }
    return fit;
  };

  const dpFit = (slots: number): DpFit | null => {
    let fit = dpFitCache.get(slots);
    if (fit === undefined) {
      fit = canDp ? bestDpFit(slots, directProducers, fitCooler!) : null;
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
      // A hub's generator stands on `tile`; beside a placed generator it
      // would be crowded, and crowd that one. Only the stale tiles are
      // re-read here and a claim marks every tile beside it stale, so this
      // sees each generator as it lands.
      const crowds = isolatedSeed && besideGenerator(tile);

      // Under a pool the fit shrinks until its reactors and its coolers both
      // fit in what is left; under the base rules the first fit is the one.
      let hub = crowds ? null : hubFit(neighbors.length);
      while (hub !== null && !reserves(1 + hub.r, hub.waste)) {
        hub = hub.r > 1 ? hubFit(hub.r - 1) : null;
      }
      if (hub !== null) {
        const tilesUsed = 1 + hub.r + hub.c;
        if (hub.power > EPS && tilesUsed > 0) {
          consider({
            powerPerTile: hub.power / cost(tilesUsed, hub.waste),
            kind: "hub",
            tile,
            neighbors,
            hub,
          });
        }
      }

      const dp = dpFit(neighbors.length);
      if (dp !== null && reserves(1, dp.waste)) {
        const tilesUsed = 1 + dp.c;
        if (dp.power > EPS && tilesUsed > 0) {
          consider({
            powerPerTile: dp.power / cost(tilesUsed, dp.waste),
            kind: "dp",
            tile,
            neighbors,
            dp,
          });
        }
      }

      if (trySharedReactor && neighbors.length >= 3) {
        const shared = sharedFit(tile, neighbors);
        if (
          shared !== null &&
          !(isolatedSeed && shared.genPositions.some(besideGenerator))
        ) {
          const tilesUsed =
            shared.reactorTiles.length +
            shared.genPositions.length +
            shared.coolerPositions.length;
          if (tilesUsed > 0 && reserves(tilesUsed, shared.waste)) {
            consider({
              powerPerTile: shared.power / cost(tilesUsed, shared.waste),
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

    if (pooled) {
      // The debt has grown since a candidate untouched by the last claim was
      // sized, so it may no longer leave room for its coolers. Re-size every
      // open tile against the debt as it stands: a candidate sized against the
      // current debt passes this at once, so the loop cannot spin.
      const tiles =
        best.kind === "hub"
          ? 1 + best.hub!.r
          : best.kind === "dp"
            ? 1
            : best.shared!.reactorTiles.length +
              best.shared!.genPositions.length;
      const waste =
        best.kind === "hub"
          ? best.hub!.waste
          : best.kind === "dp"
            ? best.dp!.waste
            : best.shared!.waste;
      if (!reserves(tiles, waste)) {
        for (const tile of buildableOrder) if (available[tile]) stale[tile] = 1;
        continue;
      }
    }

    const claimed: number[] = [];
    if (best.kind === "hub") {
      const { generator, reactor, r, c } = best.hub!;
      put(placement, ctx, best.tile, plainOf.get(generator) ?? generator);
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
    if (pooled) {
      groups.push(claimed);
      // The simulated figure rather than the sum of the fits' estimates: two
      // hubs down beside each other share reactors, and a generator fed by a
      // neighbour's surplus makes waste no fit counted.
      debt = actualWaste();
    }
  }

  if (pooled && topCooler !== null) {
    // Pay the debt off, least-connected tile first: a one-tile scrap holds a
    // cooler as well as any tile does, and nothing else can use it. Ascending
    // index breaks ties so the fill is a function of the board alone.
    const free = buildableOrder
      .filter((tile) => available[tile] === 1)
      .sort(
        (a, b) => ctx.neighbors[a].length - ctx.neighbors[b].length || a - b,
      );
    let cooling = 0;
    let next = 0;
    const payDown = () => {
      while (next < free.length && !wasteIsCovered(debt, cooling)) {
        const tile = free[next++];
        put(placement, ctx, tile, topCooler);
        cooling += placement[tile]!.effectiveValue;
      }
    };
    payDown();

    // A short pool is an all-offline board, and `stabilize` would then delete
    // every producer. So the board has to come up here: one more cooler while
    // there is a tile for it, and failing that the newest hub is taken back
    // and its tiles spent on the pool instead.
    while (debt > EPS && simulateIsland(placement, ctx).totalPower <= EPS) {
      if (next < free.length) {
        const tile = free[next++];
        put(placement, ctx, tile, topCooler);
        cooling += placement[tile]!.effectiveValue;
        continue;
      }
      const group = groups.pop();
      if (group === undefined) break;
      for (const tile of group) placement[tile] = null;
      for (const tile of group) free.push(tile);
      debt = actualWaste();
      payDown();
    }
  }

  return placement;
}

/**
 * `sizeByIsolation` is `constructSeed`'s: false builds the plain-sized seed
 * under a role isolation, which `solveIsland` compares against the sized one.
 * It means nothing under any other rule.
 */
export function constructMultiStartSeed(
  ctx: IslandContext,
  reactors: EffectiveBuilding[],
  generators: EffectiveBuilding[],
  coolers: EffectiveBuilding[],
  directProducers: EffectiveBuilding[],
  deadlineMs: number,
  sizeByIsolation = true,
): Placement {
  const buildable = Array.from(ctx.tiles);

  const passes = (
    pooled: boolean,
    sizeByIsolation = true,
  ): { seed: Placement; power: number } => {
    let bestSeed = constructSeed(
      buildable,
      ctx,
      reactors,
      generators,
      coolers,
      directProducers,
      deadlineMs,
      pooled,
      sizeByIsolation,
    );
    let bestPower = simulateIsland(bestSeed, ctx).totalPower;

    if (bestPower <= EPS) {
      // The deadline elapsed mid-construction and left a seed that powers
      // nothing. One full greedy pass costs about 25ms on the largest island
      // in the game (`npm run profile`), so finish it: refining a degenerate
      // seed wastes the whole budget and can return an empty layout for a
      // solvable island.
      bestSeed = constructSeed(
        buildable,
        ctx,
        reactors,
        generators,
        coolers,
        directProducers,
        performance.now() + 1000,
        pooled,
        sizeByIsolation,
      );
      bestPower = simulateIsland(bestSeed, ctx).totalPower;
    }

    if (performance.now() >= deadlineMs - 50 || buildable.length < 6)
      return { seed: bestSeed, power: bestPower };

    const reversed = [...buildable].reverse();
    const seedRev = constructSeed(
      reversed,
      ctx,
      reactors,
      generators,
      coolers,
      directProducers,
      deadlineMs,
      pooled,
      sizeByIsolation,
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
        pooled,
        sizeByIsolation,
      );
      const powerRand = simulateIsland(seedRand, ctx).totalPower;
      if (powerRand > bestPower + EPS) {
        bestPower = powerRand;
        bestSeed = seedRand;
      }
    }

    return { seed: bestSeed, power: bestPower };
  };

  const local = passes(false, sizeByIsolation);
  if (ctx.anomaly.rule !== "shared_cooling") return local.seed;

  // Under a pool the same three orders are run engine-first as well, and the
  // strongest seed of the six starts the search. The local passes stay in:
  // they are what the search started from before the pooled ones existed, and
  // a pooled seed that comes back weaker is not an improvement.
  const pooled = passes(true);
  return pooled.power > local.power + EPS ? pooled.seed : local.seed;
}
