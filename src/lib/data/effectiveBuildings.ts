import { snapToAuthoredPrecision } from "../solver/physics";
import type {
  BuildingDefinition,
  DirectProducerDefinition,
  EffectiveBuilding,
  GeneratorDefinition,
} from "../solver/types";

/**
 * Collapses building definitions to the single upgrade tier the player has
 * unlocked. Buildings omitted from `unlockedUpgrades` are treated as locked and
 * filtered out. Port of `data/effective_buildings.py`.
 *
 * Coolers and reactors neither produce power nor need cooling, so both of their
 * figures are zero. Generators and direct producers carry the game's authored
 * `EnergyPerTick` / `WasteHeatPerTick` for the resolved tier, and only fall back
 * to `heat - energy` for a source that authors no waste at all.
 */
export function getEffectiveBuildings(
  buildings: readonly BuildingDefinition[],
  unlockedUpgrades: Record<string, number>,
): EffectiveBuilding[] {
  const result: EffectiveBuilding[] = [];

  for (const building of buildings) {
    if (unlockedUpgrades[building.id] === undefined) {
      continue;
    }

    if (!building.levels || building.levels.length === 0) {
      continue;
    }

    const level = unlockedUpgrades[building.id] ?? 0;
    const clamped = Math.max(0, Math.min(level, building.levels.length - 1));

    let effectiveValue: number;
    let energy = 0.0;
    let waste = 0.0;

    if (building.type === "generator" || building.type === "direct_producer") {
      const tier = building.levels[clamped];
      effectiveValue = tier.heat;
      energy = tier.energy;
      waste =
        tier.waste !== undefined
          ? tier.waste
          : snapToAuthoredPrecision(tier.heat - tier.energy);
    } else if (building.type === "reactor") {
      effectiveValue = building.levels[clamped].heat;
    } else {
      effectiveValue = building.levels[clamped].cooling;
    }

    result.push({
      id: building.id,
      type: building.type,
      effectiveValue,
      energy,
      waste,
    });
  }

  return result;
}

/**
 * Whether a resolved roster is capable of producing any power at all.
 *
 * Power comes from exactly two roles, and each has a precondition the roster
 * itself can fail to meet — so "some buildings are unlocked" is not the same
 * question, and a roster of nothing but coolers will happily spend a five
 * minute solve and come back at zero.
 *
 * The rules are `docs/game-logic.md`'s, restated over the resolved roster:
 *
 * - **A direct producer is self-contained.** It never touches the heat side,
 *   runs flat out, and needs only cooling for its waste.
 * - **A generator needs heat, and heat comes only from reactors** — a direct
 *   producer neither sends nor receives any. So a generator pays off only
 *   alongside a reactor.
 * - **Either only counts if it is fully cooled**, so a roster with waste and
 *   no cooler produces nothing whatever else is in it.
 *
 * The waste test is `waste <= 0` rather than `wasteIsCovered`, because this
 * asks whether cooling *exists* at all, not whether a particular layout
 * covers a particular building — that is `simulateIsland`'s job and it needs a
 * board. Every producer in the shipped catalogue authors waste above zero, so
 * in practice this reads "a cooler is required"; the branch is here because
 * the rule is about the roster, not about the roster we happen to ship.
 */
export function rosterCanProducePower(
  roster: readonly EffectiveBuilding[],
): boolean {
  const hasCooling = roster.some(
    (b) => b.type === "cooler" && b.effectiveValue > 0,
  );
  const hasHeat = roster.some(
    (b) => b.type === "reactor" && b.effectiveValue > 0,
  );

  /** Makes power, and has somewhere for its waste to go. */
  const runs = (b: EffectiveBuilding) =>
    b.energy > 0 && (b.waste <= 0 || hasCooling);

  return roster.some((b) => {
    if (b.type === "direct_producer") return runs(b);
    // `effectiveValue` is the generator's heat capacity: one that can absorb
    // nothing converts nothing, whatever its authored energy says.
    if (b.type === "generator")
      return hasHeat && b.effectiveValue > 0 && runs(b);
    return false;
  });
}

/**
 * Resolves a *placed* building's tier from the value it was placed at.
 *
 * `getEffectiveBuildings` above answers "what may the solver build?" and reads
 * the player's current unlock level. This answers a different question — "what
 * is this building on the board rated for?" — and a placement records the value
 * it was placed at rather than a level index, so the value identifies the tier.
 * The two disagree the moment an upgrade is bought after a building is down,
 * and the board's own figures are the ones that must win.
 *
 * A building's tier values strictly increase, so the match is exact for
 * anything the app produces. A value the catalogue does not author (a
 * hand-edited save) falls back to the top tier.
 *
 * Both `simulatePlacedBuildings` and the board readout go through here, so the
 * panel cannot rate a building differently from the scorer that ran it.
 */
export function effectiveAtValue(
  def: BuildingDefinition,
  baseValue: number,
): EffectiveBuilding {
  if (def.type === "generator" || def.type === "direct_producer") {
    const levels = (def as GeneratorDefinition | DirectProducerDefinition)
      .levels;
    let tier = levels[levels.length - 1];
    for (const level of levels) {
      if (level.heat === baseValue) {
        tier = level;
        break;
      }
    }
    return {
      id: def.id,
      type: def.type,
      effectiveValue: tier.heat,
      energy: tier.energy,
      waste: tier.waste ?? snapToAuthoredPrecision(tier.heat - tier.energy),
    };
  }
  return {
    id: def.id,
    type: def.type,
    effectiveValue: baseValue,
    energy: 0,
    waste: 0,
  };
}
