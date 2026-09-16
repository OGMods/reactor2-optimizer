/**
 * The Distribution System (FairShare + Augmenting Repair).
 *
 * The worked examples below are taken straight from `docs/game-logic.md` and
 * are the highest-value tests in the suite: distribution is the one place where
 * a plausible-looking "simplification" — handing leftovers on sequentially
 * instead of re-splitting them, or skipping the repair loop — silently changes
 * every solve.
 *
 * Positions matter. The spec's processing order is ascending X then descending
 * Y, so the coordinates in each case are chosen to pin that order down.
 *
 * Ported from the reference solver's `tests/test_distribution.py`. One shape
 * differs: that implementation took `Node` lists and sorted them internally,
 * so it could be asked what happens when the input arrives in a different
 * order. Here the caller hands `runDistribution` tile indices into an
 * `IslandContext`, and ascending index *is* the spatial order — the question
 * cannot be asked, because the type no longer admits it. `distribute` below
 * does that sorting once, which is what every real caller does too.
 */
import { describe, expect, it } from "vitest";
import { buildIslandContext, type IslandContext } from "../src/solver/context";
import { runDistribution } from "../src/solver/distribution";
import { Rng } from "../src/solver/rng";
import { expectAllocation, expectClose, grassGrid } from "./helpers";

const THIRD_OF_100 = 100 / 3;

/** A node in a distribution case: where it is, and how much it can move. */
interface Node {
  pos: [number, number];
  capacity: number;
}

function node(x: number, y: number, capacity: number): Node {
  return { pos: [x, y], capacity };
}

/** Chebyshev adjacency, the game's own. */
function isAdjacent(a: [number, number], b: [number, number]): boolean {
  const dx = Math.abs(a[0] - b[0]);
  const dy = Math.abs(a[1] - b[1]);
  return (dx !== 0 || dy !== 0) && dx <= 1 && dy <= 1;
}

interface Allocation {
  sent: Map<string, number>;
  received: Map<string, number>;
  ctx: IslandContext;
}

/**
 * Runs a distribution over an all-grass board big enough to hold every node.
 *
 * Supplier and consumer tile lists are sorted ascending, which is what the
 * distribution rules require and what `simulateIsland` does when it builds
 * them.
 */
function distribute(suppliers: Node[], consumers: Node[]): Allocation {
  const all = [...suppliers, ...consumers];
  const width = Math.max(1, ...all.map((n) => n.pos[0] + 1));
  const height = Math.max(1, ...all.map((n) => n.pos[1] + 1));
  const ctx = buildIslandContext(grassGrid(width, height));

  const indexOf = (pos: [number, number]): number => {
    for (let i = 0; i < ctx.n; i++) {
      if (ctx.xs[i] === pos[0] && ctx.ys[i] === pos[1]) return i;
    }
    throw new Error(`no tile at ${pos[0]},${pos[1]}`);
  };

  const capByTile = new Map<number, number>();
  const toTiles = (nodes: Node[]): Int32Array => {
    const tiles = nodes.map((n) => {
      const t = indexOf(n.pos);
      capByTile.set(t, n.capacity);
      return t;
    });
    return Int32Array.from(tiles.sort((a, b) => a - b));
  };

  const supplierTiles = toTiles(suppliers);
  const consumerTiles = toTiles(consumers);

  for (let i = 0; i < supplierTiles.length; i++) {
    ctx.dist.supplierCap[i] = capByTile.get(supplierTiles[i])!;
  }
  for (let j = 0; j < consumerTiles.length; j++) {
    ctx.dist.consumerCap[j] = capByTile.get(consumerTiles[j])!;
  }

  runDistribution(
    supplierTiles,
    supplierTiles.length,
    consumerTiles,
    consumerTiles.length,
    ctx,
  );

  const key = (t: number) => `${ctx.xs[t]},${ctx.ys[t]}`;
  const sent = new Map<string, number>();
  for (let i = 0; i < supplierTiles.length; i++) {
    sent.set(key(supplierTiles[i]), ctx.dist.supplierSent[i]);
  }
  const received = new Map<string, number>();
  for (let j = 0; j < consumerTiles.length; j++) {
    received.set(key(consumerTiles[j]), ctx.dist.consumerReceived[j]);
  }
  return { sent, received, ctx };
}

function total(values: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const v of values.values()) sum += v;
  return sum;
}

/**
 * Independent maximum-flow oracle: a textbook Edmonds-Karp over an explicit
 * capacity matrix, deliberately sharing no structure with the implementation
 * under test. Used to check that Augmenting Repair really does run to
 * completion rather than stopping at the first improvement.
 *
 * Node layout: 0 = source, 1..S = suppliers, S+1..S+C = consumers, last = sink.
 */
function referenceMaxFlow(suppliers: Node[], consumers: Node[]): number {
  const nSup = suppliers.length;
  const nCon = consumers.length;
  const sink = nSup + nCon + 1;
  const size = sink + 1;

  const residual = Array.from({ length: size }, () => new Float64Array(size));
  for (let i = 0; i < nSup; i++) {
    residual[0][1 + i] = suppliers[i].capacity;
    for (let j = 0; j < nCon; j++) {
      if (isAdjacent(suppliers[i].pos, consumers[j].pos)) {
        residual[1 + i][1 + nSup + j] = Infinity;
      }
    }
  }
  for (let j = 0; j < nCon; j++) {
    residual[1 + nSup + j][sink] = consumers[j].capacity;
  }

  let flow = 0;
  for (;;) {
    // BFS for a shortest augmenting path in the residual graph.
    const parent = new Int32Array(size).fill(-1);
    parent[0] = 0;
    const queue = [0];
    while (queue.length > 0 && parent[sink] === -1) {
      const at = queue.shift()!;
      for (let next = 0; next < size; next++) {
        if (parent[next] === -1 && residual[at][next] > 1e-9) {
          parent[next] = at;
          queue.push(next);
        }
      }
    }
    if (parent[sink] === -1) return flow;

    let bottleneck = Infinity;
    for (let at = sink; at !== 0; at = parent[at]) {
      bottleneck = Math.min(bottleneck, residual[parent[at]][at]);
    }
    for (let at = sink; at !== 0; at = parent[at]) {
      residual[parent[at]][at] -= bottleneck;
      residual[at][parent[at]] += bottleneck;
    }
    flow += bottleneck;
  }
}

describe("FairShare", () => {
  // Phase 1: equal split, with leftovers re-split evenly on later rounds.

  it("splits equally among eligible consumers", () => {
    const { sent, received } = distribute(
      [node(1, 0, 100)],
      [node(0, 0, 100), node(2, 0, 100)],
    );

    expectAllocation(received, { "0,0": 50, "2,0": 50 });
    expectAllocation(sent, { "1,0": 100 });
  });

  it("lands a single supplier's leftover via Augmenting Repair", () => {
    /*
     * One reactor (100 heat) adjacent to three generators of capacity 10, 100
     * and 100 produces 10 / 57 / 33.
     *
     * Read the reason carefully. With a SINGLE supplier, FairShare gets only one
     * round, so its 23.33 leftover is never re-split — Augmenting Repair places
     * it, and Augmenting Repair *is* sequential. The same 10 / 57 / 33 therefore
     * comes out whether FairShare re-splits evenly or hands leftovers on one at
     * a time, so this case says nothing about which rule FairShare uses. It once
     * carried a name and a comment claiming it proved the sequential reading; it
     * does not, and the wrong rule shipped for a long time behind exactly that
     * false confidence.
     *
     * See the in-game measurements below for the multi-supplier layouts that
     * actually discriminate.
     */
    const { sent, received } = distribute(
      [node(1, 1, 100)],
      // Spatial order (ascending X, then descending Y): (0,1) -> (0,0) -> (1,0)
      [node(0, 1, 10), node(0, 0, 100), node(1, 0, 100)],
    );

    expectAllocation(received, {
      "0,1": 10, // capped at its capacity
      "0,0": THIRD_OF_100 + 70 / 3, // 33.33 share + 23.33 from repair
      "1,0": THIRD_OF_100,
    });
    expectClose(sent.get("1,1")!, 100);
  });

  it("leaves a surplus unused when no eligible consumer wants it", () => {
    // Spec: "Unreclaimed Surplus Stays Unused" — not forced onto a full consumer.
    const { sent, received } = distribute([node(1, 0, 100)], [node(0, 0, 10)]);

    expectClose(received.get("0,0")!, 10);
    expectClose(sent.get("1,0")!, 10); // must not report sending more than was absorbed
  });

  it("never lets non-adjacent pairs interact", () => {
    const { sent, received } = distribute([node(0, 0, 100)], [node(5, 5, 100)]);

    expectClose(sent.get("0,0")!, 0);
    expectClose(received.get("5,5")!, 0);
  });

  it("lets diagonal neighbours interact", () => {
    const { received } = distribute([node(0, 0, 40)], [node(1, 1, 100)]);

    expectClose(received.get("1,1")!, 40);
  });

  it("gives an earlier supplier the capacity before a later one", () => {
    // Suppliers are sequential: the first one to run sees full capacity.
    const { sent, received } = distribute(
      [node(2, 0, 60), node(0, 0, 60)],
      [node(1, 0, 100)],
    );

    expectClose(received.get("1,0")!, 100);
    expectClose(sent.get("0,0")!, 60); // x=0 is processed first and fills 60
    expectClose(sent.get("2,0")!, 40); // the later supplier gets the remaining 40
  });
});

describe("Augmenting Repair", () => {
  // Phase 2: reclaim allocations ACROSS suppliers to raise total delivery.

  it("gives a constrained supplier priority (spec example 1)", () => {
    /*
     * Supplier A reaches both consumers, supplier B only reaches consumer B.
     * FairShare splits A 50/50; repair must then move A's allocation off
     * consumer B (which B can fill on its own) onto consumer A, ending at
     * 100%/100%.
     */
    const { sent, received } = distribute(
      [node(1, 0, 100), node(3, 0, 100)],
      [node(0, 0, 100), node(2, 0, 100)],
    );

    expectAllocation(received, { "0,0": 100, "2,0": 100 });
    expectClose(sent.get("1,0")!, 100);
    expectClose(sent.get("3,0")!, 100);
  });

  it("does not force a rebalance for a partial repair (spec example 1)", () => {
    /*
     * The second half: if supplier B can only raise consumer B from 50% to 80%,
     * the result stays 50/80 — the 20% gap does not justify pulling resource
     * away from consumer A.
     */
    const { received } = distribute(
      [node(1, 0, 100), node(3, 0, 30)],
      [node(0, 0, 100), node(2, 0, 100)],
    );

    expectAllocation(received, { "0,0": 50, "2,0": 80 });
  });

  it("returns reclaimed resource in grid order (spec example 2)", () => {
    /*
     * A shared supplier FairShares 33/33/33; an independent supplier then fills
     * consumer 1, and the reclaimed 33.33 goes WHOLE to the next consumer in
     * spatial order — 100 / 66 / 33, not 100 / 50 / 50.
     */
    const { sent, received } = distribute(
      [node(1, 1, 100), node(3, 1, 100)],
      [
        node(2, 1, 100), // consumer 1: the only one the independent supplier reaches
        node(0, 1, 100), // consumer 2: first in spatial order
        node(0, 0, 100), // consumer 3
      ],
    );

    expectAllocation(received, {
      "2,1": 100, // filled outright
      "0,1": 2 * THIRD_OF_100, // 33.33 + the whole 33.33 returned
      "0,0": THIRD_OF_100, // untouched
    });
    expectClose(sent.get("1,1")!, 100);

    // An even re-split of the returned resource would give 50 here.
    expect(Math.abs(received.get("0,1")! - 50)).toBeGreaterThan(1e-6);
  });

  it("changes the result when the processing order changes", () => {
    /*
     * Spec: "Processing order changes the final result". The same capacities and
     * the same adjacency shape as the case above, but with the independent
     * supplier earlier in spatial order, giving 100 / 50 / 50 instead.
     */
    const { received } = distribute(
      [node(0, 1, 100), node(2, 1, 100)],
      [node(1, 1, 100), node(3, 1, 100), node(3, 0, 100)],
    );

    expectAllocation(received, { "1,1": 100, "3,1": 50, "3,0": 50 });
  });

  it("repeats until no further gain is available", () => {
    /*
     * A chain where one reclaim frees capacity that enables a second, distinct
     * reclaim. A single repair pass would stop short of full delivery.
     *
     * Consumers at even x, suppliers at odd x, each supplier adjacent to the
     * consumers on either side of it; the last supplier is a dead end.
     */
    const consumers = Array.from({ length: 4 }, (_, i) => node(2 * i, 0, 100));
    const suppliers = Array.from({ length: 4 }, (_, i) =>
      node(2 * i + 1, 0, 100),
    );

    const { received } = distribute(suppliers, consumers);

    expectClose(total(received), 400); // every consumer should end up full
    for (const consumer of consumers) {
      expectClose(received.get(`${consumer.pos[0]},${consumer.pos[1]}`)!, 100);
    }
  });
});

describe("distribution invariants", () => {
  // Properties that must hold for every input, per the spec's invariants.

  /** A random layout on a small board: 1-5 suppliers, 1-5 consumers. */
  function randomCase(
    rng: Rng,
    cols = 4,
    rows = 3,
    maxNodes = 5,
    maxCap = 100,
  ) {
    const positions: [number, number][] = [];
    for (let x = 0; x < cols; x++) {
      for (let y = 0; y < rows; y++) positions.push([x, y]);
    }
    rng.shuffle(positions);

    const nSup = 1 + rng.int(maxNodes);
    const nCon = 1 + rng.int(maxNodes);
    const take = (from: number, count: number) =>
      positions
        .slice(from, from + count)
        .map((pos) => ({ pos, capacity: 1 + rng.int(maxCap) }));

    return {
      suppliers: take(0, nSup),
      consumers: take(nSup, nCon),
    };
  }

  it("holds its invariants over many random layouts", () => {
    const rng = new Rng(20240817);

    for (let attempt = 0; attempt < 300; attempt++) {
      const { suppliers, consumers } = randomCase(rng);
      const { sent, received } = distribute(suppliers, consumers);

      for (const s of suppliers) {
        const key = `${s.pos[0]},${s.pos[1]}`;
        expect(sent.get(key)!).toBeGreaterThanOrEqual(-1e-9);
        expect(
          sent.get(key)!,
          `supplier ${key} sent more than its capacity`,
        ).toBeLessThanOrEqual(s.capacity + 1e-9);
      }
      for (const c of consumers) {
        const key = `${c.pos[0]},${c.pos[1]}`;
        expect(received.get(key)!).toBeGreaterThanOrEqual(-1e-9);
        expect(
          received.get(key)!,
          `consumer ${key} received more than its capacity`,
        ).toBeLessThanOrEqual(c.capacity + 1e-9);
      }
      // Conservation: everything sent must be received.
      expectClose(total(sent), total(received), 1e-6);
    }
  });

  it("reaches the maximum possible delivery", () => {
    /*
     * Augmenting Repair claims to repeat "until no further reclaim would
     * increase total valid delivery" — i.e. the result is a maximum flow.
     * Checked against an independent Edmonds-Karp implementation.
     */
    const rng = new Rng(11235);

    for (let attempt = 0; attempt < 120; attempt++) {
      const { suppliers, consumers } = randomCase(rng);
      const { received } = distribute(suppliers, consumers);

      expectClose(
        total(received),
        referenceMaxFlow(suppliers, consumers),
        1e-6,
      );
    }
  });

  it("handles empty inputs", () => {
    const noSuppliers = distribute([], [node(0, 0, 5)]);
    expect(noSuppliers.sent.size).toBe(0);
    expectAllocation(noSuppliers.received, { "0,0": 0 });

    const noConsumers = distribute([node(0, 0, 5)], []);
    expectAllocation(noConsumers.sent, { "0,0": 0 });
    expect(noConsumers.received.size).toBe(0);
  });
});

describe("component decomposition", () => {
  /*
   * Augmenting Repair runs per connected component of the supplier<->consumer
   * graph. That is a pure speed optimization — suppliers in different components
   * cannot reach each other's consumers — but it is only safe if each
   * component's suppliers keep their original ascending order.
   *
   * The BFS expands suppliers in that order, and when several augmenting paths
   * are equally short the first one reached wins. Grouping into components in
   * discovery order instead silently produced a DIFFERENT maximal flow: the same
   * total delivered, split across suppliers differently. The split is what
   * decides which buildings clear their cooling threshold, so it matters.
   */

  it("keeps disconnected groups from influencing each other", () => {
    // Two islands of supply, far apart, must each resolve on their own.
    const near = distribute([node(1, 0, 100)], [node(0, 0, 60)]);
    const together = distribute(
      [node(1, 0, 100), node(9, 9, 50)],
      [node(0, 0, 60), node(8, 9, 40)],
    );

    expectClose(together.sent.get("1,0")!, near.sent.get("1,0")!);
    expectClose(together.received.get("0,0")!, near.received.get("0,0")!);
    expectClose(together.sent.get("9,9")!, 40);
    expectClose(together.received.get("8,9")!, 40);
  });

  it("still reaches maximum delivery with many components", () => {
    const suppliers: Node[] = [];
    const consumers: Node[] = [];
    for (let group = 0; group < 6; group++) {
      const x = group * 4; // far enough apart to never be adjacent
      suppliers.push(node(x + 1, 0, 100));
      consumers.push(node(x, 0, 70));
    }

    const { received } = distribute(suppliers, consumers);

    expectClose(total(received), 6 * 70);
    for (const consumer of consumers) {
      expectClose(received.get(`${consumer.pos[0]},${consumer.pos[1]}`)!, 70);
    }
  });

  it("lets component order decide the split, not just the total", () => {
    /*
     * A case that actually distinguishes the two orderings.
     *
     * Both give the same total delivery (362), because both are maximum flows.
     * They differ in WHICH suppliers provide it: grouping components in
     * discovery order (DFS append, no sort) enqueues (4,1) before (3,0) and the
     * BFS then meets a different equally-short augmenting path first, sending
     * ~19.67 from (4,1) and ~65.33 from (3,0). Sorted by index — which is
     * `FlowNetwork.Augment`'s local supplier order — sends 85 from (3,0) and 0
     * from (4,1). The per-supplier split decides which buildings clear their
     * cooling threshold, so the values below are the ones that must hold.
     */
    const { sent, received } = distribute(
      [node(3, 3, 185), node(2, 2, 92), node(3, 0, 123), node(4, 1, 96)],
      [
        node(0, 0, 104),
        node(0, 2, 56),
        node(2, 3, 200),
        node(1, 0, 166),
        node(3, 2, 66),
        node(3, 1, 96),
      ],
    );

    expectAllocation(
      sent,
      { "3,3": 185, "2,2": 92, "3,0": 85, "4,1": 0 },
      1e-6,
    );
    expectAllocation(
      received,
      {
        "0,0": 0,
        "0,2": 0,
        "1,0": 0,
        "2,3": 200,
        "3,2": 66,
        "3,1": 96,
      },
      1e-6,
    );
  });

  it("matches an undecomposed reference on random layouts", () => {
    /*
     * The property the ordering bug broke: not just the total, but the exact
     * per-supplier and per-consumer split, must be independent of how the
     * components happen to be discovered. The reference solver asked this by
     * reversing its input; here ascending tile index is the only order there is,
     * so what is left to check is that decomposing at all still reaches the max
     * flow an undecomposed oracle finds.
     */
    const rng = new Rng(31337);

    for (let attempt = 0; attempt < 200; attempt++) {
      const positions: [number, number][] = [];
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 4; y++) positions.push([x, y]);
      }
      rng.shuffle(positions);

      const nSup = 1 + rng.int(8);
      const nCon = 1 + rng.int(8);
      const suppliers = positions
        .slice(0, nSup)
        .map((pos) => ({ pos, capacity: 1 + rng.int(200) }));
      const consumers = positions
        .slice(nSup, nSup + nCon)
        .map((pos) => ({ pos, capacity: 1 + rng.int(200) }));

      const { received } = distribute(suppliers, consumers);

      expectClose(
        total(received),
        referenceMaxFlow(suppliers, consumers),
        1e-6,
      );
    }
  });
});

describe("FairShare matches the live game", () => {
  /*
   * Layouts built in the live game, with per-building power read off the screen.
   *
   * These are observations, not derivations from the spec — the spec was wrong
   * about leftover handling until these runs corrected it. Each layout was
   * designed so that two candidate rules predict visibly different numbers, and
   * the totals act as a control: they match under both, so a mismatched total
   * means the board was built wrong rather than the rule being wrong.
   */
  const G2 = 1.31e6;
  const G1 = 2560;
  const HELIO = 250000;

  /** The power a generator makes from the heat routed to it. */
  const asPower = (heat: number) => heat * 0.75;

  it("re-splits the leftover evenly between two contested suppliers", () => {
    /*
     * Two Heliothermal Plants, both adjacent to two Generator 2s and one
     * Generator 1. Measured: both Generator 2s ran at 186k power.
     *
     * A sequential handoff predicts 217k / 156k. The even re-split predicts
     * 186,540 for both, which is what the game shows.
     */
    const { received } = distribute(
      [node(0, 1, HELIO), node(2, 1, HELIO)],
      [node(1, 2, G2), node(1, 1, G2), node(1, 0, G1)],
    );

    expectClose(asPower(received.get("1,2")!), 186540);
    expectClose(asPower(received.get("1,1")!), 186540);
    expectClose(asPower(received.get("1,0")!), 1920);
  });

  it("leaves a single reactor's remainder to sequential Augmenting Repair", () => {
    const { received } = distribute(
      [node(0, 1, HELIO)],
      [node(1, 2, G2), node(1, 1, G2), node(1, 0, G1)],
    );

    expectClose(asPower(received.get("1,2")!), 123080);
    expectClose(asPower(received.get("1,1")!), 62500);
    expectClose(asPower(received.get("1,0")!), 1920);
  });

  it("puts the round loop outside the supplier loop", () => {
    /*
     * Two Divine Reactors: the first adjacent to only two of the four
     * generators, the second to all four. Measured: no two Generator 5s ran at
     * the same power.
     *
     * Running each supplier to exhaustion before starting the next ("rounds
     * inside") predicts 6.45e15 for two of them. Running every supplier once per
     * round ("rounds outside") predicts 8.6e15 and 4.3e15. The game shows them
     * unequal.
     */
    const DIVINE = 1.72e16;
    const G5 = 1.69e16;

    const { received } = distribute(
      [node(0, 0, DIVINE), node(1, 1, DIVINE)],
      [node(0, 1, G5), node(1, 2, G5), node(1, 0, G2), node(2, 1, G5)],
    );

    expectClose(asPower(received.get("0,1")!), 1.2675e16);
    expectClose(asPower(received.get("1,2")!), 8.6e15);
    expectClose(asPower(received.get("2,1")!), 4.3e15);
    expect(
      Math.abs(received.get("1,2")! - received.get("2,1")!),
    ).toBeGreaterThan(1e-6);
  });

  it("scopes its rounds to the connected component", () => {
    /*
     * A reactor that shares no consumer with this cluster must not lengthen its
     * redistribution. The round budget is per connected component, not per
     * island and not per board. Measured in-game: the isolated cluster keeps its
     * single round even with other reactors on the same island and elsewhere on
     * the map.
     */
    const clusterSuppliers = [node(0, 1, HELIO)];
    const clusterConsumers = [node(1, 2, G2), node(1, 1, G2), node(1, 0, G1)];

    const alone = distribute(clusterSuppliers, clusterConsumers);
    const together = distribute(
      [...clusterSuppliers, node(5, 1, HELIO)],
      [...clusterConsumers, node(6, 1, G2)],
    );

    expectClose(asPower(together.received.get("1,2")!), 123080);
    expectClose(asPower(together.received.get("1,1")!), 62500);
    for (const pos of ["1,2", "1,1", "1,0"]) {
      expectClose(together.received.get(pos)!, alone.received.get(pos)!, 1e-12);
    }
  });
});
