/**
 * What a board saved as a picture is called.
 *
 * A PNG is the one form of a layout that carries no figures inside it, so the
 * name is where the power has to go — the same call `py_solver` makes for the
 * renders it writes into `solves/`. `utils/formatters.test.ts` pins the
 * spelling of the figure against that Python peer; this pins the name built
 * around it.
 */
import { describe, expect, it } from "vitest";

// `ui.svelte.ts` reaches the rest of the state layer, and the storage helpers
// under it are SSR-guarded on `typeof window`.
const store = new Map<string, string>();
(globalThis as { window?: unknown }).window = globalThis;
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
};

const { layoutImageFilename } = await import("./ui.svelte");

describe("the name a saved board gets", () => {
  it("carries the island and the power it puts out", () => {
    expect(layoutImageFilename("island3", 1.23456e16)).toBe(
      "reactor2-island-3-12AA-345T.png",
    );
  });

  /* Ids are what the name is built from, so a custom island keeps its slot. */
  it("keeps a custom island's slot number", () => {
    expect(layoutImageFilename("custom2", 5e6)).toBe(
      "reactor2-custom-2-5M.png",
    );
  });

  /*
   * Builds before custom islands were a list kept a single board under the id
   * "custom", and `layoutState` still adopts it rather than orphaning it.
   */
  it("handles the legacy un-numbered custom island", () => {
    expect(layoutImageFilename("custom", 1500)).toBe(
      "reactor2-custom-1K-500.png",
    );
  });

  /*
   * An empty board is a real thing to press this on — a fresh island, or one
   * where every building was cleared — and it names itself rather than
   * producing a file with a gap where the figure should be.
   */
  it("names an empty board zero rather than nothing", () => {
    expect(layoutImageFilename("island1", 0)).toBe("reactor2-island-1-0.png");
  });

  /*
   * Nothing that reaches a filesystem may carry what a filesystem rejects.
   * Ids are generated, so this is a backstop rather than a case in play — but
   * it is the difference between a download and a silent failure.
   */
  it("refuses to put anything but letters, digits and dashes in the name", () => {
    expect(layoutImageFilename("my island/2", 1000)).toBe(
      "reactor2-my-island-2-1K.png",
    );
    expect(layoutImageFilename("", 1000)).toBe("reactor2-island-1K.png");
  });
});
