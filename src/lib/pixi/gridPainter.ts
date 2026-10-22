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
import type { BoardLink } from "../simulation/simulator";
import { pulseAlpha, STATUS_PULSE, type Pulse } from "./statusPulse";
import { createStatusBadge } from "./statusBadge";
import { createIconSprite } from "./atlas";
import type { BoardIcon } from "../data/boardIcons";

/**
 * Where a badge sits over its building, in world pixels from the tile's
 * centre: on the front of the building, low enough that it does not cover the
 * roof of the one behind — where the game puts its own.
 */
const BADGE_OFFSET_Y = -TILE_HEIGHT * 0.55;

/**
 * Where the game's two building icons sit, and how wide, in world pixels from
 * the tile's centre.
 *
 * Taken from the building prefab: `anomalyIcon` at (0, -0.073) and the
 * not-working icon at (0.19, 0.118) under the building's visual root, at
 * scales 0.12 and 0.15 of 128px / 102px art authored at 100px per unit. That
 * puts the anomaly icon at the building's foot — the tile's front corner on
 * screen — and the state icon up and to the right of its body. Converted at
 * `PIXELS_PER_WORLD_UNIT`. `ICON_SCALE` is the knob for sizing them all at
 * once; at 1 they are the size the prefab authors.
 */
const ICON_SCALE = 1.0;
const ANOMALY_ICON = { x: 0, y: TILE_HEIGHT * 0.18, width: 31 * ICON_SCALE };
const STATE_ICON_POS = {
  x: TILE_WIDTH * 0.24,
  y: -TILE_HEIGHT * 0.3,
  width: 31 * ICON_SCALE,
};

/**
 * What the painter draws over one building beyond its sprite and pad: the fill
 * badge's figure, the anomaly icon at its foot and the state icon beside it.
 * All are worked out by the caller — they come off the scorer and the board
 * around the building, and neither is the renderer's job.
 */
export interface BuildingOverlay {
  /** The badge's figure, or null for no badge. */
  fill: number | null;
  anomalyIcon: BoardIcon | null;
  /** The game's state icon (`STATE_ICON`), or null over a working building. */
  stateIcon: BoardIcon | null;
}

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

/**
 * The lines from the inspected building to the ones it works with, drawn the
 * way the game draws its own: a dashed line along the ground, in the board's
 * "this is selected" cyan, on a dark track so it still reads across grass.
 *
 * The dashes march from supplier to receiver at `LINK_SPEED` world px/s, so the
 * line says which way the heat or cooling goes without a label. With animation
 * off they stand still and the line is simply a line.
 */
const LINK_DASH = 12;
const LINK_GAP = 9;
const LINK_SPEED = 28;
const LINK_WIDTH = 4;
/**
 * The dark band the dashes run along. Cyan alone has almost no contrast with
 * the grass and the green and amber status pads it crosses, so the line sat
 * invisible beside exactly the buildings with something to say; a dark track
 * under it reads on every ground the board has.
 */
const LINK_TRACK_WIDTH = 10;
const LINK_TRACK = 0x0b1f3a;
/**
 * How strongly a link further out along the chain draws against one touching
 * the focus — see `uiState.chainLinks`. Visible, but a step behind.
 */
const LINK_CHAIN_STRENGTH = 0.75;

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
  /** The badge's figure, or null for no badge. */
  fill: number | null;
  anomalyIcon: BoardIcon | null;
  /** The game's state icon (`STATE_ICON`), or null over a working building. */
  stateIcon: BoardIcon | null;
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
  private badgeContainer: Container;

  private hoverHighlight: Graphics;

  /** See `setLinks`. Its own layer, so `clear()` never touches it. */
  private linkGraphics: Graphics;
  private links: BoardLink[] = [];
  private linkKey = "";

  private islandTileNodes: (Container | null)[][] = [];
  private gridTileNodes: (Container | null)[][] = [];
  private propTileNodes: (Container | null)[][] = [];
  private badgeTileNodes: (Container | null)[][] = [];

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

    /*
     * 5. Layer for building overlays: status icons and fill badges.
     *
     * Above the props rather than inside each tile's prop node: a badge is
     * wider than its tile, and in a prop node the building in front would
     * draw over the badge of the one behind. Depth-sorted among themselves so
     * that, where two do overlap, the nearer one wins as it does in the game.
     */
    this.badgeContainer = new Container();
    this.badgeContainer.sortableChildren = true;
    this.badgeContainer.eventMode = "none";

    // Insertion order is draw order: ground, then the interactive grid,
    // then props, then badges, then ghosts on top of everything.
    this.gridContainer.addChild(this.islandContainer);
    this.gridContainer.addChild(this.gridLinesContainer);
    // Partner lines lie on the ground: over the pads, under the buildings.
    this.linkGraphics = new Graphics();
    this.linkGraphics.eventMode = "none";
    this.gridContainer.addChild(this.linkGraphics);
    this.gridContainer.addChild(this.propsContainer);
    this.gridContainer.addChild(this.badgeContainer);
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
    this.linkGraphics.destroy();
    this.islandContainer.destroy({ children: true });
    this.gridLinesContainer.destroy({ children: true });
    this.propsContainer.destroy({ children: true });
    this.ghostContainer.destroy({ children: true });
    this.badgeContainer.destroy({ children: true });
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
    clearContainer(this.badgeContainer);
    this.ghostKey = "";

    this.islandTileNodes = [];
    this.gridTileNodes = [];
    this.propTileNodes = [];
    this.badgeTileNodes = [];
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
    this.badgeTileNodes = Array.from({ length: gridHeight }, () => []);
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

        // --- LAYER 5: Badge Container Node ---
        const badgeNode = new Container();
        badgeNode.position.set(isoPos.x, isoPos.y);
        badgeNode.zIndex = depth;
        badgeNode.eventMode = "none";
        this.badgeTileNodes[y][x] = badgeNode;
        this.badgeContainer.addChild(badgeNode);
      }
    }

    this.gridLinesContainer.addChild(this.hoverHighlight);
    this.updateState(grid, gridWidth, gridHeight);
  }

  /**
   * Updates only changed layers per cell using state diffing.
   *
   * `overlays` is aligned with `placements` — each one's badge figure and
   * anomaly icon (see `BuildingOverlay`) — or omitted for neither.
   */
  public updateState(
    grid: Tile[][],
    gridWidth: number,
    gridHeight: number,
    placements: readonly PlacedBuilding[] = [],
    overlays?: readonly BuildingOverlay[],
  ): void {
    // Map "x,y" coordinates to the placement itself for O(1) lookups — the
    // status pad needs its scored figures, not just which building it is.
    const placementMap = new Map<string, PlacedBuilding>();
    const overlayMap = new Map<string, BuildingOverlay>();
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      placementMap.set(`${p.x},${p.y}`, p);
      const overlay = overlays?.[i];
      if (overlay) overlayMap.set(`${p.x},${p.y}`, overlay);
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
          fill: placed ? (overlayMap.get(`${x},${y}`)?.fill ?? null) : null,
          anomalyIcon: placed
            ? (overlayMap.get(`${x},${y}`)?.anomalyIcon ?? null)
            : null,
          stateIcon: placed
            ? (overlayMap.get(`${x},${y}`)?.stateIcon ?? null)
            : null,
        };

        const prevState = this.stateCache[y][x];

        if (
          prevState &&
          prevState.tileType === nextState.tileType &&
          prevState.islandFrameKey === nextState.islandFrameKey &&
          prevState.waterFrameKey === nextState.waterFrameKey &&
          prevState.propFrameKey === nextState.propFrameKey &&
          prevState.buildingFrameKey === nextState.buildingFrameKey &&
          prevState.status === nextState.status &&
          prevState.fill === nextState.fill &&
          prevState.anomalyIcon === nextState.anomalyIcon &&
          prevState.stateIcon === nextState.stateIcon
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
    this.badgeContainer.sortChildren();
  }

  private renderTileVisuals(x: number, y: number, state: TileStateCache): void {
    const islandNode = this.islandTileNodes[y]?.[x];
    const gridNode = this.gridTileNodes[y]?.[x];
    const propNode = this.propTileNodes[y]?.[x];
    const badgeNode = this.badgeTileNodes[y]?.[x];

    if (!islandNode || !gridNode || !propNode || !badgeNode) return;

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
    clearNode(badgeNode);

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

    /*
     * 4. OVERLAYS — the game's two building icons and the fill badge, in the
     * top layer so a taller neighbour in front cannot hide them. Drawn in the
     * order the eye reads them: the anomaly icon at the foot, then the state
     * icon, then the badge across the front, which may overlap both.
     */
    if (state.buildingFrameKey && state.status) {
      if (state.anomalyIcon) {
        const icon = createIconSprite(state.anomalyIcon, ANOMALY_ICON.width);
        if (icon) {
          icon.position.set(ANOMALY_ICON.x, ANOMALY_ICON.y);
          badgeNode.addChild(icon);
        }
      }
      if (state.stateIcon) {
        const icon = createIconSprite(state.stateIcon, STATE_ICON_POS.width);
        if (icon) {
          icon.position.set(STATE_ICON_POS.x, STATE_ICON_POS.y);
          badgeNode.addChild(icon);
        }
      }
      if (state.fill !== null) {
        const badge = createStatusBadge(state.fill, state.status);
        badge.position.set(0, BADGE_OFFSET_Y);
        badgeNode.addChild(badge);
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
    if (!this.animate) return;
    if (this.links.length > 0) this.drawLinks(elapsedMs);
    if (this.pulsing.size === 0) return;

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

    this.drawLinks(0);
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

  /**
   * Shows the lines from the inspected building to its partners, or none.
   *
   * Pushed in by `PixiCanvas`, which reads them off the scorer — the painter
   * only draws. Skipped when the set has not changed, since the effect that pushes
   * it re-runs on every board repaint.
   */
  public setLinks(links: BoardLink[]): void {
    const key = links
      .map(
        (l) =>
          `${l.from.x},${l.from.y}>${l.to.x},${l.to.y}${l.direct ? "!" : ""}`,
      )
      .join("|");
    if (key === this.linkKey) return;
    this.linkKey = key;
    this.links = links;
    this.drawLinks(0);
  }

  /**
   * Hides or shows the partner lines without forgetting them — for the board's
   * image export, which renders this container and must not carry a pointer's
   * passing interest into a picture meant for someone else.
   */
  public setLinksVisible(on: boolean): void {
    this.linkGraphics.visible = on;
  }

  /** Redraws every partner line with its dashes advanced to `elapsedMs`. */
  private drawLinks(elapsedMs: number): void {
    const g = this.linkGraphics;
    g.clear();
    if (this.links.length === 0) return;

    const period = LINK_DASH + LINK_GAP;
    const phase = ((elapsedMs / 1000) * LINK_SPEED) % period;

    // The chain first and fainter, so the focus's own partners draw over it
    // and still read as the answer to "what does this one touch".
    for (const direct of [false, true]) {
      const group = this.links.filter((l) => l.direct === direct);
      if (group.length === 0) continue;
      const strength = direct ? 1 : LINK_CHAIN_STRENGTH;

      for (const { from, to } of group) {
        const a = gridToIso(from.x, from.y);
        const b = gridToIso(to.x, to.y);
        g.moveTo(a.x, a.y).lineTo(b.x, b.y);
      }
      g.stroke({
        width: LINK_TRACK_WIDTH,
        color: LINK_TRACK,
        alpha: 0.85 * strength,
        cap: "round",
      });

      for (const { from, to } of group) {
        const a = gridToIso(from.x, from.y);
        const b = gridToIso(to.x, to.y);
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        if (length === 0) continue;
        const ux = (b.x - a.x) / length;
        const uy = (b.y - a.y) / length;
        // Starts one period back so the first dash slides in from the supplier.
        for (let t = phase - period; t < length; t += period) {
          const start = Math.max(t, 0);
          const end = Math.min(t + LINK_DASH, length);
          if (end <= start) continue;
          g.moveTo(a.x + ux * start, a.y + uy * start).lineTo(
            a.x + ux * end,
            a.y + uy * end,
          );
        }
      }
      g.stroke({
        width: LINK_WIDTH,
        color: ACCENT,
        alpha: 0.95 * strength,
        cap: "round",
      });
    }
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
