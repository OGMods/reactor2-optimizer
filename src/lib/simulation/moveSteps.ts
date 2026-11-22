import type { TileType } from "../types";

/**
 * The steps that turn one board into another — the player's island as the
 * game has it into the solve on screen — in an order easy to follow, and no
 * more of them than it takes.
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
 * The order is by area. At every step each action that can be taken now — a
 * sell or a replace always can; a move or a build once its tile is free — is
 * a candidate, and the one nearest the tiles the last step touched is taken,
 * ties in reading order. Power plays no part: the island is built out whole
 * either way, and a hand that works through one area is easier to follow
 * than one chasing the next-best gain from one end of the island to the
 * other. Measured on 35 real islands against their solves, it puts the next
 * step a tile from the last on average, where power order put it 3.3 away,
 * and takes fewer steps. Only a swap that sends both buildings home goes
 * ahead of distance, since it is two moves in one. The plan still ends once
 * the island makes the solve's power (`stopAtPower`), since the rest would
 * only rearrange it.
 *
 * Or the player may ask for one kind at a time (`PlanOptions.group`): every
 * generator, then every cooler, then every reactor, each kind swept in
 * reading order, the most power first among a kind's. A plan a player can
 * carry out with one building in hand and their eye moving row by row. The
 * cash rule below still comes first.
 *
 * Power is not the only thing a step can run short of: a build put ahead of
 * the sale that pays for it needs cash the finished change does not. Given
 * the prices (`PlanOptions.cash`), no step is taken that would leave more
 * spent, net of refunds so far, than the whole change costs — or than
 * nothing, for a change that pays out. So the most a player must hold at once
 * is never more than the layout's own net spend, the figure a cash limit
 * holds it to. Among the steps that fit, the order decides.
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
  /**
   * Build one kind at a time: each building's group, lower first. Among the
   * steps that fit the cash, the lowest group goes first, then the most
   * power, then the tile first in reading order — so a player puts down every
   * generator, then every cooler, sweeping the island row by row rather than
   * hopping across it. A sale goes ahead of every group: it clears ground the
   * groups build on and pays for them. A swap goes with the building that
   * set out, so the one it trades with may move a kind early — the price of
   * never selling a building only to buy it back. Without it, they go by
   * area.
   */
  group?: (buildingId: string) => number;
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

/** Steps on one tile go in this order: no sense selling what could move. */
const PRIORITY = { move: 0, swap: 1, replace: 2, build: 3, sell: 4 } as const;

/** Power within this fraction of the target counts as reaching it. */
const REACHED = 1e-9;

/** A step the planner could take next, measured. */
interface Choice {
  /** What the board would make after it; measured only when asked. */
  measure: () => number;
  power?: number;
  rank: number;
  /** See `PlanOptions.group`; 0 without it. */
  group: number;
  /** The tile it lands on (or leaves), for reading order within a group. */
  at: Pos;
  /** Cash out, net of what it refunds; 0 without prices. */
  cost: number;
  /** True for a swap that leaves both buildings home: two moves in one. */
  settles: boolean;
  /** Every tile it touches, for keeping the next step near this one. */
  near: Pos[];
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

  /*
   * Each kind's leavers paired with its arrivals, nearest pairs first. When a
   * kind has more of one than the other, some are left over, and which matters:
   * a leftover leaver on a tile something else arrives at, or a leftover
   * arrival on a tile something else leaves, is one replace rather than a sale
   * and a build. So those are paired last, and left over when any are.
   */
  const moves: PendingMove[] = [];
  const unmovedOut: BoardBuilding[] = [];
  const unmovedIn: BoardBuilding[] = [];
  for (const id of new Set(
    [...leaving, ...arriving].map((b) => b.buildingId),
  )) {
    const from = leaving.filter((b) => b.buildingId === id);
    const to = arriving.filter((b) => b.buildingId === id);
    const spareOut = (b: Pos) =>
      from.length > to.length && targetMap.has(key(b));
    const spareIn = (b: Pos) => to.length > from.length && startMap.has(key(b));
    const pairs: { i: number; j: number; d: number; spare: boolean }[] = [];
    for (let i = 0; i < from.length; i++)
      for (let j = 0; j < to.length; j++)
        pairs.push({
          i,
          j,
          d: dist(from[i], to[j]),
          spare: spareOut(from[i]) || spareIn(to[j]),
        });
    pairs.sort(
      (a, b) =>
        Number(a.spare) - Number(b.spare) ||
        a.d - b.d ||
        a.i - b.i ||
        a.j - b.j,
    );
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
  // Copies: a swap may send a build elsewhere, and the target is the caller's.
  const builds = (fresh ? target : diff.builds).map((b) => ({ ...b }));

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
  const tryOn =
    (out: Pos | null, into: (Pos & { id: string }) | null) => () => {
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
  const powerOf = (c: Choice) => (c.power ??= c.measure());

  /** First in reading order: by row, then column, then kind of step. */
  const readsBefore = (c: Choice, than: Choice) =>
    c.at.y !== than.at.y
      ? c.at.y < than.at.y
      : c.at.x !== than.at.x
        ? c.at.x < than.at.x
        : c.rank < than.rank;

  /*
   * Grouped: the lowest group, then the most power, then reading order. A
   * kind is one sweep across the island, its moves and builds in one reading
   * order, not a sweep of moves and then another of builds. A sale is grouped
   * ahead of every kind (`id` null).
   */
  const groupOf = (id: string | null) =>
    options.group ? (id === null ? -Infinity : options.group(id)) : 0;
  const byKind = (fitting: Choice[]) => {
    let best: Choice | null = null;
    for (const c of fitting) {
      if (!best) best = c;
      else if (c.group !== best.group) {
        if (c.group < best.group) best = c;
      } else if (powerOf(c) !== powerOf(best)) {
        if (powerOf(c) > powerOf(best)) best = c;
      } else if (readsBefore(c, best)) best = c;
    }
    return best;
  };

  /*
   * Otherwise by area: a swap that sends both buildings home first, then the
   * step nearest the tiles the last one touched, ties in reading order — the
   * first step the first in reading order. Power plays
   * no part — the island is built out whole either way, and a hand that stays
   * put is easier to follow than one chasing the next-best gain across the
   * island.
   */
  let last: Pos[] = [];
  const byArea = (fitting: Choice[]) => {
    let pick: Choice | null = null;
    let pickD = Infinity;
    for (const c of fitting) {
      let d = 0;
      if (last.length) {
        d = Infinity;
        for (const a of last)
          for (const b of c.near) d = Math.min(d, dist(a, b));
      }
      if (
        !pick ||
        (c.settles !== pick.settles
          ? c.settles
          : d < pickD || (d === pickD && readsBefore(c, pick)))
      ) {
        pick = c;
        pickD = d;
      }
    }
    return pick;
  };

  while (pending() > 0 && !reached()) {
    await breathe();
    const fitting: Choice[] = [];
    // Should no step fit the cash — only rounding could do that — the
    // cheapest is taken rather than none.
    let cheapest: Choice | null = null;
    const consider = (
      measure: () => number,
      rank: number,
      cost: number,
      apply: () => void,
      id: string | null,
      at: Pos,
      near: Pos[] = [at],
      settles = false,
    ) => {
      const g = groupOf(id);
      const c: Choice = {
        measure,
        rank,
        cost,
        apply,
        group: g,
        at,
        near,
        settles,
      };
      if (!cheapest || cost < cheapest.cost) cheapest = c;
      if (fits(cost)) fitting.push(c);
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
        consider(
          () => {
            state.set(toKey, m.buildingId);
            state.set(fromKey, other.buildingId);
            const power = score(state);
            state.set(toKey, other.buildingId);
            state.set(fromKey, m.buildingId);
            return power;
          },
          PRIORITY.swap,
          0,
          () => {
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
            } else {
              /*
               * Or where one of its kind is still to be built. It is that
               * building already, so it stays, and the build goes where it
               * was headed — else it would move on and another be bought
               * for the tile it left.
               */
              const build = builds.find(
                (o) =>
                  o.buildingId === other.buildingId &&
                  key(o) === key(other.from),
              );
              if (build) {
                build.x = other.to.x;
                build.y = other.to.y;
                other.to = { ...other.from };
              }
            }
            // Drop whichever moves are now home, the later index first.
            for (let k = moves.length - 1; k >= 0; k--)
              if (k === i || key(moves[k].from) === key(moves[k].to))
                moves.splice(k, 1);
          },
          m.buildingId,
          m.to,
          [m.from, m.to],
          // Home when it lands where it was headed, or where one of its kind
          // is still headed or to be built (see above).
          key(other.to) === fromKey ||
            moves.some(
              (o, k) =>
                k !== i &&
                k !== j &&
                o.buildingId === other.buildingId &&
                key(o.to) === fromKey,
            ) ||
            builds.some(
              (o) => o.buildingId === other.buildingId && key(o) === fromKey,
            ),
        );
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
        m.buildingId,
        m.to,
        [m.from, m.to],
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
        r.to,
        r,
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
        b.buildingId,
        b,
      );
    });
    sells.forEach((s, i) => {
      consider(
        tryOn(s, null),
        PRIORITY.sell,
        -sellBack(s.buildingId),
        () => {
          sells.splice(i, 1);
          state.delete(key(s));
          steps.push({ kind: "sell", ...s });
          if (ledger) spent -= ledger.sell(s.buildingId);
        },
        null,
        s,
      );
    });

    // Every pending step is always takeable — a sell or a replace at once, a
    // build onto a tile only a mover can hold, and a blocked move as a swap —
    // so there is always a best, or under prices at least a cheapest.
    const chosen = ((options.group ? byKind : byArea)(fitting) ??
      cheapest) as Choice | null;
    if (!chosen) throw new Error("No step can be taken: the plan is stuck.");
    chosen.apply();
    last = chosen.near;
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
