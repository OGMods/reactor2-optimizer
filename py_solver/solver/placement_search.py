"""
Placement search for a single island:

  seed -> repair -> composition retarget -> (annealing -> repair)* -> pruning
    -> right-sizing

The `annealing -> repair` pair repeats until the deadline. Repair's slice is
reserved before the layout it will run on exists, and on a post-anneal layout
it almost always converges in one fruitless sweep, so whatever it hands back
becomes another short walk rather than idle time at the end of the budget.

Seed construction lays out self-sufficient "hubs" -- one generator plus exactly
the reactors and coolers it needs on its own. That is a good starting shape but
a systematically incomplete one: real layouts do better by letting neighbouring
hubs SHARE, one cooler absorbing waste from two generators or one reactor
feeding two, which frees tiles for more producers. Nothing in seed construction
can express that, and on the 67-tile map 1 island it caps out 7% below the best
known layout.

The two stages around it exist to cover that blind spot from different sides:

- `_greedy_polish` is steepest ascent over single-tile changes. Annealing alone
  was supposed to find these, and does on small islands, but on a large packed
  island almost every single-tile change costs several percent, so the walk
  drifts downhill and rarely climbs back -- measured there, only 1 evaluation
  in 26,000 beat its own starting layout while 20 stable improving moves sat a
  single move away.
- `_target_compositions` / `_arrange_composition` attack the other half.
  Deciding WHAT to build is a counting problem with an exact answer, so it is
  computed directly rather than searched for; the search is then left with the
  genuinely hard part, which is where to put it.

Annealing keeps its place between them for the moves neither can make: it can
cross a barrier that no single change improves upon.

Right-sizing is the odd one out: it is not part of the search and cannot find
a better layout. It runs once the layout is final and swaps each building for
the smallest tier that still carries the load that layout gives it, because
power is blind to the difference between a cooler running flat out and one
running at 2% -- and the player is not.
"""

import itertools
import math
import random
import time
from collections import Counter
from typing import Dict, List, Optional, Set, Tuple

from solver.types import EffectiveBuilding, IslandSubGrid, PlacedBuilding
from solver.rng import Rng
from solver.constants import CHEBYSHEV_DIRECTIONS, EPS, spatial_key
from solver.physics import (
    generator_energy_ratio,
    generator_power_and_waste,
    generator_waste_ratio,
    waste_is_covered,
)
from solver.rules import TileId, build_neighbor_map, is_adjacent
from solver.simulate import simulate_island

_MAX_TOP_REACTOR_COPIES = 3
_MAX_SECOND_REACTOR_COPIES = 3

# How many reactor tiers the local-repair pass considers per tile.
_POLISH_REACTOR_TIERS = 3
# Share of the time budget reserved for repair before and after annealing.
_POLISH_SHARE = 0.3
# How many candidate compositions to try arranging, best-scoring first.
_COMPOSITION_TARGETS = 3
# Share of the time budget spent arranging those compositions.
_COMPOSITION_SHARE = 0.2
# Max Chebyshev distance between two tiles considered for an arrangement swap.
_SWAP_RADIUS = 2
# The closing repair is reserved a share of the budget up front, then handed
# back whatever it does not use (see `solve_island`). These bound the handback:
# the repair is left twice its measured cost as headroom, but never more than
# half of what is left -- on a big island one sweep costs seconds, and reserving
# twice that would strand more time than it protects. A reclaimed round shorter
# than the floor is not worth its own setup.
_RECLAIM_POLISH_MARGIN = 2.0
_RECLAIM_MAX_RESERVE_FRACTION = 0.5
_RECLAIM_MIN_ROUND_SHARE = 0.01
_RECLAIM_MIN_ROUND_S = 0.05


def _buildable_tiles(local_grid) -> List[TileId]:
    tiles = [(tile.x, tile.y) for row in local_grid for tile in row if tile.type == "grass"]
    return sorted(tiles, key=lambda p: spatial_key(*p))


def _neighbors(
    pos: TileId,
    available: Set[TileId],
    neighbor_map: Optional[Dict[TileId, List[TileId]]] = None,
) -> List[TileId]:
    if neighbor_map is not None:
        return [n for n in neighbor_map.get(pos, ()) if n in available]
    x, y = pos
    result = [(x + dx, y + dy) for dx, dy in CHEBYSHEV_DIRECTIONS]
    result = [n for n in result if n in available and n != pos]
    return sorted(result, key=lambda p: spatial_key(*p))


def _best_hub_fit(
    available_slots: int,
    generators: List[EffectiveBuilding],
    reactors: List[EffectiveBuilding],
    cooler: EffectiveBuilding,
) -> Optional[Tuple[EffectiveBuilding, EffectiveBuilding, int, int, float]]:
    best = None
    for generator in generators:
        for reactor in reactors:
            max_r = min(available_slots, math.ceil(generator.effective_value / reactor.effective_value))
            for r in range(1, max_r + 1):
                h_in = min(generator.effective_value, r * reactor.effective_value)
                power, waste = generator_power_and_waste(generator, h_in)
                c = math.ceil(waste / cooler.effective_value) if cooler.effective_value > 0 else 0
                if r + c <= available_slots:
                    if best is None or power > best[4]:
                        best = (generator, reactor, r, c, power)
                if h_in >= generator.effective_value - EPS:
                    break
    return best


def _best_shared_reactor_fit(
    pos: TileId,
    neighbors: List[TileId],
    reactors: List[EffectiveBuilding],
    generator: EffectiveBuilding,
    cooler: EffectiveBuilding,
    neighbor_map: Optional[Dict[TileId, List[TileId]]] = None,
) -> Optional[Tuple[float, List[Tuple[TileId, EffectiveBuilding]], List[TileId], List[TileId]]]:
    if not reactors:
        return None
    top_reactor = reactors[0]
    second_reactor = reactors[1] if len(reactors) > 1 else None

    connectivity = {n: sum(1 for m in neighbors if m != n and is_adjacent(n, m)) for n in neighbors}
    by_connectivity_asc = sorted(neighbors, key=lambda n: (connectivity[n], spatial_key(*n)))

    best = None
    max_k1 = min(_MAX_TOP_REACTOR_COPIES, 1 + len(neighbors))
    for k1 in range(1, max_k1 + 1):
        extra_top_needed = k1 - 1

        max_k2 = 0
        if second_reactor is not None:
            max_k2 = min(_MAX_SECOND_REACTOR_COPIES, len(neighbors) - extra_top_needed)
        for k2 in range(0, max_k2 + 1):
            n_extra_reactors = extra_top_needed + k2
            if n_extra_reactors > len(neighbors):
                continue

            total_value = k1 * top_reactor.effective_value
            if k2:
                total_value += k2 * second_reactor.effective_value

            g = math.ceil(total_value / generator.effective_value)
            if g < 2 or n_extra_reactors + g + 1 > len(neighbors):
                continue
            absorbed = min(total_value, g * generator.effective_value)
            waste_total = absorbed * generator_waste_ratio(generator)
            c = math.ceil(waste_total / cooler.effective_value) if cooler.effective_value > 0 else 0
            if n_extra_reactors + g + c > len(neighbors):
                continue

            extra_positions = by_connectivity_asc[:n_extra_reactors]
            extra_top_positions = extra_positions[:extra_top_needed]
            extra_second_positions = extra_positions[extra_top_needed:n_extra_reactors]
            pool = [n for n in neighbors if n not in extra_positions]

            for gen_positions in itertools.combinations(pool, g):
                leftover = [n for n in pool if n not in gen_positions]
                leftover.sort(
                    key=lambda n: (-sum(1 for gpos in gen_positions if is_adjacent(n, gpos)), spatial_key(*n))
                )
                cooler_positions = leftover[:c]

                placement = {pos: top_reactor}
                for n in extra_top_positions:
                    placement[n] = top_reactor
                for n in extra_second_positions:
                    placement[n] = second_reactor
                for n in gen_positions:
                    placement[n] = generator
                for n in cooler_positions:
                    placement[n] = cooler
                power, _ = simulate_island(placement, neighbor_map)
                if power > EPS and (best is None or power > best[0]):
                    reactor_placements = (
                        [(pos, top_reactor)]
                        + [(n, top_reactor) for n in extra_top_positions]
                        + [(n, second_reactor) for n in extra_second_positions]
                    )
                    best = (power, reactor_placements, list(gen_positions), cooler_positions)

    return best


def _best_dp_fit(
    available_slots: int,
    direct_producers: List[EffectiveBuilding],
    cooler: EffectiveBuilding,
) -> Optional[Tuple[EffectiveBuilding, int, float]]:
    best = None
    for dp in direct_producers:
        waste = dp.waste
        c = math.ceil(waste / cooler.effective_value) if cooler.effective_value > 0 else 0
        if c > available_slots:
            continue
        power = dp.energy
        if best is None or power > best[2]:
            best = (dp, c, power)
    return best


def _construct_seed(
    buildable_order: List[TileId],
    reactors: List[EffectiveBuilding],
    generators: List[EffectiveBuilding],
    coolers: List[EffectiveBuilding],
    direct_producers: List[EffectiveBuilding],
    deadline: float,
    neighbor_map: Optional[Dict[TileId, List[TileId]]] = None,
) -> Dict[TileId, EffectiveBuilding]:
    placement: Dict[TileId, EffectiveBuilding] = {}
    available: Set[TileId] = set(buildable_order)

    top_reactor = reactors[0] if reactors else None
    top_generator = generators[0] if generators else None
    top_cooler = coolers[0] if coolers else None
    can_hub = top_reactor is not None and top_generator is not None and top_cooler is not None
    can_dp = bool(direct_producers) and top_cooler is not None
    try_shared_reactor = can_hub and math.ceil(
        top_reactor.effective_value / top_generator.effective_value
    ) >= 2

    hub_fit_cache: Dict[int, Optional[Tuple]] = {}
    dp_fit_cache: Dict[int, Optional[Tuple]] = {}

    def hub_fit(available_slots: int):
        if available_slots not in hub_fit_cache:
            hub_fit_cache[available_slots] = (
                _best_hub_fit(available_slots, generators, reactors, top_cooler) if can_hub else None
            )
        return hub_fit_cache[available_slots]

    def dp_fit(available_slots: int):
        if available_slots not in dp_fit_cache:
            dp_fit_cache[available_slots] = (
                _best_dp_fit(available_slots, direct_producers, top_cooler) if can_dp else None
            )
        return dp_fit_cache[available_slots]

    def static_neighbors(pos: TileId) -> List[TileId]:
        if neighbor_map is not None:
            return neighbor_map.get(pos, ())
        x, y = pos
        return [(x + dx, y + dy) for dx, dy in CHEBYSHEV_DIRECTIONS]

    candidate_cache: Dict[TileId, Optional[Tuple[float, float, str, TileId, List[TileId], Tuple]]] = {}
    stale: Set[TileId] = set(available)

    while available:
        if time.time() >= deadline:
            break

        for pos in [p for p in buildable_order if p in stale]:
            if time.time() >= deadline:
                break

            neighbors = _neighbors(pos, available, neighbor_map)
            # entry: (power_per_tile, raw_power, kind, pos, neighbors, payload)
            # Candidates are ranked by power PER TILE CLAIMED, not raw power --
            # a candidate that spends more tiles (e.g. a multi-reactor "shared"
            # setup) can have higher raw power than a compact one-reactor hub
            # while actually being a worse use of the island's limited tiles.
            # Comparing raw power lets a tile-hungry option win a single greedy
            # round yet leave the *rest* of the island worse off, since those
            # extra tiles are no longer available for other, more efficient
            # hubs. Ranking by power/tile keeps the greedy choice locally
            # optimal in the currency that's actually scarce: tiles.
            entry: Optional[Tuple[float, float, str, TileId, List[TileId], Tuple]] = None

            hub = hub_fit(len(neighbors))
            if hub is not None:
                _, _, r, c, power = hub
                tiles_used = 1 + r + c
                if power > EPS and tiles_used > 0:
                    ppt = power / tiles_used
                    if entry is None or ppt > entry[0]:
                        entry = (ppt, power, "hub", pos, neighbors, hub)

            dp = dp_fit(len(neighbors))
            if dp is not None:
                _, c, power = dp
                tiles_used = 1 + c
                if power > EPS and tiles_used > 0:
                    ppt = power / tiles_used
                    if entry is None or ppt > entry[0]:
                        entry = (ppt, power, "dp", pos, neighbors, dp)

            if try_shared_reactor and len(neighbors) >= 3:
                shared = _best_shared_reactor_fit(
                    pos, neighbors, reactors, top_generator, top_cooler, neighbor_map
                )
                if shared is not None:
                    power, reactor_placements, gen_positions, cooler_positions = shared
                    tiles_used = len(reactor_placements) + len(gen_positions) + len(cooler_positions)
                    if tiles_used > 0:
                        ppt = power / tiles_used
                        if entry is None or ppt > entry[0]:
                            entry = (ppt, power, "shared", pos, neighbors, (reactor_placements, gen_positions, cooler_positions))

            candidate_cache[pos] = entry

        stale.clear()

        best: Optional[Tuple[float, float, str, TileId, List[TileId], Tuple]] = None
        for pos in [p for p in buildable_order if p in available]:
            entry = candidate_cache.get(pos)
            if entry is not None and (best is None or entry[0] > best[0]):
                best = entry

        if best is None:
            break

        _, _, kind, pos, neighbors, payload = best
        claimed: List[TileId] = []
        if kind == "hub":
            generator, reactor, r, c, _ = payload
            placement[pos] = generator
            claimed.append(pos)
            for n in neighbors[:r]:
                placement[n] = reactor
                claimed.append(n)
            for n in neighbors[r:r + c]:
                placement[n] = top_cooler
                claimed.append(n)
        elif kind == "shared":
            reactor_placements, gen_positions, cooler_positions = payload
            for n, tier in reactor_placements:
                placement[n] = tier
                claimed.append(n)
            for n in gen_positions:
                placement[n] = top_generator
                claimed.append(n)
            for n in cooler_positions:
                placement[n] = top_cooler
                claimed.append(n)
        else:
            dp, c, _ = payload
            placement[pos] = dp
            claimed.append(pos)
            for n in neighbors[:c]:
                placement[n] = top_cooler
                claimed.append(n)

        for t in claimed:
            available.discard(t)
            candidate_cache.pop(t, None)

        for t in claimed:
            for n in static_neighbors(t):
                if n in available:
                    stale.add(n)

    return placement


def _construct_multi_start_seed(
    buildable: List[TileId],
    reactors: List[EffectiveBuilding],
    generators: List[EffectiveBuilding],
    coolers: List[EffectiveBuilding],
    direct_producers: List[EffectiveBuilding],
    deadline: float,
    neighbor_map: Optional[Dict[TileId, List[TileId]]] = None,
) -> Dict[TileId, EffectiveBuilding]:
    best_seed = _construct_seed(
        buildable, reactors, generators, coolers, direct_producers, deadline, neighbor_map
    )
    best_power, _ = simulate_island(best_seed, neighbor_map)

    if best_power <= EPS:
        # The deadline elapsed mid-construction and left a seed that powers
        # nothing. One full greedy pass costs ~2ms even on the largest island
        # in the game, so finish it: refining a degenerate seed wastes the
        # whole budget and can return an empty layout for a solvable island.
        best_seed = _construct_seed(
            buildable, reactors, generators, coolers, direct_producers,
            time.time() + 1.0, neighbor_map,
        )
        best_power, _ = simulate_island(best_seed, neighbor_map)

    if time.time() >= deadline - 0.05 or len(buildable) < 6:
        return best_seed

    rev_buildable = list(reversed(buildable))
    seed_rev = _construct_seed(
        rev_buildable, reactors, generators, coolers, direct_producers, deadline, neighbor_map
    )
    power_rev, _ = simulate_island(seed_rev, neighbor_map)
    if power_rev > best_power + EPS:
        best_power = power_rev
        best_seed = seed_rev

    if time.time() < deadline - 0.05:
        rng = Rng(42)
        shuffled_buildable = list(buildable)
        rng.shuffle(shuffled_buildable)
        seed_rand = _construct_seed(
            shuffled_buildable, reactors, generators, coolers, direct_producers, deadline, neighbor_map
        )
        power_rand, _ = simulate_island(seed_rand, neighbor_map)
        if power_rand > best_power + EPS:
            best_seed = seed_rand

    return best_seed


def _random_candidate(
    reactors: List[EffectiveBuilding], generators: List[EffectiveBuilding],
    coolers: List[EffectiveBuilding], direct_producers: List[EffectiveBuilding],
    rng: Rng,
) -> Optional[EffectiveBuilding]:
    pools = [p for p in (reactors, generators, coolers, direct_producers) if p]
    if not pools or rng.random() < 0.15:
        return None
    pool = rng.choice(pools)
    if len(pool) == 1 or rng.random() < 0.7:
        return pool[0]
    return rng.choice(pool)


def _hill_climb(
    seed: Dict[TileId, EffectiveBuilding],
    buildable: List[TileId],
    reactors: List[EffectiveBuilding], generators: List[EffectiveBuilding],
    coolers: List[EffectiveBuilding], direct_producers: List[EffectiveBuilding],
    time_budget_s: float,
    neighbor_map: Optional[Dict[TileId, List[TileId]]] = None,
    rng: Optional[Rng] = None,
    max_steps: Optional[int] = None,
) -> Dict[TileId, EffectiveBuilding]:
    """
    `max_steps` caps the walk by iteration count and, when set, drives the
    temperature schedule by `step / max_steps` instead of elapsed wall time.
    With a fixed `rng` and a `time_budget_s` generous enough that the deadline
    never fires first, the walk is then fully deterministic: same seed, same
    result, bit for bit. That is what lets a run be replayed against the JS
    port of this solver. The solve pipeline itself never sets it -- wall time
    is the right budget in production, where per-step cost varies by island.
    """
    if time_budget_s <= 0 or not buildable:
        return seed
    if rng is None:
        rng = Rng(random.getrandbits(32))

    current = dict(seed)
    current_power, current_placements = simulate_island(current, neighbor_map)

    # The walk itself is free to pass through layouts containing overheating
    # buildings -- they are often one move away from good ones -- but only a
    # STABLE layout may be recorded as the best. Raw power alone would happily
    # settle on a layout that parks heat in a permanently offline generator,
    # which then has to be dismantled at the end, ending up worse than the best
    # stable layout the search already walked past.
    best_placement, best_power, _ = _stabilize(current, neighbor_map)
    # Highest raw score seen so far, used only to decide when an unstable
    # layout is promising enough to be worth stabilizing and re-scoring.
    best_raw_power = current_power

    def record_if_best(
        power: float,
        snapshot: Dict[TileId, EffectiveBuilding],
        placements: List[PlacedBuilding],
    ) -> None:
        """Records a candidate as the new best, but only in a stable form."""
        nonlocal best_placement, best_power, best_raw_power, stall

        if power <= best_power + EPS:
            return

        offline = _offline_producers(snapshot, placements)
        if not offline:
            best_power = power
            best_placement = dict(snapshot)
            stall = 0
            return

        # Unstable. Only worth the extra simulations when it is a new raw
        # high-water mark -- otherwise the walk would re-stabilize the same
        # unreachable peak on every visit.
        if power > best_raw_power + EPS:
            best_raw_power = power
            stabilized, stable_power, _ = _stabilize(snapshot, neighbor_map)
            if stable_power > best_power + EPS:
                best_power = stable_power
                best_placement = stabilized
                stall = 0

    top_cooler = coolers[0] if coolers else None
    top_generator = generators[0] if generators else None
    buildable_set = set(buildable)

    start_time = time.time()
    deadline = start_time + time_budget_s

    # Temperature is scaled to the size of one MOVE, not to the island's total
    # output. Changing a single tile is worth roughly one generator's power
    # wherever it happens, so scaling by total power made large islands run far
    # too hot: on the 67-tile map 1 island, ~23% of moves that each cost 7% of
    # the layout were being accepted, and the walk never climbed back.
    move_scale = (
        generators[0].effective_value * generator_energy_ratio(generators[0])
        if generators else 1.0
    )
    t_start = max(move_scale * 0.1, 1.0)
    t_min = 1e-4

    # Snap back to the best layout after a long run of no improvement. Without
    # this, one unlucky sequence of accepted downhill moves strands the walk in
    # a region it cannot climb out of for the rest of the budget.
    stall = 0
    stall_limit = max(2_000, len(buildable) * 200)

    step = 0
    batch_mask = 127

    while True:
        if max_steps is not None and step >= max_steps:
            break
        if (step & batch_mask) == 0:
            now = time.time()
            if now >= deadline:
                break
            if max_steps is not None:
                progress = min(1.0, step / max_steps)
            else:
                progress = min(1.0, max(0.0, (now - start_time) / time_budget_s))
            temperature = t_start * ((t_min / t_start) ** progress)

            if stall >= stall_limit:
                current = dict(best_placement)
                current_power, current_placements = simulate_island(current, neighbor_map)
                stall = 0

        step += 1
        stall += 1
        move_type = rng.random()

        if move_type < 0.15 and current_placements:
            uncooled = [
                p for p in current_placements
                if p.waste_heat_generated > EPS
                and not waste_is_covered(p.waste_heat_generated, p.cooling_received)
            ]
            wasted_reactors = [
                p for p in current_placements
                if p.heat_produced > EPS and p.heat_produced < p.base_value - EPS
            ]

            if uncooled and top_cooler and rng.random() < 0.6:
                target = rng.choice(uncooled)
                adj = _neighbors((target.x, target.y), buildable_set, neighbor_map)
                if adj:
                    pos = rng.choice(adj)
                    old = current.get(pos)
                    if old is not top_cooler:
                        current[pos] = top_cooler
                        power, placements = simulate_island(current, neighbor_map)
                        delta = power - current_power

                        exponent = delta / temperature if temperature > 0 else -100.0
                        if delta > EPS or (exponent > -50.0 and rng.random() < math.exp(exponent)):
                            current_power = power
                            current_placements = placements
                            record_if_best(power, current, placements)
                        else:
                            if old is None:
                                current.pop(pos, None)
                            else:
                                current[pos] = old
                        continue

            elif wasted_reactors and top_generator and rng.random() < 0.6:
                target = rng.choice(wasted_reactors)
                adj = _neighbors((target.x, target.y), buildable_set, neighbor_map)
                if adj:
                    pos = rng.choice(adj)
                    old = current.get(pos)
                    if old is not top_generator:
                        current[pos] = top_generator
                        power, placements = simulate_island(current, neighbor_map)
                        delta = power - current_power

                        exponent = delta / temperature if temperature > 0 else -100.0
                        if delta > EPS or (exponent > -50.0 and rng.random() < math.exp(exponent)):
                            current_power = power
                            current_placements = placements
                            record_if_best(power, current, placements)
                        else:
                            if old is None:
                                current.pop(pos, None)
                            else:
                                current[pos] = old
                        continue

        if move_type < 0.50 and len(buildable) >= 2:
            pos1 = rng.choice(buildable)
            adj_neighbors = _neighbors(pos1, buildable_set, neighbor_map)
            if adj_neighbors and rng.random() < 0.7:
                pos2 = rng.choice(adj_neighbors)
            else:
                pos2 = rng.choice(buildable)
                while pos2 == pos1:
                    pos2 = rng.choice(buildable)

            val1 = current.get(pos1)
            val2 = current.get(pos2)
            if val1 is val2:
                continue

            if val2 is not None:
                current[pos1] = val2
            else:
                current.pop(pos1, None)

            if val1 is not None:
                current[pos2] = val1
            else:
                current.pop(pos2, None)

            power, placements = simulate_island(current, neighbor_map)
            delta = power - current_power

            exponent = delta / temperature if temperature > 0 else -100.0
            if delta > EPS or (exponent > -50.0 and rng.random() < math.exp(exponent)):
                current_power = power
                current_placements = placements
                record_if_best(power, current, placements)
            else:
                if val1 is not None:
                    current[pos1] = val1
                else:
                    current.pop(pos1, None)

                if val2 is not None:
                    current[pos2] = val2
                else:
                    current.pop(pos2, None)
            continue

        pos = rng.choice(buildable)
        old = current.get(pos)
        new = _random_candidate(reactors, generators, coolers, direct_producers, rng)
        if new is old:
            continue

        if new is None:
            current.pop(pos, None)
        else:
            current[pos] = new

        power, placements = simulate_island(current, neighbor_map)
        delta = power - current_power

        exponent = delta / temperature if temperature > 0 else -100.0
        if delta > EPS or (exponent > -50.0 and rng.random() < math.exp(exponent)):
            current_power = power
            current_placements = placements
            record_if_best(power, current, placements)
        else:
            if old is None:
                current.pop(pos, None)
            else:
                current[pos] = old

    return best_placement


def _offline_producers(
    placement: Dict[TileId, EffectiveBuilding],
    placements: List[PlacedBuilding],
) -> List[TileId]:
    """
    Tiles holding a generator or direct producer that generates no power --
    either because it is overheating (waste above the cooling routed to it) or
    because it never received any heat at all.

    A layout containing one of these is not a valid answer: the goal is a
    fully stable grid where every producer runs, so these tiles are wasted at
    best and represent an overheating building at worst.
    """
    offline: List[TileId] = []
    for p in placements:
        pos = (p.x, p.y)
        building = placement.get(pos)
        if building is None:
            continue

        is_producer = building.type in ("generator", "direct_producer")
        if is_producer and (p.power_generated or 0.0) <= EPS:
            offline.append(pos)
    return offline


def _stabilize(
    placement: Dict[TileId, EffectiveBuilding],
    neighbor_map: Optional[Dict[TileId, List[TileId]]] = None,
) -> Tuple[Dict[TileId, EffectiveBuilding], float, List[PlacedBuilding]]:
    """
    Drops producers that generate no power until every remaining one is online.

    This has to iterate rather than delete them all in one pass: removing an
    offline generator hands the heat it was absorbing to its neighbours, which
    can push THEIR waste past what their coolers cover and take them offline in
    turn. Power can legitimately fall as a result -- a layout that only scores
    well by parking heat in an overheating building is not a layout we want.
    """
    current = dict(placement)
    power, placements = simulate_island(current, neighbor_map)

    while True:
        offline = _offline_producers(current, placements)
        if not offline:
            return current, power, placements

        for pos in offline:
            current.pop(pos, None)
        power, placements = simulate_island(current, neighbor_map)


def _target_compositions(
    tile_count: int,
    reactors: List[EffectiveBuilding],
    generators: List[EffectiveBuilding],
    coolers: List[EffectiveBuilding],
    top_k: int = _COMPOSITION_TARGETS,
) -> List[Tuple[float, List[EffectiveBuilding]]]:
    """
    The best MULTISETS of buildings for an island of this size, ignoring where
    they go -- highest theoretical power first.

    Which buildings to use is a tiny counting problem, not a search problem.
    For counts (n_reactor, n_generator, n_cooler) summing to the tile budget,
    the layout can convert at most

        min(reactor output, n_generator * H_max, n_cooler * C / WASTE_RATIO)

    of heat, so enumerating the O(tiles^2) splits and greedily filling the
    reactor tiles with the largest tiers that stay inside that budget gives the
    exact best composition. On the 67-tile map 1 island this returns
    13 neuro + 1 sauron_eye + 14 generator6 + 39 cooler6 -- the known optimum --
    in a few milliseconds, where the search alone plateaued 1.6% below it.

    Placement can still make a composition unachievable (a generator can only
    be fed by ADJACENT reactors), which is why several are returned, each with
    the power it would reach if it could be arranged perfectly: the caller
    tries them in order, and can skip any that could not beat what it already
    has.
    """
    if not reactors or not generators or not coolers or tile_count < 3:
        return []

    generator = generators[0]
    cooler = coolers[0]
    scored: List[Tuple[float, List[EffectiveBuilding]]] = []

    for n_gen in range(1, tile_count - 1):
        for n_cool in range(1, tile_count - n_gen):
            n_react = tile_count - n_gen - n_cool
            if n_react < 1:
                continue

            # Most heat this many generators, and this much cooling, can carry.
            waste_ratio = generator_waste_ratio(generator)
            if waste_ratio <= 0:
                continue
            budget = min(
                n_gen * generator.effective_value,
                (n_cool * cooler.effective_value) / waste_ratio,
            )

            # Two ways to fill the reactor tiles, and which one wins depends on
            # what is actually binding.
            #
            # Packing them with the largest tier maximizes heat. Overshooting
            # the budget costs nothing -- surplus heat is simply never absorbed
            # and power stays capped -- so this is what to do when generator or
            # cooling capacity is the limit.
            #
            # Stepping down through tiers to land just under the budget instead
            # matters when COOLING is the limit: the all-or-nothing rule shuts a
            # generator down entirely if its waste outruns the cooling reaching
            # it, so a smaller top-up reactor can be worth more than a larger
            # one. The 7-tile golden layout spends its last tile exactly this
            # way.
            fills: List[List[EffectiveBuilding]] = [[reactors[0]] * n_react]

            heat = 0.0
            mix: List[EffectiveBuilding] = []
            for tier in reactors[:_POLISH_REACTOR_TIERS]:
                if tier.effective_value <= 0:
                    continue
                take = min(n_react - len(mix), int((budget - heat) // tier.effective_value))
                if take > 0:
                    heat += take * tier.effective_value
                    mix.extend([tier] * take)
            if len(mix) == n_react and mix != fills[0]:
                fills.append(mix)

            for fill in fills:
                fill_heat = sum(b.effective_value for b in fill)
                absorbed = min(fill_heat, budget)
                power = absorbed * generator_energy_ratio(generator)
                if power > EPS:
                    scored.append((power, fill + [generator] * n_gen + [cooler] * n_cool))

    scored.sort(key=lambda entry: -entry[0])
    return scored[:top_k]


def _arrange_composition(
    composition: List[EffectiveBuilding],
    reference: Dict[TileId, EffectiveBuilding],
    buildable: List[TileId],
    deadline: float,
    neighbor_map: Optional[Dict[TileId, List[TileId]]] = None,
) -> Optional[Dict[TileId, EffectiveBuilding]]:
    """
    Places a fixed multiset of buildings, then improves the ARRANGEMENT only.

    Starting from `reference` (the best layout found so far), tiles are
    converted to match the target counts, choosing at each step the change that
    costs least power. The result is then improved with swaps, which move
    buildings around without changing what is on the board -- so every
    candidate keeps the target's global heat/cooling budget and the search is
    over arrangements alone.
    """
    if len(composition) > len(buildable):
        return None

    wanted = Counter(b.id for b in composition)
    by_id = {b.id: b for b in composition}
    buildable_set = set(buildable)
    current = {pos: b for pos, b in reference.items() if pos in buildable_set}

    # 1. Reconcile counts with the target, cheapest change first.
    while time.time() < deadline:
        have = Counter(b.id for b in current.values())
        surplus = [bid for bid in have if have[bid] > wanted.get(bid, 0)]
        deficit = [bid for bid in wanted if wanted[bid] > have.get(bid, 0)]
        empty = [pos for pos in buildable if pos not in current]

        if not deficit:
            # Too many buildings overall: drop the least useful surplus tile.
            if not surplus:
                break
            best_move, best_power = None, -1.0
            for pos, b in current.items():
                if b.id not in surplus:
                    continue
                trial = dict(current)
                del trial[pos]
                power, _ = simulate_island(trial, neighbor_map)
                if power > best_power:
                    best_power, best_move = power, pos
            if best_move is None:
                break
            del current[best_move]
            continue

        target_id = deficit[0]
        building = by_id[target_id]
        best_move, best_power = None, -1.0

        for pos in empty:
            trial = dict(current)
            trial[pos] = building
            power, _ = simulate_island(trial, neighbor_map)
            if power > best_power:
                best_power, best_move = power, pos
        if best_move is None:
            for pos, b in current.items():
                if b.id not in surplus:
                    continue
                trial = dict(current)
                trial[pos] = building
                power, _ = simulate_island(trial, neighbor_map)
                if power > best_power:
                    best_power, best_move = power, pos
        if best_move is None:
            return None
        current[best_move] = building

    if Counter(b.id for b in current.values()) != wanted:
        return None

    # 2. Improve the arrangement with swaps, which preserve the composition.
    # Only nearby pairs are tried: swapping two buildings changes the layout
    # solely through who they are adjacent to, so a swap between opposite ends
    # of the island is two independent local changes and is better found as
    # two separate moves. Restricting to Chebyshev distance 2 cuts the pairs
    # to a fraction of all-pairs on a large island.
    occupied = sorted(current)
    pairs = [
        (a, b)
        for i, a in enumerate(occupied)
        for b in occupied[i + 1:]
        if max(abs(a[0] - b[0]), abs(a[1] - b[1])) <= _SWAP_RADIUS
    ]

    while time.time() < deadline:
        base_power, _ = simulate_island(current, neighbor_map)
        best_gain, best_swap = 0.0, None

        for index, (a, b) in enumerate(pairs):
            if not (index & 63) and time.time() >= deadline:
                break
            if current[a] is current[b]:
                continue  # swapping identical buildings changes nothing
            current[a], current[b] = current[b], current[a]
            power, trial = simulate_island(current, neighbor_map)
            if power - base_power > best_gain and not _offline_producers(current, trial):
                best_gain, best_swap = power - base_power, (a, b)
            current[a], current[b] = current[b], current[a]

        if best_swap is None:
            break
        a, b = best_swap
        current[a], current[b] = current[b], current[a]

    return current


def _polish_candidates(
    reactors: List[EffectiveBuilding],
    generators: List[EffectiveBuilding],
    coolers: List[EffectiveBuilding],
    direct_producers: List[EffectiveBuilding],
) -> List[Optional[EffectiveBuilding]]:
    """
    The lean set of buildings worth trying on a tile during local repair.

    Generators and coolers jump 400x-4100x per tier, so only their top tier can
    ever appear in a good layout. Reactors only jump ~8x, which is small enough
    that a weaker one is genuinely useful for topping up a generator's spare
    heat capacity when there is leftover cooling, so a few reactor tiers are
    kept. Every extra candidate costs another full pass over the island.
    """
    candidates: List[Optional[EffectiveBuilding]] = list(reactors[:_POLISH_REACTOR_TIERS])
    if generators:
        candidates.append(generators[0])
    if coolers:
        candidates.append(coolers[0])
    if direct_producers:
        candidates.append(direct_producers[0])
    candidates.append(None)  # leaving the tile empty is a real option
    return candidates


def _greedy_polish(
    placement: Dict[TileId, EffectiveBuilding],
    buildable: List[TileId],
    candidates: List[Optional[EffectiveBuilding]],
    deadline: float,
    neighbor_map: Optional[Dict[TileId, List[TileId]]] = None,
) -> Tuple[Dict[TileId, EffectiveBuilding], float]:
    """
    Steepest-ascent repair: repeatedly applies the single-tile change that
    raises power the most, considering only stable layouts, until no single
    change helps.

    The annealing walk handles small islands well, but on a large, fully packed
    one nearly every single-tile change costs several percent, so the walk
    drifts downhill and rarely climbs back: measured on a 67-tile island, only
    1 evaluation in 26,000 beat its own starting layout, while 20 stable
    improving moves sat a single move away. A full sweep here costs
    |tiles| x |candidates| simulations -- a few hundred milliseconds on that
    island -- and finds them directly.
    """
    current = dict(placement)
    best_power, placements = simulate_island(current, neighbor_map)
    if _offline_producers(current, placements):
        current, best_power, _ = _stabilize(current, neighbor_map)

    while time.time() < deadline:
        best_gain = 0.0
        best_move: Optional[Tuple[TileId, Optional[EffectiveBuilding]]] = None

        for pos in buildable:
            if time.time() >= deadline:
                break
            held = current.get(pos)

            for building in candidates:
                if building is held:
                    continue

                if building is None:
                    current.pop(pos, None)
                else:
                    current[pos] = building

                power, trial = simulate_island(current, neighbor_map)
                if power - best_power > best_gain and not _offline_producers(current, trial):
                    best_gain = power - best_power
                    best_move = (pos, building)

                if held is None:
                    current.pop(pos, None)
                else:
                    current[pos] = held

        if best_move is None:
            break

        pos, building = best_move
        if building is None:
            current.pop(pos, None)
        else:
            current[pos] = building
        best_power += best_gain

    return current, best_power


def _prune_dead_weight(
    placement: Dict[TileId, EffectiveBuilding],
    neighbor_map: Optional[Dict[TileId, List[TileId]]] = None,
) -> Tuple[List[PlacedBuilding], float]:
    """
    Post-search cleanup step:
    1. Drops every producer generating 0 power, repeating until none remain.
    2. Sequentially tests removing reactors/coolers to eliminate redundant support structures.
    3. Guarantees a stable layout -- every returned producer is online -- with a
       minimal active tile footprint.

    Step 1 is unconditional: an overheating building is never acceptable, even
    when keeping it would score higher (see `_stabilize`). Step 2 is guarded,
    since removing support can only ever cost power.
    """
    if not placement:
        return [], 0.0

    # 1. Remove producers that generate no power (cascading)
    current_placement, best_power, placements = _stabilize(placement, neighbor_map)

    # 2. Greedy backward sweep: test removing support buildings (reactors & coolers)
    support_positions = [
        pos for pos, b in list(current_placement.items())
        if b.type in ("cooler", "reactor")
    ]

    for pos in support_positions:
        if pos not in current_placement:
            continue

        temp_building = current_placement.pop(pos)
        test_power, test_placements = simulate_island(current_placement, neighbor_map)

        # Power alone is not enough to accept a removal. Dropping a reactor can
        # starve one generator to zero while handing its heat to another that
        # had spare capacity, leaving total power unchanged but stranding an
        # idle generator on the board.
        if test_power >= best_power - EPS and not _offline_producers(
            current_placement, test_placements
        ):
            best_power = test_power
            placements = test_placements
        else:
            current_placement[pos] = temp_building

    return placements, best_power


# ---------------------------------------------------------------------------
# Right-sizing the finished layout
# ---------------------------------------------------------------------------

# The roles a finished layout can be re-tiered in. A direct producer always
# runs flat out on its own, so there is no slack in one to give back -- a
# smaller tier is simply less power, and the power guard below would reject it
# anyway. The other three are sized against a load the finished layout fixes,
# and any capacity above that load is money spent on a building that never uses
# it.
_DOWNGRADE_ROLES = ("cooler", "reactor", "generator")


def _covers(capacity: float, load: float) -> bool:
    """
    True when `capacity` meets `load` at the game's own relative tolerance.

    This is `physics.waste_is_covered`, whose parameters are named for the
    cooling case it was written for; the tolerance has to be relative here for
    the same reason it does there -- at 1e18 one ULP is already ~1e2, so an
    absolute epsilon would reject a tier that is exactly big enough.
    """
    return waste_is_covered(load, capacity)


def _tile_load(building: EffectiveBuilding, placed: PlacedBuilding) -> float:
    """
    What a placed building is actually doing, in the units its tier is sized in.

    Cooling sent for a cooler, heat sent for a reactor, heat absorbed for a
    generator -- the figure a replacement tier has to be able to match for the
    rest of the layout to keep behaving the same way.
    """
    if building.type == "cooler":
        return placed.cooling_provided
    if building.type == "reactor":
        return placed.heat_produced
    return placed.heat_consumed


def _downgrade_tiers(
    effective_buildings: List[EffectiveBuilding],
) -> Dict[str, List[EffectiveBuilding]]:
    """Each downgradable role's roster entries, smallest capacity first."""
    return {
        role: sorted(
            (b for b in effective_buildings if b.type == role),
            key=lambda b: b.effective_value,
        )
        for role in _DOWNGRADE_ROLES
    }


def _downgrade_oversized(
    placements: List[PlacedBuilding],
    power: float,
    effective_buildings: List[EffectiveBuilding],
    neighbor_map: Optional[Dict[TileId, List[TileId]]] = None,
) -> Tuple[List[PlacedBuilding], float]:
    """
    Final pass: replace every building with the smallest tier that still does
    the job the finished layout gives it.

    The search maximizes power, and power cannot tell a cooler running flat out
    from one running at 2%: both keep the same generators online, so both score
    identically and the search has no reason to prefer either. It therefore
    leaves the roster's top tier on tiles that need a twentieth of it, which
    costs the player real money for capacity that never runs. This is why the
    pass belongs after the search rather than inside it -- only once the layout
    stops moving is the load on each tile settled enough to size against.

    Covering the tile's current load is what makes a candidate plausible, not
    what makes it safe: shrinking a supplier changes the FairShare split, and
    the split is what decides which producers clear their cooling. So every
    swap is re-simulated and accepted only under the test `_prune_dead_weight`
    applies to a removal -- no power lost against the layout handed in, and no
    producer left offline. Power is defended against the figure this pass
    started from rather than against the running total, so a sequence of swaps
    cannot drift down one tolerance at a time.

    The sweep repeats to a fixpoint: downgrading a generator changes the waste
    its cooler has to absorb, which can free a cooler this sweep already walked
    past. It terminates because every accepted swap strictly lowers one tile's
    capacity and the ladders are finite.
    """
    if not placements:
        return placements, power

    by_id = {b.id: b for b in effective_buildings}
    current: Dict[TileId, EffectiveBuilding] = {}
    for p in placements:
        building = by_id.get(p.building_id)
        if building is None:
            # Everything the search places comes from this roster; a layout
            # holding anything else is not one this pass can reason about.
            return placements, power
        current[(p.x, p.y)] = building

    tiers = _downgrade_tiers(effective_buildings)
    order = sorted(current, key=lambda p: spatial_key(*p))
    by_pos = {(p.x, p.y): p for p in placements}
    floor = power

    changed = True
    while changed:
        changed = False

        for pos in order:
            building = current[pos]
            ladder = tiers.get(building.type)
            if not ladder:
                continue

            load = _tile_load(building, by_pos[pos])

            for candidate in ladder:
                if candidate.effective_value >= building.effective_value:
                    break  # ascending, so nothing smaller is left to try
                if not _covers(candidate.effective_value, load):
                    continue

                current[pos] = candidate
                test_power, test_placements = simulate_island(current, neighbor_map)

                if _covers(test_power, floor) and not _offline_producers(
                    current, test_placements
                ):
                    power = test_power
                    placements = test_placements
                    by_pos = {(q.x, q.y): q for q in placements}
                    changed = True
                    break

                current[pos] = building

    return placements, power


def solve_island(
    island: IslandSubGrid,
    effective_buildings: List[EffectiveBuilding],
    time_budget_s: float,
    rng_seed: Optional[int] = None,
) -> Tuple[List[PlacedBuilding], float]:
    """
    `rng_seed` fixes the random stream of the annealing walk. Same seed, same
    move sequence -- but stage deadlines are wall-clock, so where each stage
    stops (and the temperature at a given step) still varies slightly between
    runs; seeding narrows run-to-run variance rather than eliminating it. None
    draws a fresh seed, preserving the stochastic default.
    """
    buildable = _buildable_tiles(island.grid)
    if not buildable:
        return [], 0.0

    neighbor_map = build_neighbor_map(buildable)

    reactors = sorted(
        (b for b in effective_buildings if b.type == "reactor"),
        key=lambda b: -b.effective_value,
    )
    generators = sorted(
        (b for b in effective_buildings if b.type == "generator"),
        key=lambda b: -b.effective_value,
    )
    coolers = sorted(
        (b for b in effective_buildings if b.type == "cooler"),
        key=lambda b: -b.effective_value,
    )
    direct_producers = sorted(
        (b for b in effective_buildings if b.type == "direct_producer"),
        key=lambda b: -b.energy,
    )

    can_hub = bool(reactors and generators)
    can_dp = bool(direct_producers)
    if not coolers or not (can_hub or can_dp):
        return [], 0.0

    deadline = time.time() + time_budget_s
    seed = _construct_multi_start_seed(
        buildable, reactors, generators, coolers, direct_producers, deadline, neighbor_map
    )

    # Repair the seed before annealing, and again afterwards. Seed construction
    # lays out self-sufficient hubs (one generator plus the reactors and coolers
    # it needs on its own), so it systematically misses layouts where
    # neighbouring hubs share a cooler or a reactor; repair finds those directly
    # instead of hoping the walk stumbles into them. Both passes stop as soon as
    # nothing improves, so on small islands they cost almost nothing.
    candidates = _polish_candidates(reactors, generators, coolers, direct_producers)
    polish_budget = time_budget_s * _POLISH_SHARE

    polish_started = time.time()
    placement, best_power = _greedy_polish(
        seed, buildable, candidates,
        min(deadline, polish_started + polish_budget), neighbor_map,
    )
    # How long a full repair actually took here, used below to reserve just
    # enough for the closing pass instead of a fixed (over-generous) share.
    polish_elapsed = time.time() - polish_started

    # Composition-first attempt, BEFORE annealing so its result becomes the
    # walk's starting point rather than competing with it for time. What to
    # build is a counting problem with an exact answer, so solve that directly
    # instead of hoping the walk stumbles onto the right multiset. A target
    # whose perfect-arrangement power cannot beat the layout already in hand is
    # skipped, which costs nothing on islands where the search is already at
    # the bound.
    composition_deadline = min(deadline, time.time() + time_budget_s * _COMPOSITION_SHARE)
    for ceiling, composition in _target_compositions(
        len(buildable), reactors, generators, coolers
    ):
        if time.time() >= composition_deadline or ceiling <= best_power + EPS:
            break

        arranged = _arrange_composition(
            composition, placement, buildable, composition_deadline, neighbor_map
        )
        if arranged is None:
            continue

        arranged, arranged_power = _greedy_polish(
            arranged, buildable, candidates, composition_deadline, neighbor_map
        )
        if arranged_power > best_power + EPS:
            placement, best_power = arranged, arranged_power

    # Give the walk everything except what the closing repair needs. Reserving
    # the full polish share left roughly a quarter of the budget unspent, since
    # repair converges long before its cap.
    final_reserve = min(polish_budget, max(polish_elapsed, time_budget_s * 0.05))
    anneal_s = (deadline - time.time()) - final_reserve
    rng = Rng(rng_seed if rng_seed is not None else random.getrandbits(32))

    # ...and then hand back whatever that repair did not use, as another round
    # of walk-then-repair. The reserve above is a guess made before the layout
    # exists; on a post-anneal layout the closing repair is usually one
    # fruitless sweep, so the guess left the tail of the budget unspent -- a 30s
    # solve returned at 28.5s. Each further round is a fresh short anneal from
    # the layout in hand, which cannot lose power: `_hill_climb` starts its best
    # from the (stabilized) layout it is given and only ever returns a stable
    # layout at least as good, and repair on a stable layout only climbs.
    #
    # The rounds shrink -- each is what the previous round's repair handed back
    # -- so this converges on the deadline rather than looping indefinitely.
    min_round_s = max(_RECLAIM_MIN_ROUND_S, time_budget_s * _RECLAIM_MIN_ROUND_SHARE)
    while True:
        if anneal_s > 0:
            placement = _hill_climb(
                placement, buildable, reactors, generators, coolers, direct_producers,
                anneal_s, neighbor_map, rng,
            )

        polish_started = time.time()
        placement, best_power = _greedy_polish(
            placement, buildable, candidates, deadline, neighbor_map
        )
        polish_elapsed = time.time() - polish_started

        if anneal_s <= 0:
            break

        # The repair is capped by the deadline, so being cut mid-sweep costs it
        # improvements but never validity -- every move it applies was checked
        # for stability first. The reserve is therefore a tuning choice, not a
        # correctness one, which is why it may be squeezed.
        remaining = deadline - time.time()
        reserve = min(
            max(polish_elapsed * _RECLAIM_POLISH_MARGIN, _RECLAIM_MIN_ROUND_S),
            remaining * _RECLAIM_MAX_RESERVE_FRACTION,
        )
        anneal_s = remaining - reserve
        if anneal_s < min_round_s:
            break

    # Post-Search Cleanup Pass
    final_placements, final_power = _prune_dead_weight(placement, neighbor_map)

    # ...then right-size what survived. The search had no reason to prefer the
    # tier a tile actually needs over the biggest one in the roster, because
    # both score the same.
    final_placements, final_power = _downgrade_oversized(
        final_placements, final_power, effective_buildings, neighbor_map
    )
    return final_placements, final_power
