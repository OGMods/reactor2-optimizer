import { findBuilding } from "./buildings";
import { TIME_LAB } from "./timeLab";

/**
 * What a building costs to put down and pays back to take up, in the game.
 *
 * Every copy of a building costs more than the last: `base × scaler^copies`,
 * the copies counted across all the player's islands, and the scaler 1.14
 * until Standardized Builds lowers it. Two researches then take a share off —
 * Construction Permits (city research) and Quantum Replicator (Time Lab) —
 * and they multiply. Selling refunds a share of the **current** price, what the
 * next copy would cost, by Salvage Protocols, and drops the count by one.
 * Moving a building is free.
 *
 * Transcribed by hand from the extractor's progression record
 * (`tools/data/progression.json`), the way `TIME_LAB` is; the base prices are
 * the catalogue's own `price`. The rules are the game developer's, confirmed by
 * the player: copies global, refund of the current price, moves free.
 */

/** Standardized Builds: the per-copy scaler at each level, 0 the default. */
const COST_SCALER = [
  1.14, 1.13, 1.12, 1.11, 1.09, 1.07, 1.05, 1.03, 1.025, 1.02,
];

/** Construction Permits: the share taken off, by level. */
const PERMITS = [0, 0.1, 0.19, 0.27, 0.34, 0.4, 0.45, 0.49, 0.52, 0.54, 0.55];

/**
 * Salvage Protocols: the share of the current price a sale refunds, by level.
 * Level 0 is **assumed**: the record starts at level 1's 55% and climbs by
 * five points, so a player who has bought none is taken to get 50%.
 */
const REFUND = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.94, 0.98];

/** The game's research ids, as a game export's research section spells them. */
const RESEARCH = {
  scaler: "BuildingsCostMultiplierResearchSO",
  permits: "BuildingPriceReductionResearchSO",
  refund: "BuildingSellRefundResearchSO",
  replicator: "quantum_replicator",
} as const;

export interface PriceRules {
  /** What each copy multiplies the price by. */
  scaler: number;
  /** What is left of a price after both reductions: 1 with neither. */
  discount: number;
  /** The share of the current price a sale refunds. */
  refund: number;
}

const at = (table: readonly number[], level: number) =>
  table[Math.max(0, Math.min(level, table.length - 1))];

/** The price rules a player's research gives, from a game export's levels. */
export function priceRules(
  research: Readonly<Record<string, number>>,
): PriceRules {
  const replicator = TIME_LAB.find((r) => r.id === RESEARCH.replicator)!;
  const replicatorLevel = research[RESEARCH.replicator] ?? 0;
  const replicatorCut =
    replicatorLevel > 0 ? at(replicator.values!, replicatorLevel - 1) : 0;
  return {
    scaler: at(COST_SCALER, research[RESEARCH.scaler] ?? 0),
    discount:
      (1 - at(PERMITS, research[RESEARCH.permits] ?? 0)) * (1 - replicatorCut),
    refund: at(REFUND, research[RESEARCH.refund] ?? 0),
  };
}

/** What the next copy costs with `copies` already standing. */
export function buildPrice(
  base: number,
  copies: number,
  rules: PriceRules,
): number {
  return base * rules.scaler ** Math.max(0, copies) * rules.discount;
}

/** What selling one pays back with `copies` standing, the one sold included. */
export function sellRefund(
  base: number,
  copies: number,
  rules: PriceRules,
): number {
  return copies > 0 ? buildPrice(base, copies, rules) * rules.refund : 0;
}

/** The price rules of a player with none of the price research. */
const BASE_RULES: PriceRules = {
  scaler: COST_SCALER[0],
  discount: 1,
  refund: REFUND[0],
};

/**
 * What building `layout` from an empty board costs, every copy at the price
 * the next one would be.
 *
 * This is what ranks layouts that tie on power, so it only has to order them
 * right, and the research that lowers prices mostly cannot change the order:
 * both reductions scale every price alike. The scaler can, a little, and the
 * copies standing on other islands too, so this is the board's own cost under
 * the base scaler — a ranking, not a quote.
 */
export function layoutCost(
  layout: readonly { buildingId: string }[],
  rules: PriceRules = BASE_RULES,
): number {
  const copies = new Map<string, number>();
  for (const p of layout)
    copies.set(p.buildingId, (copies.get(p.buildingId) ?? 0) + 1);
  let cost = 0;
  for (const [id, n] of copies) {
    const base = findBuilding(id)?.price ?? 0;
    for (let k = 0; k < n; k++) cost += buildPrice(base, k, rules);
  }
  return cost;
}

/**
 * Relative slack for "the same cost": two layouts holding the same buildings
 * sum them in a different order and can disagree in the last bits.
 */
const COST_TIE_RELATIVE_TOLERANCE = 1e-9;

/**
 * Orders layouts that tie on power cheapest first: by `layoutCost`, then — the
 * prices span thirty orders of magnitude, so a cooler more or less is lost in
 * the cost of a reactor — by how many buildings stand, fewest first, so the
 * layout leaving more of the land empty wins. Stable, so layouts neither
 * figure separates keep the order they came in.
 *
 * Each layout is costed once, not once per comparison.
 */
export function cheapestFirst<T>(
  items: readonly T[],
  placementsOf: (item: T) => readonly { buildingId: string }[],
): T[] {
  return items
    .map((item) => {
      const placements = placementsOf(item);
      return { item, cost: layoutCost(placements), count: placements.length };
    })
    .sort((a, b) =>
      Math.abs(a.cost - b.cost) >
      COST_TIE_RELATIVE_TOLERANCE * Math.max(a.cost, b.cost)
        ? a.cost - b.cost
        : a.count - b.count,
    )
    .map(({ item }) => item);
}
