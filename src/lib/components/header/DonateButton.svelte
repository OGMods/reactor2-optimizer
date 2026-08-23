<script lang="ts">
  import { Heart } from "lucide-svelte";

  /**
   * Support link.
   *
   * The `| null` and the disabled branch below are not dead code: this button
   * shipped inert for a while rather than pointing at a placeholder URL that
   * would take a willing donor somewhere broken, and emptying this constant is
   * still the whole of how to take it down again.
   */
  const DONATE_URL: string | null = "https://paypal.me/ogm0ds";

  interface Props {
    /** `menu` is the stacked overflow-menu row; `inline` is the header bar. */
    variant?: "inline" | "menu";
  }

  let { variant = "menu" }: Props = $props();
</script>

{#if DONATE_URL}
  <a
    class="donate"
    class:menu={variant === "menu"}
    href={DONATE_URL}
    target="_blank"
    rel="noopener noreferrer"
  >
    <Heart size={16} />
    <span>Support this project</span>
  </a>
{:else}
  <button
    class="donate"
    class:menu={variant === "menu"}
    disabled
    title="Not available yet"
  >
    <Heart size={16} />
    <span>Support this project</span>
    <span class="soon">Soon</span>
  </button>
{/if}

<style>
  /*
   * The lowest-priority control on the screen: it never takes an accent
   * colour, and it never sits next to the grid or solve controls in the
   * header bar. Muted by default, warm only on hover once it is live.
   */
  .donate {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-height: var(--tap);
    padding: 0 0.6rem;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-family: inherit;
    font-size: var(--fs-md);
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
    transition:
      background var(--dur-fast),
      color var(--dur-fast);
  }

  .donate.menu {
    width: 100%;
  }

  .donate:hover:not(:disabled) {
    background: var(--heart-bg);
    color: var(--heart);
  }

  .donate:disabled {
    cursor: default;
    color: var(--text-dim);
  }

  .soon {
    margin-left: auto;
    font-size: var(--fs-2xs);
    font-weight: 700;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    color: var(--text-dim);
    background: var(--surface-raised);
    border-radius: var(--radius-pill);
    padding: 0.1rem 0.45rem;
  }
</style>
