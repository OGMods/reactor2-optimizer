"""Painter's-algorithm isometric renderer: draws a grid + placements to a PNG."""

from typing import List, Tuple

from PIL import Image, ImageDraw

from solver.types import PlacedBuilding, Tile
from grid import is_island_tile
from render.atlas import TextureAtlas
from render.isometric import (
    FRAME_KEYS,
    PIXELS_PER_WORLD_UNIT,
    TILE_HEIGHT,
    TILE_IMAGE_MAP,
    TILE_WIDTH,
    get_island_frame_key,
    get_water_frame_key,
    grid_to_iso,
)

CANVAS_PADDING = 250
BUILDING_SCALE = 0.28
TRANSFORMER_SCALE = 2.0


class IsometricRenderer:
    def __init__(self, atlas: TextureAtlas, bg_color=(70, 182, 150, 255)):
        self.atlas = atlas
        self.bg_color = bg_color

    def _draw_sprite(
        self,
        canvas: Image.Image,
        frame_key: str,
        screen_x: float,
        screen_y: float,
        world_unit_multiplier: float = 1.0,
        offset_x: float = 0.0,
        offset_y: float = 0.0,
    ):
        tex_data = self.atlas.get_texture(frame_key)
        if not tex_data:
            return

        sprite = tex_data["image"].copy()
        anchor_x, anchor_y = tex_data["anchor"]
        ptu = tex_data["ptu"]

        # Exact Scale Formula matching PixiJS atlas.ts
        scale_factor = (PIXELS_PER_WORLD_UNIT / ptu) * world_unit_multiplier
        if scale_factor != 1.0:
            new_w = max(1, int(round(sprite.width * scale_factor)))
            new_h = max(1, int(round(sprite.height * scale_factor)))
            sprite = sprite.resize((new_w, new_h), Image.Resampling.LANCZOS)

        # Apply anchor offset relative to screen position + tile offset
        target_x = screen_x + offset_x
        target_y = screen_y + offset_y

        paste_x = int(round(target_x - (sprite.width * anchor_x)))
        paste_y = int(round(target_y - (sprite.height * anchor_y)))

        canvas.alpha_composite(sprite, (paste_x, paste_y))

    def _draw_tile_diamond(self, canvas: Image.Image, screen_x: float, screen_y: float):
        overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)

        half_w = TILE_WIDTH / 2.0
        half_h = TILE_HEIGHT / 2.0

        polygon = [
            (screen_x, screen_y - half_h),
            (screen_x + half_w, screen_y),
            (screen_x, screen_y + half_h),
            (screen_x - half_w, screen_y),
        ]

        draw.polygon(polygon, fill=(0, 0, 0, 1), outline=(0, 0, 0, 50), width=1)
        canvas.alpha_composite(overlay)

    def render(self, grid: List[List[Tile]], placements: List[PlacedBuilding], output_path: str):
        grid_h = len(grid)
        grid_w = len(grid[0]) if grid_h > 0 else 0

        canvas_w = int((grid_w + grid_h) * (TILE_WIDTH / 2) + CANVAS_PADDING * 2)
        canvas_h = int((grid_w + grid_h) * (TILE_HEIGHT / 2) + CANVAS_PADDING * 2)

        offset_x = canvas_w // 2
        offset_y = CANVAS_PADDING

        canvas = Image.new("RGBA", (canvas_w, canvas_h), self.bg_color)
        placement_map = {(p.x, p.y): p.building_id for p in placements}

        # Back-to-front draw order: cells sorted by isometric depth (x + y).
        sorted_cells: List[Tuple[int, int]] = []
        for depth in range(grid_w + grid_h - 1):
            for y in range(grid_h):
                x = depth - y
                if 0 <= x < grid_w:
                    sorted_cells.append((x, y))

        def screen_pos(x: int, y: int) -> Tuple[float, float]:
            iso_x, iso_y = grid_to_iso(x, y)
            return iso_x + offset_x, iso_y + offset_y

        # PASS 1: Ground & Water
        for x, y in sorted_cells:
            if not is_island_tile(grid[y][x]):
                continue
            sx, sy = screen_pos(x, y)

            self._draw_sprite(canvas, get_island_frame_key(grid, x, y), sx, sy)

            water_key = get_water_frame_key(grid, x, y)
            if water_key:
                wsy = sy + TILE_HEIGHT + (3.5 if water_key == "tile_water_middle" else 0.0)
                self._draw_sprite(canvas, water_key, sx, wsy)

        # PASS 2: Grid Outlays
        for x, y in sorted_cells:
            sx, sy = screen_pos(x, y)

            if is_island_tile(grid[y][x]):
                self._draw_sprite(canvas, FRAME_KEYS["indicator_basic_grid"], sx, sy)

            self._draw_tile_diamond(canvas, sx, sy)

        # PASS 3: Buildings / Props
        for x, y in sorted_cells:
            sx, sy = screen_pos(x, y)

            prop_key = TILE_IMAGE_MAP.get(grid[y][x].type)
            if prop_key:
                mult = TRANSFORMER_SCALE if prop_key == "transformer" else 1.0
                self._draw_sprite(canvas, prop_key, sx, sy, world_unit_multiplier=mult)

            building_id = placement_map.get((x, y))
            if building_id:
                self._draw_sprite(
                    canvas,
                    building_id,
                    sx,
                    sy,
                    world_unit_multiplier=BUILDING_SCALE,
                    offset_y=-TILE_HEIGHT * 0.175,
                )

        canvas.save(output_path, "PNG")
