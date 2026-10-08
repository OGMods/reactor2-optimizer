<script lang="ts">
  import { ANOMALIES } from "@reactor2/solver";
  import { configState, solverState } from "../../state";
  import { asset } from "../../utils/assetUrl";
  import { CircleOff } from "lucide-svelte";

  /*
   * Which anomaly the player's timeline is running under.
   *
   * This mirrors a choice already made *in the game*, at the prestige screen —
   * it does not make one. So the list is not a place to shop: what it has to
   * do is let someone find the anomaly they picked a moment ago and confirm it
   * is the one the solver is now using. Hence icon and name first, the game's
   * own benefit/drawback pair beside them, and the full rule only under the
   * one that is selected: four rules stacked at once is a wall of text on a
   * phone, and three of them describe a timeline nobody is in.
   *
   * Radio semantics rather than the pressed-button idiom the tab switch uses:
   * exactly one is always active, which is what a radio group means and what
   * `configState.anomalyId` already guarantees.
   */

  /*
   * The icons are the game's own, extracted beside the building sprites, and
   * named for the anomaly. `asset()` because this is a runtime-assembled path
   * — see `utils/assetUrl.ts`; a leading slash would 404 on GitHub Pages.
   *
   * "No anomaly" has none to extract, so it gets a lucide glyph in the same
   * frame rather than a broken image or a blank square.
   */
  const iconFor = (id: string) => asset(`icons/anomaly_${id}.webp`);

  /*
   * A run reads the anomaly once, at launch (`solverState`'s `#runAnomalyId`),
   * so a press here cannot reach the search already under way: it would
   * silently retarget the *next* one and leave the layout landing on screen
   * searched under a rule the player has just moved off.
   *
   * A backstop rather than the rule, since Setup is not on screen during a
   * run at all — see `uiState.setupHidden`. What it covers is the frame
   * between the run starting and the panel being unmounted, and it stays
   * disabled rather than hidden for the case the panel-level rule does not
   * make: this is Setup's own choice, not a control the current mode makes
   * irrelevant.
   */
  let disabled = $derived(solverState.isOptimizing);

  /*
   * An older build of an anomaly (`variantOf`) is not a card: in the game it is
   * the same anomaly, and a second Tidal card would read as a fifth rule. It is
   * a switch on its parent's card instead, and the card shows whichever build
   * is selected so the figures printed are the ones the solver runs on.
   */
  const CARDS = ANOMALIES.filter((a) => !a.variantOf);
  const variantsOf = (id: string) => {
    const older = ANOMALIES.filter((a) => a.variantOf === id);
    return older.length ? [ANOMALIES.find((a) => a.id === id)!, ...older] : [];
  };
  const familyOf = (id: string) =>
    ANOMALIES.find((a) => a.id === id)?.variantOf ?? id;
</script>

<div class="section-box" role="radiogroup" aria-label="Timeline anomaly">
  <!--
    Titled, where a lone list on this tab would not need to be: the research
    above it is a second section, so without a heading the two run together and
    the cards read as more of the same list.
  -->
  <div class="section-title">
    <span>Anomaly</span>
  </div>

  <p class="lede">
    Pick the anomaly your current timeline is running under, so a solve uses the
    same rules the game does.
  </p>

  {#each CARDS as card (card.id)}
    {@const active = familyOf(configState.anomalyId) === card.id}
    {@const anomaly = active ? configState.activeAnomaly : card}
    {@const variants = variantsOf(card.id)}
    <!--
      A box rather than one button, so the chosen card can hold the switch
      between builds of its anomaly: a button cannot contain buttons. The
      selecting half is `.card-hit`, which carries the radio semantics.
    -->
    <div class="anomaly-card" class:active class:disabled>
      <!-- Says the one thing this list is for: which timeline you are in. -->
      <span class="select-stripe" class:on={active}></span>

      <div class="card-body">
        <button
          type="button"
          class="card-hit"
          role="radio"
          aria-checked={active}
          {disabled}
          onclick={() => {
            if (!active) configState.setAnomaly(card.id);
          }}
        >
          <span class="main-row">
            <span class="icon-frame" class:glyph={anomaly.rule === "baseline"}>
              {#if anomaly.rule === "baseline"}
                <!-- Tracks the frame, which grows when the card is the chosen one. -->
                <CircleOff size={active ? 24 : 17} />
              {:else}
                <img src={iconFor(card.id)} alt="" class="anomaly-icon" />
              {/if}
            </span>

            <span class="info">
              <span class="name">{anomaly.name}</span>
            </span>
          </span>

          <!--
            The game's own pairing, panel for panel: what it gives you over what
            it costs, green over red, striped. See the `--benefit-*` /
            `--drawback-*` note in `app.css` for why these are not the board's
            two colours.
          -->
          <span class="effects">
            <span class="effect benefit">{anomaly.benefit}</span>
            <span class="effect drawback">{anomaly.drawback}</span>
          </span>
        </button>

        <!--
          Only on the chosen card: it is a detail of the timeline the player is
          in, not something to pick between anomalies by. Under the benefit line
          because that is the figure it changes.
        -->
        {#if active && variants.length}
          <div class="variant-row">
            <span class="lbl">Bonus</span>
            <div
              class="variants"
              role="radiogroup"
              aria-label="{card.name} bonus"
            >
              {#each variants as v (v.id)}
                {@const on = configState.anomalyId === v.id}
                <button
                  type="button"
                  class="variant"
                  class:on
                  role="radio"
                  aria-checked={on}
                  title={v.variantOf
                    ? "Pre-nerf figure: an old save keeps it until its next jump"
                    : undefined}
                  {disabled}
                  onclick={() => configState.setAnomaly(v.id)}
                >
                  {v.variantLabel}
                </button>
              {/each}
            </div>
          </div>
        {/if}

        {#if active}
          <span class="description">{anomaly.description}</span>
        {/if}
      </div>
    </div>
  {/each}
</div>

<style>
  .section-box {
    margin-bottom: 1.5rem;
  }

  /* The heading idiom `PrestigeUpgrades` and `TemplateSelector` both use. */
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

  .lede {
    margin: 0 0 0.85rem;
    font-size: var(--fs-xs);
    line-height: 1.45;
    color: var(--text-dim);
  }

  .anomaly-card {
    position: relative;
    display: flex;
    width: 100%;
    /* The stripe is the first child and must reach both edges. */
    align-items: stretch;
    gap: 0;
    margin-bottom: 0.5rem;
    padding: 0;
    text-align: left;
    /* The game's own card ground — see `--anomaly-card` in `app.css`. */
    background: var(--anomaly-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
    transition:
      border-color var(--dur-fast) var(--ease),
      background var(--dur-fast) var(--ease);
  }

  .anomaly-card:hover:not(.disabled) {
    border-color: var(--anomaly-selected-glow);
  }

  .anomaly-card.disabled {
    opacity: 0.5;
  }

  /*
   * Green, not `--accent`, and only here — see the `--anomaly-selected` note in
   * `app.css`. The ring is the game's own, so the card the player chose a
   * moment ago in the game is the card that looks chosen here.
   */
  /* No background change: the game's selected card is the same purple, and the
     ring is what says so. */
  .anomaly-card.active {
    border-color: var(--anomaly-selected);
    box-shadow: 0 0 0 1px var(--anomaly-selected-glow);
  }

  .select-stripe {
    flex: 0 0 3px;
    background: transparent;
    transition: background var(--dur-fast) var(--ease);
  }

  .select-stripe.on {
    background: var(--anomaly-selected);
  }

  /*
   * ── Compact until chosen ──────────────────────────────────────
   * Four cards, and only one of them describes the timeline the player is in.
   * The other three are there to be picked from, which needs their name and
   * their trade and nothing else — so the unselected size is the default here
   * and `.active` is what loosens it, rather than the other way round. It also
   * makes the selected card obvious by *shape* as well as by colour, which is
   * the reading that survives a colourblind viewer.
   */
  .card-body {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    /* Shrinks below its content so a long name ellipsizes rather than
       widening the card past the panel. */
    min-width: 0;
    flex: 1;
    padding: 0.45rem 0.55rem;
  }

  .anomaly-card.active .card-body {
    gap: 0.5rem;
    padding: 0.6rem 0.7rem;
  }

  /* The selecting half of the card: a bare button laid out as the column it
     replaced, so the card reads exactly as it did when it was one button. */
  .card-hit {
    display: flex;
    flex-direction: column;
    gap: inherit;
    width: 100%;
    margin: 0;
    padding: 0;
    font: inherit;
    color: inherit;
    text-align: left;
    background: none;
    border: 0;
    cursor: pointer;
  }

  .card-hit:disabled {
    cursor: default;
  }

  .anomaly-card.active .card-hit {
    cursor: default;
  }

  .main-row {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    min-width: 0;
  }

  /*
   * No backing plate behind the art. The extracted icons are finished round
   * badges with their own rim and their own ground, so a disc under one is a
   * second circle showing at the corners — the game draws them bare. The
   * baseline entry has no art to draw, so `.glyph` gives its lucide mark the
   * disc the others do not need.
   */
  .icon-frame {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 30px;
    height: 30px;
    border-radius: var(--radius-pill);
    color: var(--text-dim);
    transition:
      width var(--dur-fast) var(--ease),
      height var(--dur-fast) var(--ease);
  }

  .anomaly-card.active .icon-frame {
    width: 42px;
    height: 42px;
  }

  .icon-frame.glyph {
    background: rgba(255, 255, 255, 0.07);
  }

  .anomaly-icon {
    width: 100%;
    height: 100%;
    object-fit: contain;
    border-radius: var(--radius-pill);
  }

  /* Claims the row, so the name sits against the card's own width rather than
     against its own length — see the note on `.info` in `PrestigeUpgrades`. */
  .info {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    flex: 1;
    min-width: 0;
  }

  .name {
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--text);
  }

  .effects {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .anomaly-card.active .effects {
    gap: 0.3rem;
  }

  /*
   * Full width and stacked rather than tucked beside the icon: this is the
   * shape the game shows them in, and this screen exists to be recognised
   * from that one. Wrapping rather than ellipsizing for the same reason — a
   * drawback cut off mid-phrase is the half of the trade nobody read.
   *
   * The stripe is the game's, measured off it: ~6px bands at 45°, running "/".
   */
  .effect {
    padding: 0.22rem 0.45rem;
    border-radius: var(--radius-xs);
    font-size: var(--fs-2xs);
    font-weight: 600;
    line-height: 1.3;
    text-align: center;
    text-wrap: balance;
  }

  .anomaly-card.active .effect {
    padding: 0.35rem 0.5rem;
    line-height: 1.35;
  }

  .benefit {
    color: var(--benefit-text);
    background: repeating-linear-gradient(
      -45deg,
      var(--benefit-fill) 0 6px,
      var(--benefit-fill-alt) 6px 12px
    );
  }

  .drawback {
    color: var(--drawback-text);
    background: repeating-linear-gradient(
      -45deg,
      var(--drawback-fill) 0 6px,
      var(--drawback-fill-alt) 6px 12px
    );
  }

  .description {
    font-size: var(--fs-xs);
    line-height: 1.5;
    color: var(--text-dim);
    /* Follows the tab's re-pointed `--border`, so the rule under a description
       is the same hairline as the card's own edge. */
    border-top: 1px solid var(--border);
    padding-top: 0.5rem;
  }

  /*
   * The research cards' level chips (`PrestigeUpgrades`' `.tier-btn`), copied
   * rather than shared: they sit one section up on this same tab and make the
   * same kind of choice — which build of this thing your timeline holds.
   * Wider than a level chip only because the label is a figure, not a digit.
   */
  .variant-row {
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

  .variants {
    display: flex;
    gap: 3px;
  }

  .variant {
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 6px;
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

  .variant:disabled {
    cursor: default;
  }

  .variant:not(:disabled):hover {
    color: var(--text);
    border-color: var(--accent-dim);
  }

  .variant.on {
    background: var(--accent-bg);
    border-color: var(--accent);
    color: var(--accent);
  }

  @media (pointer: coarse) {
    .card-hit {
      min-height: var(--tap);
    }
  }
</style>
