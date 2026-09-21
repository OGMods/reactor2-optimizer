import type {
  BuildingType,
  PrestigeScales,
  PrestigeUpgrade,
} from "../solver/types";

/**
 * The Time Lab researches that change what a building is worth.
 *
 * Transcribed by hand from the external extractor's Time Lab record, the way
 * `ANOMALIES` is, and like that table nothing splices this one — the extractor
 * writes its record and the icons and stops. Each entry's `bonuses` is that
 * record's own `values` array, its authored `BonusPercentage`; the record also
 * carries a `multiplier` array that is just `1 + values`, and it is not copied,
 * because deriving it is what keeps the two from drifting.
 *
 * **Three of the game's ten are here.** The other seven change the economy
 * around the board rather than anything on it, and the solver cannot feel any
 * of them — they are listed so it is clear they were read and dismissed rather
 * than missed:
 *
 * - `archives_beyond_time` — research point income
 * - `chrono_accelerator` — research time
 * - `chronon_reactor` — chronons earned per timeline
 * - `erased_from_time` / `phase_breaker` — obstacle removal time and cost
 * - `quantum_replicator` — building prices
 * - `zero_time_protocol` — free research speed-up window
 *
 * The solver optimises power on a fixed board from a fixed roster. What a
 * building costs, how long an obstacle takes to clear and how fast research
 * completes are all decisions made *before* it is handed a board, so none of
 * them can change which layout is best. `quantum_replicator` is the one worth
 * a second look — it is the only one that touches buildings at all — but it
 * moves their price, and price is not an input to any figure the solver
 * computes.
 */
export const PRESTIGE_UPGRADES: readonly PrestigeUpgrade[] = [
  {
    id: "absolute_zero",
    name: "Absolute Zero",
    effect: "Cooling Output",
    description: "Boosts the Cooling output of all cooling systems.",
    roles: ["cooler"],
    bonuses: [1.0, 1.5, 2.25, 3.0, 4.0],
  },
  {
    id: "infinite_grid",
    name: "Infinite Grid",
    effect: "Power Source Stats",
    description:
      "Improves all Generators and Wind Turbines, increasing Energy output, " +
      "Heat, and overheat thresholds.",
    // A uniform scale like the stat anomalies: energy and heat are two of
    // `EffectiveBuilding`'s three figures, and the third -- waste -- is derived
    // as `snap(heat - energy)` from the pair after they are scaled, so it grows
    // with them. That is what keeps this from being free power: a generator
    // rated x5 makes x5 the waste and needs x5 the cooling to stay online.
    //
    // The overheat threshold it also names is not modelled and is not the
    // reason. It sizes a power source's waste-heat *store*, not the waste it
    // makes, and a sustainable layout never fills it, so per
    // `docs/game-logic.md` it is never the binding constraint.
    roles: ["generator", "direct_producer"],
    bonuses: [1.0, 1.5, 2.25, 3.0, 4.0],
  },
  {
    id: "stellar_forge",
    name: "Stellar Forge",
    effect: "Heat Output",
    description: "Boosts the Heat output of all Heat Producers.",
    /*
     * Reactors only, and the boundary is the **class of building** rather than
     * the catalogue's grouping.
     *
     * The game's own category `heat_producer` holds reactors *and* direct
     * producers (see `BuildingDefinition`), so "all Heat Producers" read
     * literally would take the wind turbine too. It does not: a turbine's SO
     * inherits `PowerSourceBuildingSO` and reads `infinite_grid`, while this
     * research is read only by `HeatProducerBuildingSO`. That is why
     * `infinite_grid` above goes out of its way to name "Generators and Wind
     * Turbines" -- worth saying precisely because the turbine is not covered
     * here.
     *
     * So the rule is "every heat producer", and a reactor is the only one the
     * shipped roster has; it would cover any other the game added. Modelling it
     * as `["reactor"]` is that rule, not an approximation of it.
     */
    roles: ["reactor"],
    bonuses: [1.0, 1.5, 2.25, 3.0, 4.0],
  },
];

/** The factor a bonus buys. The game authors the bonus; this is the derivation. */
export function prestigeMultiplier(bonus: number): number {
  return 1 + bonus;
}

const UNSCALED: PrestigeScales = {
  cooler: 1,
  reactor: 1,
  generator: 1,
  direct_producer: 1,
};

/**
 * Folds researched levels into one factor per role.
 *
 * `levels` maps an upgrade id to its researched level **index**, and follows
 * `buildingUpgrades` exactly: a key's presence is what "researched" means, and
 * un-researching deletes the key rather than storing a zero. So 0 is the first
 * level, not the absence of one — the same convention, because these are picked
 * with the same control and confusing the two would silently rate a board at the
 * wrong level rather than failing.
 *
 * An index past the table clamps rather than throwing, since this arrives from
 * `localStorage`.
 *
 * Two upgrades touching one role would multiply; none do today, and writing it
 * as a product rather than an assignment is what keeps that true when one does.
 */
export function prestigeScales(
  levels: Record<string, number> | undefined,
): PrestigeScales {
  if (!levels) return UNSCALED;

  const scales: Record<BuildingType, number> = { ...UNSCALED };
  let touched = false;

  for (const upgrade of PRESTIGE_UPGRADES) {
    if (levels[upgrade.id] === undefined) continue;
    const idx = Math.max(
      0,
      Math.min(levels[upgrade.id], upgrade.bonuses.length - 1),
    );
    const factor = prestigeMultiplier(upgrade.bonuses[idx]);
    for (const role of upgrade.roles) scales[role] *= factor;
    touched = true;
  }

  // The identity by reference, so an unresearched roster costs nothing and the
  // common case can be compared cheaply.
  return touched ? scales : UNSCALED;
}
