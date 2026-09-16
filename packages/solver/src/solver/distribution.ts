import { EPS } from "./constants";
import type { IslandContext } from "./context";

/**
 * Implements the game's Distribution System: FairShare followed by Augmenting
 * Repair, run identically for the heat instance (Reactor -> Generator) and the
 * cooling instance (Cooler -> Generator/DirectProducer). Port of
 * Unity's `FlowNetwork.cs`.
 *
 * FairShare is simulated literally, in the documented spatial order (ascending
 * X, then descending Y), including its bounded round loop and the even
 * re-split of each supplier's leftover.
 *
 * Augmenting Repair is Unity's BFS: the source enqueues every supplier with
 * remaining supply; a supplier enqueues every unvisited adjacent consumer
 * (forward residual unbounded); a consumer with leftover demand connects to the
 * sink and ends that search, otherwise it walks back-edges.
 *
 * Two shapes here are load-bearing and neither is arbitrary:
 *
 * - A supplier does **not** jump straight to the sink on finding a consumer
 *   with room. It enqueues the consumer and lets the consumer node connect,
 *   because the shortcut marks later consumers visited and can select a
 *   different equal-length augmenting path — same maximum flow, different
 *   split, and the split is what decides which buildings clear their cooling.
 * - Supply and demand are counted DOWN. `cap - sent` accumulated separately is
 *   not bit-identical to a decremented remainder, and the parity fixtures are
 *   asserted exactly.
 *
 * The node numbering matches `FlowNetwork`: suppliers, then consumers, then
 * source, then sink.
 */

/**
 * Distributes `ctx.dist.supplierCap` over `ctx.dist.consumerCap`, writing the
 * outcome to `ctx.dist.supplierSent` / `ctx.dist.consumerReceived` (aligned
 * with `supplierTiles` / `consumerTiles`).
 *
 * Both tile lists MUST be in ascending tile-index order, which for an
 * `IslandContext` is exactly the game's spatial processing order — so unlike
 * ascending tile index, this never has to sort.
 */
export function runDistribution(
  supplierTiles: Int32Array,
  numSuppliers: number,
  consumerTiles: Int32Array,
  numConsumers: number,
  ctx: IslandContext,
): void {
  const d = ctx.dist;
  const supplierCap = d.supplierCap;
  const consumerCap = d.consumerCap;
  const supplierSent = d.supplierSent;
  const consumerReceived = d.consumerReceived;

  supplierSent.fill(0, 0, numSuppliers);
  consumerReceived.fill(0, 0, numConsumers);

  if (numSuppliers === 0 || numConsumers === 0) return;

  const supRem = d.remSupplierCap;
  const demRem = d.remConsumerCap;
  for (let i = 0; i < numSuppliers; i++) supRem[i] = supplierCap[i];
  for (let j = 0; j < numConsumers; j++) demRem[j] = consumerCap[j];

  const finish = (): void => {
    for (let i = 0; i < numSuppliers; i++)
      supplierSent[i] = supplierCap[i] - supRem[i];
    for (let j = 0; j < numConsumers; j++) {
      consumerReceived[j] = consumerCap[j] - demRem[j];
    }
  };

  const stamp = ++d.stamp;

  // Map consumer tiles to their consumer index so adjacency can be filtered
  // with an O(1) lookup instead of a pairwise `isAdjacent` scan.
  for (let j = 0; j < numConsumers; j++) {
    const tile = consumerTiles[j];
    d.conIdxOf[tile] = j;
    d.conIdxStamp[tile] = stamp;
  }

  // Supplier -> consumer adjacency, CSR-packed. Neighbor lists are already in
  // ascending index order, so the consumer indices come out spatially sorted —
  // the same order `FlowNetwork.BuildIsland` gives each supplier's edge list.
  // The reverse direction is only walked by Augmenting Repair, which often
  // turns out to have nothing to do, so it is built on demand.
  const supAdjStart = d.supAdjStart;
  const supAdjItems = d.supAdjItems;
  let write = 0;
  for (let i = 0; i < numSuppliers; i++) {
    supAdjStart[i] = write;
    const nb = ctx.neighbors[supplierTiles[i]];
    for (let k = 0; k < nb.length; k++) {
      const tile = nb[k];
      if (d.conIdxStamp[tile] === stamp)
        supAdjItems[write++] = d.conIdxOf[tile];
    }
  }
  supAdjStart[numSuppliers] = write;

  const flow = d.flow;
  flow.fill(0, 0, numSuppliers * numConsumers);

  // Consumer->supplier adjacency and the component decomposition are needed by
  // FairShare only when it runs past its first round, and by Augmenting Repair
  // only when it has something to do. Both are common enough to skip and
  // expensive enough to matter, so they are built at most once, on demand.
  let conAdjBuilt = false;
  let componentsBuilt = false;
  let numComponents = 0;

  // --- Phase 1: FairShare (FlowNetwork.FairShare inner loop) ---
  // Each round walks every supplier in spatial order and splits whatever that
  // supplier still holds EVENLY across its adjacent consumers that still have
  // demand. A leftover (created when an even share overshoots a consumer's
  // remaining capacity) is re-split evenly on the NEXT round -- never handed
  // whole to one neighbour. The round loop sits OUTSIDE the supplier loop, so a
  // supplier's round-N split sees what the others did in round N-1.
  //
  // A supplier gets as many rounds as there are suppliers in **its own
  // connected component** of the supplier<->consumer graph -- not on the
  // island, and not on the board. Buildings that cannot exchange anything must
  // not lengthen each other's redistribution. All three properties are measured
  // in-game; see `distribution.test.ts`.
  const supRoundBudget = d.supRoundBudget;

  /** Returns the total mass moved, which is how the round loop knows to stop. */
  const runRound = (budgeted: boolean, roundIdx: number): number => {
    let moved = 0.0;

    for (let sIdx = 0; sIdx < numSuppliers; sIdx++) {
      if (budgeted && roundIdx >= supRoundBudget[sIdx]) continue;
      if (supRem[sIdx] <= EPS) continue;

      const from = supAdjStart[sIdx];
      const to = supAdjStart[sIdx + 1];

      let needy = 0;
      for (let k = from; k < to; k++) {
        if (demRem[supAdjItems[k]] > EPS) needy++;
      }
      if (needy === 0) continue;

      const share = supRem[sIdx] / needy;
      const rowBase = sIdx * numConsumers;

      for (let k = from; k < to; k++) {
        if (supRem[sIdx] <= EPS) break;
        const cIdx = supAdjItems[k];
        if (demRem[cIdx] <= EPS) continue;
        let give = share;
        if (demRem[cIdx] < give) give = demRem[cIdx];
        if (supRem[sIdx] < give) give = supRem[sIdx];
        if (give <= EPS) continue;
        flow[rowBase + cIdx] += give;
        supRem[sIdx] -= give;
        demRem[cIdx] -= give;
        moved += give;
      }
    }

    return moved;
  };

  // Round 1 needs no component map: every supplier's component contains at
  // least itself, so every supplier is entitled to one round.
  runRound(false, 0);

  // Every later round needs the per-supplier budget, and that costs a graph
  // walk. Most layouts settle in one round, so only pay for it when some
  // supplier could still move something.
  let needsMoreRounds = false;
  for (let i = 0; i < numSuppliers && !needsMoreRounds; i++) {
    if (supRem[i] <= EPS) continue;
    for (let k = supAdjStart[i]; k < supAdjStart[i + 1]; k++) {
      if (demRem[supAdjItems[k]] > EPS) {
        needsMoreRounds = true;
        break;
      }
    }
  }

  if (needsMoreRounds) {
    buildConsumerAdjacency(
      supplierTiles,
      numSuppliers,
      consumerTiles,
      numConsumers,
      ctx,
      stamp,
    );
    conAdjBuilt = true;
    numComponents = buildComponents(numSuppliers, numConsumers, d);
    componentsBuilt = true;

    let maxRounds = 1;
    for (let i = 0; i < numSuppliers; i++) {
      if (supRoundBudget[i] > maxRounds) maxRounds = supRoundBudget[i];
    }
    for (let roundIdx = 1; roundIdx < maxRounds; roundIdx++) {
      // A round that moves nothing leaves the state untouched, so no later
      // round can move anything either.
      if (runRound(true, roundIdx) <= EPS) break;
    }
  }

  // --- Phase 2: Augmenting Repair (FlowNetwork.Augment) ---
  // Augmenting Repair can only raise total delivery, so it needs BOTH a
  // supplier with something left to give and a consumer with room to take it.
  // Whenever either side is exhausted -- which is common, since layouts tend to
  // be tight on one of the two -- the whole phase is a guaranteed no-op and its
  // BFS machinery can be skipped entirely.
  let anySupplierLeft = false;
  for (let i = 0; i < numSuppliers; i++) {
    if (supRem[i] > EPS) {
      anySupplierLeft = true;
      break;
    }
  }
  if (!anySupplierLeft) {
    finish();
    return;
  }

  let anyConsumerRoom = false;
  for (let j = 0; j < numConsumers; j++) {
    if (demRem[j] > EPS) {
      anyConsumerRoom = true;
      break;
    }
  }
  if (!anyConsumerRoom) {
    finish();
    return;
  }

  // Consumer -> supplier adjacency. FairShare already builds this whenever it
  // needed a second round, so re-do it only if that did not happen.
  if (!conAdjBuilt) {
    buildConsumerAdjacency(
      supplierTiles,
      numSuppliers,
      consumerTiles,
      numConsumers,
      ctx,
      stamp,
    );
  }
  const conAdjStart = d.conAdjStart;
  const conAdjItems = d.conAdjItems;

  const source = numSuppliers + numConsumers;
  const sink = source + 1;
  const visitedToken = d.visitedToken;
  const parentNode = d.parentNode;
  const queue = d.queue;
  visitedToken.fill(0, 0, sink + 1);
  let token = 0;

  // Suppliers grouped into connected components of the supplier<->consumer
  // graph. An augmenting path can never leave its component, and augmenting
  // inside one cannot change any other's residual state, so each is repaired
  // independently -- identical result, but every BFS scans one component
  // instead of the whole island. On a solved map-1 layout the heat graph splits
  // in two and the cooling graph into five.
  //
  // FairShare already needs this decomposition whenever it runs a second round
  // (a supplier's round budget is its component's supplier count), so reuse it
  // when it is already there.
  const componentMembers = d.componentMembers;
  const componentStart = d.componentStart;
  if (!componentsBuilt) {
    numComponents = buildComponents(numSuppliers, numConsumers, d);
  }

  for (let comp = 0; comp < numComponents; comp++) {
    const memberFrom = componentStart[comp];
    const memberTo = componentStart[comp + 1];

    for (;;) {
      let anyLeft = false;
      for (let m = memberFrom; m < memberTo; m++) {
        if (supRem[componentMembers[m]] > EPS) {
          anyLeft = true;
          break;
        }
      }
      if (!anyLeft) break;

      token += 1;
      visitedToken[source] = token;
      queue[0] = source;
      let qHead = 0;
      let qTail = 1;
      let reachedSink = false;

      while (qHead < qTail && !reachedSink) {
        const node = queue[qHead++];

        if (node === source) {
          for (let m = memberFrom; m < memberTo; m++) {
            const sIdx = componentMembers[m];
            if (visitedToken[sIdx] === token) continue;
            if (supRem[sIdx] > EPS) {
              visitedToken[sIdx] = token;
              parentNode[sIdx] = source;
              queue[qTail++] = sIdx;
            }
          }
        } else if (node < numSuppliers) {
          // Supplier -> every unvisited adjacent consumer. Forward residual is
          // unbounded, and the sink is deliberately NOT reached from here.
          for (let k = supAdjStart[node]; k < supAdjStart[node + 1]; k++) {
            const conNode = numSuppliers + supAdjItems[k];
            if (visitedToken[conNode] === token) continue;
            visitedToken[conNode] = token;
            parentNode[conNode] = node;
            queue[qTail++] = conNode;
          }
        } else if (node < source) {
          const cIdx = node - numSuppliers;
          if (visitedToken[sink] !== token && demRem[cIdx] > EPS) {
            visitedToken[sink] = token;
            parentNode[sink] = node;
            reachedSink = true;
            break;
          }

          for (let m = conAdjStart[cIdx]; m < conAdjStart[cIdx + 1]; m++) {
            const sIdx = conAdjItems[m];
            if (flow[sIdx * numConsumers + cIdx] <= EPS) continue;
            if (visitedToken[sIdx] === token) continue;
            visitedToken[sIdx] = token;
            parentNode[sIdx] = node;
            queue[qTail++] = sIdx;
          }
        }
      }

      if (!reachedSink) break;

      // Walk back from SINK to SOURCE to find the path bottleneck. A forward
      // edge (consumer reached from a supplier) has unbounded residual; only
      // the source edge, the sink edge and back-edges constrain the path.
      let bottleneck = Infinity;
      for (let node = sink; node !== source;) {
        const prev = parentNode[node];
        let residual: number;
        if (node === sink) {
          residual = demRem[prev - numSuppliers];
        } else if (prev === source) {
          residual = supRem[node];
        } else if (node < numSuppliers) {
          residual = flow[node * numConsumers + (prev - numSuppliers)];
        } else {
          residual = Infinity;
        }
        if (residual < bottleneck) bottleneck = residual;
        node = prev;
      }

      if (bottleneck === Infinity || bottleneck <= EPS) break;

      for (let node = sink; node !== source;) {
        const prev = parentNode[node];
        if (node === sink) {
          demRem[prev - numSuppliers] -= bottleneck;
        } else if (prev === source) {
          supRem[node] -= bottleneck;
        } else if (node < numSuppliers) {
          flow[node * numConsumers + (prev - numSuppliers)] -= bottleneck;
        } else {
          flow[prev * numConsumers + (node - numSuppliers)] += bottleneck;
        }
        node = prev;
      }
    }
  }

  finish();
}

/**
 * Fills `d.conAdjStart` / `d.conAdjItems` with each consumer's adjacent
 * suppliers, in ascending supplier index (i.e. spatial) order.
 */
function buildConsumerAdjacency(
  supplierTiles: Int32Array,
  numSuppliers: number,
  consumerTiles: Int32Array,
  numConsumers: number,
  ctx: IslandContext,
  stamp: number,
): void {
  const d = ctx.dist;
  for (let i = 0; i < numSuppliers; i++) {
    const tile = supplierTiles[i];
    d.supIdxOf[tile] = i;
    d.supIdxStamp[tile] = stamp;
  }
  const conAdjStart = d.conAdjStart;
  const conAdjItems = d.conAdjItems;
  let write = 0;
  for (let j = 0; j < numConsumers; j++) {
    conAdjStart[j] = write;
    const nb = ctx.neighbors[consumerTiles[j]];
    for (let k = 0; k < nb.length; k++) {
      const tile = nb[k];
      if (d.supIdxStamp[tile] === stamp)
        conAdjItems[write++] = d.supIdxOf[tile];
    }
  }
  conAdjStart[numConsumers] = write;
}

/**
 * Groups suppliers into connected components of the supplier<->consumer graph,
 * filling `d.componentOf` / `componentMembers` / `componentStart`, and writes
 * each supplier's component size into `d.supRoundBudget` — which is that
 * supplier's FairShare round budget. Returns the component count.
 *
 * Requires `buildConsumerAdjacency` to have run. Each component's members MUST
 * stay in ascending index order: the repair BFS expands suppliers in that
 * order, and when several augmenting paths are equally short the first one
 * reached wins, so discovery order would silently pick a different (equally
 * maximal, but differently split) flow — and the split decides which buildings
 * clear their cooling threshold.
 */
function buildComponents(
  numSuppliers: number,
  numConsumers: number,
  d: IslandContext["dist"],
): number {
  const componentOf = d.componentOf;
  const componentMembers = d.componentMembers;
  const componentStart = d.componentStart;
  const supRoundBudget = d.supRoundBudget;
  const conSeen = d.conSeen;
  const stack = d.stack;
  const supAdjStart = d.supAdjStart;
  const supAdjItems = d.supAdjItems;
  const conAdjStart = d.conAdjStart;
  const conAdjItems = d.conAdjItems;

  componentOf.fill(-1, 0, numSuppliers);
  conSeen.fill(0, 0, numConsumers);

  let numComponents = 0;
  let memberWrite = 0;
  for (let start = 0; start < numSuppliers; start++) {
    if (componentOf[start] !== -1) continue;

    const componentBegin = memberWrite;
    componentStart[numComponents] = componentBegin;
    componentOf[start] = numComponents;
    componentMembers[memberWrite++] = start;

    let stackTop = 0;
    stack[stackTop++] = start;
    while (stackTop > 0) {
      const sIdx = stack[--stackTop];
      for (let k = supAdjStart[sIdx]; k < supAdjStart[sIdx + 1]; k++) {
        const cIdx = supAdjItems[k];
        if (conSeen[cIdx] === 1) continue;
        conSeen[cIdx] = 1;
        for (let m = conAdjStart[cIdx]; m < conAdjStart[cIdx + 1]; m++) {
          const other = conAdjItems[m];
          if (componentOf[other] === -1) {
            componentOf[other] = numComponents;
            componentMembers[memberWrite++] = other;
            stack[stackTop++] = other;
          }
        }
      }
    }

    componentMembers.subarray(componentBegin, memberWrite).sort();
    const size = memberWrite - componentBegin;
    for (let m = componentBegin; m < memberWrite; m++) {
      supRoundBudget[componentMembers[m]] = size;
    }
    numComponents++;
  }
  componentStart[numComponents] = memberWrite;
  return numComponents;
}
