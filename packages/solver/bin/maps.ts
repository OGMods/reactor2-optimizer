/**
 * The boards this CLI can solve: the islands the app itself ships.
 *
 * This used to read a second table, kept by the reference solver, so that its
 * figures were comparable with that solver's. The two tables had drifted —
 * same landmasses, far fewer obstacles on the other side — so a figure from
 * one was not a figure from the other, and the CLI did not solve the boards
 * the app ships, which is a strange thing for the app's own CLI to do.
 *
 * There is one table left now, and this reads it: `ISLAND_TEMPLATES`, the same
 * codes the app loads. A figure printed here is a figure about a board a
 * player can actually open.
 */

import { BLANK_ISLAND_CODE, ISLAND_TEMPLATES } from "../src/data/maps";

export interface CliMap {
  num: number;
  name: string;
  code: string;
}

/**
 * `island3` -> 3. The ids are the app's identity for a board and the numbers
 * are what `--map` takes, so the mapping is spelled once here rather than
 * maintained as a second table.
 */
function numberOf(id: string): number {
  const match = /(\d+)$/.exec(id);
  if (!match) throw new Error(`island id "${id}" does not end in a number`);
  return Number(match[1]);
}

/**
 * Map 0 is the blank 10x10 board every custom island starts from — the same
 * slot the reference solver gave its own small "custom" board, and a useful
 * thing to have when you want a quick run rather than a real island.
 */
export const MAPS: CliMap[] = [
  { num: 0, name: "blank", code: BLANK_ISLAND_CODE },
  ...ISLAND_TEMPLATES.map((template) => ({
    num: numberOf(template.id),
    name: template.name,
    code: template.code,
  })),
];

export const MAPS_BY_NUM = new Map(MAPS.map((m) => [m.num, m]));

export const DEFAULT_MAP_NUM = 1;
