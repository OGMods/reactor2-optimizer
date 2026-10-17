import { BitmapFont, BitmapText, Container, Graphics } from "pixi.js";
import type { PlacementStatus } from "../data/placements";
import { createIconSprite } from "./atlas";

/**
 * The gauge the game prints over every building: a dark pill holding its dial
 * icon (`status_gauge`, the game's own sprite) and how hard the building is
 * working ("70%").
 *
 * The pill is see-through, as the game's is, so it reads as a label floating
 * over the board rather than a slab covering the building behind it.
 *
 * The figure is tinted with the board's reserved status colours rather than the
 * game's one red, so the badge and the pad beneath it are one reading — see the
 * colour law in `src/CLAUDE.md`. These are `--status-ok`, `--status-idle` and
 * `--danger` from `app.css`, repeated as Pixi literals for the same reason
 * `ACCENT` is in `gridPainter.ts`: Pixi cannot read a custom property.
 */
const STATUS_TINT: Record<PlacementStatus, number> = {
  active: 0x4ade80,
  idle: 0xfacc15,
  starved: 0xff4757,
};

const PILL_FILL = 0x16213a;
const PILL_ALPHA = 0.55;
const PILL_HEIGHT = 21;
const PILL_PAD_X = 6;
/** The gauge icon's width; its art is 108 x 76. */
const GAUGE_WIDTH = 18;
const GAUGE_GAP = 3;
const FONT_SIZE = 15;

/**
 * One bitmap font for every badge on the board, installed on first use.
 *
 * `BitmapText` rather than `Text`: a `Text` rasterises a texture of its own,
 * and a large island carries a few hundred badges. The glyphs are drawn white
 * and each badge tints them, so the three statuses share one sheet. Installed
 * at 3x because the board zooms well past 1:1 and a 1x sheet goes soft there.
 */
const FONT_NAME = "status-badge";
let fontInstalled = false;

function ensureFont(): void {
  if (fontInstalled) return;
  BitmapFont.install({
    name: FONT_NAME,
    style: {
      fontFamily: ["Segoe UI", "Tahoma", "Geneva", "Verdana", "sans-serif"],
      fontSize: FONT_SIZE,
      fontWeight: "bold",
      fill: 0xffffff,
    },
    chars: "0123456789%",
    resolution: 3,
  });
  fontInstalled = true;
}

/**
 * Builds one badge, centred on its own origin. The caller positions it over the
 * building and owns its lifetime.
 */
export function createStatusBadge(
  percent: number,
  status: PlacementStatus,
): Container {
  ensureFont();
  const tint = STATUS_TINT[status];

  const label = new BitmapText({
    text: `${percent}%`,
    style: { fontFamily: FONT_NAME, fontSize: FONT_SIZE },
  });
  label.tint = tint;

  const contentWidth = GAUGE_WIDTH + GAUGE_GAP + label.width;
  const width = contentWidth + PILL_PAD_X * 2;
  const left = -width / 2;

  const pill = new Graphics()
    .roundRect(left, -PILL_HEIGHT / 2, width, PILL_HEIGHT, PILL_HEIGHT / 2)
    .fill({ color: PILL_FILL, alpha: PILL_ALPHA })
    .stroke({ width: 1, color: 0x000000, alpha: 0.25 });

  const gauge = createIconSprite("status_gauge", GAUGE_WIDTH);
  gauge?.position.set(left + PILL_PAD_X + GAUGE_WIDTH / 2, 0);

  label.position.set(
    left + PILL_PAD_X + GAUGE_WIDTH + GAUGE_GAP,
    -label.height / 2,
  );

  const badge = new Container();
  badge.eventMode = "none";
  badge.addChild(pill);
  if (gauge) badge.addChild(gauge);
  badge.addChild(label);
  return badge;
}
