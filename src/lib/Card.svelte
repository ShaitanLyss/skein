<script lang="ts">
  import type { Conversation } from "./conversation.svelte";

  import type { Lod } from "./studio.svelte";

  let {
    conv,
    focused = false,
    selected = false,
    pinned = false,
    lod = "wall",
    onfocus,
    onclose,
  }: {
    conv: Conversation;
    focused?: boolean;
    selected?: boolean;
    pinned?: boolean;
    lod?: Lod;
    onfocus: (e: MouseEvent) => void;
    onclose: () => void;
  } = $props();

  /** At the open density a card shows what it has been saying, not just what
   *  it is doing — the latest line, which is enough to know whether to open the
   *  transcript. Deliberately one line: a card has to fit the slot it is placed
   *  in (see CARD_BOX in layout.ts), and reading at length is what the
   *  transcript panel is for. */
  const recent = $derived(
    conv.lines
      .filter((l) => l.kind === "text")
      .slice(-1)
      .map((l) => l.text),
  );

  const CIRC = 2 * Math.PI * 11;

  /* The ring warms independently of status as it approaches full, so a card can
     be calmly at rest and still visibly close to the edge. */
  const ringColor = $derived(
    conv.dormant
      ? "var(--paper-faint)"
      : conv.ctx >= 0.85
        ? "var(--st-fail)"
        : conv.ctx >= 0.65
          ? "var(--st-ask)"
          : "var(--st-work)",
  );

  const label = $derived.by(() => {
    const s = conv.idleSeconds;
    if (conv.working || s < 2) return conv.activity;
    if (s < 60) return `${conv.activity} · ${s}s`;
    if (s < 3600) return `${conv.activity} · ${Math.floor(s / 60)}m`;
    return `${conv.activity} · ${Math.floor(s / 3600)}h`;
  });

  /* The close control is a sibling rather than a child: a button inside a
     button is invalid, and the card itself needs to be a real button so it is
     keyboard-reachable without hand-rolling the semantics. */
</script>

<div class="slot" class:focused class:selected data-lod={lod}>
  <button
    class="card"
    data-st={conv.tier}
    data-dormant={conv.dormant ? "" : undefined}
    onclick={onfocus}
  >
    <span class="top">
    <span class="id">
      <span class="proj">{conv.project}</span>
      <span class="title">{conv.title}</span>
    </span>
    <svg class="ring" viewBox="0 0 26 26" aria-hidden="true">
      <circle class="track" cx="13" cy="13" r="11" />
      <circle
        class="fill"
        cx="13"
        cy="13"
        r="11"
        style:stroke={ringColor}
        style:stroke-dasharray={CIRC}
        style:stroke-dashoffset={CIRC * (1 - conv.ctx)}
      />
    </svg>
    </span>

    <span class="act"><span class="dot"></span>{label}</span>

    {#if lod === "open"}
      <span class="said">
        {#if conv.streaming}
          <span class="say">{conv.streaming}</span>
        {:else if recent.length}
          {#each recent as r}<span class="say">{r}</span>{/each}
        {:else}
          <span class="say faint">nothing said yet</span>
        {/if}
      </span>
    {/if}
  </button>

  {#if pinned}
    <span class="pin" title="Pinned — this position is yours now"></span>
  {/if}

  <button class="shut" onclick={onclose} aria-label="Close conversation">
    <svg viewBox="0 0 10 10" aria-hidden="true"
      ><path d="M2 2l6 6M8 2L2 8" /></svg
    >
  </button>
</div>

<style>
  .slot {
    position: relative;
    flex: 0 0 auto;
  }

  .card {
    width: 208px;
    text-align: left;
    font: inherit;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 4px;
    padding: 0.62rem 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.42rem;
    cursor: pointer;
    transition:
      box-shadow 0.5s ease,
      border-color 0.5s ease,
      background 0.5s ease;
  }
  .card:hover {
    border-color: var(--rule);
  }

  /* Selection is achromatic on purpose — colour is the status channel, and a
     blue "selected" ring would be the one thing on the wall that means nothing.
     Focus is a thin ring; gathered-for-broadcast is a solid one. */
  .slot.focused::after,
  .slot.selected::after {
    content: "";
    position: absolute;
    inset: -5px;
    border: 1px solid var(--paper-faint);
    border-radius: 7px;
    pointer-events: none;
  }
  .slot.selected::after {
    border-color: var(--paper-dim);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--paper-dim) 30%, transparent);
  }

  .top {
    display: flex;
    align-items: flex-start;
    gap: 0.55rem;
  }
  .id {
    flex: 1 1 auto;
    min-width: 0;
    display: block;
  }
  .proj,
  .title {
    display: block;
  }
  .proj {
    font-family: var(--util);
    font-size: 0.6rem;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--paper-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .title {
    font-family: var(--display);
    font-size: 0.95rem;
    line-height: 1.22;
    color: var(--paper);
    letter-spacing: -0.004em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ring {
    flex: 0 0 auto;
    width: 26px;
    height: 26px;
    transform: rotate(-90deg);
  }
  .ring circle {
    fill: none;
    stroke-width: 2.5;
  }
  .ring .track {
    stroke: var(--edge);
  }
  .ring .fill {
    stroke-linecap: round;
    transition:
      stroke-dashoffset 0.6s ease,
      stroke 0.6s ease;
  }

  .act {
    font-family: var(--util);
    font-size: 0.75rem;
    line-height: 1.35;
    color: var(--paper-dim);
    display: flex;
    align-items: center;
    gap: 0.4rem;
    min-height: 1.2em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dot {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--st, var(--st-rest));
  }

  .shut {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 18px;
    height: 18px;
    display: grid;
    place-items: center;
    background: none;
    border: 0;
    padding: 0;
    border-radius: 3px;
    cursor: pointer;
    color: var(--paper-faint);
    opacity: 0;
    transition:
      opacity 0.15s ease,
      color 0.15s ease,
      background 0.15s ease;
  }
  .shut svg {
    width: 8px;
    height: 8px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.3;
    stroke-linecap: round;
  }
  .slot:hover .shut,
  .shut:focus-visible {
    opacity: 1;
  }

  /* A pinned card carries a small mark — it earned its position. */
  .pin {
    position: absolute;
    top: -3px;
    left: -3px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--paper-faint);
    box-shadow: 0 0 0 2.5px var(--ink);
    pointer-events: none;
  }

  /* ── semantic zoom ───────────────────────────────────────── */
  .slot[data-lod="field"] .card {
    width: 58px;
    padding: 0.4rem;
    gap: 0;
  }
  .slot[data-lod="field"] .id,
  .slot[data-lod="field"] .act {
    display: none;
  }
  .slot[data-lod="field"] .top {
    justify-content: center;
  }

  /* Open does NOT widen the card, on purpose. Cards are placed on a fixed
     248-unit pitch, so a 288-wide card overlapped its right-hand neighbour by
     exactly the 40 units where the ring is drawn — zooming in to read hid the
     one number you were zooming in to read. What open adds is a line of speech,
     downwards, within the slot. */

  .said {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    border-top: 1px solid var(--edge);
    padding-top: 0.42rem;
    margin-top: 0.1rem;
    /* One line of .say (0.76rem × 1.4 ≈ 17px) and no more: the card has to stay
       inside SLOT_H, or rows overlap the way columns used to. */
    max-height: 1.2rem;
    overflow: hidden;
  }
  .say {
    display: -webkit-box;
    -webkit-line-clamp: 1;
    line-clamp: 1;
    -webkit-box-orient: vertical;
    overflow: hidden;
    font-size: 0.76rem;
    line-height: 1.4;
    color: var(--paper-mute);
  }
  .say.faint {
    color: var(--paper-faint);
    font-family: var(--util);
    font-size: 0.7rem;
  }
  .shut:hover {
    background: color-mix(in srgb, var(--st-fail) 30%, transparent);
    color: var(--paper);
  }

  /* ── status: light and motion, never a badge ─────────────── */
  .card[data-st="work"] {
    --st: var(--st-work);
    animation: breathe 4.2s ease-in-out infinite;
  }
  .card[data-st="ask"] {
    --st: var(--st-ask);
    border-color: color-mix(in srgb, var(--st-ask) 55%, var(--edge));
    animation: bloom 2.4s ease-in-out infinite;
  }
  .card[data-st="soft"] {
    --st: var(--st-soft);
    border-color: color-mix(in srgb, var(--st-soft) 32%, var(--edge));
  }
  .card[data-st="rest"] {
    --st: var(--st-rest);
    background: color-mix(in srgb, var(--surface) 76%, var(--ink));
  }
  .card[data-st="fail"] {
    --st: var(--st-fail);
    border-color: color-mix(in srgb, var(--st-fail) 48%, var(--edge));
  }

  /* Dormant is a fill, not a fifth colour: the card keeps whatever tier it
     closed on and is drawn hollow, because the light is what's missing.
     "Hollow" is the *ground's* colour and not `transparent`, which it was until
     the wall had ambience drawn on it: a brush flourish or a drifting leaf
     passing behind a dormant card came straight through the middle of it, and a
     conversation is not something the weather gets to cross. Filling it with the
     wall reads identically — the wall is what you would have seen — and it is
     the only thing standing between the backdrop and the card, since the card is
     what has to occlude it. Same reasoning as `.pin`'s `--ink` halo. */
  .card[data-dormant] {
    background: var(--ink);
    border-style: dashed;
    animation: none;
    box-shadow: none;
  }
  .card[data-dormant] .title {
    color: var(--paper-mute);
  }
  .card[data-dormant] .act {
    color: var(--paper-faint);
  }
  .card[data-dormant] .dot {
    background: var(--paper-faint);
  }

  @keyframes breathe {
    0%,
    100% {
      box-shadow: 0 6px 26px -18px rgba(127, 184, 164, 0.5);
    }
    50% {
      box-shadow: 0 6px 34px -14px rgba(127, 184, 164, 0.85);
    }
  }
  @keyframes bloom {
    0%,
    100% {
      box-shadow:
        0 0 0 0 rgba(233, 161, 59, 0.3),
        0 8px 30px -14px rgba(233, 161, 59, 0.6);
    }
    50% {
      box-shadow:
        0 0 0 5px rgba(233, 161, 59, 0),
        0 8px 38px -10px rgba(233, 161, 59, 0.95);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .card {
      animation: none !important;
    }
  }
</style>
