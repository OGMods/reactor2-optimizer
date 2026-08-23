"""
Building-placement optimizer.

The authoritative rules this implements -- grid, adjacency, heat/cooling
distribution via "FairShare + Augmenting Repair", the placement/simulation
model -- are in docs/game-logic.md.

Re-exports are resolved lazily (PEP 562). `solver.types` is imported by leaf
modules that `solver.solver` itself depends on (`grid`), so eagerly importing
the orchestrator here would make `import solver.types` a circular import
whenever the leaf module is imported first. Attribute access on this package
is unchanged: `from solver import solve` works exactly as before.
"""

from typing import TYPE_CHECKING

if TYPE_CHECKING:  # import-time only for type checkers; no runtime cycle
    from solver.report import print_summary, verify
    from solver.solver import DEFAULT_TIME_BUDGET_S, solve

__all__ = ["solve", "verify", "print_summary", "DEFAULT_TIME_BUDGET_S"]

_EXPORTS = {
    "solve": "solver.solver",
    "DEFAULT_TIME_BUDGET_S": "solver.solver",
    "verify": "solver.report",
    "print_summary": "solver.report",
}


def __getattr__(name: str):
    module_path = _EXPORTS.get(name)
    if module_path is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

    import importlib

    return getattr(importlib.import_module(module_path), name)


def __dir__():
    return sorted(__all__)
