import type { IslandTemplate } from "../types/building";

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
  },
  {
    id: "island2",
    name: "Ash Bay",
    code: "eJx1jkEOgDAIBDsseDT-_7WmVBqMcU8MJMOe18gwWszHTz4HeBNtBOtAaLqlRVL6PGBuPNU5BeVx5GyisqTHY60fhqNWVavsDVOPAMo",
  },
  {
    id: "island3",
    name: "Magma Rift",
    code: "eJxNjkkSwEAIAm1lckz-_9uUOhu3Fgr5XksFIJtSODA2U4q4CXgyehCWLa98oQtim-VrCDx_XnX59UKZH9LsMnWS8B4dvXkNFX3_AW4kAOo",
  },
  {
    id: "island4",
    name: "Core Island",
    code: "eJyVkFEKwzAMQ_1sZSco7P43HYm9Jt1KafURgpAl2dvbBsIeQT7_HgDdQ8WEBsViCiS5TEJzEpoy1J82p9kRlWNeAUNKd2wSRKSo1nHDokbX8lxwB_KVkdlkVoxeTqvQ5EK4HRE_fl-DvNrJVf-pW9hzP3STAU0",
  },
  {
    id: "island5",
    name: "Mirror Expanse",
    code: "eJxtkVESgCAIRFkWOkFf3f-gTQmiBV-Ob3kwep1SBSOkK1PC0DAAIADLC0bKkHXMLLNj1jri1QzbKhTycTlpPoZVC6gherrcOJHHtQbVQmn_L7HIN0QRrX303aN9pu0ldkLDN1sL7cSca66OCmhrj1j3P_PAP0w0pDftPwF3",
  },
  {
    id: "island6",
    name: "Event Horizon",
    code: "eJyFkVESAyEIQ3kQe4b2_hftgOu6OnaazwdBgu-PXYKwo_Az_6PN1cfH3iKIMCPa5oZ8F-CJIwFKGwtVFRreC7iSS42p5GGqZcRaKC3wMf8HFuEdsRwvZmvuaiP3vU2NzMCjWtSv3HPQqzKpr7AeM69w-q8MNrhj06XZroNvV-_xc6840U1fE50Bjw",
  },
  {
    id: "island7",
    name: "Entropy Isles",
    code: "eJx1kEEOwzAIBHfN0i_k0P__syI2tokbHxKJgRHs90I-0uTiB8cjSYsPa3kgngiAPEk7kCyZumYJN6Wy3tJvw2mJwuPEPuehZINoUx1LTIcArZXytqiEVVaQ9DiMg9hab-u_Z_xEmGFkGqOH_YaS4ZbYCsr7vZrqbazdxSQNUBQt_iVf0CLM3ph3JhZK68t77zD_xx5J_AClRwHO",
  },
  {
    id: "island8",
    name: "Shadowspire",
    code: "eJytkl0OwCAIgy2UXWL3v-ciDPzL3kZionxqoXrfbQTb30F8ABCA7IJAHxE8qwFg2pnqoQNQ4qC29mL2ff2AGh2N_T1rAFNtukowhacsmVVesqSaAKJF8I6m8OKYh8DE7rZNOp6UKmVSYq4Lre24XTG91vLUSTpJGHSAuWtlkLXxZByEOJ40fTf3_sBWzR_PltdueeaaOwlDg3381tJ_ABV7Ago",
  },
];

/**
 * The board every custom island starts from: 10x10, all grass. It is a normal
 * blueprint like any other, so nothing downstream needs a special case for it.
 */
export const BLANK_ISLAND_CODE = "eJzj4mKkAwAAHA4AeQ";

/** How many custom islands a user may keep at once. */
export const MAX_CUSTOM_ISLANDS = 5;
