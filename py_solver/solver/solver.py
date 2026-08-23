"""
Top-level solve pipeline: split the grid into islands, solve each one under its
own slice of the time budget, then stitch the results back into grid coordinates.
"""

import os
from concurrent.futures import ProcessPoolExecutor, as_completed
from typing import List, Optional, Tuple

from solver.types import (
    EffectiveBuilding,
    IslandSubGrid,
    OptimizationResult,
    OptimizationSummary,
    PlacedBuilding,
    Tile,
)
from grid import count_grass_tiles
from solver.island import estimate_total_max_power, split_grid_into_islands
from solver.placement_search import solve_island

DEFAULT_TIME_BUDGET_S = 10.0


def solve(
    grid: List[List[Tile]],
    roster: List[EffectiveBuilding],
    time_budget_s: float = DEFAULT_TIME_BUDGET_S,
    parallel: bool = True,
    seed: Optional[int] = None,
) -> OptimizationResult:
    if not grid or not grid[0]:
        return _empty_result(0)

    original_width = len(grid[0])
    total_grass_tiles = count_grass_tiles(grid)

    # 1. Partition the grid into independent sub-grid islands
    sub_grids = split_grid_into_islands(grid, roster)
    if not sub_grids:
        return _empty_result(total_grass_tiles)

    # 2. Solve each island independently, splitting the time budget
    # proportionally by buildable-tile count.
    island_results = _solve_islands(sub_grids, roster, time_budget_s, parallel, seed)

    # 3. Aggregate by original island index (not completion order), so output
    # ordering is identical to the sequential version regardless of which
    # worker finishes first.
    global_placements: List[PlacedBuilding] = []
    total_power = 0.0
    summary = OptimizationSummary()

    for sub_grid, (local_placements, island_power) in zip(sub_grids, island_results):
        total_power += island_power
        global_placements.extend(
            _remap_placements(sub_grid, local_placements, original_width)
        )

        for p in local_placements:
            summary.total_heat_produced += p.heat_produced
            summary.total_heat_consumed += p.heat_consumed
            summary.total_waste_generated += p.waste_heat_generated
            summary.total_cooling_capacity += p.cooling_provided

    active_tiles_count = len(global_placements)

    return OptimizationResult(
        total_power=total_power,
        placements=global_placements,
        active_tiles_count=active_tiles_count,
        unused_tiles_count=total_grass_tiles - active_tiles_count,
        summary=summary,
        theoretical_max_power=estimate_total_max_power(sub_grids, roster),
    )


def _solve_islands(
    sub_grids: List[IslandSubGrid],
    roster: List[EffectiveBuilding],
    time_budget_s: float,
    parallel: bool,
    seed: Optional[int] = None,
) -> List[Tuple[List[PlacedBuilding], float]]:
    """
    Runs solve_island over every island.

    Islands never interact -- nothing that happens on one can affect another --
    so they're solved in worker processes to make wall-clock time
    ~max(island time) instead of sum(island time); each island still gets its
    full proportional share of time_budget_s, it just runs concurrently with
    the others rather than after them. Falls back to plain sequential execution
    for a single island or a single-core machine, where a process pool's
    startup cost would outweigh any benefit.
    """
    grass_counts = [count_grass_tiles(sg.grid) for sg in sub_grids]
    total_grass = sum(grass_counts) or 1
    budgets = [time_budget_s * (count / total_grass) for count in grass_counts]
    # Each island gets its own random stream, offset from the base seed so a
    # seeded solve is reproducible per island rather than coupled across them.
    seeds = [
        None if seed is None else (seed + i) & 0xFFFFFFFF
        for i in range(len(sub_grids))
    ]

    max_workers = min(len(sub_grids), os.cpu_count() or 1)
    results: List[Optional[Tuple[List[PlacedBuilding], float]]] = [None] * len(sub_grids)

    if parallel and len(sub_grids) > 1 and max_workers > 1:
        with ProcessPoolExecutor(max_workers=max_workers) as executor:
            future_to_index = {
                executor.submit(solve_island, sub_grid, roster, budget, island_seed): i
                for i, (sub_grid, budget, island_seed) in enumerate(
                    zip(sub_grids, budgets, seeds)
                )
            }
            for future in as_completed(future_to_index):
                results[future_to_index[future]] = future.result()
    else:
        for i, (sub_grid, budget, island_seed) in enumerate(zip(sub_grids, budgets, seeds)):
            results[i] = solve_island(sub_grid, roster, budget, island_seed)

    return results


def _remap_placements(
    island: IslandSubGrid,
    local_placements: List[PlacedBuilding],
    original_width: int,
) -> List[PlacedBuilding]:
    """Rewrites island-local coordinates back to full-grid coordinates."""
    for p in local_placements:
        local_flat_index = p.y * island.width + p.x
        original_flat_index = island.original_tile_indices[local_flat_index]
        orig_y, orig_x = divmod(original_flat_index, original_width)
        p.x, p.y = orig_x, orig_y
    return local_placements


def _empty_result(total_grass: int) -> OptimizationResult:
    return OptimizationResult(
        total_power=0.0,
        placements=[],
        active_tiles_count=0,
        unused_tiles_count=total_grass,
        summary=OptimizationSummary(),
    )
