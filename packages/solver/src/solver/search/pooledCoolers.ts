import type { IslandContext } from "../context";
import { type SimPlacedBuilding, simulateIsland } from "../simulate";
import type { EffectiveBuilding, Placement } from "../types";
import {
  chebyshev,
  copyInto,
  emptyPlacement,
  isReactor,
  put,
  ratedFor,
  SWAP_RADIUS,
} from "./placement";
import { covers } from "./rightSize";
import { anyOfflineProducer, planHolds } from "./stability";

/**
 * Under a shared cooling pool only: gathering the coolers the search scattered,
 * after moving hubs off the smaller landmasses so those can hold them.
 */

/**
 * How long `gatherPooledCoolers` may spend, per solve on the primary layout and
 * once more shared across its alternates. It runs after the search's deadline,
 * so this is time added to a run. Moving a cooler onto an empty tile costs
 * nothing. The cap is for the cooler-to-producer swaps, which mostly fail and
 * cost a simulation each. On the shipped maps one layout finishes in 15-110ms.
 */
export const GATHER_BUDGET_MS = 150;

/**
 * How long `evacuateMinorLandmasses` may spend, on top of `GATHER_BUDGET_MS`
 * and taken first. Spent only on a board with producers on more than one
 * landmass, and the pass stops as soon as a hub is placed — moving a
 * 15-producer hub costs about 170ms on a desktop. The cap is sized for a phone,
 * several times slower, where a tight one would make the pass silently do
 * nothing; a second is small beside a 10-30s attempt. Out of time, the layout
 * stays as it was.
 */
export const EVACUATE_BUDGET_MS = 1000;

/** Chebyshev radius of the patch `gatherPooledCoolers` anchors on. */
const GATHER_ANCHOR_RADIUS = 2;

/** Each tile's landmass, numbered from 0, and how many there are. */
function landmasses(ctx: IslandContext): {
  component: Int32Array;
  count: number;
} {
  const component = new Int32Array(ctx.n).fill(-1);
  let count = 0;
  for (let start = 0; start < ctx.n; start++) {
    if (component[start] >= 0) continue;
    const id = count++;
    const stack = [start];
    component[start] = id;
    while (stack.length > 0) {
      const nb = ctx.neighbors[stack.pop()!];
      for (let k = 0; k < nb.length; k++) {
        if (component[nb[k]] < 0) {
          component[nb[k]] = id;
          stack.push(nb[k]);
        }
      }
    }
  }
  return { component, count };
}

/**
 * Under a shared cooling pool, moves the hubs off every landmass but the main
 * one, so that landmass can be given to the coolers.
 *
 * `gatherPooledCoolers` moves one tile at a time, and that cannot move a hub:
 * a generator taken from its reactors loses power at every step of the way, so
 * the hub on a small second landmass stays there and its coolers stay with it.
 * This moves a landmass's producers all at once instead. Each takes a tile on
 * the main landmass, the one holding the most producers, and the cooler it
 * displaces goes to one of the tiles the producers left — so the pool's total
 * and the board's composition never change, and the landmass comes out
 * producer-free for the sweep to fill.
 *
 * The producers are placed greedily, whichever of them is worth the most power
 * on whichever free tile goes next, and then the main landmass is swapped
 * into shape until power is back (`relocateHub`). A landmass is evacuated only if the result
 * holds the power floor, keeps every producer online and passes the upgrade
 * plan; otherwise the layout is left exactly as it was. Smallest first, since a
 * hub of a few producers is the likeliest to fit.
 */
function evacuateMinorLandmasses(
  current: Placement,
  ctx: IslandContext,
  component: Int32Array,
  count: number,
  floor: number,
  deadlineMs: number,
): void {
  const producersOn = new Array<number>(count).fill(0);
  for (let t = 0; t < ctx.n; t++) {
    const b = current[t];
    if (b !== null && b.type !== "cooler") producersOn[component[t]]++;
  }
  let main = 0;
  for (let c = 1; c < count; c++)
    if (producersOn[c] > producersOn[main]) main = c;

  const minors: number[] = [];
  for (let c = 0; c < count; c++)
    if (c !== main && producersOn[c] > 0) minors.push(c);
  minors.sort((a, b) => producersOn[a] - producersOn[b] || a - b);

  const trial = current.slice();
  for (const minor of minors) {
    if (performance.now() >= deadlineMs) return;
    copyInto(trial, current);
    if (relocateHub(trial, ctx, component, minor, main, floor, deadlineMs))
      copyInto(current, trial);
  }
}

/**
 * Moves every producer on `minor` onto `main`, in place. True when the result
 * is a layout `evacuateMinorLandmasses` may keep; `trial` is junk otherwise.
 */
function relocateHub(
  trial: Placement,
  ctx: IslandContext,
  component: Int32Array,
  minor: number,
  main: number,
  floor: number,
  deadlineMs: number,
): boolean {
  const movers: EffectiveBuilding[] = [];
  const vacated: number[] = [];
  for (let t = 0; t < ctx.n; t++) {
    const b = trial[t];
    if (component[t] !== minor || b === null || b.type === "cooler") continue;
    movers.push(b);
    vacated.push(t);
    trial[t] = null;
  }

  // A tile on the main landmass a producer may take: empty, or a cooler that
  // can step across to the landmass being emptied.
  const free = (t: number): boolean =>
    component[t] === main && (trial[t] === null || trial[t]!.type === "cooler");
  const freeAround = (t: number): number => {
    let n = 0;
    for (const u of ctx.neighbors[t]) if (free(u)) n++;
    return n;
  };
  // A reactor makes power only through a generator beside it, so a tile with
  // none is not worth simulating.
  const besideGenerator = (t: number): boolean => {
    for (const u of ctx.neighbors[t])
      if (trial[u] !== null && trial[u]!.type === "generator") return true;
    return false;
  };

  let nextVacated = 0;
  while (movers.length > 0) {
    if (performance.now() >= deadlineMs) return false;

    let bestPower = -Infinity;
    let bestRoom = -1;
    let bestTile = -1;
    let bestMover = -1;
    // A reactor beside no generator is still placed when nothing better is
    // left — a generator that took the strongest tile may have taken the last
    // free one beside it too — and the swap descent below moves it into place.
    for (const anywhere of [false, true]) {
      const tried = new Set<string>();
      for (let m = 0; m < movers.length; m++) {
        const b = movers[m];
        if (tried.has(b.id)) continue;
        tried.add(b.id);
        for (const t of ctx.tiles) {
          if (!free(t)) continue;
          if (!anywhere && isReactor(b) && !besideGenerator(t)) continue;
          const held = trial[t];
          put(trial, ctx, t, b);
          const power = simulateIsland(trial, ctx).totalPower;
          trial[t] = held;
          // On a tie, the tile with the most room left around it, so a
          // generator lands where its reactors can follow.
          const room = freeAround(t);
          if (power > bestPower || (power === bestPower && room > bestRoom)) {
            bestPower = power;
            bestRoom = room;
            bestTile = t;
            bestMover = m;
          }
        }
      }
      if (bestTile >= 0) break;
    }
    if (bestTile < 0) return false;

    const displaced = trial[bestTile];
    put(trial, ctx, bestTile, movers[bestMover]);
    // The displaced cooler crosses over at once, so the pool is whole while
    // the rest of the hub is placed.
    if (displaced !== null) put(trial, ctx, vacated[nextVacated++], displaced);
    movers.splice(bestMover, 1);
  }

  // The greedy order cannot see that a reactor placed early sits on the tile a
  // later generator wanted, and the hubs already on the main landmass were
  // built around a board that had no room for these. So: a swap descent over
  // the whole landmass, nearby pairs only (as `arrangeComposition` does), first
  // gain taken, until the floor is met. Swaps never change what is on the
  // board, and the emptied landmass is not in the pairs, so nothing returns to
  // it. On a cleared Entropy Isles under Cryo the greedy reaches 98.5% of the
  // floor and one pass of this closes the rest.
  const onMain: number[] = [];
  for (const t of ctx.tiles) if (component[t] === main) onMain.push(t);
  const pairs: [number, number][] = [];
  for (let i = 0; i < onMain.length; i++)
    for (let j = i + 1; j < onMain.length; j++)
      if (chebyshev(ctx, onMain[i], onMain[j]) <= SWAP_RADIUS)
        pairs.push([onMain[i], onMain[j]]);

  const producer = (b: EffectiveBuilding | null): boolean =>
    b !== null && b.type !== "cooler";
  let power = simulateIsland(trial, ctx).totalPower;
  let improved = true;
  while (improved && !covers(power, floor)) {
    improved = false;
    for (const [a, b] of pairs) {
      if (performance.now() >= deadlineMs) return false;
      const va = trial[a];
      const vb = trial[b];
      // Coolers and empty tiles are interchangeable under the pool.
      if (!producer(va) && !producer(vb)) continue;
      if (ratedFor(ctx, a, vb) === va) continue;
      put(trial, ctx, a, vb);
      put(trial, ctx, b, va);
      const swapped = simulateIsland(trial, ctx).totalPower;
      if (swapped > power) {
        power = swapped;
        improved = true;
        if (covers(power, floor)) break;
        continue;
      }
      put(trial, ctx, a, va);
      put(trial, ctx, b, vb);
    }
  }

  const final = simulateIsland(trial, ctx);
  return (
    covers(final.totalPower, floor) &&
    !anyOfflineProducer(trial, final.placements) &&
    planHolds(trial, ctx)
  );
}

/**
 * Under a shared cooling pool, pulls the coolers into one area of the board
 * and onto the small islands no producer is using.
 *
 * Under the pool a cooler's tile does not matter. Every cooler pays into one
 * figure (`simulateIsland`), so power cannot tell a cooler in the middle of the
 * hubs from one at the edge. The walk leaves coolers wherever a hub left a gap,
 * scattered across the landmass, and that board is harder to read and to build
 * than the same layout with its coolers together.
 *
 * Like `downgradeOversized`, this cannot find a better layout. It only moves
 * coolers, swapping each with a tile nearer the anchor. Moving onto an empty
 * tile always holds, because the pool's total and every producer are
 * untouched. A swap with a producer moves that producer into the cooler's old
 * tile, so it is re-simulated and kept only if power holds, every producer
 * stays online and the upgrade plan still runs.
 *
 * The anchor is the tile with the most coolers within `GATHER_ANCHOR_RADIUS`,
 * so the coolers gather on the patch where most of them already stand. Anchoring
 * on the coolers' centroid was measured too: it put the anchor among the hubs,
 * where a swap rarely holds, and left more clusters on maps 1 and 8. A tile on a
 * landmass with no producer is a scrap nothing else can use, and counts as
 * nearer than any tile on a working landmass, so empty scraps fill first. Every
 * accepted move strictly lowers the coolers' summed distance, so the sweep
 * terminates; the deadline only bounds how far it gets.
 */
export function gatherPooledCoolers(
  rows: SimPlacedBuilding[],
  power: number,
  effectiveBuildings: EffectiveBuilding[],
  ctx: IslandContext,
  deadlineMs: number,
  evacuateDeadlineMs = Math.min(
    deadlineMs,
    performance.now() + EVACUATE_BUDGET_MS,
  ),
): { rows: SimPlacedBuilding[]; power: number } {
  if (ctx.anomaly.rule !== "shared_cooling" || rows.length === 0)
    return { rows, power };

  const byId = new Map(effectiveBuildings.map((b) => [b.id, b]));
  const current = emptyPlacement(ctx.n);
  for (const row of rows) {
    const building = byId.get(row.buildingId);
    if (building === undefined) return { rows, power };
    put(current, ctx, row.idx, building);
  }

  const { component, count } = landmasses(ctx);
  // The callers' deadline covers both budgets; capping the evacuation at its
  // own (the default) leaves the sweep at least `GATHER_BUDGET_MS`.
  evacuateMinorLandmasses(
    current,
    ctx,
    component,
    count,
    power,
    evacuateDeadlineMs,
  );

  // Which landmasses hold a producer, read after the evacuation so a landmass
  // it emptied fills with coolers first, like any other scrap.
  const working = new Array<boolean>(count).fill(false);
  for (let t = 0; t < ctx.n; t++) {
    const b = current[t];
    if (b !== null && b.type !== "cooler") working[component[t]] = true;
  }

  const movable = (t: number): boolean => {
    const b = current[t];
    return b !== null && b.type === "cooler" && working[component[t]];
  };
  const placed: number[] = [];
  for (let t = 0; t < ctx.n; t++) if (movable(t)) placed.push(t);
  if (placed.length === 0) return { rows, power };

  let anchor = -1;
  let densest = -1;
  for (let t = 0; t < ctx.n; t++) {
    if (!working[component[t]]) continue;
    let near = 0;
    for (const u of placed)
      if (chebyshev(ctx, t, u) <= GATHER_ANCHOR_RADIUS) near++;
    if (near > densest) {
      densest = near;
      anchor = t;
    }
  }

  /** Squared distance to the anchor; a scrap tile is nearer than any. */
  const distance = new Float64Array(ctx.n);
  for (let t = 0; t < ctx.n; t++) {
    distance[t] = working[component[t]]
      ? (ctx.xs[t] - ctx.xs[anchor]) ** 2 + (ctx.ys[t] - ctx.ys[anchor]) ** 2
      : -1;
  }
  // Nearest first, ascending index on a tie, so the result depends only on the
  // board.
  const byDistance = Array.from(ctx.tiles).sort(
    (a, b) => distance[a] - distance[b] || a - b,
  );

  const floor = power;
  let changed = true;
  while (changed && performance.now() < deadlineMs) {
    changed = false;
    // Farthest cooler first: it has the most to gain from a move.
    const coolers: number[] = [];
    for (let t = 0; t < ctx.n; t++) if (movable(t)) coolers.push(t);
    coolers.sort((a, b) => distance[b] - distance[a] || a - b);

    for (const from of coolers) {
      if (performance.now() >= deadlineMs) break;
      const cooler = current[from]!;
      for (const to of byDistance) {
        if (distance[to] >= distance[from]) break;
        const other = current[to];
        if (other !== null && other.type === "cooler") continue;

        put(current, ctx, to, cooler);
        put(current, ctx, from, other);
        if (other === null) {
          // The pool's total and every producer are unchanged.
          changed = true;
          break;
        }
        const trial = simulateIsland(current, ctx);
        if (
          covers(trial.totalPower, floor) &&
          !anyOfflineProducer(current, trial.placements) &&
          planHolds(current, ctx)
        ) {
          changed = true;
          break;
        }
        put(current, ctx, from, cooler);
        put(current, ctx, to, other);
        if (performance.now() >= deadlineMs) break;
      }
    }
  }

  const final = simulateIsland(current, ctx);
  // A move to an empty tile is exact, and a swap had to hold the floor, so a
  // shortfall here would be a bug rather than a trade. Give the input back.
  if (!covers(final.totalPower, floor)) return { rows, power };
  return { rows: final.placements, power: final.totalPower };
}
