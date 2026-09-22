<script lang="ts">
  import { PRESTIGE_UPGRADES, prestigeMultiplier } from "@reactor2/solver";
  import { configState } from "../../state";
  import { asset } from "../../utils/assetUrl";

  /**
   * The Time Lab research that changes what buildings are worth.
   *
   * Only the three the solver can feel are listed — `PRESTIGE_UPGRADES` says
   * which of the game's ten those are and why the other seven are not: the
   * rest change the economy around the board rather than anything on it.
   *
   * **Toggled and levelled exactly like a building**, down to the edge stripe
   * and the disabled tier row: both are "what has the player got", both are
   * picked in this panel, and the roster next door already taught the gesture.
   * Unlike the anomaly below, these stack rather than exclude — so each is its
   * own card rather than a choice among cards.
   */

  const iconFor = (id: string) => asset(`icons/prestige_${id}.webp`);

  /**
   * The game prints the bonus, not the factor: "+100%", never "×2". It authors
   * `BonusPercentage` and derives the multiplier from it, so printing the
   * multiplier here would be showing the player a number their own game never
   * says. `Math.round` on a tenth of a percent, so 2.25 cannot surface as
   * 225.00000000000003.
   */
  /**
   * Clamped the same way `prestigeScales` clamps, and for the same reason: the
   * level comes out of `localStorage`, so a record from a build with six levels
   * indexes past this table. Unclamped the card printed "+NaN%" while the solver
   * quietly ran at the top level — the two disagreeing about the same save.
   */
  function bonusAt(bonuses: readonly number[], level: number): number {
    return bonuses[Math.max(0, Math.min(level, bonuses.length - 1))];
  }

  function bonusLabel(bonus: number): string {
    const pct = Math.round(bonus * 1000) / 10;
    return `+${pct}%`;
  }

  function onKeyDown(e: KeyboardEvent, id: string) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      configState.toggleResearch(id);
    }
  }
</script>

<div class="section-box">
  <div class="section-title">
    <span>Research</span>
  </div>

  {#each PRESTIGE_UPGRADES as upgrade (upgrade.id)}
    {@const on = configState.isResearchEnabled(upgrade.id)}
    {@const level = configState.researchLevel(upgrade.id)}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="upgrade-card"
      class:disabled={!on}
      role="button"
      tabindex="0"
      aria-pressed={on}
      onclick={() => configState.toggleResearch(upgrade.id)}
      onkeydown={(e) => onKeyDown(e, upgrade.id)}
    >
      <!-- The same edge stripe the roster uses, saying the same thing: is this
           one of the things the solver is allowed to count. -->
      <div class="unlock-stripe" class:on></div>

      <div class="card-body">
        <div class="main-row">
          <span class="icon-frame">
            <img src={iconFor(upgrade.id)} alt="" class="upgrade-icon" />
          </span>

          <span class="info">
            <span class="name-row">
              <span class="name">{upgrade.name}</span>
              <span class="factor" class:on>
                {on
                  ? bonusLabel(bonusAt(upgrade.bonuses, level))
                  : upgrade.effect}
              </span>
            </span>
            <span class="effect">{upgrade.description}</span>
          </span>
        </div>

        <!--
          No `stopPropagation` on this row — only on the buttons themselves.
          On the row it covers the whole width, including the empty space past
          the last number, so a press there hit nothing and toggled nothing: a
          dead strip across the card whose one visible job is to be clicked.
        -->
        <div class="levels">
          <span class="lbl">Level</span>
          <div class="tiers">
            {#each upgrade.bonuses as bonus, idx (idx)}
              <button
                type="button"
                class="tier-btn"
                class:active={on && level === idx}
                disabled={!on}
                title="+{Math.round(bonus * 1000) / 10}% (×{prestigeMultiplier(
                  bonus,
                )})"
                aria-label="{upgrade.name}: level {idx + 1}"
                onclick={(e) => {
                  e.stopPropagation();
                  configState.setResearchLevel(upgrade.id, idx);
                }}
              >
                {idx + 1}
              </button>
            {/each}
          </div>
        </div>
      </div>
    </div>
  {/each}
</div>

<style>
  .section-box {
    margin-bottom: 1.5rem;
  }

  .section-title {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: var(--fs-md);
    font-weight: 600;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 0.6rem;
  }

  .upgrade-card {
    position: relative;
    display: flex;
    align-items: stretch;
    width: 100%;
    margin-bottom: 0.5rem;
    background: var(--anomaly-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    cursor: pointer;
    transition:
      border-color var(--dur-fast) var(--ease),
      opacity var(--dur-fast) var(--ease);
  }

  .upgrade-card:hover {
    border-color: var(--accent-dim);
  }

  /*
   * Dimmed rather than hidden or greyed to a different colour: the roster's own
   * idiom for a building that is locked, and the same reading — it is still
   * here, it is just not something the solver may count.
   */
  .upgrade-card.disabled {
    opacity: 0.55;
  }

  .unlock-stripe {
    flex: 0 0 3px;
    background: transparent;
    transition: background var(--dur-fast) var(--ease);
  }

  .unlock-stripe.on {
    background: var(--accent);
  }

  .card-body {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    flex: 1;
    min-width: 0;
    padding: 0.5rem 0.55rem;
  }

  .main-row {
    display: flex;
    align-items: flex-start;
    gap: 0.55rem;
    min-width: 0;
  }

  .icon-frame {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 30px;
    height: 30px;
  }

  .upgrade-icon {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  /*
   * `flex: 1` is what makes the card look full width. Without it this column is
   * only as wide as its own longest line, so on an upgrade with a short
   * description the `space-between` in `.name-row` had nothing to span and the
   * bonus sat against the name with the rest of the card empty beside it.
   */
  .info {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    flex: 1;
    min-width: 0;
  }

  .name-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.4rem;
    min-width: 0;
  }

  .name {
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--text);
  }

  /*
   * The bonus the chosen level buys, printed where the level is chosen — the
   * row of numbers says which level is picked, only this says what it is worth.
   * Switched off there is no bonus to state, so the slot carries the game's own
   * label for what the upgrade changes instead of an empty gap or a "+0%" that
   * would read as a researched level worth nothing.
   */
  .factor {
    flex: 0 0 auto;
    font-size: var(--fs-2xs);
    font-weight: 700;
    color: var(--text-dim);
  }

  .factor.on {
    color: var(--accent);
  }

  .effect {
    font-size: var(--fs-2xs);
    line-height: 1.4;
    color: var(--text-dim);
  }

  .levels {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .lbl {
    font-size: var(--fs-2xs);
    font-weight: 600;
    text-transform: uppercase;
    color: var(--text-dim);
  }

  .tiers {
    display: flex;
    gap: 3px;
  }

  .tier-btn {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    color: var(--text-dim);
    font-size: var(--fs-2xs);
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
    transition: all var(--dur-fast) var(--ease);
  }

  .tier-btn:disabled {
    cursor: default;
  }

  .tier-btn:not(:disabled):hover {
    color: var(--text);
    border-color: var(--accent-dim);
  }

  .tier-btn.active {
    background: var(--accent-bg);
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
