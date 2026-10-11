/**
 * A shipped board: an id, a name and the blueprint code that *is* the board.
 *
 * Declared here rather than in the app because the code is the only thing that
 * carries the terrain, and the CLI reads these templates too. `CustomIsland` —
 * a board the player made — stays app-side, since nothing headless has one.
 */
export interface IslandTemplate {
  id: string;
  name: string;
  /**
   * Blueprint code (`encoding/blueprint.ts`). Carries the grid, its dimensions
   * and any placements, so there is no separate width/height here.
   */
  code: string;
  /**
   * Where this board sits in the game, for reading a code from the game's
   * Export to Optimizer button (`data/gameImport.ts`). Shipped islands only.
   *
   * The game has one world grid and every island is a region of it, named by
   * an area id. Our boards are those regions trimmed and turned: board tile
   * `(x, y)` is the game's grid cell `(originX - y, originY - x)` — rows run
   * along the game's x axis, columns along its y axis, both reversed. Measured
   * against the 1.1.10 scene, where it matches every land cell of all eight
   * islands; the same transform holds for all of them.
   */
  game?: { areaId: string; originX: number; originY: number };
}

/**
 * The shipped island maps, as blueprint codes (`lib/encoding/blueprint.ts`).
 *
 * The code carries the grid's dimensions in its first two bytes, so a template
 * is just an id, a name and a code — there is no separate `width`/`height` to
 * drift out of sync with the terrain.
 *
 * To author a new island, build it in the app and use the Share Code button;
 * the string it copies is exactly this format.
 */
export const ISLAND_TEMPLATES: IslandTemplate[] = [
  {
    id: "island1",
    name: "Gale Hills",
    code: "eJxtjDsOwDAMQo0hndL7X7eKQcrSN4H4vLsGqisQWIC1hMMzpmHGRINFziaRbiRfrPQyY-dB_q8_2tsPPc0Aow",
    game: { areaId: "area_1", originX: 7, originY: 4 },
  },
  {
    id: "island2",
    name: "Ash Bay",
    code: "eJx1jkEOgDAIBDsseDT-_7WmVBqMcU8MJMOe18gwWszHTz4HeBNtBOtAaLqlRVL6PGBuPNU5BeVx5GyisqTHY60fhqNWVavsDVOPAMo",
    game: { areaId: "area_2", originX: 17, originY: -12 },
  },
  {
    id: "island3",
    name: "Magma Rift",
    code: "eJxNjkkSwEAIAm1lckz-_9uUOhu3Fgr5XksFIJtSODA2U4q4CXgyehCWLa98oQtim-VrCDx_XnX59UKZH9LsMnWS8B4dvXkNFX3_AW4kAOo",
    game: { areaId: "area_3", originX: -4, originY: -6 },
  },
  {
    id: "island4",
    name: "Core Island",
    code: "eJyVkFEKwzAMQ_1sZSco7P43HYm9Jt1KafURgpAl2dvbBsIeQT7_HgDdQ8WEBsViCiS5TEJzEpoy1J82p9kRlWNeAUNKd2wSRKSo1nHDokbX8lxwB_KVkdlkVoxeTqvQ5EK4HRE_fl-DvNrJVf-pW9hzP3STAU0",
    game: { areaId: "area_4", originX: 6, originY: -24 },
  },
  {
    id: "island5",
    name: "Mirror Expanse",
    code: "eNptkUESwCAIAwmBvqCn_v-hHVsUcchNAksGn1tSMEI6mRKGxgMAArBZYHQZpq7VyzmxtK_4MD9tBwo5WE6a_8tyBNQAjSk3LsujrOEqS2Tbg6ST8GJRRDOPfjnaM5VLVIeGszcDHcd2tgxRQHeCHI_uf-rxWwX0BezxAXc",
    game: { areaId: "area_5", originX: -18, originY: -14 },
  },
  {
    id: "island6",
    name: "Event Horizon",
    code: "eJyFkVESAyEIQ3kQe4b2_hftgOu6OnaazwdBgu-PXYKwo_Az_6PN1cfH3iKIMCPa5oZ8F-CJIwFKGwtVFRreC7iSS42p5GGqZcRaKC3wMf8HFuEdsRwvZmvuaiP3vU2NzMCjWtSv3HPQqzKpr7AeM69w-q8MNrhj06XZroNvV-_xc6840U1fE50Bjw",
    game: { areaId: "area_6", originX: -8, originY: -41 },
  },
  {
    id: "island7",
    name: "Entropy Isles",
    code: "eJx1kEEOwzAIBHfN0i_k0P__syI2tokbHxKJgRHs90I-0uTiB8cjSYsPa3kgngiAPEk7kCyZumYJN6Wy3tJvw2mJwuPEPuehZINoUx1LTIcArZXytqiEVVaQ9DiMg9hab-u_Z_xEmGFkGqOH_YaS4ZbYCsr7vZrqbazdxSQNUBQt_iVf0CLM3ph3JhZK68t77zD_xx5J_AClRwHO",
    game: { areaId: "area_7", originX: -40, originY: -35 },
  },
  {
    id: "island8",
    name: "Shadowspire",
    code: "eJytkl0OwCAIgy2UXWL3v-ciDPzL3kZionxqoXrfbQTb30F8ABCA7IJAHxE8qwFg2pnqoQNQ4qC29mL2ff2AGh2N_T1rAFNtukowhacsmVVesqSaAKJF8I6m8OKYh8DE7rZNOp6UKmVSYq4Lre24XTG91vLUSTpJGHSAuWtlkLXxZByEOJ40fTf3_sBWzR_PltdueeaaOwlDg3381tJ_ABV7Ago",
    game: { areaId: "area_8", originX: -29, originY: -62 },
  },
];

/**
 * The board every custom island starts from: 10x10, all grass. It is a normal
 * blueprint like any other, so nothing downstream needs a special case for it.
 */
export const BLANK_ISLAND_CODE = "eJzj4mKkAwAAHA4AeQ";

/** How many custom islands a user may keep at once. */
export const MAX_CUSTOM_ISLANDS = 5;
