import type { AnomalyDefinition, AnomalyId } from "../solver/types";

/**
 * The anomalies a timeline can be run under.
 *
 * Transcribed by hand from the anomaly record the external extractor reads out
 * of the game alongside the roster — each entry there carries the game's
 * `{0}`-templated strings and the `values` that fill them, and both halves land
 * here with the placeholders resolved. Unlike `BUILDING_TABLE` next door,
 * **nothing splices this file**: the extractor writes its record and the icons
 * and stops, so the table is hand-owned and a new anomaly has to be brought
 * across by hand. The ids are the extractor's (`CryoNexusAnomalySO` ->
 * `cryo_nexus`), so they match without translation.
 *
 * `docs/game-logic.md` is the authority on what the rules *mean* — including
 * the two things the description text does not say outright: that "an island"
 * is the whole map, and that a pond is an obstacle rather than water.
 *
 * `"none"` leads the table, is not in the extractor's output, and is a real
 * entry rather than an absence — see `AnomalyId`. Its wording is ours.
 */
export const ANOMALIES: readonly AnomalyDefinition[] = [
  {
    id: "none",
    rule: "baseline",
    name: "No Anomaly",
    benefit: "The ordinary rules",
    drawback: "No bonus either",
    description:
      "The timeline runs under the ordinary rules. Nothing is modified: " +
      "every building is worth exactly what its tier says, and heat and " +
      "cooling reach only the tiles beside them.",
  },
  {
    id: "cryo_nexus",
    rule: "shared_cooling",
    name: "Cryo Nexus",
    benefit: "Cooling is shared per island",
    drawback: "Heat Sink cooling ×0.88",
    description:
      "All Heat Sinks on an island add their Cooling to one shared pool. It " +
      "can cool every Power Source on that island, no matter how far away it " +
      "is. If there is not enough Cooling, every Power Source receives the " +
      "same percentage of what it needs. Each Heat Sink contributes ×0.88 of " +
      "its normal Cooling. Cooling does not carry over to other islands.",
    contribution: 0.88,
  },
  {
    id: "tidal_ascendancy",
    rule: "terrain_affinity",
    name: "Tidal Ascendancy",
    benefit: "Waterside buildings ×1.67",
    drawback: "Inland buildings gain nothing",
    description:
      "Production buildings next to water get a ×1.67 multiplier. Corners " +
      "count too. The bonus affects Energy, Heat, Cooling, and overheat " +
      "capacity. Buildings away from water work normally and get no bonus.",
    // Water only. A pond looks wet and is not: the game files it with the rocks
    // and the trees as an obstacle, and it grants nothing. Between 36% and 44%
    // of the grass on every shipped map is water-adjacent, so this list decides
    // the rating of roughly half the board — it is the cheapest thing here to
    // get wrong.
    terrain: ["water"],
    multiplier: 1.67,
  },
  {
    id: "singularity_isolation",
    rule: "role_isolation",
    name: "Singularity Isolation",
    benefit: "Isolated generators ×2.5",
    drawback: "Adjacent generators ×0.8",
    description:
      "A Generator with no other Generator next to it gets ×2.5 Energy " +
      "output, Heat output, and overheat capacity. If another Generator " +
      "touches it, including at a corner, those values drop to ×0.8. More " +
      "neighbours do not make the penalty worse.",
    role: "generator",
    isolated: 2.5,
    crowded: 0.8,
  },
];

/** The anomaly a timeline runs under until the player picks otherwise. */
export const DEFAULT_ANOMALY_ID: AnomalyId = "none";

/**
 * The definition for an id, falling back to the baseline.
 *
 * Total on purpose: the id crosses `localStorage` and the worker boundary, so
 * it can arrive as something this build has never heard of — a save written by
 * a later version, most likely. Running the base rules is the honest answer to
 * that, and it is the one an unrecognised id would have meant anyway.
 */
export function getAnomaly(id: string | undefined): AnomalyDefinition {
  return (
    ANOMALIES.find((a) => a.id === id) ??
    ANOMALIES.find((a) => a.id === DEFAULT_ANOMALY_ID)!
  );
}
