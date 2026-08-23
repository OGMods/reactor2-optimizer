"""
Fixture script for test_pipeline's parallel-solve test.

This lives in its own file, run via subprocess, because ProcessPoolExecutor
uses the "spawn" start method on macOS: worker processes re-import the parent's
__main__ module, which is safe for a real script with an `if __name__` guard
but not for the unittest runner itself.

Prints one JSON object describing a parallel and a sequential solve of the same
multi-island map.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from data.effective_buildings import get_effective_buildings
from blueprint import decode_blueprint
from grid import count_grass_tiles
from data.maps import MAPS_BY_NUM
from solver import solve
from solver.island import split_grid_into_islands


def summarize(result, grid):
    return {
        "total_power": result.total_power,
        "active_tiles": result.active_tiles_count,
        "unused_tiles": result.unused_tiles_count,
        "max_power": result.theoretical_max_power,
        "positions": sorted([p.x, p.y] for p in result.placements),
        "all_on_grass": all(
            grid[p.y][p.x].type == "grass" for p in result.placements
        ),
    }


def main() -> int:
    map_num = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    budget = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0

    game_map = MAPS_BY_NUM[map_num]
    grid = decode_blueprint(game_map.code).grid
    roster = get_effective_buildings()

    print(json.dumps({
        "island_count": len(split_grid_into_islands(grid, roster)),
        "grass_tiles": count_grass_tiles(grid),
        "parallel": summarize(solve(grid, roster, budget, parallel=True), grid),
        "sequential": summarize(solve(grid, roster, budget, parallel=False), grid),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
