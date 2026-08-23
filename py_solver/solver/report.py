"""Post-solve sanity checks and console reporting."""

from typing import List, Optional

from solver.types import EffectiveBuilding, OptimizationResult, Tile
from formatters import format_number


def verify(grid: List[List[Tile]], roster: List[EffectiveBuilding], result: OptimizationResult) -> None:
    """Raises ValueError if a layout violates a placement rule."""
    seen_tiles = set()
    # Unlocked building ids may be placed on as many tiles as fit -- there is
    # no per-id quantity limit, so this only checks that each placed id is an
    # unlocked/available building, not how many times it appears.
    available_ids = {b.id for b in roster}

    for placement in result.placements:
        pos = (placement.x, placement.y)

        # 1. No duplicate tiles
        if pos in seen_tiles:
            raise ValueError(f"Duplicate tile found at {pos}")
        seen_tiles.add(pos)

        # 2. Grass-only
        if grid[placement.y][placement.x].type != "grass":
            raise ValueError(f"Building placed on non-grass tile at {pos}")

        # 3. Building is actually unlocked/available
        if placement.building_id not in available_ids:
            raise ValueError(f"Unavailable/locked building placed: {placement.building_id}")


def print_summary(result: OptimizationResult, solve_time_s: Optional[float] = None) -> None:
    p_max = result.theoretical_max_power
    efficiency = (result.total_power / p_max * 100) if p_max > 0 else 0.0
    total_tiles = result.active_tiles_count + result.unused_tiles_count

    if solve_time_s is not None:
        print(f"Solve time:             {solve_time_s:.2f}s")
    print(f"Total power:            {format_number(result.total_power)}")
    print(f"Theoretical max power:  {format_number(p_max)}")
    print(f"Layout efficiency:      {efficiency:.1f}%")
    print(f"Tiles:                  {result.active_tiles_count}/{total_tiles}\n")
