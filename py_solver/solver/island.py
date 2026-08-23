"""
Island decomposition and per-island upper bounds.

A grid's buildable tiles split into 8-neighbor connected components -- islands --
that cannot influence each other, so each is solved independently.
"""

from collections import deque
from typing import List

from solver.types import EffectiveBuilding, IslandSubGrid, Tile
from grid import count_grass_tiles
from solver.constants import (
    CHEBYSHEV_DIRECTIONS, EPS, GENERATOR_ENERGY_RATIO, GENERATOR_WASTE_RATIO,
)
from solver.physics import generator_energy_ratio, generator_waste_ratio


def can_cool_direct_producer(roster: List[EffectiveBuilding]) -> bool:
    """
    True if a single cooler can fully absorb some direct producer's waste.

    This sets the minimum viable island size: a Direct Producer + Cooler pair
    needs only 2 tiles, whereas a Reactor + Generator + Cooler chain needs 3.
    """
    coolers = [b for b in roster if b.type == "cooler"]
    if not coolers:
        return False

    max_cooling = max(c.effective_value for c in coolers)
    direct_producers = [b for b in roster if b.type == "direct_producer"]

    return any(dp.waste <= max_cooling for dp in direct_producers)


def split_grid_into_islands(
    grid: List[List[Tile]],
    roster: List[EffectiveBuilding],
) -> List[IslandSubGrid]:
    """
    Splits the grid into independently solvable sub-grids of buildable tiles.

    Components too small to ever bring a building online are dropped.
    """
    if not grid or not grid[0]:
        return []

    original_height = len(grid)
    original_width = len(grid[0])
    min_tiles_required = 2 if can_cool_direct_producer(roster) else 3

    # 1. Only grass is buildable; everything else is an impassable boundary.
    processed_grid = [
        [Tile(x=t.x, y=t.y, type="water" if t.type != "grass" else "grass") for t in row]
        for row in grid
    ]

    visited = [[False] * original_width for _ in range(original_height)]
    sub_grids: List[IslandSubGrid] = []

    for y in range(original_height):
        for x in range(original_width):
            if visited[y][x] or processed_grid[y][x].type == "water":
                continue

            # 2. BFS connected-component search
            component_tiles: List[Tile] = []
            queue = deque([(x, y)])
            visited[y][x] = True

            min_x, max_x = x, x
            min_y, max_y = y, y

            while queue:
                cx, cy = queue.popleft()
                component_tiles.append(processed_grid[cy][cx])

                min_x, max_x = min(min_x, cx), max(max_x, cx)
                min_y, max_y = min(min_y, cy), max(max_y, cy)

                for dx, dy in CHEBYSHEV_DIRECTIONS:
                    nx, ny = cx + dx, cy + dy
                    if (0 <= ny < original_height and
                        0 <= nx < original_width and
                        not visited[ny][nx] and
                        processed_grid[ny][nx].type != "water"):
                        visited[ny][nx] = True
                        queue.append((nx, ny))

            if len(component_tiles) < min_tiles_required:
                continue

            # 3. Extract bounding dimensions and build sub-grid mapping
            sub_width = max_x - min_x + 1
            sub_height = max_y - min_y + 1
            component_set = {(t.x, t.y) for t in component_tiles}

            sub_grid_tiles: List[List[Tile]] = []
            original_tile_indices: List[int] = [0] * (sub_width * sub_height)

            for sub_y in range(sub_height):
                row: List[Tile] = []
                orig_y = min_y + sub_y

                for sub_x in range(sub_width):
                    orig_x = min_x + sub_x
                    local_flat_index = sub_y * sub_width + sub_x

                    original_tile_indices[local_flat_index] = orig_y * original_width + orig_x

                    if (orig_x, orig_y) in component_set:
                        row.append(Tile(x=sub_x, y=sub_y, type=processed_grid[orig_y][orig_x].type))
                    else:
                        row.append(Tile(x=sub_x, y=sub_y, type="water"))

                sub_grid_tiles.append(row)

            sub_grids.append(
                IslandSubGrid(
                    width=sub_width,
                    height=sub_height,
                    grid=sub_grid_tiles,
                    original_tile_indices=original_tile_indices,
                )
            )

    return sub_grids


def estimate_island_max_power(island: IslandSubGrid, roster: List[EffectiveBuilding]) -> float:
    """
    A TRUE upper bound on a single island's power: no layout on this island
    can exceed it, so the "layout efficiency" figure it feeds never reads
    above 100% (an earlier per-hub density estimate ignored cross-hub sharing
    of reactors and coolers, which real layouts exploit, and was routinely
    beaten by 3-50%).

    The bound relaxes adjacency away entirely and asks only what the tile
    COUNTS allow. For every split of the island into n_engine tiles
    (reactors + generators), n_dp direct producers and n_cool coolers, any
    layout obeys

        heat absorbed  H <= min(n_react * R_top, n_gen * G_top)
        online DPs     D <= n_dp
        total cooling  0.25 * H + w_min * D <= n_cool * C_top

    and produces at most 0.75 * H + net_max * D, where net_max / w_min are
    the best net power and smallest waste any unlocked direct producer can
    have. Maximizing that tiny LP over all splits gives the bound. On the
    67-tile map 1 island it lands ~2% above the known optimum, so the
    efficiency figure it produces is meaningful, not just safe.

    Anything a real layout must additionally respect -- adjacency, the
    all-or-nothing cooling rule, whole buildings rather than fractional
    ones -- only lowers achievable power below this.
    """
    buildable_tiles = count_grass_tiles(island.grid)
    if buildable_tiles <= 0:
        return 0.0

    reactors = [b for b in roster if b.type == "reactor"]
    generators = [b for b in roster if b.type == "generator"]
    coolers = [b for b in roster if b.type == "cooler"]
    direct_producers = [b for b in roster if b.type == "direct_producer"]

    best_cooler = max(coolers, key=lambda b: b.effective_value) if coolers else None
    if not best_cooler or best_cooler.effective_value <= 0:
        return 0.0

    c_val = best_cooler.effective_value
    r_val = max((b.effective_value for b in reactors), default=0.0)
    g_val = max((b.effective_value for b in generators), default=0.0)

    can_hub = r_val > 0 and g_val > 0 and buildable_tiles >= 3
    can_dp = bool(direct_producers) and buildable_tiles >= 2
    if not can_hub and not can_dp:
        return 0.0

    # A mixed DP roster is bounded by its best net power and its smallest
    # cooling appetite -- each real DP produces no more and cools no less.
    dp_net = max((b.energy for b in direct_producers), default=0.0)
    dp_waste = min((b.waste for b in direct_producers), default=0.0)

    # The bound must not sit below a layout the solver actually builds, so it
    # takes the greediest energy ratio and the stingiest waste ratio any
    # unlocked generator can offer -- they need not come from the same tier.
    energy_ratio = max(
        (generator_energy_ratio(b) for b in generators),
        default=GENERATOR_ENERGY_RATIO,
    )
    waste_ratio = min(
        (generator_waste_ratio(b) for b in generators),
        default=GENERATOR_WASTE_RATIO,
    )
    if waste_ratio <= 0:
        waste_ratio = GENERATOR_WASTE_RATIO

    best = 0.0
    engine_counts = range(0, buildable_tiles + 1) if can_hub else (0,)
    for n_engine in engine_counts:
        heat_cap = _best_heat_for_engine_tiles(n_engine, r_val, g_val)
        if n_engine > 0 and heat_cap <= 0.0:
            continue  # engine tiles that can't form a reactor+generator pair

        dp_counts = range(0, buildable_tiles - n_engine + 1) if can_dp else (0,)
        for n_dp in dp_counts:
            n_cool = buildable_tiles - n_engine - n_dp
            if n_cool < 1:
                continue  # nothing runs on an island with zero coolers
            cooling = n_cool * c_val

            # Maximize 0.75*H + dp_net*D under the shared cooling budget: a
            # two-variable LP whose optimum sits at one of the two "fill one
            # side first" corners.
            h_first = min(heat_cap, cooling / waste_ratio)
            d_rest = (
                n_dp if dp_waste <= EPS
                else min(n_dp, (cooling - h_first * waste_ratio) / dp_waste)
            )
            p_heat_first = h_first * energy_ratio + dp_net * d_rest

            d_first = n_dp if dp_waste <= EPS else min(n_dp, cooling / dp_waste)
            h_rest = min(heat_cap, (cooling - dp_waste * d_first) / waste_ratio)
            p_dp_first = h_rest * energy_ratio + dp_net * d_first

            best = max(best, p_heat_first, p_dp_first)

    return best


def _best_heat_for_engine_tiles(n_engine: int, r_val: float, g_val: float) -> float:
    """
    Most heat n_engine tiles of reactors + generators can hand over, cooling
    ignored: max over n_react of min(n_react * r_val, (n_engine - n_react) *
    g_val). The min of two crossing lines peaks where they intersect, so only
    the two integer counts around the crossing need checking.
    """
    if n_engine < 2 or r_val <= 0 or g_val <= 0:
        return 0.0

    crossing = n_engine * g_val / (r_val + g_val)
    best = 0.0
    for n_react in (int(crossing), int(crossing) + 1):
        if 1 <= n_react <= n_engine - 1:
            best = max(best, min(n_react * r_val, (n_engine - n_react) * g_val))
    return best


def estimate_total_max_power(islands: List[IslandSubGrid], roster: List[EffectiveBuilding]) -> float:
    """Sum of theoretical max power across all valid island sub-grids."""
    return sum(estimate_island_max_power(island, roster) for island in islands)
