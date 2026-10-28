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
 * When the island changes almost entirely — a new roster swaps most of its
 * buildings — walking it tile by tile is longer than starting again, so the
 * plan opens with one **sell everything** and builds from there. Whichever of
 * the two routes takes fewer steps is the one planned.
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
 * Moves can block each other in a ring — A wants B's tile while B wants A's.
 * The ring is broken by parking one building on a free tile and moving it on
 * once its destination opens; with no free tile at all, by selling it and
 * building it again.
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
}

const key = (p: Pos) => `${p.x},${p.y}`;
const dist = (a: Pos, b: Pos) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** Steps of equal power go in this order: no sense selling what could move. */
const PRIORITY = { move: 0, replace: 1, build: 2, sell: 3 } as const;

/** Power within this fraction of the target counts as reaching it. */
const REACHED = 1e-9;

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
  return { moves, replaces, builds: [...arrivingAt.values()], sells };
}

/** Steps a route takes, clears aside: tile by tile, or sell everything. */
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
    restart: start.length > 0 ? 1 + target.length : Infinity,
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
  freeTiles: readonly Pos[],
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
  if (fresh) {
    steps.push({
      kind: "sellAll",
      count: state.size,
      tiles: start.map(({ x, y }) => ({ x, y })),
    });
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
    let best: { power: number; rank: number; apply: () => void } | null = null;
    const consider = (power: number, rank: number, apply: () => void) => {
      if (
        !best ||
        power > best.power ||
        (power === best.power && rank < best.rank)
      )
        best = { power, rank, apply };
    };

    moves.forEach((m, i) => {
      if (state.has(key(m.to))) return;
      consider(
        tryOn(m.from, { ...m.to, id: m.buildingId }),
        PRIORITY.move,
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
        () => {
          replaces.splice(i, 1);
          state.set(key(r), r.to);
          steps.push({ kind: "replace", ...r });
        },
      );
    });
    builds.forEach((b, i) => {
      if (state.has(key(b))) return;
      consider(tryOn(null, { ...b, id: b.buildingId }), PRIORITY.build, () => {
        builds.splice(i, 1);
        state.set(key(b), b.buildingId);
        steps.push({ kind: "build", ...b });
      });
    });
    sells.forEach((s, i) => {
      consider(tryOn(s, null), PRIORITY.sell, () => {
        sells.splice(i, 1);
        state.delete(key(s));
        steps.push({ kind: "sell", ...s });
      });
    });

    if (best) {
      (best as { apply: () => void }).apply();
      snapshot();
      continue;
    }

    // Only moves are left and every one is blocked: a ring. Park the first
    // on a free tile no pending step wants, or sell and rebuild it.
    const m = moves[0];
    const wanted = new Set([
      ...moves.map((p) => key(p.to)),
      ...builds.map(key),
    ]);
    const park = freeTiles.find(
      (t) => !state.has(key(t)) && !wanted.has(key(t)),
    );
    if (park) {
      state.delete(key(m.from));
      state.set(key(park), m.buildingId);
      steps.push({
        kind: "move",
        buildingId: m.buildingId,
        from: m.from,
        to: park,
      });
      m.from = park;
    } else {
      moves.shift();
      state.delete(key(m.from));
      steps.push({ kind: "sell", buildingId: m.buildingId, ...m.from });
      builds.push({ buildingId: m.buildingId, ...m.to });
    }
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
 * one, the copies counted across every island and moving with every step.
 *
 * `copies` is each building's count across all the player's islands before
 * the first step; `baseOf` its base price. Prices come from `buildPrice` and
 * `sellRefund` in the solver package, passed in so this module stays free of
 * the rules' tables.
 */
export function priceSteps(
  plan: MovePlan,
  copies: ReadonlyMap<string, number>,
  build: (buildingId: string, copies: number) => number,
  refund: (buildingId: string, copies: number) => number,
): StepPrice[] {
  const count = new Map(copies);
  const n = (id: string) => count.get(id) ?? 0;
  const sell = (id: string) => {
    const r = refund(id, n(id));
    count.set(id, Math.max(0, n(id) - 1));
    return r;
  };
  const buy = (id: string) => {
    const p = build(id, n(id));
    count.set(id, n(id) + 1);
    return p;
  };
  return plan.steps.map((step, i) => {
    switch (step.kind) {
      case "build":
        return { spend: buy(step.buildingId), refund: 0 };
      case "sell":
        return { spend: 0, refund: sell(step.buildingId) };
      case "replace": {
        const back = sell(step.from);
        return { spend: buy(step.to), refund: back };
      }
      case "sellAll":
        return {
          spend: 0,
          refund: plan.boards[i].reduce(
            (sum, b) => sum + sell(b.buildingId),
            0,
          ),
        };
      default:
        return { spend: 0, refund: 0 };
    }
  });
}
