/**
 * Guards the one architectural boundary that actually matters: everything in
 * `lib/solver/` has to be importable into a Web Worker.
 *
 * `TS_MIGRATION_V2.md` called for an ESLint `no-restricted-imports` rule, but
 * this project has no ESLint toolchain at all — adding one (eslint,
 * typescript-eslint, eslint-plugin-svelte, a flat config, a script) to carry a
 * single rule is a lot of surface for the result. Vitest is already installed
 * and `parity.test.ts` already reads the filesystem, so the same rule is
 * enforced here instead. It runs in `npm test` and it can check things
 * `no-restricted-imports` cannot: bare package specifiers, `.svelte` imports,
 * and dynamic `import()`.
 *
 * The rule: a module under `lib/solver/` may import from `lib/solver/` itself
 * and from `lib/data/` (pure definition tables, no DOM). Nothing else — no
 * `worker/`, `pixi/`, `storage/`, `encoding/`, `states/`, `components/`,
 * `simulation/`, no npm package, no `.svelte`.
 *
 * Two deliberate exemptions:
 * - **`*.test.ts`** — `parity.test.ts` and `rng.parity.test.ts` live in this
 *   folder and legitimately use `node:fs` and vitest. Nothing imports them, so
 *   they never reach the worker bundle.
 * - **`pacer.ts` is NOT exempt from this scan, and does not need to be.** It
 *   touches `MessageChannel` / `setTimeout` / `performance.now()` by design,
 *   but those are globals, not imports. `lib/solver/` is *worker-safe*, not
 *   environment-free — see docs/PARITY.md divergence 2.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOLVER_DIR = dirname(fileURLToPath(import.meta.url));

/** Sibling `lib/` folders a solver module is allowed to reach into. */
const ALLOWED_SIBLING_FOLDERS = ["data"];

/** Every import/export specifier in a module, including dynamic `import()`. */
function extractSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  // `import … from "x"`, `export … from "x"`
  for (const m of source.matchAll(/\bfrom\s*["']([^"']+)["']/g))
    specifiers.push(m[1]);
  // side-effect `import "x"`
  for (const m of source.matchAll(/\bimport\s+["']([^"']+)["']/g))
    specifiers.push(m[1]);
  // dynamic `import("x")`
  for (const m of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g))
    specifiers.push(m[1]);
  return specifiers;
}

/**
 * Returns a reason string if `specifier` breaks worker safety, else `null`.
 * Exported shape kept tiny so the rule itself can be unit-tested below.
 */
export function violationFor(specifier: string): string | null {
  if (specifier.endsWith(".svelte")) {
    return "imports a Svelte component";
  }
  if (!specifier.startsWith(".")) {
    return "imports a bare package specifier (solver code must have no runtime deps)";
  }
  if (specifier.startsWith("./")) {
    return null; // within lib/solver/
  }
  const sibling = /^\.\.\/([^/]+)/.exec(specifier)?.[1];
  if (sibling === undefined) {
    return `escapes lib/ entirely`;
  }
  if (!ALLOWED_SIBLING_FOLDERS.includes(sibling)) {
    return `reaches into lib/${sibling}/, which is not worker-safe`;
  }
  return null;
}

function solverSourceFiles(): string[] {
  return readdirSync(SOLVER_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort();
}

describe("worker safety", () => {
  it("finds the solver source files to scan", () => {
    const files = solverSourceFiles();
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain("placementSearch.ts");
    expect(files).toContain("pacer.ts");
  });

  it.each(solverSourceFiles())("%s imports nothing worker-unsafe", (file) => {
    const source = readFileSync(join(SOLVER_DIR, file), "utf8");
    const violations = extractSpecifiers(source)
      .map((s) => ({ specifier: s, reason: violationFor(s) }))
      .filter((v) => v.reason !== null)
      .map((v) => `${file}: "${v.specifier}" ${v.reason}`);

    expect(violations).toEqual([]);
  });

  it("flags the imports the rule exists to catch", () => {
    expect(violationFor("../pixi/atlas")).toMatch(/lib\/pixi/);
    expect(violationFor("../states/uiState.svelte")).toMatch(
      /Svelte component/,
    );
    expect(violationFor("../worker/workerClient")).toMatch(/lib\/worker/);
    expect(violationFor("../components/canvas/PixiCanvas.svelte")).toMatch(
      /Svelte component/,
    );
    expect(violationFor("../storage/storage")).toMatch(/lib\/storage/);
    expect(violationFor("../encoding/blueprint")).toMatch(/lib\/encoding/);
    expect(violationFor("../simulation/simulator")).toMatch(/lib\/simulation/);
    expect(violationFor("pixi.js")).toMatch(/bare package/);
  });

  it("allows what the solver legitimately needs", () => {
    expect(violationFor("./types")).toBeNull();
    expect(violationFor("./constants")).toBeNull();
    expect(violationFor("../data/effectiveBuildings")).toBeNull();
  });

  it("scans pacer.ts rather than exempting it", () => {
    // pacer.ts uses MessageChannel/setTimeout/performance.now() — globals, not
    // imports — so it passes the same scan every other solver module does.
    const source = readFileSync(join(SOLVER_DIR, "pacer.ts"), "utf8");
    expect(source).toMatch(/MessageChannel/);
    expect(
      extractSpecifiers(source).filter((s) => violationFor(s) !== null),
    ).toEqual([]);
  });
});
