<script lang="ts">
  import { TIME_LAB, type TimeLabResearch } from "@reactor2/solver";
  import { Minus, Plus } from "lucide-svelte";
  import {
    configState,
    layoutState,
    timelineState,
    uiState,
  } from "../../state";
  import { asset, formatSpan } from "../../utils";
  import ModalShell from "./ModalShell.svelte";

  /*
   * What to buy with the Chronons a Time Jump leaves: every Time Lab research,
   * its level in the game, and a plan of levels on top priced against the
   * budget — what the timeline panel's target says the player would hold
   * after the jump, plus the +88 when they mean to enter a new anomaly.
   *
   * It measures what it can and says nothing where it cannot. Chronon Reactor
   * is priced in Chronons a jump, at the energy the jump is made at; the three
   * stat researches in power, by re-scoring the player's own boards at the
   * higher level (a floor: a solve re-run at the new rating can do better).
   * The economy researches move cash, research and obstacle clocks the
   * optimizer does not model, so they get their figure and their cost only —
   * a number invented for them would be worse than none.
   */

  const GROUPS: { label: string; ids: string[] }[] = [
    { label: "Chronons", ids: ["chronon_reactor"] },
    {
      label: "Power",
      ids: ["stellar_forge", "infinite_grid", "absolute_zero"],
    },
    {
      label: "Economy",
      ids: [
        "archives_beyond_time",
        "chrono_accelerator",
        "zero_time_protocol",
        "quantum_exchange",
        "quantum_replicator",
        "phase_breaker",
        "erased_from_time",
        "skip_city",
      ],
    },
  ];
  const byId = new Map(TIME_LAB.map((r) => [r.id, r]));

  let open = $derived(uiState.activeModal === "timeLab");
  let levels = $derived(timelineState.timeLabLevels);
  let plan = $derived(timelineState.timeLabPlan);
  let budget = $derived(timelineState.planBudget);
  let cost = $derived(timelineState.planCost);
  let power = $derived(timelineState.planPower);
  let eta = $derived(timelineState.targetEta);
  let bonusNames = $derived(
    timelineState.unenteredAnomalies.map((a) => a.name).join(" or "),
  );

  // Re-price the plan's power whenever it, the roster or a board changes —
  // and only while the planner is open, since it re-scores every island.
  $effect(() => {
    if (!open) return;
    void configState.buildingUpgrades;
    void layoutState.savedGrids;
    void timelineState.refreshPlanPower();
  });

  const count = (n: number) => Math.round(n).toLocaleString("en-US");
  const pct = (ratio: number) => {
    const p = (ratio - 1) * 100;
    return `${p >= 0 ? "+" : ""}${Math.abs(p) >= 10 ? p.toFixed(0) : p.toFixed(1)}%`;
  };

  /** The research's figure at `level`, as the game words it. */
  function valueAt(r: TimeLabResearch, level: number): string {
    if (r.kind === "level" || !r.values)
      return level > 0 ? `level ${level}` : "none";
    const v = level > 0 ? r.values[level - 1] : 0;
    switch (r.kind) {
      case "bonus":
        return r.id === "chronon_reactor"
          ? `×${(1 + v).toFixed(2)}`
          : `+${Math.round(v * 100)}%`;
      case "reduction":
        return `−${Math.round(v * 100)}%`;
      case "window":
        return v > 0 ? formatSpan(v) : "none";
    }
  }

  /** What one more level of `r` would do, where the planner can say. */
  function impact(r: TimeLabResearch): string | null {
    if (r.id === "chronon_reactor") {
      const gain = timelineState.reactorNextGain;
      return gain === null ? null : `+${count(gain)} Chronons every jump`;
    }
    const next = power?.next[r.id];
    if (next === undefined || !power || power.plan <= 0) return null;
    // Under a twentieth of a percent is no gain at all on these layouts: the
    // research raises a figure the boards are not short of.
    if (next / power.plan - 1 < 0.0005)
      return "no gain on your boards as built";
    return `${pct(next / power.plan)} power on your boards`;
  }
</script>

{#if open && levels && budget !== null}
  <ModalShell title="Time Lab planner" onClose={() => uiState.closeModal()}>
    <section class="summary">
      <dl>
        <dt>To spend after the jump</dt>
        <dd>
          <img
            src={asset("icons/icon_chronon.webp")}
            alt=""
            width="14"
            height="14"
          />
          {count(budget)}
        </dd>
        <dt>Planned</dt>
        <dd>{count(cost)}</dd>
        <dt>Left</dt>
        <dd class:over={budget - cost < 0}>{count(budget - cost)}</dd>
        {#if power && power.plan !== power.base}
          <dt>Plan's power</dt>
          <dd>{pct(power.plan / power.base)}</dd>
        {/if}
      </dl>
      <p class="aside">
        {eta && eta.seconds
          ? `Jumping at ${count(eta.target)}, the panel's target.`
          : "Jumping now."}
        {#if bonusNames}
          <label class="bonus">
            <input type="checkbox" bind:checked={timelineState.planWithBonus} />
            Count the +88 for entering {bonusNames}
          </label>
        {/if}
      </p>
    </section>

    {#each GROUPS as group (group.label)}
      <h3>{group.label}</h3>
      <ul>
        {#each group.ids as id (id)}
          {@const r = byId.get(id)!}
          {@const now = levels[id]}
          {@const extra = plan[id] ?? 0}
          {@const max = r.costs.length}
          {@const to = now + extra}
          {@const note = to < max ? impact(r) : null}
          <li class:planned={extra > 0}>
            <img
              class="badge"
              src={asset(`icons/prestige_${id}.webp`)}
              alt=""
              width="36"
              height="36"
            />
            <div class="info">
              <div class="title">
                <span class="name">{r.name}</span>
                <!-- Spaces as text: markup between them would collapse it. -->
                <span class="level"
                  >Lv {now}{#if extra}<span class="up">{` → ${to}`}</span
                    >{/if}/{max}</span
                >
              </div>
              <div class="effect">
                {r.effect}:
                <strong>{valueAt(r, now)}</strong>{#if extra}{" → "}<strong
                    class="up">{valueAt(r, to)}</strong
                  >{/if}
              </div>
              <div class="next">
                {#if to < max}
                  Next {count(r.costs[to])}{#if note}<span class="impact"
                      >{` · ${note}`}</span
                    >{/if}
                {:else}
                  {extra ? "Maxed with this plan" : "Maxed"}
                {/if}
              </div>
            </div>
            <div class="stepper">
              {#if extra > 0}
                <button
                  type="button"
                  aria-label="One level fewer of {r.name}"
                  onclick={() => timelineState.planLevels(id, -1)}
                >
                  <Minus size={14} />
                </button>
              {/if}
              {#if to < max}
                <button
                  type="button"
                  aria-label="Plan one more level of {r.name}"
                  onclick={() => timelineState.planLevels(id, 1)}
                >
                  <Plus size={14} />
                </button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/each}

    {#if cost > 0}
      <button
        type="button"
        class="clear"
        onclick={() => timelineState.clearTimeLabPlan()}
      >
        Clear plan
      </button>
    {/if}
  </ModalShell>
{/if}

<style>
  .summary {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.7rem 0.8rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-sunken);
  }

  dl {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.25rem 0.75rem;
    margin: 0;
    font-size: var(--fs-sm);
  }

  dt {
    color: var(--text-muted);
  }

  dd {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.3rem;
    margin: 0;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  /* Over budget is a limit reached, which is `--warn`'s. */
  dd.over {
    color: var(--warn);
  }

  .aside {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }

  .bonus {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--text-muted);
    cursor: pointer;
  }

  .bonus input {
    accent-color: var(--accent);
  }

  h3 {
    margin: 1rem 0 0.4rem;
    font-size: var(--fs-2xs);
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
    color: var(--text-muted);
  }

  ul {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  /* A row the plan buys into: a selection, which is what `--accent` means. */
  li.planned {
    border-color: var(--accent-dim);
    background: var(--accent-faint);
  }

  .badge {
    flex-shrink: 0;
    width: 36px;
    height: 36px;
  }

  .info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .title {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .name {
    font-size: var(--fs-sm);
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .level {
    flex-shrink: 0;
    font-size: var(--fs-xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .effect {
    font-size: var(--fs-xs);
    color: var(--text-muted);
  }

  .effect strong {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .up {
    color: var(--accent);
  }

  .next {
    font-size: var(--fs-xs);
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }

  .impact {
    color: var(--text-muted);
  }

  .stepper {
    display: flex;
    gap: 0.3rem;
    flex-shrink: 0;
  }

  .stepper button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--ctl-sm);
    height: var(--ctl-sm);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    cursor: pointer;
  }

  .stepper button:hover {
    background: var(--surface-raised);
    border-color: var(--accent-dim);
  }

  @media (pointer: coarse) {
    .stepper button {
      width: var(--tap);
      height: var(--tap);
    }
  }

  .clear {
    align-self: flex-start;
    margin-top: 0.9rem;
    padding: 0.35rem 0.7rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--fs-sm);
    font-weight: 600;
    cursor: pointer;
  }

  .clear:hover {
    background: var(--surface-raised);
    color: var(--text);
  }
</style>
