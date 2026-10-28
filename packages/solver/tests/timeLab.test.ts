/**
 * The Time Lab table the planner prices a jump with. Hand-transcribed, so the
 * tests are mostly that it agrees with itself, with the two other tables that
 * carry part of it, and with what the game's own exports say a player owns.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { chrononAward, chrononMultiplier } from "../src/data/chronons";
import { PRESTIGE_UPGRADES } from "../src/data/prestige";
import {
  chrononReactorGain,
  TIME_LAB,
  timeLabCost,
  timeLabLevels,
  timeLabResearch,
} from "../src/data/timeLab";
import { decodeGameExport } from "../src/encoding/gameExport";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "gameExports");

describe("TIME_LAB", () => {
  it("has twelve researches, each priced level by level", () => {
    expect(TIME_LAB).toHaveLength(12);
    expect(new Set(TIME_LAB.map((r) => r.id)).size).toBe(12);
    for (const r of TIME_LAB) {
      expect(r.costs.length, r.id).toBeGreaterThan(0);
      // Each level costs more than the one before it.
      for (let i = 1; i < r.costs.length; i++)
        expect(r.costs[i], `${r.id} ${i}`).toBeGreaterThan(r.costs[i - 1]);
      if (r.kind === "level") expect(r.values).toBeNull();
      else expect(r.values!.length, r.id).toBe(r.costs.length);
    }
  });

  it("agrees with the stat researches the solver rates buildings by", () => {
    for (const upgrade of PRESTIGE_UPGRADES) {
      expect(timeLabResearch(upgrade.id).values).toEqual(upgrade.bonuses);
    }
  });

  it("agrees with the Chronon Reactor multiplier the award uses", () => {
    const { values } = timeLabResearch("chronon_reactor");
    values!.forEach((bonus, i) =>
      expect(chrononMultiplier(i + 1)).toBeCloseTo(1 + bonus, 12),
    );
  });
});

describe("timeLabLevels", () => {
  it("reads a player's levels off a game export, Chrono Seed included", async () => {
    const exp = await decodeGameExport(
      readFileSync(join(DIR, "gen2_city52_9c43e4b7_server.txt"), "utf8"),
    );
    expect(timeLabLevels(exp.research)).toEqual({
      absolute_zero: 5,
      archives_beyond_time: 8,
      chrono_accelerator: 8,
      chronon_reactor: 3,
      erased_from_time: 5,
      infinite_grid: 5,
      phase_breaker: 6,
      quantum_exchange: 5,
      quantum_replicator: 6,
      skip_city: 0,
      stellar_forge: 10,
      zero_time_protocol: 10,
    });
  });

  it("reads a research it is not told about as unbought, and clamps past the cap", () => {
    const levels = timeLabLevels({ chronon_reactor: 99 });
    expect(levels.chronon_reactor).toBe(5);
    expect(levels.stellar_forge).toBe(0);
  });
});

describe("timeLabCost", () => {
  const reactor = timeLabResearch("chronon_reactor");

  it("adds up the levels between", () => {
    expect(timeLabCost(reactor, 0, 1)).toBe(150);
    expect(timeLabCost(reactor, 3, 5)).toBe(1800 + 4000);
  });

  it("costs nothing going nowhere, and stops at the cap", () => {
    expect(timeLabCost(reactor, 3, 3)).toBe(0);
    expect(timeLabCost(reactor, 4, 2)).toBe(0);
    expect(timeLabCost(reactor, 4, 9)).toBe(4000);
  });
});

describe("chrononReactorGain", () => {
  it("is the extra award the higher multiplier pays at the same energy", () => {
    const energy = 1.77717e31;
    expect(chrononReactorGain(energy, 3, 4)).toBe(
      chrononAward(energy, 1.2) - chrononAward(energy, 1.15),
    );
    // About 4.3% more of an award near 11,140.
    expect(chrononReactorGain(energy, 3, 4)).toBeGreaterThan(450);
    expect(chrononReactorGain(energy, 3, 4)).toBeLessThan(500);
    expect(chrononReactorGain(energy, 3, 3)).toBe(0);
  });
});
