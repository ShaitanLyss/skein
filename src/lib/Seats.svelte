<script lang="ts">
  import type { Seat } from "./conversation.svelte";

  let { seats, scale }: { seats: Seat[]; scale: number } = $props();

  /* An arc: the middle seats ride higher than the outer ones, so a row of four
     reads as a gathering rather than a toolbar. */
  function lift(i: number, n: number): number {
    if (n < 3) return 0;
    const mid = (n - 1) / 2;
    return Math.round(22 * (1 - Math.abs(i - mid) / mid));
  }

  /** Bubbles are only legible above the wall density, and become noise below
   *  it — at a distance a seat is just a figure. */
  const showBubbles = $derived(scale >= 0.72);
</script>

<div class="satellites" class:bare={!showBubbles}>
  {#each seats as seat, i (seat.id)}
    <div
      class="persona"
      data-seat={seat.id}
      data-state={seat.state}
      style:--lift="{lift(i, seats.length)}px"
    >
      {#if showBubbles}
        <div class="bubble" style:animation-delay="{-i * 1.3}s">
          {#if seat.state === "done"}
            <span class="verdict">✓ {seat.verdict ?? "returned"}</span>
          {:else if seat.thought}
            {seat.thought}
          {:else}
            <span class="faint">arriving…</span>
          {/if}
        </div>
      {/if}

      <svg class="figure" viewBox="0 0 24 30" aria-hidden="true">
        <circle cx="12" cy="7.6" r="5.1" />
        <path d="M2.6 30 C2.6 20.4 7 16.4 12 16.4 C17 16.4 21.4 20.4 21.4 30 Z" />
      </svg>

      {#if showBubbles}
        <div class="pname">{seat.persona}</div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .satellites {
    position: absolute;
    left: 50%;
    bottom: calc(100% + 14px);
    transform: translateX(-50%);
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
    pointer-events: none;
  }
  .satellites.bare {
    gap: 0.3rem;
  }

  .persona {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.34rem;
    width: 150px;
    margin-bottom: var(--lift, 0px);
    /* Seats are told apart by position and name, never by hue: colour is the
       status channel and giving each persona its own would quietly wreck it. */
    color: var(--tone, var(--paper-dim));
  }
  .satellites.bare .persona {
    width: auto;
  }

  /* A hairline strand binding each seat down to the card that convened it. */
  .persona::after {
    content: "";
    position: absolute;
    left: 50%;
    bottom: calc(-14px - var(--lift, 0px));
    width: 1px;
    height: calc(var(--lift, 0px) + 14px);
    background: linear-gradient(to bottom, var(--edge), transparent);
  }

  .figure {
    width: 21px;
    height: 27px;
    fill: currentColor;
    opacity: 0.9;
  }
  .pname {
    font-family: var(--util);
    font-size: 0.58rem;
    font-weight: 600;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--paper-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }

  /* Thought bubble: trailing circles, not a speech tail. */
  .bubble {
    position: relative;
    width: 100%;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 11px;
    padding: 0.48rem 0.6rem;
    font-family: var(--body);
    font-size: 0.7rem;
    line-height: 1.42;
    color: var(--paper-dim);
    margin-bottom: 0.5rem;
    max-height: 6.2em;
    overflow: hidden;
    animation: drift 5.5s ease-in-out infinite;
  }
  .bubble::before,
  .bubble::after {
    content: "";
    position: absolute;
    left: 50%;
    border-radius: 50%;
    background: var(--surface);
    border: 1px solid var(--edge);
  }
  .bubble::before {
    width: 7px;
    height: 7px;
    bottom: -10px;
    margin-left: -9px;
  }
  .bubble::after {
    width: 4px;
    height: 4px;
    bottom: -18px;
    margin-left: -1px;
  }
  .faint {
    color: var(--paper-faint);
  }
  .verdict {
    font-family: var(--util);
    font-size: 0.66rem;
    color: var(--paper-mute);
  }

  @keyframes drift {
    0%,
    100% {
      transform: translateY(0);
    }
    50% {
      transform: translateY(-4px);
    }
  }

  .persona[data-state="spawning"] {
    --tone: var(--paper-faint);
  }
  .persona[data-state="spawning"] .bubble,
  .persona[data-state="spawning"] .figure {
    opacity: 0.4;
  }

  .persona[data-state="thinking"] {
    --tone: var(--st-work);
  }
  .persona[data-state="thinking"] .figure {
    animation: breathe-fig 3.6s ease-in-out infinite;
  }
  @keyframes breathe-fig {
    0%,
    100% {
      opacity: 0.62;
    }
    50% {
      opacity: 1;
    }
  }

  .persona[data-state="done"] {
    --tone: var(--st-rest);
  }
  .persona[data-state="done"] .bubble {
    background: var(--well);
    animation: none;
  }
  .persona[data-state="done"] .bubble::before,
  .persona[data-state="done"] .bubble::after {
    background: var(--well);
  }

  @media (prefers-reduced-motion: reduce) {
    .bubble,
    .figure {
      animation: none !important;
    }
  }
</style>
