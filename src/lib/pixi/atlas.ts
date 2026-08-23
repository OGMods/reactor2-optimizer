import { Assets, Texture, Spritesheet, Sprite } from "pixi.js";
import { PIXELS_PER_WORLD_UNIT } from "../utils/isoMath";
import { asset } from "../utils/assetUrl";
import type { TileType } from "../types";

/** Which atlas frame draws the prop sitting on each obstacle tile. */
export const TILE_IMAGE_MAP: Partial<Record<TileType, string>> = {
  rock: "rocks",
  tree1: "trees1",
  tree2: "trees2",
  pond: "pond",
  transformer: "transformer",
};

export const FRAME_KEYS = {
  indicatorBasicGrid: "indicator_grid",
  indicatorNormal: "indicator_normal",
  indicatorOverheat: "indicator_overheat",
  indicatorIdle: "indicator_idle",
} as const;

export const GROUND_TILING_FRAMES = {
  // m_Id: 3 -> Both (0,1) and (1,0) are land
  3: ["tile_ground_0_v0", "tile_ground_0_v1", "tile_ground_0_v2"],
  // m_Id: 1 -> Both (0,1) and (1,0) are NOT land
  1: ["tile_ground_1_v0", "tile_ground_1_v1", "tile_ground_1_v2"],
  // m_Id: 0 -> (0,1) is NOT land
  0: ["tile_ground_3_v0", "tile_ground_3_v1", "tile_ground_3_v2"],
  // m_Id: 4 -> (1,0) is NOT land
  4: ["tile_ground_2_v0", "tile_ground_2_v1", "tile_ground_2_v2"],
} as const;

let spritesheet: Spritesheet | null = null;
const textureCache: Record<string, Texture> = {};

/** The atlas description, and through `meta.image` the sheet beside it. */
const ATLAS_JSON = "data/web_atlas.json";

/**
 * The one in-flight (or fulfilled) load, so every caller shares a single fetch.
 *
 * The sheet is ~1MB, and asking for it at the *end* of a serial chain —
 * bundle, `hydrateState()`, mount, `Application.init()` — makes the largest
 * thing the app downloads the last thing it starts downloading, with no board
 * until it lands. Memoising the promise is what lets `main.ts` start it the
 * moment the entry module runs (see `preloadAtlas`) while `PixiCanvas` still
 * writes a plain `await loadAtlas()` and gets the same load rather than a
 * second one.
 *
 * A *rejection* is deliberately not memoised — see `preloadAtlas`.
 */
let atlasLoad: Promise<void> | null = null;

/**
 * Starts the atlas download without waiting for it.
 *
 * Called from `main.ts` before `hydrateState()`, so the fetch overlaps
 * hydration, mount and WebGL context creation instead of queueing behind them.
 * Safe to call before an `Application` exists: `Assets.load` initialises itself
 * on first use, and a `Texture` is renderer-agnostic until something draws it.
 *
 * The memo is dropped if the load fails, so the next caller starts a fresh
 * attempt rather than being handed the failure. That matters precisely because
 * the first call is speculative: it is made from the entry module with nothing
 * yet on screen and nothing waiting on it, so a connection that has not come up
 * yet would otherwise poison the load the board actually needs a moment later —
 * turning a transient failure into a permanently empty board for the session.
 * Whoever is already awaiting the failed attempt still sees it fail; retrying is
 * for the caller that comes after.
 */
export function preloadAtlas(): Promise<void> {
  atlasLoad ??= fetchAtlas().catch((err) => {
    atlasLoad = null;
    throw err;
  });
  return atlasLoad;
}

/**
 * Loads the JSON atlas and its corresponding texture sheet into PixiJS memory.
 *
 * Idempotent, and deliberately so — the caller that needs the sheet awaits it
 * whether or not `preloadAtlas` already started it.
 */
export function loadAtlas(): Promise<void> {
  return preloadAtlas();
}

async function fetchAtlas(): Promise<void> {
  const jsonUrl = asset(ATLAS_JSON);
  const response = await fetch(jsonUrl);
  const atlasData = await response.json();

  // `meta.image` is authored relative to `public/` ("data/web_atlas.webp"), so
  // it goes through asset() like every other runtime path -- see assetUrl.ts.
  // Handing it to Assets.load() raw resolves it against the *page* URL, which
  // is the same thing only for as long as the app is served from its own
  // directory with a trailing slash.
  const imagePath = asset(atlasData.meta?.image ?? "data/web_atlas.webp");
  const texture: Texture = await Assets.load(imagePath);

  spritesheet = new Spritesheet(texture, atlasData);
  await spritesheet.parse();

  Object.values(FRAME_KEYS).forEach((frameName) => {
    if (spritesheet?.textures[frameName]) {
      textureCache[frameName] = spritesheet.textures[frameName];
    }
  });

  Object.values(TILE_IMAGE_MAP).forEach((frameName) => {
    if (frameName && spritesheet?.textures[frameName]) {
      textureCache[frameName] = spritesheet.textures[frameName];
    }
  });

  Object.values(GROUND_TILING_FRAMES).forEach((variants) => {
    variants.forEach((frameName) => {
      if (spritesheet?.textures[frameName]) {
        textureCache[frameName] = spritesheet.textures[frameName];
      }
    });
  });
}

/**
 * Retrieves a cached texture by frame key. Internal: every caller goes through
 * `createScaledSprite`, which is what applies the atlas's pivot and scale.
 */
function getTexture(frameName: string): Texture | undefined {
  return textureCache[frameName] ?? spritesheet?.textures[frameName];
}

/**
 * Creates and scales a sprite relative to world grid units (where 1 Unit = TILE_WIDTH pixels).
 * PixiJS automatically applies the Unity Pivot/Anchor from the atlas JSON.
 */
export function createScaledSprite(
  frameKey: string,
  worldUnitMultiplier: number = 1.0,
  offsetX: number = 0,
  offsetY: number = 0,
): Sprite | null {
  const texture = getTexture(frameKey);
  if (!texture) return null;

  const sprite = new Sprite(texture);
  const frameData = (spritesheet?.data.frames as any)?.[frameKey];

  const ptu = frameData?.pixelsToUnits ?? 256;

  const scaleFactor = (PIXELS_PER_WORLD_UNIT / ptu) * worldUnitMultiplier;
  sprite.scale.set(scaleFactor);

  if (offsetX !== 0 || offsetY !== 0) {
    sprite.position.set(offsetX, offsetY);
  }

  return sprite;
}
