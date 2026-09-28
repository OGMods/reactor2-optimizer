import { snapToAuthoredPrecision } from "../solver/physics";
import type {
  BuildingDefinition,
  DirectProducerDefinition,
  EffectiveBuilding,
  GeneratorDefinition,
  PrestigeScales,
} from "../solver/types";

/**
 * Collapses building definitions to the single upgrade tier the player has
 * unlocked. Buildings omitted from `unlockedUpgrades` are treated as locked and
 * filtered out.
 *
 * Coolers and reactors neither produce power nor need cooling, so both of their
 * figures are zero. Generators and direct producers carry the game's authored
 * `EnergyPerTick` / `WasteHeatPerTick` for the resolved tier, and only fall back
 * to `heat - energy` for a source that authors no waste at all.
 *
 * `prestige` folds the player's Time Lab research in — see `prestigeScales`.
 * It belongs here rather than anywhere downstream because it is a property of
 * the *roster*, not of a layout or a tile: by the time an `EffectiveBuilding`
 * crosses the worker boundary the research is already in its three numbers, and
 * nothing in the solver has to know the Time Lab exists. Omitted means
 * unresearched.
 */
export function getEffectiveBuildings(
  buildings: readonly BuildingDefinition[],
  unlockedUpgrades: Record<string, number>,
  prestige?: PrestigeScales,
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

    result.push(
      scaleEffectiveBuilding(
        {
          id: building.id,
          type: building.type,
          effectiveValue,
          energy,
          waste,
          baseValue: effectiveValue,
        },
        prestige?.[building.type] ?? 1,
      ),
    );
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
 *
 * `prestige` applies here too, and must: a placement stores the **authored**
 * tier value, which is what identifies the tier and is deliberately not
 * rewritten when research lands. So the research is applied on the way out,
 * every time, and both callers pass the same scales the solver was handed.
 */
export function effectiveAtValue(
  def: BuildingDefinition,
  baseValue: number,
  prestige?: PrestigeScales,
): EffectiveBuilding {
  const factor = prestige?.[def.type] ?? 1;
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
    return scaleEffectiveBuilding(
      {
        id: def.id,
        type: def.type,
        effectiveValue: tier.heat,
        energy: tier.energy,
        waste: tier.waste ?? snapToAuthoredPrecision(tier.heat - tier.energy),
        baseValue: tier.heat,
      },
      factor,
    );
  }
  return scaleEffectiveBuilding(
    {
      id: def.id,
      type: def.type,
      effectiveValue: baseValue,
      energy: 0,
      waste: 0,
      baseValue,
    },
    factor,
  );
}

/**
 * Re-rates a resolved building by a uniform multiplier.
 *
 * Every multiplier that changes a building's numbers — a Time Lab research, a
 * stat anomaly — scales **all of its authored figures by the same factor**. The
 * game lists "Energy, Heat, Cooling, and overheat capacity" separately, but
 * those four names are one field each across the four roles, so a bonus is
 * simply a building whose whole tier is worth more. One function covers every
 * such rule there will be.
 *
 * Which means a multiplier is *not* free power: a scaled producer absorbs more,
 * makes more, and needs proportionally more cooling, so it goes offline exactly
 * as readily as an unscaled one. Only `wasteIsCovered` decides that, and it is
 * relative.
 *
 * **Waste is derived here rather than scaled, and that is the whole point of
 * the function.** The game holds no waste figure of its own at runtime: its
 * getter is `(HeatPerTick - EnergyPerTick).SnapToAuthoredPrecision()` over
 * whatever heat and energy currently are, so waste is re-derived from the
 * scaled pair every time something scales them. Multiplying the incoming waste
 * instead agrees to about fifteen digits and disagrees in the last, because the
 * snap is a decimal rounding of the *scaled* difference rather than something
 * carried along from the table — and the golden fixtures assert exactly.
 *
 * That is also what makes this composable. The game applies research in the SO
 * getter and the anomaly in the runtime getter, one after the other, and
 * `(authored × research) × anomaly` is not bit-identical to
 * `authored × (research × anomaly)`. So the two arrive as two successive calls
 * here, in that order, and each re-derives waste from the pair it produced —
 * which is exactly what the game does.
 *
 * Only the two roles that *have* waste derive one. A cooler and a reactor have
 * no energy figure, so `heat - energy` would silently turn their whole output
 * into waste.
 *
 * Heat, energy and cooling are left unsnapped: the game multiplies those at
 * runtime rather than authoring a table entry, so snapping them would be
 * inventing a rounding it does not do.
 *
 * Returns the building unchanged at a factor of 1, so the common case allocates
 * nothing and the identity holds by reference.
 */
export function scaleEffectiveBuilding(
  building: EffectiveBuilding,
  factor: number,
): EffectiveBuilding {
  if (factor === 1) return building;

  const effectiveValue = building.effectiveValue * factor;
  const energy = building.energy * factor;

  return {
    id: building.id,
    type: building.type,
    effectiveValue,
    energy,
    waste:
      building.type === "generator" || building.type === "direct_producer"
        ? snapToAuthoredPrecision(effectiveValue - energy)
        : building.waste,
    // Carried through untouched, and that is the point of it: it identifies the
    // tier, and a tier does not change because something scaled what it is
    // worth. See `EffectiveBuilding.baseValue`.
    baseValue: building.baseValue,
  };
}
