/**
 * `@reactor2/solver` — the game's rules, its roster, and a search over them.
 *
 * One entry point, deliberately. The tempting split was a narrow `.` for the
 * engine and subpaths for the wire format, the shipped maps and the number
 * ladder — but every one of those is part of "solve a board headlessly", the
 * app imports several of them in the same breath, and a bundler drops what a
 * given consumer does not reach anyway. Two spellings for one module is a
 * thing to get wrong; one is not.
 *
 * What this package must NOT acquire is a dependency on a browser framework:
 * the web app runs it inside a Web Worker, so no DOM library, no Svelte, no
 * Pixi and no npm package at all. `tests/workerSafety.test.ts` scans for that
 * and fails on it. Platform *globals* are fair game and used on purpose —
 * `CompressionStream` in the codec, `MessageChannel` and `performance` in the
 * pacer — because Node and the browser both have them.
 */

export * from "./solver/types";
export * from "./solver/constants";
export * from "./solver/rng";
export * from "./solver/island";
export * from "./solver/physics";
export * from "./solver/context";
export * from "./solver/simulate";
export * from "./solver/placementSearch";
export * from "./solver/alternates";
export * from "./solver/report";
export * from "./solver/solver";

export * from "./data/buildings";
export * from "./data/effectiveBuildings";
export * from "./data/maps";

export * from "./encoding/blueprint";
export * from "./utils/formatters";

export * from "./grid";
