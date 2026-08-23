/**
 * Public surface of the solver engine. Peer: `py_solver/solver/__init__.py`.
 *
 * Only solver-owned modules are re-exported here. `worker/` and `data/` are
 * deliberately NOT re-exported: `lib/solver/` must stay free of DOM, Worker,
 * Svelte and Pixi imports (see docs/PARITY.md divergence 2), and a barrel that
 * pulled `workerClient` back in would break that quietly. Import those from
 * `../worker/workerClient` and `../data/effectiveBuildings` directly.
 */

export * from "./types";
export * from "./constants";
export * from "./rng";
export * from "./island";
export * from "./simulate";
export * from "./placementSearch";
export * from "./alternates";
export * from "./report";
export * from "./solver";
