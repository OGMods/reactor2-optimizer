// vite.config.ts
import { defineConfig, type Plugin } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

/*
 * One id per build, baked into the bundle as `import.meta.env.VITE_APP_BUILD` and written beside
 * it as `version.json`. A page compares the two to learn that a deploy has
 * replaced the files it was loaded with — see `lib/utils/appUpdate.ts`. Every
 * asset name is content-hashed and a Pages deploy replaces the whole site, so
 * a page older than the deploy points at a worker script that is gone.
 */
const BUILD_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function buildVersionFile(): Plugin {
  return {
    name: "build-version-file",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({ build: BUILD_ID }),
      });
    },
  };
}

export default defineConfig({
  plugins: [svelte(), buildVersionFile()],
  base: "./", // Ensures relative paths work on GitHub Pages subpaths
  define: {
    "import.meta.env.VITE_APP_BUILD": JSON.stringify(BUILD_ID),
  },
  build: {
    outDir: "dist",
    assetsDir: "assets",
  },
});
