/**
 * The tile predicates, the ASCII alphabet the suite is written in, and the
 * shipped map codes.
 *
 * The map cases matter more than they look: a template is a blueprint code and
 * nothing else, so a typo in one is completely silent — the board simply comes
 * out wrong, or does not come out at all. Ported from the reference solver's
 * `tests/test_grid.py`, with `MAPS` replaced by the app's `ISLAND_TEMPLATES`
 * (the reference shipped one player's partly-cleared boards; these are the
 * islands as the game hands them out).
 */
import { describe, expect, it } from "vitest";
import { decodeBlueprint } from "../src/encoding/blueprint";
import { TILE_CHAR_MAP, isIslandTile, makeGrid } from "../src/grid";
import { countGrassTiles } from "../src/solver/island";
import { BLANK_ISLAND_CODE, ISLAND_TEMPLATES } from "../src/data/maps";

describe("tile predicates", () => {
  it("calls everything but water an island tile", () => {
    const grid = makeGrid(["G.RTUOX"]);

    expect(grid[0].map(isIslandTile)).toEqual([
      true,
      false,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it("handles a missing tile", () => {
    expect(isIslandTile(null)).toBe(false);
    expect(isIslandTile(undefined)).toBe(false);
  });

  it("counts grass tiles", () => {
    expect(countGrassTiles(makeGrid(["G.G", "GRG"]))).toBe(4);
    expect(countGrassTiles([])).toBe(0);
  });
});

describe("the ASCII alphabet", () => {
  it("names every tile type exactly once", () => {
    const types = Object.values(TILE_CHAR_MAP);

    expect(new Set(types).size).toBe(types.length);
    expect(types).toContain("grass");
    expect(types).toContain("water");
    expect(types).toContain("transformer");
  });

  it("refuses a character it does not know", () => {
    expect(() => makeGrid(["GZG"])).toThrow(/not a tile character/);
  });

  it("refuses a ragged picture", () => {
    expect(() => makeGrid(["GGG", "GG"])).toThrow(/equal length/);
  });
});

describe("the shipped maps", () => {
  const codes = [
    ...ISLAND_TEMPLATES.map((t) => [t.id, t.code] as const),
    ["blank", BLANK_ISLAND_CODE] as const,
  ];

  it.each(codes)(
    "%s decodes to a rectangular grid with buildable tiles",
    async (_id, code) => {
      const decoded = await decodeBlueprint(code);

      expect(decoded.grid.length).toBeGreaterThan(0);
      expect(decoded.grid.length).toBe(decoded.height);
      for (const row of decoded.grid) {
        expect(row.length, "grid is ragged").toBe(decoded.width);
      }
      expect(
        countGrassTiles(decoded.grid),
        "map has no buildable tiles",
      ).toBeGreaterThan(0);
    },
  );

  it.each(codes)(
    "%s ships terrain only, not a solved layout",
    async (_id, code) => {
      expect((await decodeBlueprint(code)).placements).toEqual([]);
    },
  );

  it("gives every template a unique id", () => {
    const ids = ISLAND_TEMPLATES.map((t) => t.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});
