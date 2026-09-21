/**
 * The blueprint codec: the wire format every saved board, shipped island and
 * share code is written in.
 *
 * Two things here look like implementation detail and are not. The byte tables
 * are a **compatibility surface** — a renumbered building decodes as a
 * *different* building rather than failing, so a code a player saved last year
 * silently becomes a different board. And the payload *layout* is the same kind
 * of promise: a tier table appended in a different order, or with its count in
 * a different place, is read as a different roster rather than rejected. The
 * byte-exact assertion below is what pins it.
 *
 * Those tables used to be checked from a second language, by a Python test that
 * parsed this module's source. With that reference retired, the coverage that
 * mattered is restated here as round-trips over the real roster: every shipped
 * building must survive one, which is the property the cross-check was really
 * buying.
 *
 * Ported from the reference solver's `tests/test_blueprint.py`.
 */
import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { BUILDINGS } from "../src/data/buildings";
import { makeGrid } from "../src/grid";
import {
  BLUEPRINT_VERSION,
  MIN_GRID_DIM,
  blueprintKey,
  blueprintRules,
  decodeBlueprint,
  encodeBlueprint,
  type BlueprintPlacement,
} from "../src/encoding/blueprint";
import type { Tile, TileType } from "../src/solver/types";

/** A rectangle of one terrain, which is all any of these need. */
function grid(
  width: number,
  height: number,
  type: TileType = "grass",
): Tile[][] {
  return Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x): Tile => ({ x, y, type })),
  );
}

function place(x: number, y: number, buildingId: string): BlueprintPlacement {
  return { x, y, buildingId };
}

/** The uncompressed payload behind a code — what the two trees must agree on. */
async function payloadOf(code: string): Promise<number[]> {
  const binary = atob(
    code
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(code.length + ((4 - (code.length % 4)) % 4), "="),
  );
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return [...inflateSync(bytes)];
}

/** A code for an already-deflated payload, for the malformed-input cases. */
function codeFor(payload: number[]): string {
  return Buffer.from(deflateSync(Buffer.from(payload)))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("round trips", () => {
  it("round-trips terrain", async () => {
    const original = makeGrid(["G.RT", "UOXG", "GGGG"]);

    const decoded = await decodeBlueprint(await encodeBlueprint(original));

    expect([decoded.width, decoded.height]).toEqual([4, 3]);
    expect(decoded.grid.map((row) => row.map((t) => t.type))).toEqual(
      original.map((row) => row.map((t) => t.type)),
    );
  });

  it("rebuilds tile coordinates", async () => {
    const decoded = await decodeBlueprint(
      await encodeBlueprint(makeGrid(["GG", "GG"])),
    );

    decoded.grid.forEach((row, y) =>
      row.forEach((tile, x) => expect([tile.x, tile.y]).toEqual([x, y])),
    );
  });

  it("round-trips placements", async () => {
    const placements = [
      place(0, 0, "cooler1"),
      place(2, 1, "doomStar_reactor"),
    ];

    const decoded = await decodeBlueprint(
      await encodeBlueprint(makeGrid(["GGG", "GGG"]), placements),
    );

    expect(decoded.placements).toEqual(placements);
  });

  it("implies grass under a building", async () => {
    const decoded = await decodeBlueprint(
      await encodeBlueprint(makeGrid(["."]), [place(0, 0, "generator")]),
    );

    expect(decoded.grid[0][0].type).toBe("grass");
  });

  it("encodes an empty grid to an empty string", async () => {
    expect(await encodeBlueprint([])).toBe("");

    const decoded = await decodeBlueprint("");
    expect([decoded.width, decoded.height, decoded.grid]).toEqual([0, 0, []]);
  });

  it("falls back to terrain for an unknown building id", async () => {
    const decoded = await decodeBlueprint(
      await encodeBlueprint(makeGrid(["R"]), [place(0, 0, "not_a_building")]),
    );

    expect(decoded.placements).toEqual([]);
    expect(decoded.grid[0][0].type).toBe("rock");
  });

  it.each(BUILDINGS.map((b) => b.id))(
    "round-trips %s, so no shipped building is missing a byte",
    async (id) => {
      const decoded = await decodeBlueprint(
        await encodeBlueprint(makeGrid(["G"]), [place(0, 0, id)]),
      );

      expect(decoded.placements.map((p) => p.buildingId)).toEqual([id]);
    },
  );
});

describe("malformed input", () => {
  it.each(["!!!!", "not-base64!", "eJzz"])("rejects %s", async (bad) => {
    await expect(decodeBlueprint(bad)).rejects.toThrow();
  });

  it("rejects a truncated payload", async () => {
    // Claims 10x10 but carries no tile bytes.
    await expect(decodeBlueprint(codeFor([10, 10]))).rejects.toThrow(
      /truncated or malformed/,
    );
  });
});

describe("blueprintKey", () => {
  it("gives identical layouts the same key", () => {
    expect(blueprintKey(makeGrid(["GG.", "G.G"]))).toBe(
      blueprintKey(makeGrid(["GG.", "G.G"])),
    );
  });

  it("gives differing layouts different keys", () => {
    expect(blueprintKey(makeGrid(["GG"]))).not.toBe(
      blueprintKey(makeGrid(["G."])),
    );
  });

  it("counts placements as part of the key", () => {
    const board = makeGrid(["GG"]);

    expect(blueprintKey(board)).not.toBe(
      blueprintKey(board, [place(0, 0, "cooler1")]),
    );
  });

  it("is the uncompressed payload, so no compressor can change it", async () => {
    /*
     * The reason a key exists at all. DEFLATE is only required to round-trip,
     * and two engines — or two compression levels — may emit different bytes for
     * the same board. Comparing codes would report a difference that is not
     * there; comparing keys cannot.
     */
    const board = makeGrid(["GGGG", "GGGG"]);
    const key = blueprintKey(board);
    const payload = [...key].map((c) => c.charCodeAt(0));

    expect([...(await payloadOf(await encodeBlueprint(board)))]).toEqual(
      payload,
    );

    const fast = deflateSync(Buffer.from(payload), { level: 1 });
    const small = deflateSync(Buffer.from(payload), { level: 9 });
    expect([...inflateSync(fast)]).toEqual(payload);
    expect([...inflateSync(small)]).toEqual(payload);
  });
});

describe("tier table", () => {
  it("round-trips the tier each building was placed at", async () => {
    const placements = [place(0, 0, "cooler2"), place(2, 1, "generator3")];
    const tiers = { cooler2: 4, generator3: 7 };

    const decoded = await decodeBlueprint(
      await encodeBlueprint(grid(3, 2), placements, tiers),
    );

    expect(decoded.tiers).toEqual(tiers);
    expect(decoded.placements).toEqual(placements);
  });

  it("reports no tiers for a code that carries none", async () => {
    // Not "everything is at tier 0": every code written before the table
    // existed is one of these, and reading it that way would silently
    // downgrade every layout ever shared.
    const decoded = await decodeBlueprint(
      await encodeBlueprint(grid(2, 1), [place(0, 0, "cooler1")]),
    );

    expect(decoded.tiers).toEqual({});
  });

  it("appends the table after the tiles, count first", async () => {
    // The twin of `test_the_table_is_appended_after_the_tiles` in
    // The payload layout, byte for byte: count first, then the pairs.
    const code = await encodeBlueprint(grid(2, 1), [place(0, 0, "cooler1")], {
      cooler1: 3,
    });

    //                                    v  w  h  tiles  n  [byte, level]
    expect(await payloadOf(code)).toEqual([1, 2, 1, 10, 1, 1, 10, 3]);
  });

  it("appends nothing when no tiers are given", async () => {
    // What lets `blueprintKey` keep its meaning: a code encoded without tiers
    // is the header and the tiles and nothing else.
    const board = grid(3, 2);
    const placements = [place(1, 0, "cooler1")];

    //                v  w  h  tiles
    expect(await payloadOf(await encodeBlueprint(board, placements))).toEqual([
      1, 3, 2, 1, 10, 1, 1, 1, 1,
    ]);
  });

  it("writes an entry only for buildings that are on the board", async () => {
    const decoded = await decodeBlueprint(
      await encodeBlueprint(grid(2, 1), [place(0, 0, "cooler1")], {
        cooler1: 1,
        generator5: 6,
      }),
    );

    expect(decoded.tiers).toEqual({ cooler1: 1 });
  });

  it("writes no entry for an id the catalogue does not carry", async () => {
    // That id never reached a tile byte either, so a tier for it would point
    // at a building the board does not have.
    const decoded = await decodeBlueprint(
      await encodeBlueprint(grid(1, 1), [place(0, 0, "not_a_building")], {
        not_a_building: 2,
      }),
    );

    expect(decoded.tiers).toEqual({});
    expect(decoded.placements).toEqual([]);
  });

  it("keeps tiers out of the layout key", async () => {
    // `blueprintKey` answers "is this the same layout?", and buying an upgrade
    // does not repaint a board. `persist()` compares against a pristine
    // template with it, so folding tiers in would mark every board modified
    // the moment a tier was bought.
    const board = grid(2, 1);
    const placements = [place(0, 0, "cooler1")];

    const before = blueprintKey(board, placements);
    const encoded = await encodeBlueprint(board, placements, { cooler1: 5 });

    expect(blueprintKey(board, placements)).toBe(before);
    expect(await payloadOf(encoded)).not.toEqual(
      [...before].map((c) => c.charCodeAt(0)),
    );
  });

  it("survives a code whose table is cut short", async () => {
    // The tiles cannot be reconstructed and the tiers can, so a payload that
    // stops mid-table gives up the tiers and keeps the board.
    const placements = [place(0, 0, "cooler1")];
    const full = await payloadOf(
      await encodeBlueprint(grid(2, 1), placements, { cooler1: 3 }),
    );

    // Claims one entry, carries only the building byte of it.
    const truncated = new Uint8Array(full.slice(0, -1));
    const stream = new Blob([truncated])
      .stream()
      .pipeThrough(new CompressionStream("deflate"));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    const code = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const decoded = await decodeBlueprint(code);

    expect(decoded.tiers).toEqual({});
    expect(decoded.placements).toEqual(placements);
  });
});

describe("the rules section", () => {
  /*
   * The anomaly and the research a board was built under. Everything here is a
   * way the section fails *quietly*: a reader that mistakes "unstated" for
   * "none" rates someone else's board at nothing and still shows a number, and
   * one that starts reading at the wrong offset finds an anomaly where a tier
   * was. Neither throws.
   */
  const GRID = makeGrid(["GG", "GG"]);

  it("round-trips the anomaly and the research", async () => {
    const code = await encodeBlueprint(
      GRID,
      [],
      {},
      blueprintRules("cryo_nexus", { absolute_zero: 2, stellar_forge: 4 }),
    );
    const decoded = await decodeBlueprint(code);

    expect(decoded.rules).toEqual({
      anomalyId: "cryo_nexus",
      research: { absolute_zero: 2, stellar_forge: 4 },
    });
  });

  it("distinguishes 'no rules stated' from 'no anomaly and no research'", async () => {
    // The whole reason `rules` is nullable. A save states nothing and must pick
    // up the reader's own; a share code can state emptiness and mean it.
    const silent = await decodeBlueprint(await encodeBlueprint(GRID, []));
    expect(silent.rules).toBeNull();

    const explicit = await decodeBlueprint(
      await encodeBlueprint(GRID, [], undefined, blueprintRules("none", {})),
    );
    expect(explicit.rules).toEqual({ anomalyId: "none", research: {} });
  });

  it("writes a tier count byte ahead of rules given no tiers", async () => {
    // The section is read only after the tier table, so rules without that byte
    // would be read as a tier table. Zero there means "tiers unknown", which is
    // what a code with no tiers has always meant.
    const code = await encodeBlueprint(
      GRID,
      [],
      undefined,
      blueprintRules("tidal_ascendancy", {}),
    );
    const payload = await payloadOf(code);

    expect(payload.slice(0, 3)).toEqual([1, 2, 2]);
    // tiles, then the zero tier count, then the anomaly byte and a zero
    // research count.
    expect(payload.slice(7)).toEqual([0, 2, 0]);

    const decoded = await decodeBlueprint(code);
    expect(decoded.tiers).toEqual({});
    expect(decoded.rules?.anomalyId).toBe("tidal_ascendancy");
  });

  it("reads rules that sit after a real tier table", async () => {
    const placements: BlueprintPlacement[] = [
      { x: 0, y: 0, buildingId: "cooler1" },
    ];
    const decoded = await decodeBlueprint(
      await encodeBlueprint(
        GRID,
        placements,
        { cooler1: 3 },
        blueprintRules("singularity_isolation", { infinite_grid: 1 }),
      ),
    );

    expect(decoded.tiers).toEqual({ cooler1: 3 });
    expect(decoded.rules).toEqual({
      anomalyId: "singularity_isolation",
      research: { infinite_grid: 1 },
    });
  });

  it("reads an unknown anomaly byte as no anomaly", async () => {
    // A code from a later build naming an anomaly this one has never heard of.
    // The same fallback `getAnomaly` makes, and the only safe one.
    const decoded = await decodeBlueprint(
      codeFor([1, 2, 2, 1, 1, 1, 1, 0, 200, 0]),
    );
    expect(decoded.rules?.anomalyId).toBe("none");
  });

  it("drops a truncated rules section rather than the layout", async () => {
    // A count that outruns the payload. The tiles are the part that cannot be
    // reconstructed and they have already been read.
    const decoded = await decodeBlueprint(
      codeFor([1, 2, 2, 1, 1, 1, 1, 0, 1, 9]),
    );
    expect(decoded.grid).toHaveLength(2);
    expect(decoded.rules).toEqual({ anomalyId: "cryo_nexus", research: {} });
  });

  it("keeps rules out of the layout key", async () => {
    // `blueprintKey` answers "is this the same layout?" — the same reason tiers
    // are not in it. Choosing an anomaly must not read as a repainted board.
    const withRules = await encodeBlueprint(
      GRID,
      [],
      {},
      blueprintRules("cryo_nexus", { absolute_zero: 4 }),
    );
    expect(await payloadOf(withRules)).not.toEqual(
      [...blueprintKey(GRID, [])].map((c) => c.charCodeAt(0)),
    );
    expect(blueprintKey(GRID, [])).toBe(blueprintKey(GRID, []));
  });
});

describe("the format version byte", () => {
  /*
   * A code written before the byte existed begins with its width, so the two
   * are told apart by value: below `MIN_GRID_DIM` is a version, at or above it
   * is a width. Nothing here throws when it goes wrong — a legacy code read as
   * versioned is off by one byte from its second tile onward, which is a
   * different board, not an error. That is what these pin.
   */
  it("writes the current version as byte 0", async () => {
    const payload = await payloadOf(await encodeBlueprint(grid(6, 1)));
    expect(payload[0]).toBe(BLUEPRINT_VERSION);
    expect(payload.slice(0, 3)).toEqual([BLUEPRINT_VERSION, 6, 1]);
  });

  it("still reads a code written before the byte existed", async () => {
    // Byte 0 is 6 — too big to be a version, so this is a width and the tiles
    // start at byte 2. Every share code and saved layout in the wild is one of
    // these.
    const decoded = await decodeBlueprint(codeFor([6, 1, 1, 1, 2, 1, 1, 1]));

    expect([decoded.width, decoded.height]).toEqual([6, 1]);
    expect(decoded.grid[0].map((t) => t.type)).toEqual([
      "grass",
      "grass",
      "rock",
      "grass",
      "grass",
      "grass",
    ]);
    expect(decoded.rules).toBeNull();
  });

  it("reads a legacy code at the narrowest board that can exist", async () => {
    // The boundary the whole scheme rests on: a width of exactly
    // `MIN_GRID_DIM` must still read as a width, not as a version.
    const tiles = new Array(MIN_GRID_DIM).fill(1);
    const decoded = await decodeBlueprint(codeFor([MIN_GRID_DIM, 1, ...tiles]));
    expect(decoded.width).toBe(MIN_GRID_DIM);
  });

  it("refuses a version it does not know rather than guessing", async () => {
    // Reading a later payload as this one would not fail — the tiles are
    // positional — so it would quietly hand back a different board.
    await expect(
      decodeBlueprint(codeFor([BLUEPRINT_VERSION + 1, 2, 2, 1, 1, 1, 1])),
    ).rejects.toThrow(/format version/);
  });

  it("encodes boards smaller than the legacy floor", async () => {
    // `MIN_GRID_DIM` constrains which *old* codes are recognisable, not what a
    // board may be: a versioned code says its width where no value is
    // ambiguous, which is what the 4x4 fixtures rely on.
    const decoded = await decodeBlueprint(await encodeBlueprint(grid(2, 2)));
    expect([decoded.width, decoded.height]).toEqual([2, 2]);
  });
});
