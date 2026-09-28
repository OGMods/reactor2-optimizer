import {
  Container,
  Graphics,
  Polygon,
  type FederatedPointerEvent,
  type Sprite,
} from "pixi.js";
import type { Tile, PlacedBuilding, TileType } from "../types";
import {
  gridToIso,
  TILE_WIDTH,
  TILE_HEIGHT,
  getIsoDepth,
} from "../utils/isoMath";
import {
  FRAME_KEYS,
  GROUND_TILING_FRAMES,
  TILE_IMAGE_MAP,
  createScaledSprite,
} from "./atlas";
import { placementStatus, type PlacementStatus } from "../data/placements";
import { pulseAlpha, STATUS_PULSE, type Pulse } from "./statusPulse";

/**
 * The selection accent, as Pixi wants it.
 *
 * This is the base theme's `--accent` in `src/app.css` (`#00f3ff`): the
 * board's hover highlight and the ghost pad under a restorable obstacle are
 * the canvas half of the same "this is selected" language every control in the
 * UI speaks. Pixi takes a numeric literal and cannot read a custom property,
 * so this is the one place the value is repeated — named here rather than
 * spelled out at the three call sites that had it inline, so a change to the
 * palette has somewhere to land.
 *
 * It is pinned to the *base* theme, and does not follow the one on the shell.
 * A theme is a rebinding of CSS custom properties, which is precisely what
 * Pixi cannot see, so these two marks stay cyan while the chrome around them
 * goes purple. They sit on the board rather than on the chrome, where the
 * board's own reserved language is likewise never themed — see the theme block
 * in `app.css` — so the mismatch reads as the board keeping its own colours
 * rather than as chrome that was missed.
 */
const ACCENT = 0x00f3ff;

/**
 * The pad drawn on the tile beneath a building, saying whether it is running.
 *
 * One colour per state, which is the whole point: `starved` and `idle` both
 * contribute nothing, but they are different problems with different fixes —
 * an overheating building needs a cooler, an idle one needs a neighbour. On a
 * shared red pad the board cannot say which it is without the player tapping
 * every tile.
 *
 * Red stays with the more urgent of the two, matching the board readout, where
 * Overheating is red and Idle is amber.
 */
const STATUS_FRAME: Record<PlacementStatus, string> = {
  active: FRAME_KEYS.indicatorNormal,
  starved: FRAME_KEYS.indicatorOverheat,
  idle: FRAME_KEYS.indicatorIdle,
};

/** A building sprite that breathes, and the shape of its breath. */
interface PulsingSprite {
  sprite: Sprite;
  pulse: Pulse;
}

/** A cleared obstacle offered back to the user, drawn as a ghost. */
export interface GhostObstacle {
  x: number;
  y: number;
  type: TileType;
}

export interface GridPainterCallbacks {
  onPointerDown: (x: number, y: number, event: FederatedPointerEvent) => void;
  onPointerOver: (x: number, y: number) => void;
  onPointerOut: (x: number, y: number) => void;
}

interface TileStateCache {
  tileType: string;
  islandFrameKey: string | null;
  waterFrameKey: string | null;
  propFrameKey: string | null;
  buildingFrameKey: string | null;
  /**
   * The status itself rather than the pad frame it resolves to. Two things now
   * read off it — the pad's colour and the building's pulse — and caching the
   * frame key would have left the second with nothing to key on.
   */
  status: PlacementStatus | null;
}

function isIslandTile(tile?: Tile): boolean {
  return !!tile && tile.type !== "water";
}

function getVariantIndex(x: number, y: number, count: number): number {
  const hash = Math.abs((x * 73856093) ^ (y * 19349663));
  return hash % count;
}

function getIslandFrameKey(grid: Tile[][], x: number, y: number): string {
  const hasTopLeft = isIslandTile(grid[y]?.[x - 1]);
  const hasTopRight = isIslandTile(grid[y - 1]?.[x]);

  let ruleId: keyof typeof GROUND_TILING_FRAMES;
  if (hasTopLeft && hasTopRight) ruleId = 1;
  else if (hasTopLeft && !hasTopRight) ruleId = 4;
  else if (!hasTopLeft && hasTopRight) ruleId = 0;
  else ruleId = 3;

  const variants = GROUND_TILING_FRAMES[ruleId];
  const index = getVariantIndex(x, y, variants.length);
  return variants[index];
}

function getWaterFrameKey(grid: Tile[][], x: number, y: number): string | null {
  if (!isIslandTile(grid[y]?.[x])) return null;
  const bottomLeftWater = !isIslandTile(grid[y + 1]?.[x]);
  const bottomRightWater = !isIslandTile(grid[y]?.[x + 1]);

  if (bottomLeftWater && bottomRightWater) return "tile_water_middle";
  if (bottomLeftWater) return "tile_water_left";
  if (bottomRightWater) return "tile_water_right";
  return null;
}

/**
 * One tile's isometric diamond, as flat `x, y` pairs from its top vertex
 * clockwise. Every outline the renderer draws is this same shape — the hover
 * highlight, each tile's hairline border, and the ghost pad under a restorable
 * obstacle — so it is stated once. Written out per call site it is four
 * chances for a tile's edges to stop meeting its neighbour's.
 *
 * Shared rather than copied per call: `Graphics.poly()` reads these points
 * into a `Polygon` of its own and does not hold or mutate the array. It is
 * typed `number[]` rather than `readonly` only because Pixi's signature
 * demands a mutable one — treat it as constant.
 */
const TILE_DIAMOND: number[] = [
  0,
  -TILE_HEIGHT / 2,
  TILE_WIDTH / 2,
  0,
  0,
  TILE_HEIGHT / 2,
  -TILE_WIDTH / 2,
  0,
];

/** The same diamond as a hit-area, so a tile is clickable where it is drawn. */
const diamondPolygon = new Polygon([...TILE_DIAMOND]);

export class GridRenderer {
  private gridContainer: Container;

  private islandContainer: Container;
  private gridLinesContainer: Container;
  private propsContainer: Container;
  private ghostContainer: Container;

  private hoverHighlight: Graphics;

  private islandTileNodes: (Container | null)[][] = [];
  private gridTileNodes: (Container | null)[][] = [];
  private propTileNodes: (Container | null)[][] = [];

  private stateCache: (TileStateCache | null)[][] = [];

  /** Identity of the ghosts currently drawn, so redraws are skipped. */
  private ghostKey = "";

  /**
   * The buildings currently breathing, keyed by tile so `renderTileVisuals`
   * can drop one before destroying its sprite. Empty on a board where
   * everything works, which is what makes `tick` free in the common case.
   */
  private pulsing = new Map<string, PulsingSprite>();

  /**
   * Whether failing buildings breathe. Pushed in by `PixiCanvas` from
   * `uiState.animations` — the renderer does not read the preference itself,
   * because the answer is the user's Settings choice *or* the system's
   * reduced-motion query, and deciding between those is the state layer's job.
   *
   * Defaults to on so a board built before the first push is not briefly
   * frozen; `PixiCanvas` sets the real value in the same tick it mounts.
   */
  private animate = true;

  constructor(gridContainer: Container) {
    this.gridContainer = gridContainer;

    // 1. Layer for Island Tiles & Water
    this.islandContainer = new Container();
    this.islandContainer.sortableChildren = true;

    // 2. Layer for Grid Lines, Indicators, & Hover
    this.gridLinesContainer = new Container();
    this.gridLinesContainer.sortableChildren = true;

    // 3. Layer for Buildings, Obstacles, & Props
    this.propsContainer = new Container();
    this.propsContainer.sortableChildren = true;
    this.propsContainer.eventMode = "none"; // Pass pointer events down to grid layer

    /*
     * 4. Layer for restore-mode ghosts.
     *
     * Its own container, above the props, rather than sharing the per-tile
     * prop nodes: those are cleared and rebuilt by `renderTileVisuals`
     * whenever a tile's state changes, which would silently wipe ghosts.
     * Drawing above everything is also what we want here — a ghost is a
     * call to action and should not end up behind a neighbouring tall prop.
     */
    this.ghostContainer = new Container();
    this.ghostContainer.sortableChildren = true;
    this.ghostContainer.eventMode = "none";

    // Insertion order is draw order: ground, then the interactive grid,
    // then props, then ghosts on top of everything.
    this.gridContainer.addChild(this.islandContainer);
    this.gridContainer.addChild(this.gridLinesContainer);
    this.gridContainer.addChild(this.propsContainer);
    this.gridContainer.addChild(this.ghostContainer);

    // Hover Highlight Overlay
    this.hoverHighlight = new Graphics();
    this.hoverHighlight
      .poly(TILE_DIAMOND)
      .fill({ color: ACCENT, alpha: 0.25 })
      .stroke({ width: 1.5, color: 0xffffff, alpha: 0.9 });

    this.hoverHighlight.visible = false;
    this.hoverHighlight.zIndex = 999999;
    this.hoverHighlight.eventMode = "none";

    this.gridLinesContainer.addChild(this.hoverHighlight);
  }

  public destroy(): void {
    this.clear();
    this.hoverHighlight.destroy({ children: true });
    this.islandContainer.destroy({ children: true });
    this.gridLinesContainer.destroy({ children: true });
    this.propsContainer.destroy({ children: true });
    this.ghostContainer.destroy({ children: true });
  }

  public clear(): void {
    const clearContainer = (container: Container) => {
      while (container.children.length > 0) {
        const child = container.children[0];
        if (child === this.hoverHighlight) {
          container.removeChild(child);
          continue;
        }
        container.removeChild(child);
        child.destroy({ children: true });
      }
    };

    clearContainer(this.islandContainer);
    clearContainer(this.gridLinesContainer);
    clearContainer(this.propsContainer);
    clearContainer(this.ghostContainer);
    this.ghostKey = "";

    this.islandTileNodes = [];
    this.gridTileNodes = [];
    this.propTileNodes = [];
    this.stateCache = [];
    this.pulsing.clear();
  }

  /** One-time setup of structural containers across all 3 layers */
  public buildGrid(
    grid: Tile[][],
    gridWidth: number,
    gridHeight: number,
    callbacks: GridPainterCallbacks,
  ): void {
    this.clear();

    this.islandTileNodes = Array.from({ length: gridHeight }, () => []);
    this.gridTileNodes = Array.from({ length: gridHeight }, () => []);
    this.propTileNodes = Array.from({ length: gridHeight }, () => []);
    this.stateCache = Array.from({ length: gridHeight }, () =>
      Array(gridWidth).fill(null),
    );

    for (let y = 0; y < gridHeight; y++) {
      for (let x = 0; x < gridWidth; x++) {
        const isoPos = gridToIso(x, y);
        const depth = getIsoDepth(x, y);

        // --- LAYER 1: Island Container Node ---
        const islandNode = new Container();
        islandNode.position.set(isoPos.x, isoPos.y);
        islandNode.zIndex = depth;
        islandNode.eventMode = "none";
        this.islandTileNodes[y][x] = islandNode;
        this.islandContainer.addChild(islandNode);

        // --- LAYER 2: Grid Container Node (Handles Interactions) ---
        const gridNode = new Container();
        gridNode.position.set(isoPos.x, isoPos.y);
        gridNode.zIndex = depth;
        gridNode.hitArea = diamondPolygon;
        gridNode.eventMode = "static";
        gridNode.cursor = "pointer";

        gridNode.on("pointerdown", (e: FederatedPointerEvent) =>
          callbacks.onPointerDown(x, y, e),
        );
        gridNode.on("pointerover", () => callbacks.onPointerOver(x, y));
        gridNode.on("pointerout", () => callbacks.onPointerOut(x, y));

        this.gridTileNodes[y][x] = gridNode;
        this.gridLinesContainer.addChild(gridNode);

        // --- LAYER 3: Props Container Node ---
        const propNode = new Container();
        propNode.position.set(isoPos.x, isoPos.y);
        propNode.zIndex = depth;
        propNode.eventMode = "none";
        this.propTileNodes[y][x] = propNode;
        this.propsContainer.addChild(propNode);
      }
    }

    this.gridLinesContainer.addChild(this.hoverHighlight);
    this.updateState(grid, gridWidth, gridHeight);
  }

  /** Updates only changed layers per cell using state diffing */
  public updateState(
    grid: Tile[][],
    gridWidth: number,
    gridHeight: number,
    placements: PlacedBuilding[] = [],
  ): void {
    // Map "x,y" coordinates to the placement itself for O(1) lookups — the
    // status pad needs its scored figures, not just which building it is.
    const placementMap = new Map<string, PlacedBuilding>();
    for (const p of placements) {
      placementMap.set(`${p.x},${p.y}`, p);
    }

    for (let y = 0; y < gridHeight; y++) {
      for (let x = 0; x < gridWidth; x++) {
        const tile = grid[y]?.[x];
        if (!tile) continue;

        const isLand = isIslandTile(tile);
        const placed = placementMap.get(`${x},${y}`) ?? null;

        const nextState: TileStateCache = {
          tileType: tile.type,
          islandFrameKey: isLand ? getIslandFrameKey(grid, x, y) : null,
          waterFrameKey: getWaterFrameKey(grid, x, y),
          propFrameKey: TILE_IMAGE_MAP[tile.type] || null,
          buildingFrameKey: placed?.buildingId ?? null,
          status: placed ? placementStatus(placed) : null,
        };

        const prevState = this.stateCache[y][x];

        if (
          prevState &&
          prevState.tileType === nextState.tileType &&
          prevState.islandFrameKey === nextState.islandFrameKey &&
          prevState.waterFrameKey === nextState.waterFrameKey &&
          prevState.propFrameKey === nextState.propFrameKey &&
          prevState.buildingFrameKey === nextState.buildingFrameKey &&
          prevState.status === nextState.status
        ) {
          continue;
        }

        this.stateCache[y][x] = nextState;
        this.renderTileVisuals(x, y, nextState);
      }
    }

    this.islandContainer.sortChildren();
    this.gridLinesContainer.sortChildren();
    this.propsContainer.sortChildren();
  }

  private renderTileVisuals(x: number, y: number, state: TileStateCache): void {
    const islandNode = this.islandTileNodes[y]?.[x];
    const gridNode = this.gridTileNodes[y]?.[x];
    const propNode = this.propTileNodes[y]?.[x];

    if (!islandNode || !gridNode || !propNode) return;

    const clearNode = (node: Container) => {
      while (node.children.length > 0) {
        const child = node.children[0];
        node.removeChild(child);
        child.destroy({ children: true });
      }
    };

    // Before the sprites go: this tile's building is about to be destroyed and
    // rebuilt, and a destroyed sprite left in the registry is a `tick` writing
    // alpha into freed memory.
    this.pulsing.delete(`${x},${y}`);

    clearNode(islandNode);
    clearNode(gridNode);
    clearNode(propNode);

    // 1. ISLAND & WATER LAYER
    if (state.islandFrameKey) {
      const islandSprite = createScaledSprite(state.islandFrameKey, 1.0);
      if (islandSprite) islandNode.addChild(islandSprite);

      if (state.waterFrameKey) {
        const waterSprite = createScaledSprite(state.waterFrameKey, 1.0);
        if (waterSprite) {
          const nextX = x + 1;
          const nextY = y + 1;
          const bottomPos = gridToIso(nextX, nextY);
          const waterWrapper = new Container();
          waterWrapper.position.set(
            bottomPos.x - islandNode.position.x,
            bottomPos.y - islandNode.position.y,
          );
          if (state.waterFrameKey === "tile_water_middle") {
            waterWrapper.position.y += 3.5;
          }
          waterWrapper.addChild(waterSprite);
          islandNode.addChild(waterWrapper);
        }
      }
    }

    // 2. GRID LINES LAYER
    if (state.islandFrameKey) {
      const indicatorSprite = createScaledSprite(
        FRAME_KEYS.indicatorBasicGrid,
        1.0,
      );
      if (indicatorSprite) gridNode.addChild(indicatorSprite);
    }

    /*
     * Status pad, on the tile rather than on the building: it lives in the
     * grid layer, so the building sprite in `propsContainer` draws over it and
     * the pad reads as the ground lighting up underneath.
     */
    if (state.status) {
      const statusSprite = createScaledSprite(
        STATUS_FRAME[state.status],
        1.18,
        0,
        -4,
      );
      if (statusSprite) gridNode.addChild(statusSprite);
    }

    const strokeBox = new Graphics();
    strokeBox
      .poly(TILE_DIAMOND)
      .fill({ color: 0x000000, alpha: 0.001 })
      .stroke({ width: 1.5, color: 0x000000, alpha: 0.2 });
    gridNode.addChild(strokeBox);

    // 3. BUILDINGS / OBSTACLES / PROPS LAYER
    if (state.propFrameKey) {
      const propSprite = createScaledSprite(
        state.propFrameKey,
        state.propFrameKey === "transformer" ? 2.0 : 1.0,
      );
      if (propSprite) propNode.addChild(propSprite);
    }

    // Draw placed building from atlas (atlas frame key === buildingId)
    if (state.buildingFrameKey) {
      const offsetY = -TILE_HEIGHT * 0.175;
      const offsetX = 0;
      const buildingSprite = createScaledSprite(
        state.buildingFrameKey,
        0.28,
        offsetX,
        offsetY,
      );
      if (buildingSprite) {
        propNode.addChild(buildingSprite);

        /*
         * A building that is not working breathes. Registered here rather than
         * driven from a per-sprite timer because `tick` walks one list once a
         * frame — and because the sprite is destroyed and rebuilt whenever its
         * tile changes, so the registry has to be rebuilt with it. The delete
         * at the top of this method is what keeps a destroyed sprite from
         * staying in the list.
         */
        const pulse = state.status ? STATUS_PULSE[state.status] : undefined;
        if (pulse) {
          // Registered either way. With animation off the sprite is simply
          // held at the floor of the breath it would otherwise take, and
          // keeping it in the registry is what lets `setAnimated(true)` start
          // it moving again without rebuilding the board.
          this.pulsing.set(`${x},${y}`, { sprite: buildingSprite, pulse });
          if (!this.animate) buildingSprite.alpha = pulse.minAlpha;
        }
      }
    }
  }

  /**
   * Advances every breathing building. Driven by the Pixi ticker — see
   * `PixiCanvas` — and does nothing at all on a board where everything works,
   * because only failing buildings are ever in the list.
   *
   * The curve itself is `pulseAlpha`; this is the walk that applies it.
   */
  public tick(elapsedMs: number): void {
    if (!this.animate || this.pulsing.size === 0) return;

    for (const { sprite, pulse } of this.pulsing.values()) {
      if (sprite.destroyed) continue;
      sprite.alpha = pulseAlpha(elapsedMs, pulse);
    }
  }

  /**
   * Turns the breathing on or off.
   *
   * Switching it **off settles every sprite at the floor** rather than letting
   * it freeze wherever the last frame left it: mid-breath is an arbitrary
   * opacity that says nothing, while the floor is the resting point of the
   * animation and still reads as "this one is not working". Turning it back on
   * needs no work — the next `tick` overwrites the alpha anyway.
   *
   * Idempotent, because the effect that drives it re-runs on any of its
   * dependencies changing, not only on this one.
   */
  public setAnimated(on: boolean): void {
    if (this.animate === on) return;
    this.animate = on;
    if (on) return;

    for (const { sprite, pulse } of this.pulsing.values()) {
      if (!sprite.destroyed) sprite.alpha = pulse.minAlpha;
    }
  }

  /**
   * Draws the cleared obstacles the user may put back, semi-transparent and
   * ringed in cyan so they read as an offer rather than as real terrain.
   *
   * Rebuilt wholesale rather than diffed per tile: the list is at most a
   * handful of tiles and only changes when the user restores one or leaves
   * restore mode, so the cheap correctness is worth more than the diff.
   */
  public setGhosts(ghosts: GhostObstacle[]): void {
    const key = ghosts.map((g) => `${g.x},${g.y},${g.type}`).join("|");
    if (key === this.ghostKey) return;
    this.ghostKey = key;

    while (this.ghostContainer.children.length > 0) {
      const child = this.ghostContainer.children[0];
      this.ghostContainer.removeChild(child);
      child.destroy({ children: true });
    }

    for (const ghost of ghosts) {
      const isoPos = gridToIso(ghost.x, ghost.y);
      const node = new Container();
      node.position.set(isoPos.x, isoPos.y);
      node.zIndex = getIsoDepth(ghost.x, ghost.y);
      node.eventMode = "none";

      // Cyan diamond underneath, so an empty grass tile still reads as a
      // target even where the sprite is small.
      const pad = new Graphics();
      pad
        .poly(TILE_DIAMOND)
        .fill({ color: ACCENT, alpha: 0.14 })
        .stroke({ width: 1.5, color: ACCENT, alpha: 0.75 });
      node.addChild(pad);

      const frameKey = TILE_IMAGE_MAP[ghost.type];
      if (frameKey) {
        const sprite = createScaledSprite(
          frameKey,
          frameKey === "transformer" ? 2.0 : 1.0,
        );
        if (sprite) {
          sprite.alpha = 0.45;
          node.addChild(sprite);
        }
      }

      this.ghostContainer.addChild(node);
    }

    this.ghostContainer.sortChildren();
  }

  public setHover(x: number | null, y: number | null): void {
    if (x === null || y === null) {
      this.hoverHighlight.visible = false;
      return;
    }
    const isoPos = gridToIso(x, y);
    this.hoverHighlight.position.set(isoPos.x, isoPos.y);
    this.hoverHighlight.visible = true;
  }
}
