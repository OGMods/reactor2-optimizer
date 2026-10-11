/**
 * Reading a code from the game's Export to Optimizer button, and turning it into
 * the optimizer's roster, Time Lab, anomaly, plan and boards.
 *
 * The three fixtures in `gameExports/` are real exports the game produced from
 * three saves: city level 23 in a first timeline (five islands, early
 * buildings, most obstacles still standing), city level 34 in a third timeline
 * (Cryo Nexus, Time Lab research, two islands still locked) and city level 47
 * in a first timeline (everything unlocked, one research running). They are the only evidence of what the game
 * actually writes, which is why most of what is pinned here is pinned against
 * them rather than against codes built in the test.
 */
import { readFileSync } from "node:fs";
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

  it("ignores a section appended after the six it knows", async () => {
    const w = tinyExport().str("a later section");
    const exp = await decodeGameExport(w.code());
    expect(exp.islands[0]).toMatchObject({
      areaId: "area_1",
      minX: -3,
      minY: 4,
      cells: ["TileGrass", "TileWater"],
    });
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
