/**
 * Reading a code from the game's Export to Optimizer button, and turning it into
 * the optimizer's roster, Time Lab, anomaly, plan and boards.
 *
 * The three fixtures in `gameExports/` are real exports the game produced from
 * three saves: city level 23 in a first timeline (five islands, early
 * buildings, most obstacles still standing), city level 34 in a third timeline
 * (Cryo Nexus, Time Lab research, two islands still locked) and city level 47
 * in a first timeline (everything unlocked, one research running). They
 * predate section 7; the `gen*` samples beside them carry it, and have their
 * own block at the end. They are the only evidence of what the game
 * actually writes, which is why most of what is pinned here is pinned against
 * them rather than against codes built in the test.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  applyInProgress,
  plannableProgress,
  resolveGameExport,
} from "../src/data/gameImport";
import { ISLAND_TEMPLATES } from "../src/data/maps";
import { decodeGameExport, isGameExportCode } from "../src/encoding/gameExport";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "gameExports");
const city23 = readFileSync(join(DIR, "city23-timeline1.txt"), "utf8");
const city34 = readFileSync(join(DIR, "city34-timeline3.txt"), "utf8");
const city47 = readFileSync(join(DIR, "city47-timeline1.txt"), "utf8");

/** A `BinaryWriter` in miniature, for codes the game has not written. */
class Writer {
  bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v & 0xff);
    return this;
  }
  i16(v: number) {
    const b = Buffer.alloc(2);
    b.writeInt16LE(v);
    this.bytes.push(...b);
    return this;
  }
  u16(v: number) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v);
    this.bytes.push(...b);
    return this;
  }
  i32(v: number) {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v);
    this.bytes.push(...b);
    return this;
  }
  i64(v: number) {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(v));
    this.bytes.push(...b);
    return this;
  }
  f64(v: number) {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(v);
    this.bytes.push(...b);
    return this;
  }
  str(s: string) {
    const utf8 = Buffer.from(s, "utf8");
    let n = utf8.length;
    while (n >= 0x80) {
      this.u8((n & 0x7f) | 0x80);
      n >>= 7;
    }
    this.u8(n);
    this.bytes.push(...utf8);
    return this;
  }
  code(version = 1) {
    const body = deflateRawSync(Buffer.from(this.bytes)).toString("base64url");
    return `R2X${version}.${body}`;
  }
}

/** The smallest valid export: one 2x1 island and nothing else. */
function tinyExport(): Writer {
  return new Writer()
    .str("1.1.10")
    .str("none")
    .u8(0)
    .u8(2)
    .str("TileWater")
    .str("TileGrass")
    .u8(1)
    .str("area_1")
    .u8(1)
    .i16(-3)
    .i16(4)
    .u8(2)
    .u8(1)
    .u8(1)
    .u8(0)
    .u16(0)
    .u16(0)
    .u16(0);
}

describe("decodeGameExport", () => {
  it("recognises a game code by its prefix", () => {
    expect(isGameExportCode(city34)).toBe(true);
    expect(isGameExportCode("  R2X2.abc")).toBe(true);
    expect(isGameExportCode(ISLAND_TEMPLATES[0].code)).toBe(false);
  });

  it("reads the game's own export", async () => {
    const exp = await decodeGameExport(city34);
    expect(exp.version).toBe(1);
    expect(exp.gameVersion).toBe("1.1.10");
    expect(exp.anomalyId).toBe("cryo_nexus");
    expect(exp.palette.slice(0, 7)).toEqual([
      "TileWater",
      "TileGrass",
      "Map_Rock",
      "Map_Forest_Coniferous",
      "Map_Forest_Deciduous",
      "Map_Pond",
      "CantBuildHere",
    ]);
    expect(exp.islands.map((i) => i.areaId)).toEqual([
      "area_1",
      "area_2",
      "area_3",
      "area_4",
      "area_5",
      "area_6",
      "area_7",
      "area_8",
    ]);
    expect(exp.islands.map((i) => i.unlocked)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(Object.keys(exp.research)).toHaveLength(79);
    // Ids are the game's, verbatim — including the trailing space two of them
    // shipped with.
    expect(exp.research["DepositsSlotsResearchSO "]).toBe(4);
    expect(exp.researchInProgress).toEqual([]);
  });

  it("reads research in progress", async () => {
    const exp = await decodeGameExport(city47);
    expect(exp.researchInProgress).toEqual([
      { id: "research_building_doomStar_reactor", level: 3, secondsLeft: 0 },
    ]);
  });

  it("ignores line breaks and stray characters around the body", async () => {
    // The first sample arrived with a stray `ś` after the code.
    const messy = `  ${city34.slice(0, 60)}\n${city34.slice(60).trim()}ś \n`;
    const exp = await decodeGameExport(messy);
    expect(exp.anomalyId).toBe("cryo_nexus");
  });

  it("refuses a format it does not know", async () => {
    await expect(decodeGameExport(tinyExport().code(2))).rejects.toThrow(
      /format 2/,
    );
  });

  it("refuses a code that was cut off", async () => {
    await expect(decodeGameExport(city34.slice(0, 1200))).rejects.toThrow();
  });

  it("ignores a section appended after the seven it knows", async () => {
    const w = timelineSection(tinyExport())
      .f64(1e6)
      .f64(5e4)
      .u8(0)
      .str("a later section");
    const exp = await decodeGameExport(w.code());
    expect(exp.islands[0]).toMatchObject({
      areaId: "area_1",
      minX: -3,
      minY: 4,
      cells: ["TileGrass", "TileWater"],
    });
    expect(exp.timeline).toMatchObject({
      generation: 3,
      cash: 1e6,
      researchPoints: 5e4,
      stampSource: "server",
    });
  });
});

/**
 * The worked example of `docs/game-export.md`'s section 7, plus the generation
 * field the game added after it.
 */
function timelineSection(w: Writer): Writer {
  return w
    .i64(1792540800)
    .i64(6200)
    .f64(5.14e29)
    .i64(2592000)
    .i64(6905)
    .u16(1)
    .str("cryo_nexus")
    .i32(3);
}

/**
 * Section 7, the timeline. Saves the developer exported from 1.1.11 for this
 * purpose, named `gen<jumps>_<anomaly>_city<level>`; `gen2_city52_9c43e4b7`
 * and `editor_current_save` are a player's, and a `_server` file is the same
 * save stamped by server time rather than the device clock. They are the third
 * round, which ends with the clock byte — except `owner_editor_save`, kept
 * from the second, the one real code that ends at research points. Only the
 * figures are pinned here — the award is the game's own, and whether our
 * formula agrees with it is the Chronon module's to test.
 */
const TIMELINE_SAMPLES = readdirSync(DIR)
  .filter((f) => !f.startsWith("city"))
  .map((f) => f.replace(/\.txt$/, ""));
describe("the timeline section", () => {
  const sample = (name: string) =>
    decodeGameExport(readFileSync(join(DIR, `${name}.txt`), "utf8"));

  it("is null on a code written before it existed", async () => {
    for (const code of [city23, city34, city47]) {
      expect((await decodeGameExport(code)).timeline).toBeNull();
    }
  });

  it("reads every figure the game wrote", async () => {
    const exp = await sample("gen1_cryo_city41");
    expect(exp.gameVersion).toBe("1.1.11");
    expect(exp.timeline).toEqual({
      exportedAt: 1792610302,
      chronons: 553,
      energy: 8.906078559870158e25,
      elapsedSeconds: 1841407,
      jumpAward: 2051,
      anomaliesEntered: ["cryo_nexus"],
      generation: 1,
      cash: 3.001636196701361e30,
      researchPoints: 7630000001250,
      stampSource: "device",
    });
  });

  it("reads a player who has never entered an anomaly", async () => {
    const { timeline } = await sample("gen0_none_city2");
    expect(timeline).toMatchObject({
      energy: 23814,
      jumpAward: 2,
      anomaliesEntered: [],
      generation: 0,
      cash: 13926.60626791145,
      researchPoints: 0,
    });
  });

  it("names Tidal Ascendancy plainly when the header names its legacy balance", async () => {
    const exp = await sample("gen6_tidal_city49");
    expect(exp.anomalyId).toBe("tidal_ascendancy_legacy");
    expect(exp.timeline?.anomaliesEntered).toEqual([
      "cryo_nexus",
      "singularity_isolation",
      "tidal_ascendancy",
    ]);
    expect(exp.timeline?.generation).toBe(6);
  });

  /*
   * One sample is not clean, and it is the game's save rather than our map:
   * `gen1_cryo_city41` has a building standing on the transformer cell of
   * areas 6, 7 and 8 (a chaos core, a psionic tower, a cooler6), where every
   * other export writes `CantBuildHere`. The import drops each one and counts
   * it, which is the rule — pinned so a fourth would show.
   */
  const ON_TRANSFORMER: Record<string, Record<string, number>> = {
    gen1_cryo_city41: { island6: 1, island7: 1, island8: 1 },
  };

  it("reads every sample, and every one resolves onto our maps", async () => {
    expect(TIMELINE_SAMPLES.length).toBe(13);
    for (const name of TIMELINE_SAMPLES) {
      const exp = await sample(name);
      expect(exp.timeline, name).not.toBeNull();
      const r = await resolveGameExport(exp);
      for (const island of r.islands) {
        expect(island.blockedBuildings, `${name} ${island.templateId}`).toBe(
          ON_TRANSFORMER[name]?.[island.templateId] ?? 0,
        );
      }
    }
  });

  it("reads the spec's worked example byte for byte", async () => {
    const exp = await decodeGameExport(timelineSection(tinyExport()).code());
    expect(exp.timeline).toEqual({
      exportedAt: 1792540800,
      chronons: 6200,
      energy: 5.14e29,
      elapsedSeconds: 2592000,
      jumpAward: 6905,
      anomaliesEntered: ["cryo_nexus"],
      generation: 3,
      cash: null,
      researchPoints: null,
      stampSource: null,
    });
  });

  it("reads cash and research points after the generation, debt included", async () => {
    const w = timelineSection(tinyExport()).f64(-2.5e30).f64(9.15e11);
    const { timeline } = await decodeGameExport(w.code());
    expect(timeline).toMatchObject({ cash: -2.5e30, researchPoints: 9.15e11 });
  });

  it("reads the clock byte the game writes, and its absence", async () => {
    for (const name of TIMELINE_SAMPLES) {
      const { timeline } = await sample(name);
      expect(timeline?.stampSource, name).toBe(
        name === "owner_editor_save"
          ? null
          : name.endsWith("_server")
            ? "server"
            : "device",
      );
    }
  });

  it("says which clock stamped the export, and not a clock it does not know", async () => {
    const read = async (source: number) =>
      (
        await decodeGameExport(
          timelineSection(tinyExport()).f64(0).f64(0).u8(source).code(),
        )
      ).timeline?.stampSource;
    expect(await read(0)).toBe("server");
    expect(await read(1)).toBe("device");
    expect(await read(7)).toBeNull();
  });

  it("refuses a timeline that was cut off rather than reading half of it", async () => {
    const w = timelineSection(tinyExport());
    w.bytes.length -= 2;
    await expect(decodeGameExport(w.code())).rejects.toThrow(/cut off/);
  });
});

describe("resolveGameExport", () => {
  it("maps research levels to tier indexes", async () => {
    const r = await resolveGameExport(await decodeGameExport(city34));
    // Level 9 bought of nine: the top tier, index 8.
    expect(r.buildingUpgrades.cooler5).toBe(8);
    // Level 1 is the unlock, which is tier 1.
    expect(r.buildingUpgrades.cooler6).toBe(0);
    // Level 0 is locked: no key.
    expect(r.buildingUpgrades).not.toHaveProperty("chaos_core");
    // The one research id the game spells without `building_`.
    expect(r.buildingUpgrades.gas_plant).toBe(5);
    expect(r.prestigeLevels).toEqual({
      absolute_zero: 4,
      infinite_grid: 4,
      stellar_forge: 5,
    });
    expect(r.anomalyId).toBe("cryo_nexus");
    expect(r.unknownAnomaly).toBeNull();
  });

  it("leaves locked islands out", async () => {
    const r = await resolveGameExport(await decodeGameExport(city34));
    expect(r.islands.map((i) => i.templateId)).toEqual([
      "island1",
      "island2",
      "island3",
      "island4",
      "island5",
      "island6",
    ]);
    expect(r.lockedTemplateIds).toEqual(["island7", "island8"]);
  });

  /*
   * The alignment test: every land cell of the game's map has to land on the
   * matching tile of ours. A wrong origin or a wrong turn would show here as
   * hundreds of mismatches. The first exports caught one real error this way:
   * island 5 had a tree one tile from where the game has it.
   */
  it("lines every island up with our map", async () => {
    for (const code of [city23, city34, city47]) {
      const r = await resolveGameExport(await decodeGameExport(code));
      for (const island of r.islands) {
        expect(island.mismatched, island.templateId).toBe(0);
        expect(island.unknownBuildings, island.templateId).toBe(0);
        expect(island.blockedBuildings, island.templateId).toBe(0);
      }
    }
  });

  it("places every building and clears the obstacles under them", async () => {
    const exp = await decodeGameExport(city34);
    const r = await resolveGameExport(exp);
    const area = exp.islands[0];
    const built = area.cells.filter(
      (c) =>
        !c.startsWith("Tile") && !c.startsWith("Map_") && c !== "CantBuildHere",
    );
    const island1 = r.islands[0];
    expect(island1.placements).toHaveLength(built.length);
    for (const p of island1.placements) {
      expect(island1.grid[p.y][p.x].type).toBe("grass");
    }
    expect(island1.cleared).toBeGreaterThan(0);
  });

  it("reports an anomaly it does not know rather than guessing", async () => {
    const w = new Writer()
      .str("9.9.9")
      .str("some_future_anomaly")
      .u8(0)
      .u8(0)
      .u8(0)
      .u16(0)
      .u16(0)
      .u16(0);
    const r = await resolveGameExport(await decodeGameExport(w.code()));
    expect(r.anomalyId).toBe("none");
    expect(r.unknownAnomaly).toBe("some_future_anomaly");
  });
});

/**
 * `gen2_city52_9c43e4b7` was exported with three obstacles being cleared, 5h7m,
 * 5h43m and 6h20m from done, and Erased from Time at level 5 — a 70-minute
 * free window, so none of them free yet.
 */
describe("obstacles being cleared", () => {
  const name = "gen2_city52_9c43e4b7";
  const read = async (now?: number) => {
    const exp = await decodeGameExport(
      readFileSync(join(DIR, `${name}.txt`), "utf8"),
    );
    const r = await resolveGameExport(exp, { now });
    const cleared = r.islands.reduce((n, i) => n + i.cleared, 0);
    return { exp, r, cleared };
  };

  it("stay obstacles while they have longer left than the free window", async () => {
    const { r } = await read();
    expect(r.clears).toEqual({ done: 0, pending: 3 });
  });

  it("come in cleared once finished, or once inside the free window", async () => {
    const before = await read();
    const at = before.exp.timeline!.exportedAt;
    // 18420 s left on the first: done after that, free from 4200 s before it.
    const free = await read(at + 18420 - 4200);
    expect(free.r.clears).toEqual({ done: 1, pending: 2 });
    expect(free.cleared).toBe(before.cleared + 1);
    const all = await read(at + 30000);
    expect(all.r.clears).toEqual({ done: 3, pending: 0 });
    expect(all.cleared).toBe(before.cleared + 3);
    // The clock is read from the export's own stamp, not before it.
    expect((await read(at - 99999)).r.clears.done).toBe(0);
  });
});

describe("research in progress", () => {
  it("is a building upgrade the plan can hold", async () => {
    const r = await resolveGameExport(await decodeGameExport(city47));
    expect(r.buildingUpgrades.doomStar_reactor).toBe(1);
    expect(r.inProgress).toEqual([
      { kind: "building", id: "doomStar_reactor", level: 2, secondsLeft: 0 },
    ]);
    expect(plannableProgress(r)).toHaveLength(1);
  });

  it("counts as bought when imported as finished", async () => {
    const r = await resolveGameExport(await decodeGameExport(city47));
    const s = applyInProgress(r, "finished");
    expect(s.buildingUpgrades.doomStar_reactor).toBe(2);
    expect(s.upgradePlan).toBeNull();
    // The resolved import itself is not changed.
    expect(r.buildingUpgrades.doomStar_reactor).toBe(1);
  });

  it("becomes the upgrade plan when imported as a plan", async () => {
    const r = await resolveGameExport(await decodeGameExport(city47));
    const s = applyInProgress(r, "plan");
    expect(s.buildingUpgrades.doomStar_reactor).toBe(1);
    expect(s.upgradePlan).toEqual([
      { buildingId: "doomStar_reactor", level: 2 },
    ]);
  });

  it("leaves an unlock out of the plan, since a locked building cannot be planned", async () => {
    const r = await resolveGameExport(await decodeGameExport(city47));
    const unlocking = {
      ...r,
      inProgress: [
        {
          kind: "building" as const,
          id: "ecto_compressor",
          level: 0,
          secondsLeft: 60,
        },
        ...r.inProgress,
      ],
    };
    expect(plannableProgress(unlocking).map((p) => p.id)).toEqual([
      "doomStar_reactor",
    ]);
    expect(
      applyInProgress(unlocking, "finished").buildingUpgrades.ecto_compressor,
    ).toBe(0);
  });

  it("changes nothing when ignored", async () => {
    const r = await resolveGameExport(await decodeGameExport(city47));
    const s = applyInProgress(r, "ignore");
    expect(s.buildingUpgrades).toEqual(r.buildingUpgrades);
    expect(s.upgradePlan).toBeNull();
  });
});
