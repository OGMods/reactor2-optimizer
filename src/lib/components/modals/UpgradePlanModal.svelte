<script lang="ts">
  import {
    BUILDINGS,
    buildingCategory,
    formatNumber,
    MAX_UPGRADE_STEPS,
    type BuildingCategory,
    type BuildingDefinition,
  } from "@reactor2/solver";
  import { ChevronDown, ChevronUp, Info, Plus, X } from "lucide-svelte";
  import { configState, uiState } from "../../state";
  import { asset } from "../../utils";
  import { headlineValue, statForType } from "../statIcons";
  import ModalShell from "./ModalShell.svelte";

  /*
   * The upgrade plan editor: the next few tiers the player means to buy, in
   * the order they will buy them.
   *
   * A step is one building and the tier it goes to, drawn in the catalogue
   * card's idiom — sprite, name, a row of numbered tier buttons — so it reads
   * as the same building the roster lists. Its building is fixed once added;
   * the tier row is what edits it. Changing a step's building is removing it
   * and adding another, which is one tap each and needs no picker of its own.
   *
   * The order is the buying order and it decides what the layout has to
   * survive, so steps move up and down rather than staying in the order they
   * happened to be added.
   *
   * The picker offers only buildings with a tier left to buy once the steps
   * above are counted, so a maxed building never appears and a step can never
   * be a no-op when it is made. One made earlier can become one — the tier was
   * bought — and stays in the list, dimmed, saying so.
   */

  const GROUPS: { category: BuildingCategory; label: string }[] = [
    { category: "generator", label: "Generators" },
    { category: "cooler", label: "Coolers" },
    { category: "heat_producer", label: "Reactors" },
  ];

  const iconFor = (id: string) => asset(`icons/${id}.webp`);

  /** Each step with the tier its building stands at when the step comes up. */
  let rows = $derived.by(() => {
    const running: Record<string, number> = {
      ...configState.buildingUpgrades,
    };
    return configState.upgradePlan.map((step, i) => {
      const def = BUILDINGS.find((b) => b.id === step.buildingId);
      const from = running[step.buildingId];
      const effective = configState.resolvedPlan.effective[i];
      if (effective) running[step.buildingId] = step.level;
      return { step, def, from, effective };
    });
  });

  let full = $derived(configState.upgradePlan.length >= MAX_UPGRADE_STEPS);

  /**
   * Buildings a new step could name, by the roster's own groups and
   * strongest-first — the order the HUD palette uses, since the building a
   * player upgrades next is almost always their best one, and the catalogue is
   * authored weakest-first.
   */
  let candidates = $derived(
    GROUPS.map((g) => ({
      label: g.label,
      buildings: BUILDINGS.filter(
        (b) =>
          buildingCategory(b.type) === g.category && configState.canPlan(b.id),
      ).sort(
        (a, b) =>
          headlineValue(b, configState.resolvedPlan.target[b.id]) -
          headlineValue(a, configState.resolvedPlan.target[a.id]),
      ),
    })).filter((g) => g.buildings.length > 0),
  );

  /*
   * The picker is open by default on an empty plan, where it is the only
   * thing to do, and behind a button otherwise, where the steps are what the
   * dialog was opened to read.
   */
  let picking = $state(false);
  let showPicker = $derived(
    !full && (picking || configState.upgradePlan.length === 0),
  );

  function pick(id: string) {
    configState.addPlanStep(id);
    picking = false;
  }

  /** Why a step no longer counts, in the terms the player acted in. */
  function idleReason(
    def: BuildingDefinition | undefined,
    from: number | undefined,
    level: number,
  ): string {
    if (!def || from === undefined) return "Locked";
    if (level <= from) return "Already bought";
    return "No effect";
  }

  function levelsAbove(def: BuildingDefinition, from: number): number[] {
    const out: number[] = [];
    for (let lvl = from + 1; lvl < def.levels.length; lvl++) out.push(lvl);
    return out;
  }
</script>

{#if uiState.activeModal === "upgradePlan"}
  <ModalShell title="Upgrade plan" onClose={() => uiState.closeModal()}>
    <p class="lead">
      The upgrades you'll buy next, in order. A run then solves for the last one
      while keeping the layout running at every step, so buying them never
      overheats what you built. The board still shows today's tiers.
    </p>

    <!--
      The trade the plan makes, said before anyone runs one: it is optimal only
      once every step is bought. Measured, today's power under a plan ran from
      57% to 98% of a plain solve's, and a player who did not expect that reads
      the lower figure as the solver getting worse. Neutral rather than
      `--warn`: nothing is wrong, this is what the plan is for.
    -->
    <p class="note-box">
      <Info size={14} />
      <span>
        <strong>Only the last step is optimal.</strong> Until every upgrade is bought,
        the layout makes less power than a normal solve would, because it keeps room
        for what's coming. The readout shows power now and after the upgrades.
      </span>
    </p>

    {#if rows.length > 0}
      <ol class="steps">
        {#each rows as row, i (i)}
          <li class="step" class:idle={!row.effective}>
            <span class="step-no" aria-hidden="true">{i + 1}</span>

            <img class="sprite" src={iconFor(row.step.buildingId)} alt="" />

            <div class="step-body">
              <div class="step-head">
                <span class="name">{row.def?.name ?? row.step.buildingId}</span>
                <span class="step-tools">
                  <button
                    type="button"
                    class="icon-btn"
                    disabled={i === 0}
                    aria-label="Buy step {i + 1} earlier"
                    onclick={() => configState.movePlanStep(i, -1)}
                  >
                    <ChevronUp size={14} />
                  </button>
                  <button
                    type="button"
                    class="icon-btn"
                    disabled={i === rows.length - 1}
                    aria-label="Buy step {i + 1} later"
                    onclick={() => configState.movePlanStep(i, 1)}
                  >
                    <ChevronDown size={14} />
                  </button>
                  <button
                    type="button"
                    class="icon-btn"
                    aria-label="Remove step {i + 1}"
                    onclick={() => configState.removePlanStep(i)}
                  >
                    <X size={14} />
                  </button>
                </span>
              </div>

              {#if row.effective && row.def && row.from !== undefined}
                <div class="tier-row">
                  <span class="from">Lv. {row.from + 1} →</span>
                  <span class="tiers">
                    {#each levelsAbove(row.def, row.from) as lvl (lvl)}
                      <button
                        type="button"
                        class="tier-btn"
                        class:active={row.step.level === lvl}
                        aria-label="{row.def.name}: level {lvl + 1}"
                        aria-pressed={row.step.level === lvl}
                        onclick={() =>
                          configState.setPlanStep(i, {
                            buildingId: row.step.buildingId,
                            level: lvl,
                          })}
                      >
                        {lvl + 1}
                      </button>
                    {/each}
                  </span>
                </div>
              {:else}
                <span class="note">
                  Lv. {row.step.level + 1} · {idleReason(
                    row.def,
                    row.from,
                    row.step.level,
                  )}
                </span>
              {/if}
            </div>
          </li>
        {/each}
      </ol>
    {/if}

    {#if showPicker}
      <div class="picker">
        <div class="picker-head">
          <span>{rows.length === 0 ? "Pick an upgrade" : "Add an upgrade"}</span
          >
          {#if rows.length > 0}
            <button
              type="button"
              class="icon-btn"
              aria-label="Cancel"
              onclick={() => (picking = false)}
            >
              <X size={14} />
            </button>
          {/if}
        </div>

        {#each candidates as group (group.label)}
          <div class="group-label">{group.label}</div>
          <div class="options">
            {#each group.buildings as b (b.id)}
              {@const at = configState.resolvedPlan.target[b.id]}
              {@const stat = statForType(b.type)}
              <button type="button" class="option" onclick={() => pick(b.id)}>
                <img class="sprite small" src={iconFor(b.id)} alt="" />
                <span class="option-text">
                  <span class="name">{b.name}</span>
                  <span class="option-stat">
                    <img src={stat.icon} alt="" />
                    {formatNumber(headlineValue(b, at))}
                  </span>
                </span>
                <span class="option-level">Lv. {at + 1}/{b.levels.length}</span>
              </button>
            {/each}
          </div>
        {:else}
          <p class="lead">
            Nothing to plan: every unlocked building is at its top level.
          </p>
        {/each}
      </div>
    {:else if !full}
      <button type="button" class="add" onclick={() => (picking = true)}>
        <Plus size={14} />
        Add an upgrade
      </button>
    {:else}
      <p class="lead small">
        A plan holds up to {MAX_UPGRADE_STEPS} upgrades.
      </p>
    {/if}
  </ModalShell>
{/if}

<style>
  .lead {
    margin: 0;
    font-size: var(--fs-sm);
    line-height: 1.45;
    color: var(--text-muted);
  }

  .note-box {
    display: flex;
    align-items: flex-start;
    gap: 0.45rem;
    margin: 0;
    padding: 0.5rem 0.6rem;
    background: var(--surface-inset);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: var(--fs-xs);
    line-height: 1.45;
    color: var(--text-muted);
  }

  .note-box :global(svg) {
    flex: 0 0 auto;
    margin-top: 0.1rem;
    color: var(--text-dim);
  }

  .note-box strong {
    color: var(--text);
  }

  .lead.small {
    font-size: var(--fs-xs);
    color: var(--text-dim);
  }

  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .step {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.5rem;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }

  /* The roster's idiom for "here, but not counted". */
  .step.idle {
    opacity: 0.55;
  }

  .step-no {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    margin-top: 0.55rem;
    border-radius: var(--radius-pill);
    background: var(--accent-bg);
    color: var(--accent);
    font-size: var(--fs-2xs);
    font-weight: 700;
  }

  .sprite {
    flex: 0 0 auto;
    width: 36px;
    height: 36px;
    object-fit: contain;
  }

  .sprite.small {
    width: 28px;
    height: 28px;
  }

  .step-body {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    flex: 1;
    min-width: 0;
  }

  .step-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
    min-width: 0;
  }

  .name {
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .step-tools {
    display: flex;
    flex: 0 0 auto;
  }

  .icon-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-xs);
    color: var(--text-dim);
    cursor: pointer;
  }

  .icon-btn:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--border);
  }

  .icon-btn:disabled {
    opacity: 0.3;
    cursor: default;
  }

  .tier-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .from {
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .tiers {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
  }

  /* `PrestigeUpgrades`' tier buttons, which take the theme's accent. */
  .tier-btn {
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    background: var(--surface-inset);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    color: var(--text-dim);
    font-size: var(--fs-2xs);
    font-weight: 700;
    cursor: pointer;
    transition: all var(--dur-fast) var(--ease);
  }

  .tier-btn:hover {
    color: var(--text);
    border-color: var(--accent-dim);
  }

  .tier-btn.active {
    background: var(--accent-bg);
    border-color: var(--accent);
    color: var(--accent);
  }

  .note {
    font-size: var(--fs-2xs);
    font-weight: 600;
    text-transform: uppercase;
    color: var(--text-dim);
  }

  .picker {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .picker-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--text);
  }

  .group-label {
    margin-top: 0.25rem;
    font-size: var(--fs-2xs);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-dim);
  }

  .options {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    min-height: var(--ctl);
    padding: 0.25rem 0.5rem;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    text-align: left;
    cursor: pointer;
    transition: border-color var(--dur-fast) var(--ease);
  }

  .option:hover {
    border-color: var(--accent-dim);
  }

  .option-text {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }

  .option-stat {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    font-size: var(--fs-2xs);
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }

  .option-stat img {
    width: 11px;
    height: 11px;
    object-fit: contain;
  }

  .option-level {
    flex: 0 0 auto;
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }

  .add {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    width: 100%;
    min-height: var(--ctl);
    background: transparent;
    border: 1px dashed var(--accent-dim);
    border-radius: var(--radius-sm);
    color: var(--accent);
    font-size: var(--fs-sm);
    font-weight: 600;
    cursor: pointer;
  }

  .add:hover {
    background: var(--accent-bg);
  }

  @media (pointer: coarse) {
    /* `--ctl` rather than `--tap`: three of these share a row with the name,
       and at 44px each the name had barely a word of room on a phone. */
    .icon-btn {
      width: var(--ctl);
      height: var(--ctl);
    }

    .tier-btn {
      width: 34px;
      height: 34px;
      font-size: var(--fs-base);
    }

    .tiers {
      gap: 6px;
    }

    .option {
      min-height: var(--tap);
    }
  }
</style>
