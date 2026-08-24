<script lang="ts">
  import { uiState } from "../../state";
  import { ChartColumn, ImageDown, Sparkles, Vibrate } from "lucide-svelte";
  import type { ImageScale } from "../../types/ui";
  import { EXPORT_MAX_SIDE_PX } from "../../pixi/boardExport";
  import ModalShell from "./ModalShell.svelte";

  const hasVibration =
    typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

  /*
   * App preferences that are not about the board in front of you.
   *
   * Everything else the user can set — the run length, which board is drawn,
   * whether the readout is folded — sits beside the thing it changes, because
   * it is part of doing the task. This holds the ones that are not: settings
   * about the app itself, which have nowhere else to live and would only be
   * clutter if pinned to a panel.
   *
   * The rows are a list rather than a bespoke layout per setting, which is
   * what has to be rebuilt the first time the dialog grows another one.
   */

  /*
   * The animation toggle's sub-label does double duty: it says what the
   * setting is for, and — while nobody has chosen — that the system is
   * currently answering. Without that, a viewer whose OS asks for reduced
   * motion sees the toggle already off and has no way to tell whether the app
   * did that or they did.
   */
  let motionHint = $derived(
    uiState.animationsFollowSystem
      ? "Following your system's reduced-motion setting."
      : uiState.animations
        ? "Idle and overheating buildings pulse so they are easy to spot."
        : "Buildings that are not working stay dimmed instead of pulsing.",
  );

  /*
   * Says what it does *and*, on a device that cannot do it, that the switch is
   * academic. Every desktop browser and every iOS browser is in that second
   * case — iOS Safari implements none of the Vibration API — so without the
   * hint a user would flip this and correctly conclude the app was broken.
   */
  let hapticsHint = $derived(
    !hasVibration
      ? "This device does not support vibration."
      : uiState.haptics
        ? "A short buzz when a building is placed or cleared."
        : "Placing and clearing buildings stay silent.",
  );

  /*
   * Says what is collected rather than what the switch is called: "analytics"
   * alone invites the reader to assume the worst. The first branch does the
   * double duty the motion hint does — it says the browser is what turned this
   * off, and the value of honouring that signal is in the user knowing it was.
   */
  const IMAGE_SCALES: ImageScale[] = [1, 2];

  let analyticsHint = $derived(
    uiState.analyticsFollowsDoNotTrack
      ? "Off: your browser asks sites not to track you."
      : uiState.analyticsDisabled
        ? "No usage data is sent."
        : "Sends anonymous page views so I can improve the app.",
  );
</script>

{#if uiState.activeModal === "settings"}
  <ModalShell title="Settings" onClose={() => uiState.closeModal()}>
    <div class="settings">
      <div class="setting">
        <span class="icon"><Sparkles size={16} /></span>

        <span class="text">
          <span class="name" id="setting-animations">Animations</span>
          <span class="hint">{motionHint}</span>
        </span>

        <!--
          A real switch rather than a checkbox: `role="switch"` is what tells a
          screen reader this takes effect immediately, which it does — there is
          no Save here, and a dialog that looked like it needed one would leave
          people wondering whether their change stuck.
        -->
        <button
          class="switch"
          role="switch"
          aria-checked={uiState.animations}
          aria-labelledby="setting-animations"
          onclick={() => uiState.setAnimations(!uiState.animations)}
        >
          <span class="track"><span class="knob"></span></span>
        </button>
      </div>

      <div class="setting">
        <span class="icon"><Vibrate size={16} /></span>

        <span class="text">
          <span class="name" id="setting-haptics">Haptics</span>
          <span class="hint">{hapticsHint}</span>
        </span>

        <button
          class="switch"
          role="switch"
          aria-checked={uiState.haptics}
          aria-labelledby="setting-haptics"
          onclick={() => uiState.setHaptics(!uiState.haptics)}
        >
          <span class="track"><span class="knob"></span></span>
        </button>
      </div>

      <!-- Affirmative, though stored as the negative: every switch in this
           list is lit when the thing it names is happening. -->
      <div class="setting">
        <span class="icon"><ChartColumn size={16} /></span>

        <span class="text">
          <span class="name" id="setting-analytics">Usage analytics</span>
          <span class="hint">{analyticsHint}</span>
        </span>

        <button
          class="switch"
          role="switch"
          aria-checked={!uiState.analyticsDisabled}
          aria-labelledby="setting-analytics"
          onclick={() =>
            uiState.setAnalyticsDisabled(!uiState.analyticsDisabled)}
        >
          <span class="track"><span class="knob"></span></span>
        </button>
      </div>

      <!-- Stacked, not a control on the right: three options do not fit
           beside a hint on a phone, and shrinking them would put the row
           under the touch floor. -->
      <div class="setting stacked">
        <span class="icon"><ImageDown size={16} /></span>

        <span class="text">
          <span class="name" id="setting-image-scale">Saved image size</span>
          <span class="hint">
            How far <em>Save as image</em> scales the board up. 2× is sharper
            and roughly four times the file; either way a large board is capped
            at {EXPORT_MAX_SIDE_PX}px.
          </span>
        </span>

        <div
          class="segmented"
          role="group"
          aria-labelledby="setting-image-scale"
        >
          {#each IMAGE_SCALES as scale (scale)}
            <button
              class="segment"
              class:active={uiState.imageScale === scale}
              aria-pressed={uiState.imageScale === scale}
              onclick={() => uiState.setImageScale(scale)}
            >
              {scale}×
            </button>
          {/each}
        </div>
      </div>
    </div>
  </ModalShell>
{/if}

<style>
  .settings {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .setting {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0.6rem 0.7rem;
  }

  .icon {
    display: flex;
    flex: 0 0 auto;
    color: var(--neon);
  }

  .text {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    /* Yields first: the switch must never be squeezed off the row. */
    min-width: 0;
    flex: 1 1 auto;
  }

  .name {
    font-size: var(--fs-md);
    font-weight: 600;
    color: var(--text);
  }

  .hint {
    font-size: var(--fs-sm);
    line-height: 1.4;
    color: var(--text-dim);
  }

  /*
   * The button is the 44px touch target; the track it centres is the 42x24
   * the eye sees, and the negative margin pulls the difference back out of the
   * layout so the oversized target does not stretch the row. The margin box
   * ends up the size of the track, which is what keeps the flex `gap` measured
   * against what is visible.
   */
  /* Icon and text on the first line, the control across the second. */
  .setting.stacked {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.4rem 0.65rem;
  }

  .setting.stacked .segmented {
    grid-column: 1 / -1;
  }

  .segmented {
    display: flex;
    gap: 0.25rem;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.2rem;
  }

  .segment {
    flex: 1 1 0;
    min-height: var(--ctl);
    border: 1px solid transparent;
    border-radius: calc(var(--radius-sm) - 2px);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--fs-base);
    font-weight: 600;
    cursor: pointer;
    transition:
      color var(--dur-fast) ease,
      background var(--dur-fast) ease,
      border-color var(--dur-fast) ease;
  }

  .segment:hover {
    color: var(--text);
    background: var(--surface-raised);
  }

  .segment.active {
    background: var(--neon-bg);
    border-color: var(--neon-line);
    color: var(--neon);
  }

  .segment:focus-visible {
    outline: 2px solid var(--neon);
    outline-offset: 2px;
  }

  .switch {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 62px;
    height: 44px;
    margin: -10px;
    padding: 0;
    background: none;
    border: none;
    cursor: pointer;
  }

  /*
   * A real element rather than a `::before`, which is what the first version
   * used and got wrong twice over: a pseudo-element cannot be measured with
   * `getBoundingClientRect`, so the misalignment could only be eyeballed, and
   * sizing it with `padding` + `inset` collided with the global
   * `box-sizing: border-box` in `app.css` — the declared width already
   * included the padding, leaving a 4px sliver of track under the knob.
   *
   * Everything here is now laid out by the box model rather than by arithmetic
   * that has to agree with it.
   */
  .track {
    position: relative;
    width: 42px;
    height: 24px;
    border-radius: var(--radius-pill);
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid var(--border);
    transition:
      background var(--dur-fast),
      border-color var(--dur-fast);
  }

  .switch[aria-checked="true"] .track {
    background: var(--neon-bg);
    border-color: var(--neon-dim);
  }

  .knob {
    position: absolute;
    /*
     * Positioned against the track's *padding* box — 40x22 inside the 1px
     * border. `top: 50%` with half the knob pulled back centres it exactly,
     * whatever the border does — which is the part a fixed offset gets 1px
     * wrong.
     */
    top: 50%;
    left: 3px;
    width: 18px;
    height: 18px;
    margin-top: -9px;
    border-radius: 50%;
    background: var(--text-dim);
    /*
     * The one animation this dialog runs itself, and it stays on even with
     * animations off: this is the control's feedback, not decoration, and a
     * knob that teleports reads as a failed press. `prefers-reduced-motion` is
     * still honoured, by the media query below.
     */
    transition:
      transform var(--dur-fast) var(--ease),
      background var(--dur-fast);
  }

  .switch[aria-checked="true"] .knob {
    /* 40px of track interior, less the 18px knob and its 3px rest at each
       end, leaves exactly 16px to travel. */
    transform: translateX(16px);
    background: var(--neon);
  }

  .switch:focus-visible .track {
    outline: 2px solid var(--neon);
    outline-offset: 2px;
  }

  @media (prefers-reduced-motion: reduce) {
    .knob {
      transition: none;
    }
  }
</style>
