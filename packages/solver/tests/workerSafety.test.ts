/**
 * Guards the one architectural boundary that actually matters: this whole
 * package has to be importable into a Web Worker.
 *
 * `TS_MIGRATION_V2.md` called for an ESLint `no-restricted-imports` rule, but
 * this project has no ESLint toolchain at all — adding one (eslint,
 * typescript-eslint, eslint-plugin-svelte, a flat config, a script) to carry a
 * single rule is a lot of surface for the result. Vitest is already installed
 * and `fixtures.test.ts` already reads the filesystem, so the same rule is
 * enforced here instead. It runs in `npm test` and it can check things
 * `no-restricted-imports` cannot: bare package specifiers, `.svelte` imports,
 * and dynamic `import()`.
 *
 * Two rules, and they are different questions:
 *
 * - **Nothing under `src/` may import a bare specifier or a `.svelte` file.**
 *   The package declares no dependencies and the web app loads it inside a
 *   worker; either would break that. This is what the package boundary is for,
 *   and it is now enforced by the manifest as well — but a manifest is a claim
 *   and this is a check.
 * - **`src/solver/` may reach only into itself and `src/data/`.** The engine
 *   works in resolved `EffectiveBuilding`s and tile indices; it has no business
 *   knowing the wire format a board arrived in or how a number is spelled for a
 *   filename. Keeping that one-way lets the codec and the formatters change
 *   without anyone having to think about the search.
 *
 * Two deliberate exemptions:
 * - **`tests/`** — this file and `fixtures.test.ts` legitimately use `node:fs`
 *   and vitest, and `bin/` and `scripts/` are Node programs by definition.
 *   Nothing imports any of them, so they never reach the worker bundle. Only
 *   `src/` is scanned.
 * - **`pacer.ts` is NOT exempt from this scan, and does not need to be.** It
 *   touches `MessageChannel` / `setTimeout` / `performance.now()` by design,
 *   but those are globals, not imports. This package is *worker-safe*, not
 *   environment-free — see docs/SOLVER.md.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src");

/** Folders under `src/` that `src/solver/` is allowed to reach into. */
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
 *
 * `from` is the importing module's path relative to `src/`, because the second
 * rule is about where the import is *written*, not only what it names.
 */
export function violationFor(specifier: string, from: string): string | null {
  if (specifier.endsWith(".svelte")) {
    return "imports a Svelte component";
  }
  if (!specifier.startsWith(".")) {
    return "imports a bare package specifier (this package must have no runtime deps)";
  }
  if (!from.startsWith("solver/")) {
    return null;
  }
  if (specifier.startsWith("./")) {
    return null; // within src/solver/
  }
  const sibling = /^\.\.\/([^/]+)/.exec(specifier)?.[1];
  if (sibling === undefined) {
    return "escapes src/ entirely";
  }
  if (!ALLOWED_SIBLING_FOLDERS.includes(sibling)) {
    return `reaches into src/${sibling}/, which the engine may not depend on`;
  }
  return null;
}

/** Every `.ts` under `src/`, as a `/`-joined path relative to `src/`. */
function sourceFiles(dir = SRC_DIR, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory())
      found.push(...sourceFiles(join(dir, entry.name), rel));
    else if (entry.name.endsWith(".ts")) found.push(rel);
  }
  return found;
}

describe("worker safety", () => {
  it("finds the source files to scan", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain("solver/placementSearch.ts");
    expect(files).toContain("solver/pacer.ts");
    expect(files).toContain("encoding/blueprint.ts");
  });

  it.each(sourceFiles())("%s imports nothing worker-unsafe", (file) => {
    const source = readFileSync(join(SRC_DIR, file), "utf8");
    const violations = extractSpecifiers(source)
      .map((s) => ({ specifier: s, reason: violationFor(s, file) }))
      .filter((v) => v.reason !== null)
      .map((v) => `${file}: "${v.specifier}" ${v.reason}`);

    expect(violations).toEqual([]);
  });

  it("flags the imports the rule exists to catch", () => {
    const from = "solver/placementSearch.ts";
    expect(violationFor("../pixi/atlas", from)).toMatch(/src\/pixi/);
    expect(violationFor("../state/uiState.svelte", from)).toMatch(
      /Svelte component/,
    );
    expect(violationFor("../encoding/blueprint", from)).toMatch(
      /src\/encoding/,
    );
    expect(violationFor("../utils/formatters", from)).toMatch(/src\/utils/);
    expect(violationFor("pixi.js", from)).toMatch(/bare package/);
    // A bare specifier is refused wherever it is written, not only in solver/.
    expect(violationFor("pako", "encoding/blueprint.ts")).toMatch(
      /bare package/,
    );
  });

  it("allows what each layer legitimately needs", () => {
    expect(violationFor("./types", "solver/placementSearch.ts")).toBeNull();
    expect(violationFor("./constants", "solver/island.ts")).toBeNull();
    expect(
      violationFor("../data/effectiveBuildings", "solver/solver.ts"),
    ).toBeNull();
    // Outside the engine, the layering rule does not apply: the codec reads the
    // building table and the barrel reaches everywhere by design.
    expect(
      violationFor("../data/buildings", "encoding/blueprint.ts"),
    ).toBeNull();
    expect(violationFor("./encoding/blueprint", "index.ts")).toBeNull();
  });

  it("scans pacer.ts rather than exempting it", () => {
    // pacer.ts uses MessageChannel/setTimeout/performance.now() — globals, not
    // imports — so it passes the same scan every other module does.
    const source = readFileSync(join(SRC_DIR, "solver/pacer.ts"), "utf8");
    expect(source).toMatch(/MessageChannel/);
    expect(
      extractSpecifiers(source).filter(
        (s) => violationFor(s, "solver/pacer.ts") !== null,
      ),
    ).toEqual([]);
  });
});
