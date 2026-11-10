import type { BuildingCategory } from "@reactor2/solver";
import { Cpu, Snowflake, Zap } from "lucide-svelte";

/**
 * The name and icon of each kind of building, as the solver board's kind
 * filter and step mode's build order show them — the same three words, and
 * the icons the Edit board's building ribbon uses.
 * A `Record` over `BuildingCategory`, so a fourth kind fails to typecheck.
 */
export const KIND_META: Record<
  BuildingCategory,
  { label: string; icon: typeof Cpu }
> = {
  generator: { label: "Generators", icon: Cpu },
  cooler: { label: "Coolers", icon: Snowflake },
  heat_producer: { label: "Reactors", icon: Zap },
};
