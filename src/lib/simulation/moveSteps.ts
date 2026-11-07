import type { TileType } from "../types";

/**
 * The steps that turn one board into another — the player's island as the
 * game has it into the solve on screen — in an order that keeps it producing,
 * and no more of them than it takes.
 *
 * What the game allows decides the kinds of step. A building can be **moved**,
 * so one leaving a tile is paired with one of its kind wanted elsewhere,
 * nearest first, as a single action. A building can be put down **on top of
 * another**, so a tile whose building changes is one **replace**, not a sale
 * and a purchase. What is left over is a **sell** or a **build**. A tile the
 * target builds on that is still an obstacle needs a **clear**, and clears
 * lead: they free ground, change no power, and in the game they are timers
 * worth starting early.
 *
 * When the island changes entirely — a new roster swaps every one of its
 * buildings — walking it tile by tile is longer than starting again, so the
 * plan opens with one **sell everything** and builds from there. Only then,
 * though: a building the target keeps, where it stands or moved, would be sold
 * at a share of its price and bought back at the next copy's, and a step saved
 * is not worth cash lost — under a cash limit, it is the difference between a
 * plan the budget pays for and one it does not. With nothing kept the two
 * routes buy and sell the same copies, so the shorter is planned.
 *
 * The order is greedy on power. At every step each action that can be taken
 * now — a sell or a replace always can; a move or a build once its tile is
 * free — is tried on the board as it stands, and the one that leaves the most
 * power is taken. So coolers go in before the generators that need them, and
 * a building that would steal heat from a cooled neighbour waits until it can
 * be cooled itself. Because the best steps come first, the island often makes
 * the solve's power well before it *is* the solve; with `stopAtPower` the plan
 * ends there, since the rest would only rearrange it.
 *
 * Power is not the only thing a step can run short of: a build put ahead of
 * the sale that pays for it needs cash the finished change does not. Given
 * the prices (`PlanOptions.cash`), no step is taken that would leave more
 * spent, net of refunds so far, than the whole change costs — or than
 * nothing, for a change that pays out. So the most a player must hold at once
 * is never more than the layout's own net spend, the figure a cash limit
 * holds it to. Among the steps that fit, power still decides.
 *
 * A move onto a tile another building is still waiting to leave is a
 * **swap**: the game trades two buildings' places in one action. So moves can
 * never block each other — not in a ring where A wants B's tile while B wants
 * A's, nor on a board with no free tile — and nothing is ever sold to be built
 * again. A swap finishes the one move, and the other building moves on from
 * where it landed, if it is not already home. If it landed on a tile another
 * of its kind was headed for, it is home: that one takes over its trip, so no
 * swap ever trades two identical buildings.
 */

export interface Pos {
  x: number;
  y: number;
}

export interface BoardBuilding extends Pos {
  buildingId: string;
}

export type MoveStep =
  | { kind: "clear"; x: number; y: number; obstacle: TileType }
  | { kind: "sellAll"; count: number; tiles: Pos[] }
  | { kind: "move"; buildingId: string; from: Pos; to: Pos }
  /** `a` and `b` trade tiles: `a` ends at `b`'s, `b` at `a`'s. */
  | { kind: "swap"; a: BoardBuilding; b: BoardBuilding }
  | { kind: "replace"; from: string; to: string; x: number; y: number }
  | { kind: "build"; buildingId: string; x: number; y: number }
  | { kind: "sell"; buildingId: string; x: number; y: number };

export interface MovePlan {
  steps: MoveStep[];
  /** The board before the first step and after each: `steps.length + 1`. */
  boards: BoardBuilding[][];
  /** The power of each of `boards`. */
  powers: number[];
  /**
   * True when the plan stopped at the target's power with steps left that
   * would only rearrange the island into the target's exact layout.
   */
  stoppedEarly: boolean;
}

export interface PlanOptions {
  /** Called as the plan grows, with steps decided and steps in all. */
  onProgress?: (done: number, total: number) => void;
  /** How long to work before yielding to the browser, ms. */
  sliceMs?: number;
  /** Polled between slices; a true return abandons the plan. */
  cancelled?: () => boolean;
  /** End the plan once the board makes this much. */
  stopAtPower?: number;
  /**
   * Prices to order by: no step may push the cash needed at once past what
   * the whole change costs net (or past nothing, for one that pays out).
   */
  cash?: StepPricing;
}

/**
 * The prices a plan is charged at. `copies` is each building's count across
 * all the player's islands before the first step; `build` and `refund` are
 * `buildPrice` and `sellRefund` from the solver package, passed in so this
 * module stays free of the rules' tables.
 */
export interface StepPricing {
  copies: ReadonlyMap<string, number>;
  build: (buildingId: string, copies: number) => number;
  refund: (buildingId: string, copies: number) => number;
}

/**
 * The copies standing as a plan goes, and what each purchase and sale comes
 * to: a build at the next copy's price, a sale refunding a share of the
 * current one, the count moving with each.
 */
function cashLedger(p: StepPricing) {
  const count = new Map(p.copies);
  const n = (id: string) => count.get(id) ?? 0;
  return {
    /** What buying one would cost now. */
    buyPrice: (id: string) => p.build(id, n(id)),
    /** What selling one would pay back now. */
    sellPrice: (id: string) => p.refund(id, n(id)),
    buy(id: string) {
      const price = p.build(id, n(id));
      count.set(id, n(id) + 1);
      return price;
    },
    sell(id: string) {
      const back = p.refund(id, n(id));
      count.set(id, Math.max(0, n(id) - 1));
      return back;
    },
  };
}

/**
 * Relative slack for "within the cash": spends sum terms across thirty orders
 * of magnitude, so they are compared against the size of their own terms.
 */
const CASH_TOLERANCE = 1e-9;

const key = (p: Pos) => `${p.x},${p.y}`;
const dist = (a: Pos, b: Pos) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** Steps of equal power go in this order: no sense selling what could move. */
const PRIORITY = { move: 0, swap: 1, replace: 2, build: 3, sell: 4 } as const;

/** Power within this fraction of the target counts as reaching it. */
const REACHED = 1e-9;

/** A step the planner could take next, measured. */
interface Choice {
  power: number;
  rank: number;
  /** Cash out, net of what it refunds; 0 without prices. */
  cost: number;
  apply: () => void;
}

interface PendingMove {
  buildingId: string;
  from: Pos;
  to: Pos;
}

interface Diff {
  moves: PendingMove[];
  replaces: { from: string; to: string; x: number; y: number }[];
  builds: BoardBuilding[];
  sells: BoardBuilding[];
  /** Start buildings the target keeps on their own tile. */
  kept: number;
}

/** What separates two boards, paired into moves and replaces. */
function diffBoards(
  start: readonly BoardBuilding[],
  target: readonly BoardBuilding[],
): Diff {
  const startMap = new Map(start.map((b) => [key(b), b.buildingId]));
  const targetMap = new Map(target.map((b) => [key(b), b.buildingId]));
  const leaving = start.filter((b) => targetMap.get(key(b)) !== b.buildingId);
  const arriving = target.filter((b) => startMap.get(key(b)) !== b.buildingId);

  // Each kind's leavers paired with its arrivals, nearest pairs first.
  const moves: PendingMove[] = [];
  const unmovedOut: BoardBuilding[] = [];
  const unmovedIn: BoardBuilding[] = [];
  for (const id of new Set(
    [...leaving, ...arriving].map((b) => b.buildingId),
  )) {
    const from = leaving.filter((b) => b.buildingId === id);
    const to = arriving.filter((b) => b.buildingId === id);
    const pairs: { i: number; j: number; d: number }[] = [];
    for (let i = 0; i < from.length; i++)
      for (let j = 0; j < to.length; j++)
        pairs.push({ i, j, d: dist(from[i], to[j]) });
    pairs.sort((a, b) => a.d - b.d || a.i - b.i || a.j - b.j);
    const usedFrom = new Set<number>();
    const usedTo = new Set<number>();
    for (const { i, j } of pairs) {
      if (usedFrom.has(i) || usedTo.has(j)) continue;
      usedFrom.add(i);
      usedTo.add(j);
      moves.push({
        buildingId: id,
        from: { x: from[i].x, y: from[i].y },
        to: { x: to[j].x, y: to[j].y },
      });
    }
    from.forEach((b, i) => usedFrom.has(i) || unmovedOut.push(b));
    to.forEach((b, j) => usedTo.has(j) || unmovedIn.push(b));
  }

  // A tile that loses one building and gains another is one replace.
  const arrivingAt = new Map(unmovedIn.map((b) => [key(b), b]));
  const replaces: Diff["replaces"] = [];
  const sells: BoardBuilding[] = [];
  for (const out of unmovedOut) {
    const into = arrivingAt.get(key(out));
    if (into) {
      replaces.push({
        from: out.buildingId,
        to: into.buildingId,
        x: out.x,
        y: out.y,
      });
      arrivingAt.delete(key(out));
    } else {
      sells.push(out);
    }
  }
  return {
    moves,
    replaces,
    builds: [...arrivingAt.values()],
    sells,
    kept: start.length - leaving.length,
  };
}

/**
 * Steps a route takes, clears aside: tile by tile, or sell everything — the
 * latter only open when no building survives into the target, so it never
 * costs more cash than the walk.
 */
function routeLengths(
  start: readonly BoardBuilding[],
  target: readonly BoardBuilding[],
  diff: Diff,
) {
  return {
    walk:
      diff.moves.length +
      diff.replaces.length +
      diff.builds.length +
      diff.sells.length,
    restart:
      start.length > 0 && diff.kept === 0 && diff.moves.length === 0
        ? 1 + target.length
        : Infinity,
  };
}

/**
 * How many steps the shorter route between two boards takes — what choosing
 * among a solve's equal layouts the one nearest the island is measured by.
 */
export function stepCount(
  start: readonly BoardBuilding[],
  target: readonly BoardBuilding[],
): number {
  const { walk, restart } = routeLengths(
    start,
    target,
    diffBoards(start, target),
  );
  return Math.min(walk, restart);
}

export class PlanCancelled extends Error {
  constructor() {
    super("The move plan was cancelled.");
  }
}

export async function planMoveSteps(
  start: readonly BoardBuilding[],
  target: readonly BoardBuilding[],
  obstacles: readonly (Pos & { type: TileType })[],
  score: (board: ReadonlyMap<string, string>) => number,
  options: PlanOptions = {},
): Promise<MovePlan> {
  const sliceMs = options.sliceMs ?? 30;
  const diff = diffBoards(start, target);
  const { walk, restart } = routeLengths(start, target, diff);
  const fresh = restart < walk;

  const moves = fresh ? [] : diff.moves;
  const replaces = fresh ? [] : diff.replaces;
  const sells = fresh ? [] : diff.sells;
  const builds = fresh ? target.map((b) => ({ ...b })) : diff.builds;

  const state = new Map(start.map((b) => [key(b), b.buildingId]));
  const steps: MoveStep[] = [];
  const boards: BoardBuilding[][] = [];
  const powers: number[] = [];
  const snapshot = () => {
    boards.push(
      [...state].map(([k, buildingId]) => {
        const [x, y] = k.split(",").map(Number);
        return { buildingId, x, y };
      }),
    );
    powers.push(score(state));
  };
  const goal = options.stopAtPower;
  const reached = () =>
    goal !== undefined && powers[powers.length - 1] >= goal * (1 - REACHED);
  const pending = () =>
    moves.length + replaces.length + builds.length + sells.length;

  // Clears first: they only free ground, so they change no power.
  const targetTiles = new Set(target.map(key));
  snapshot();
  for (const o of obstacles) {
    if (!targetTiles.has(key(o))) continue;
    steps.push({ kind: "clear", x: o.x, y: o.y, obstacle: o.type });
    snapshot();
  }
  /*
   * The cash. Each type's count only rises or only falls — one leaving and
   * one arriving would have been paired into a move — so what the change
   * costs net is the same in any order, and that is the ceiling. It is always
   * reachable: a sale lowers the cash out, and with none left the cheapest
   * build or replace now costs at most its share of what remains, since
   * prices climb with copies and refunds fall with them.
   */
  const ledger = options.cash ? cashLedger(options.cash) : null;
  let spent = 0;
  let ceiling = Infinity;
  if (options.cash) {
    const all = cashLedger(options.cash);
    let net = 0;
    if (fresh) for (const b of start) net -= all.sell(b.buildingId);
    for (const s of sells) net -= all.sell(s.buildingId);
    for (const r of replaces) net += all.buy(r.to) - all.sell(r.from);
    for (const b of builds) net += all.buy(b.buildingId);
    ceiling = Math.max(0, net);
  }
  const fits = (cost: number) =>
    spent + cost <=
    ceiling +
      CASH_TOLERANCE *
        Math.max(Math.abs(ceiling), Math.abs(spent), Math.abs(cost));

  if (fresh) {
    steps.push({
      kind: "sellAll",
      count: state.size,
      tiles: start.map(({ x, y }) => ({ x, y })),
    });
    if (ledger) for (const id of state.values()) spent -= ledger.sell(id);
    state.clear();
    snapshot();
  }

  const total = steps.length + pending();
  let sliceStart = performance.now();
  const breathe = async () => {
    if (performance.now() - sliceStart < sliceMs) return;
    options.onProgress?.(steps.length, total);
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (options.cancelled?.()) throw new PlanCancelled();
    sliceStart = performance.now();
  };

  /** Tries an action on the board, measures it, and puts the board back. */
  const tryOn = (out: Pos | null, into: (Pos & { id: string }) | null) => {
    const outKey = out ? key(out) : null;
    const was = outKey ? state.get(outKey) : undefined;
    const intoKey = into ? key(into) : null;
    const under = intoKey ? state.get(intoKey) : undefined;
    if (outKey) state.delete(outKey);
    if (intoKey) state.set(intoKey, into!.id);
    const power = score(state);
    if (intoKey) {
      if (under !== undefined) state.set(intoKey, under);
      else state.delete(intoKey);
    }
    if (outKey && was !== undefined) state.set(outKey, was);
    return power;
  };

  while (pending() > 0 && !reached()) {
    await breathe();
    let best: Choice | null = null;
    // Should no step fit the cash — only rounding could do that — the
    // cheapest is taken rather than none.
    let cheapest: Choice | null = null;
    const consider = (
      power: number,
      rank: number,
      cost: number,
      apply: () => void,
    ) => {
      const c: Choice = { power, rank, cost, apply };
      if (!cheapest || cost < cheapest.cost) cheapest = c;
      if (!fits(cost)) return;
      if (
        !best ||
        power > best.power ||
        (power === best.power && rank < best.rank)
      )
        best = c;
    };
    const buyCost = (id: string) => (ledger ? ledger.buyPrice(id) : 0);
    const sellBack = (id: string) => (ledger ? ledger.sellPrice(id) : 0);

    moves.forEach((m, i) => {
      if (state.has(key(m.to))) {
        // Taken by a building still to move: swap the two.
        const j = moves.findIndex((o) => key(o.from) === key(m.to));
        if (j < 0) return;
        const other = moves[j];
        const fromKey = key(m.from);
        const toKey = key(m.to);
        state.set(toKey, m.buildingId);
        state.set(fromKey, other.buildingId);
        const power = score(state);
        state.set(toKey, other.buildingId);
        state.set(fromKey, m.buildingId);
        consider(power, PRIORITY.swap, 0, () => {
          state.set(toKey, m.buildingId);
          state.set(fromKey, other.buildingId);
          steps.push({
            kind: "swap",
            a: { buildingId: m.buildingId, ...m.from },
            b: { buildingId: other.buildingId, ...m.to },
          });
          other.from = { ...m.from };
          /*
           * The other may have landed where one of its own kind is still
           * headed. Then it is that one's building already: it stays, and
           * the one headed here takes over its trip instead. Left as two
           * moves, the next would trade two identical buildings' places.
           */
          const twin = moves.find(
            (o, k) =>
              k !== i &&
              k !== j &&
              o.buildingId === other.buildingId &&
              key(o.to) === key(other.from),
          );
          if (twin) {
            twin.to = other.to;
            other.to = { ...other.from };
          }
          // Drop whichever moves are now home, the later index first.
          for (let k = moves.length - 1; k >= 0; k--)
            if (k === i || key(moves[k].from) === key(moves[k].to))
              moves.splice(k, 1);
        });
        return;
      }
      consider(
        tryOn(m.from, { ...m.to, id: m.buildingId }),
        PRIORITY.move,
        0,
        () => {
          moves.splice(i, 1);
          state.delete(key(m.from));
          state.set(key(m.to), m.buildingId);
          steps.push({ kind: "move", ...m });
        },
      );
    });
    replaces.forEach((r, i) => {
      consider(
        tryOn(null, { x: r.x, y: r.y, id: r.to }),
        PRIORITY.replace,
        buyCost(r.to) - sellBack(r.from),
        () => {
          replaces.splice(i, 1);
          state.set(key(r), r.to);
          steps.push({ kind: "replace", ...r });
          if (ledger) {
            const back = ledger.sell(r.from);
            spent += ledger.buy(r.to) - back;
          }
        },
      );
    });
    builds.forEach((b, i) => {
      if (state.has(key(b))) return;
      consider(
        tryOn(null, { ...b, id: b.buildingId }),
        PRIORITY.build,
        buyCost(b.buildingId),
        () => {
          builds.splice(i, 1);
          state.set(key(b), b.buildingId);
          steps.push({ kind: "build", ...b });
          if (ledger) spent += ledger.buy(b.buildingId);
        },
      );
    });
    sells.forEach((s, i) => {
      consider(tryOn(s, null), PRIORITY.sell, -sellBack(s.buildingId), () => {
        sells.splice(i, 1);
        state.delete(key(s));
        steps.push({ kind: "sell", ...s });
        if (ledger) spent -= ledger.sell(s.buildingId);
      });
    });

    // Every pending step is always takeable — a sell or a replace at once, a
    // build onto a tile only a mover can hold, and a blocked move as a swap —
    // so there is always a best, or under prices at least a cheapest.
    const chosen = (best ?? cheapest) as Choice | null;
    if (!chosen) throw new Error("No step can be taken: the plan is stuck.");
    chosen.apply();
    snapshot();
  }

  options.onProgress?.(steps.length, steps.length);
  return { steps, boards, powers, stoppedEarly: pending() > 0 };
}

/** What one step costs and pays back, in cash. Moves and clears are free. */
export interface StepPrice {
  spend: number;
  refund: number;
}

/**
 * Prices a plan's steps in order, as the game would charge them: each build
 * at the next copy's price and each sale refunding a share of the current
 * one, the copies counted across every island and moving with every step —
 * the ledger the planner orders by under `PlanOptions.cash`. `copies`,
 * `build` and `refund` are a `StepPricing`'s.
 */
export function priceSteps(
  plan: MovePlan,
  copies: ReadonlyMap<string, number>,
  build: StepPricing["build"],
  refund: StepPricing["refund"],
): StepPrice[] {
  const ledger = cashLedger({ copies, build, refund });
  return plan.steps.map((step, i) => {
    switch (step.kind) {
      case "build":
        return { spend: ledger.buy(step.buildingId), refund: 0 };
      case "sell":
        return { spend: 0, refund: ledger.sell(step.buildingId) };
      case "replace": {
        const back = ledger.sell(step.from);
        return { spend: ledger.buy(step.to), refund: back };
      }
      case "sellAll":
        return {
          spend: 0,
          refund: plan.boards[i].reduce(
            (sum, b) => sum + ledger.sell(b.buildingId),
            0,
          ),
        };
      default:
        return { spend: 0, refund: 0 };
    }
  });
}
