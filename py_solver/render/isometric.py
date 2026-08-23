"""
Isometric projection constants and sprite-frame selection.

Everything here is purely about how a grid is drawn: the world->screen
projection, which sprite frame a tile gets, and the bitmask auto-tiling rules
for ground and shoreline tiles.
"""

from typing import Dict, List, Optional, Tuple

from solver.types import Tile
from grid import is_island_tile

# --- Isometric projection ---
UNITY_CELL_WIDTH = 0.82
UNITY_CELL_HEIGHT = 0.48
TILE_WIDTH = 164
TILE_HEIGHT = TILE_WIDTH * (UNITY_CELL_HEIGHT / UNITY_CELL_WIDTH)  # 96.0
PIXELS_PER_WORLD_UNIT = TILE_WIDTH / UNITY_CELL_WIDTH              # 200.0

# --- Sprite frame lookups ---
# Scenery tile type -> atlas frame key. Types absent here draw no prop.
TILE_IMAGE_MAP: Dict[str, str] = {
    "rock": "rocks",
    "tree1": "trees1",
    "tree2": "trees2",
    "pond": "pond",
    "transformer": "transformer",
}

FRAME_KEYS = {
    "indicator_basic_grid": "indicator_grid",
}

# Ground auto-tiling: bitmask rule id -> interchangeable frame variants.
GROUND_TILING_FRAMES: Dict[int, List[str]] = {
    3: ["tile_ground_0_v0", "tile_ground_0_v1", "tile_ground_0_v2"],
    1: ["tile_ground_1_v0", "tile_ground_1_v1", "tile_ground_1_v2"],
    0: ["tile_ground_3_v0", "tile_ground_3_v1", "tile_ground_3_v2"],
    4: ["tile_ground_2_v0", "tile_ground_2_v1", "tile_ground_2_v2"],
}


def grid_to_iso(x: int, y: int) -> Tuple[float, float]:
    """Converts grid (x, y) coordinates to 2.5D isometric screen coordinates."""
    iso_x = (x - y) * (TILE_WIDTH / 2)
    iso_y = (x + y) * (TILE_HEIGHT / 2)
    return iso_x, iso_y


def _variant_index(x: int, y: int, count: int) -> int:
    """Stable per-tile hash so a tile always picks the same sprite variant."""
    hash_val = abs((x * 73856093) ^ (y * 19349663))
    return hash_val % count


def get_island_frame_key(grid: List[List[Tile]], x: int, y: int) -> str:
    """Matches the TypeScript bitmask auto-tiling logic for ground tiles."""
    has_top_left = is_island_tile(grid[y][x - 1]) if x > 0 else False
    has_top_right = is_island_tile(grid[y - 1][x]) if y > 0 else False

    if has_top_left and has_top_right:
        rule_id = 1
    elif has_top_left and not has_top_right:
        rule_id = 4
    elif not has_top_left and has_top_right:
        rule_id = 0
    else:
        rule_id = 3

    variants = GROUND_TILING_FRAMES[rule_id]
    return variants[_variant_index(x, y, len(variants))]


def get_water_frame_key(grid: List[List[Tile]], x: int, y: int) -> Optional[str]:
    """Shoreline frame for a land tile, or None if it has no water edge."""
    if not is_island_tile(grid[y][x]):
        return None

    bottom_left_water = not is_island_tile(grid[y + 1][x]) if (y + 1 < len(grid)) else True
    bottom_right_water = not is_island_tile(grid[y][x + 1]) if (x + 1 < len(grid[0])) else True

    if bottom_left_water and bottom_right_water:
        return "tile_water_middle"
    if bottom_left_water:
        return "tile_water_left"
    if bottom_right_water:
        return "tile_water_right"
    return None
