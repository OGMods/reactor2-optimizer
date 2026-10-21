/**
 * The Chronon award against the game's own: every 1.1.11 sample carries the
 * award the game computed, and the formula has to land on each one exactly.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CHRONON_REACTOR_ID,
  chrononAward,
  chrononMultiplier,
  energyForAward,
  FIRST_ENTRY_BONUS,
  firstEntryBonus,
  jumpThreshold,
  projectTimeline,
} from "../src/data/chronons";
import { decodeGameExport } from "../src/encoding/gameExport";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "gameExports");

describe("chrononAward", () => {
  it("reproduces the game's award in every sample", async () => {
    // Every sample but the three written before the timeline section.
    const names = readdirSync(DIR).filter((f) => !f.startsWith("city"));
    expect(names.length).toBe(13);
    for (const name of names) {
      const exp = await decodeGameExport(readFileSync(join(DIR, name), "utf8"));
      const t = exp.timeline!;
      const m = chrononMultiplier(exp.research[CHRONON_REACTOR_ID] ?? 0);
      expect(chrononAward(t.energy, m), name).toBe(t.jumpAward);
    }
  });

  it("pays nothing at zero energy, and at least one past it", () => {
    expect(chrononAward(0, 1)).toBe(0);
    expect(chrononAward(1, 1)).toBe(1);
  });

  it("takes the multiplier inside the floor", () => {
    // The live save: E 1.77717e31 at Chronon Reactor 3 paid 11140.
    expect(chrononMultiplier(3)).toBe(1.15);
    expect(chrononAward(1.77717e31, 1.15)).toBe(11140);
  });
});

describe("chrononMultiplier", () => {
  it("is ×1 unbought and clamps past the last level", () => {
    expect(chrononMultiplier(0)).toBe(1);
    expect(chrononMultiplier(5)).toBe(1.25);
    expect(chrononMultiplier(9)).toBe(1.25);
  });
});

describe("energyForAward", () => {
  it("is where the award first reaches each count", () => {
    for (const m of [1, 1.15, 1.25]) {
      for (const n of [2, 134, 6905, 11221]) {
        const e = energyForAward(n, m);
        expect(chrononAward(e * (1 + 1e-12), m)).toBe(n);
        expect(chrononAward(e * (1 - 1e-9), m)).toBe(n - 1);
      }
    }
  });
});

describe("jumpThreshold", () => {
  it("grows by 15% a jump and caps at 5000", () => {
    expect([0, 1, 2, 3, 4, 6].map(jumpThreshold)).toEqual([
      88, 101, 116, 134, 154, 204,
    ]);
    expect(jumpThreshold(28)).toBeLessThan(5000);
    expect(jumpThreshold(29)).toBe(5000);
    expect(jumpThreshold(60)).toBe(5000);
  });
});

describe("firstEntryBonus", () => {
  it("pays once per anomaly, and a rebalance is the same anomaly", () => {
    const entered = ["cryo_nexus", "tidal_ascendancy"];
    expect(firstEntryBonus("singularity_isolation", entered)).toBe(
      FIRST_ENTRY_BONUS,
    );
    expect(firstEntryBonus("cryo_nexus", entered)).toBe(0);
    expect(firstEntryBonus("tidal_ascendancy_legacy", entered)).toBe(0);
    expect(firstEntryBonus("none", [])).toBe(0);
  });
});

describe("projectTimeline", () => {
  /*
   * The live check this was built against: a save exported at 12:41:17 UTC,
   * 12d 23h 6m into its timeline, with 1.5374e26 power across its eight
   * islands. The game's counter read 11220 at 13d 4h, and each Chronon after
   * it took 4 minutes and a second or two.
   */
  const timeline = {
    exportedAt: 1792586477,
    chronons: 67,
    energy: 1.77717e31,
    elapsedSeconds: 1119984,
    jumpAward: 11140,
    anomaliesEntered: ["cryo_nexus", "tidal_ascendancy"],
    generation: 2,
  };
  const perSecond = 1.5374e26 / 3;

  it("reads the export's own figures at the moment of export", () => {
    const p = projectTimeline(timeline, perSecond, 1.15, timeline.exportedAt);
    expect(p).toMatchObject({
      sinceExport: 0,
      award: 11140,
      threshold: 116,
      canJump: true,
    });
  });

  it("lands Chronon 11220 inside 13d 4h, four minutes a Chronon", () => {
    const at = (award: number) =>
      timeline.exportedAt +
      (energyForAward(award, 1.15) - timeline.energy) / perSecond;
    const elapsed = at(11220) - timeline.exportedAt + timeline.elapsedSeconds;
    expect(elapsed).toBeGreaterThan(13 * 86400 + 4 * 3600);
    expect(elapsed).toBeLessThan(13 * 86400 + 5 * 3600);

    const p = projectTimeline(timeline, perSecond, 1.15, at(11223) + 1);
    expect(p.award).toBe(11223);
    expect(p.secondsToNext! + 1).toBeCloseTo(at(11224) - at(11223), 6);
    expect(p.secondsToNext! + 1).toBeGreaterThan(239);
    expect(p.secondsToNext! + 1).toBeLessThan(243);
  });

  it("never runs backwards on a clock behind the export", () => {
    const p = projectTimeline(timeline, perSecond, 1.15, 0);
    expect(p.sinceExport).toBe(0);
    expect(p.award).toBe(11140);
  });

  it("has no next Chronon on a board making nothing", () => {
    const p = projectTimeline(timeline, 0, 1.15, timeline.exportedAt + 999);
    expect(p.secondsToNext).toBeNull();
    expect(p.elapsedSeconds).toBe(timeline.elapsedSeconds + 999);
  });

  it("refuses a jump below the generation's threshold", () => {
    const p = projectTimeline(
      { ...timeline, energy: 87, generation: 3 },
      0,
      1.1,
      timeline.exportedAt,
    );
    expect(p).toMatchObject({ award: 1, threshold: 134, canJump: false });
  });
});
