/**
 * The blueprint codec's optional tier table, and the promise that came with
 * adding it: nothing already encoded changed meaning.
 *
 * The byte tables themselves are pinned from the Python side
 * (`py_solver/tests/test_blueprint.py`), which reads this module's source. What
 * that cannot check is the *layout* of the payload, so the one byte-exact
 * assertion here has a twin over there asserting the same seven bytes for the
 * same board. A tier table appended in a different order, or with the count in
 * a different place, decodes as a different roster rather than failing — the
 * same silent failure mode a renumbered building has.
 */
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  blueprintKey,
  decodeBlueprint,
  encodeBlueprint,
  type BlueprintPlacement,
} from "./blueprint";
import type { Tile, TileType } from "../types";

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
    // `py_solver/tests/test_blueprint.py`. Both trees must build these bytes.
    const code = await encodeBlueprint(grid(2, 1), [place(0, 0, "cooler1")], {
      cooler1: 3,
    });

    //                                    w  h  tiles  n  [byte, level]
    expect(await payloadOf(code)).toEqual([2, 1, 10, 1, 1, 10, 3]);
  });

  it("leaves the payload untouched when no tiers are given", async () => {
    // This is what let `blueprintKey` keep its meaning across the change: a
    // code encoded without tiers is byte for byte what it always was.
    const board = grid(3, 2);
    const placements = [place(1, 0, "cooler1")];

    expect(await payloadOf(await encodeBlueprint(board, placements))).toEqual([
      3, 2, 1, 10, 1, 1, 1, 1,
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
