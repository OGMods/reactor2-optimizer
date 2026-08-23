// vite.config.ts
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  plugins: [svelte()],
  base: "./", // Ensures relative paths work on GitHub Pages subpaths
  build: {
    outDir: "dist",
    assetsDir: "assets",
  },
});
