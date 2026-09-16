import { defineConfig } from "vite";

/**
 * The publishable build. Named `vite.build.config.ts` rather than
 * `vite.config.ts` because this package ships no dev server, and a file by the
 * usual name is picked up by every tool that goes looking for one — starting
 * with `svelte-check`, which then reports the package for not configuring a
 * Svelte plugin it has no business having.
 *
 * Nothing in this repository consumes its output — the web app and the tests
 * import `src/` directly through the workspace link, which is what keeps
 * `npm run dev` free of a build step.
 *
 * It exists so the package can actually be published, and CI runs it so that
 * claim does not rot. Rollup is what resolves the extensionless relative
 * imports the source is written with into the explicit specifiers Node's ESM
 * loader requires; `tsc -p tsconfig.build.json` emits the declarations beside
 * the output.
 */
export default defineConfig({
  build: {
    outDir: "dist",
    target: "es2023",
    minify: false,
    lib: {
      entry: {
        index: "src/index.ts",
        "bin/solve": "bin/solve.ts",
        // A separate entry, not a chunk: the pool loads it by URL at run time,
        // so nothing imports it and a bundler would otherwise drop it.
        "bin/worker": "bin/worker.ts",
      },
      formats: ["es"],
    },
    rollupOptions: {
      // The CLI is the only thing here that touches Node's own modules, and it
      // must not be inlined into a bundle the browser also loads.
      external: [/^node:/],
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
      },
    },
  },
});
