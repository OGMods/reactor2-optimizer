import { EPS } from "./constants";
import type { EffectiveBuilding } from "./types";

/**
 * Generator conversion and the cooling threshold, in the game's own terms.
 * Port of `solver/physics.py`.
 *
 * The game does not convert heat at a fixed ratio. Each generator tier authors
 * its own `HeatPerTick` / `EnergyPerTick` / `WasteHeatPerTick` in
 * `PowerSourceResearchLevelSO`, and late-game `Energy / Heat` is not exactly
 * 0.75 because the three fields are authored to 3 significant figures
 * independently. `EffectiveBuilding` carries the resolved pair, so what these
 * functions buy is that the conversion and the online test are written once
 * instead of being spelled out at every call site.
 */

/**
 * Match `NumbersTools.SnapToAuthoredPrecision`: double -> 15 s.f. -> double.
 *
 * The game's own `WasteHeatPerTick` is `SnapToAuthoredPrecision(Heat - Energy)`,
 * which is why the catalogue's waste figures are round numbers (4.3e18) rather
 * than what the subtraction actually lands on (4.2999999999999996e18).
 */
export function snapToAuthoredPrecision(value: number): number {
  if (Number.isNaN(value)) return value;
  const absValue = Math.abs(value);
  if (absValue === Infinity || absValue > 7.9e28) return value;
  if (absValue < 1e-28) return 0.0;
  return Number(value.toPrecision(15));
}

/**
 * True when the cooling reaching a producer keeps it online.
 *
 * The game treats net waste <= max(HeatFlowTolerance.Floor, magnitude * 1e-9)
 * as balanced. A fixed absolute epsilon decides nothing at late-game
 * magnitudes -- one ULP at 1e18 is already ~1e2 -- so the relative term is what
 * settles stability up there, and the floor is what settles it down at single
 * digits.
 */
export function wasteIsCovered(waste: number, cooling: number): boolean {
  const aw = Math.abs(waste);
  const ac = Math.abs(cooling);
  const magnitude = aw >= ac ? aw : ac;
  const relative = magnitude * 1e-9;
  const tolerance = EPS >= relative ? EPS : relative;
  return waste - cooling <= tolerance;
}

/**
 * Power and waste from a generator given its settled heat input.
 *
 * Mirrors `GeneratorBuilding.TickGeneratingEnergy`: the generator scales both
 * of its authored figures by how full it is, rather than applying a ratio to
 * the heat it received. Writes into `out` so the hot path allocates nothing.
 */
export function generatorPowerAndWaste(
  building: EffectiveBuilding,
  hIn: number,
  out: { power: number; waste: number },
): void {
  const cap = building.effectiveValue;
  if (cap <= 0.0 || hIn <= 0.0) {
    out.power = 0.0;
    out.waste = 0.0;
    return;
  }
  const h = hIn < cap ? hIn : cap;
  const scale = h / cap;
  out.power = scale * building.energy;
  out.waste = scale * building.waste;
}

/** Power per unit of heat this generator absorbs. */
export function generatorEnergyRatio(building: EffectiveBuilding): number {
  const cap = building.effectiveValue;
  return cap <= 0.0 ? 0.0 : building.energy / cap;
}

/** Waste heat per unit of heat this generator absorbs. */
export function generatorWasteRatio(building: EffectiveBuilding): number {
  const cap = building.effectiveValue;
  return cap <= 0.0 ? 0.0 : building.waste / cap;
}
