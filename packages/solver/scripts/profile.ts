/**
 * Measures the search's hot path on the largest shipped island, stage by
 * stage.
 *
 *     npm run profile                       (from the repo root)
 *     npm run profile -- --anomaly cryo_nexus --anomaly none
 *     npm run profile -- --map 3
 *
 * `npm run survey` says what a real run finds; this says what it costs. One
 * figure per stage — the bound, the composition targets, seed construction,
 * one simulation, the collector's tie check, one full repair, and how many
 * annealing steps a second buys — so a change to any of them can be judged
 * against the figure it started from rather than against a feeling.
 *
 * Every figure is wall-clock on this machine under this load, so compare two
 * runs taken back to back with nothing else running, never two taken on
 * different days. The stages are taken in solve order on the same seed layout,
 * and the seed is deterministic (`constructMultiStartSeed` draws no fresh
 * randomness), so two runs of the same code measure the same work.
 *
 * It runs under `tsx` with esbuild's `keepNames` wrapper on every function,
 * which the Vite bundle the app ships does not carry; the absolute figures are
 * therefore a little pessimistic for the browser, and the ratios between
 * stages are what to read.
 */

import { ANOMALIES, getAnomaly } from "../src/data/anomalies";
import { BUILDINGS, allUpgradesUnlocked } from "../src/data/buildings";
import { getEffectiveBuildings } from "../src/data/effectiveBuildings";
import { decodeBlueprint } from "../src/encoding/blueprint";
import { MAPS, MAPS_BY_NUM, type CliMap } from "../bin/maps";
import { AlternateCollector } from "../src/solver/alternates";
import { buildIslandContext } from "../src/solver/context";
import {
  canCoolDirectProducer,
  estimateTotalMaxPower,
  splitGridIntoIslands,
} from "../src/solver/island";
import { Pacer } from "../src/solver/pacer";
import { internals } from "../src/solver/placementSearch";
import { Rng } from "../src/solver/rng";
import { simulateIsland } from "../src/solver/simulate";
import type {
  AnomalyId,
  EffectiveBuilding,
  IslandSubGrid,
  Placement,
} from "../src/solver/types";
import { formatNumber } from "../src/utils/formatters";

const DEFAULT_ANOMALIES: AnomalyId[] = [
  "none",
  "cryo_nexus",
  "tidal_ascendancy",
  "singularity_isolation",
];
/** How long the annealing walk is run to read its step rate. */
const WALK_MS = 2000;

const USAGE = `usage: profile [--map NUM]... [--anomaly ID]...

  --map NUM      map to profile (repeatable; default: the largest island of
                 every map, which is one island per anomaly)
  --anomaly ID   anomaly to profile (repeatable; default: ${DEFAULT_ANOMALIES.join(", ")})
`;

interface Args {
  maps: CliMap[];
  anomalies: AnomalyId[];
}

function parseArgs(argv: string[]): Args | null {
  const maps: CliMap[] = [];
  const anomalies: AnomalyId[] = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") return null;
    const raw = argv[++i];
    if (raw === undefined) return null;
    if (flag === "--map") {
      const map = MAPS_BY_NUM.get(Number(raw));
      if (map === undefined) {
        console.error(`unknown map ${raw}`);
        return null;
      }
      maps.push(map);
    } else if (flag === "--anomaly") {
      if (!ANOMALIES.some((a) => a.id === raw)) {
        console.error(`unknown anomaly ${raw}`);
        return null;
      }
      anomalies.push(raw as AnomalyId);
    } else {
      return null;
    }
  }
  return {
    maps: maps.length > 0 ? maps : MAPS.filter((m) => m.num !== 0),
    anomalies: anomalies.length > 0 ? anomalies : DEFAULT_ANOMALIES,
  };
}

const roster = getEffectiveBuildings(BUILDINGS, allUpgradesUnlocked());
const byRole = (
  type: EffectiveBuilding["type"],
  key: "effectiveValue" | "energy",
): EffectiveBuilding[] =>
  roster.filter((b) => b.type === type).sort((a, b) => b[key] - a[key]);
const reactors = byRole("reactor", "effectiveValue");
const generators = byRole("generator", "effectiveValue");
const coolers = byRole("cooler", "effectiveValue");
const directProducers = byRole("direct_producer", "energy");

const ms = (from: number): string =>
  `${(performance.now() - from).toFixed(1)} ms`;

/** A shortlist of ten layouts, each a few tiles from `seed`, to tie against. */
function filledCollector(seed: Placement, n: number): AlternateCollector {
  const collector = new AlternateCollector();
  const rng = new Rng(1);
  for (let i = 0; i < 10; i++) {
    const copy = seed.slice();
    let cleared = 0;
    while (cleared < 6) {
      const t = rng.int(n);
      if (copy[t] !== null) {
        copy[t] = null;
        cleared++;
      }
    }
    collector.offer(1, copy);
  }
  return collector;
}

async function largestIsland(
  maps: CliMap[],
  anomalyId: AnomalyId,
): Promise<{ map: CliMap; island: IslandSubGrid } | null> {
  const anomaly = getAnomaly(anomalyId);
  let best: { map: CliMap; island: IslandSubGrid } | null = null;
  for (const map of maps) {
    const { grid } = await decodeBlueprint(map.code);
    for (const island of splitGridIntoIslands(
      grid,
      canCoolDirectProducer(roster),
      anomaly,
    )) {
      if (best === null || island.tileCount > best.island.tileCount)
        best = { map, island };
    }
  }
  return best;
}

async function profile(
  map: CliMap,
  island: IslandSubGrid,
  anomalyId: AnomalyId,
) {
  const anomaly = getAnomaly(anomalyId);
  const ctx = buildIslandContext(
    island.grid,
    island.buildable,
    anomaly,
    island.waterAdjacent,
  );
  console.log(`\n== ${anomaly.name}: ${map.name}, ${ctx.n} tiles ==`);

  let t0 = performance.now();
  const bound = estimateTotalMaxPower([island], roster, anomaly);
  console.log(
    `bound                 ${ms(t0).padStart(10)}   (${formatNumber(bound)})`,
  );

  t0 = performance.now();
  const targets = internals.targetCompositions(
    ctx.n,
    reactors,
    generators,
    coolers,
    internals.generatorCapacityTable(island, ctx, generators[0]),
  );
  console.log(
    `targetCompositions    ${ms(t0).padStart(10)}   (${targets.length} kept)`,
  );

  t0 = performance.now();
  const seed = internals.constructMultiStartSeed(
    ctx,
    reactors,
    generators,
    coolers,
    directProducers,
    performance.now() + 1e9,
  );
  console.log(`seed                  ${ms(t0).padStart(10)}`);

  const sims = 20000;
  t0 = performance.now();
  for (let i = 0; i < sims; i++) simulateIsland(seed, ctx);
  const simUs = ((performance.now() - t0) * 1000) / sims;
  console.log(
    `simulateIsland        ${`${simUs.toFixed(1)} us`.padStart(10)}   (${Math.round(1e6 / simUs / 1000)}k/s)`,
  );

  const collector = filledCollector(seed, ctx.n);
  const ties = 20000;
  t0 = performance.now();
  for (let i = 0; i < ties; i++) collector.accepts(seed);
  const tieUs = ((performance.now() - t0) * 1000) / ties;
  console.log(
    `collector.accepts     ${`${tieUs.toFixed(1)} us`.padStart(10)}   (${Math.round((tieUs / simUs) * 100)}% of a simulation, on a tie)`,
  );

  const candidates: (EffectiveBuilding | null)[] = [
    ...reactors.slice(0, 3),
    generators[0],
    coolers[0],
    ...directProducers.slice(0, 1),
    null,
  ];
  t0 = performance.now();
  const polished = await internals.greedyPolish(
    seed,
    ctx,
    candidates,
    performance.now() + 1e9,
    new Pacer(),
  );
  console.log(
    `greedyPolish on seed  ${ms(t0).padStart(10)}   (${formatNumber(simulateIsland(seed, ctx).totalPower)} -> ${formatNumber(polished.power)})`,
  );

  let steps = 0;
  const pacer = new Pacer({ shouldStop: () => (steps++, false) });
  t0 = performance.now();
  await internals.hillClimb(
    polished.placement,
    ctx,
    reactors,
    generators,
    coolers,
    directProducers,
    WALK_MS,
    new Rng(7),
    pacer,
    undefined,
    new AlternateCollector(),
  );
  // The walk yields every 50ms and asks `shouldStop` each time, so this is
  // its yield count; the step rate is read off the simulation cost instead,
  // since every step is one simulation plus the tie check.
  console.log(
    `hillClimb             ${ms(t0).padStart(10)}   (${steps} yields; about ${Math.round(1e6 / (simUs + tieUs) / 1000)}k steps/s at most)`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }
  for (const anomalyId of args.anomalies) {
    const found = await largestIsland(args.maps, anomalyId);
    if (found === null) continue;
    await profile(found.map, found.island, anomalyId);
  }
}

await main();
