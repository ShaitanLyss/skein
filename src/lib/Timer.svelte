<script lang="ts">
  /* Three instruments over one pair of numbers: a stopwatch, a countdown, and a
   * duo of which one lane runs.
   *
   * All the arithmetic is in `timing.ts` and all of it is tested; this decides
   * only what is drawn and which gesture writes what. The variant is the
   * instrument and `face` is how it is drawn, which is the one place this file
   * differs from `Clock.svelte` — a clock's face *is* its reading, and a
   * stopwatch and a countdown are two questions with the same digits.
   *
   * Achromatic, except for one thing: a countdown that has rung goes amber,
   * because on this wall amber means *waiting to be noticed* and that is exactly
   * what a rung timer is. Nothing else here earns a colour. */

  import { clock } from "./conversation.svelte";
  import {
    duoShare,
    duoTotal,
    elapsed,
    hold,
    IDLE,
    isRunning,
    laneRunning,
    lengthLabel,
    overrun,
    progress,
    remaining,
    said,
    span,
    standing,
    start,
    switchTo,
    type Lane,
  } from "./timing";
  import { duoIn, limitIn, runIn, textOf, variantOf, type Widget } from "./widgets";
  import { arcPath } from "./clock";
  import type { Duo, Run } from "./timing";

  let {
    widget,
    onrun,
    onduo,
  }: {
    widget: Widget;
    onrun: (run: Run) => void;
    onduo: (duo: Duo) => void;
  } = $props();

  /* The one-second tick the whole wall already runs on — the same rune the
     clock reads. A timer is the most obvious thing in the app to give its own
     interval, and giving it one would be a wake-up per timer on a machine that
     is otherwise idle. The reference implementation ran one at 50Hz each. */
  const now = $derived(clock.t);

  const variant = $derived(variantOf(widget));
  const face = $derived(textOf(widget, "face", "digits"));
  const run = $derived(runIn(widget));
  const duo = $derived(duoIn(widget));
  const limit = $derived(limitIn(widget));
  const state = $derived(standing(run, limit, now));

  const down = $derived(variant === "down");
  const isDuo = $derived(variant === "duo");

  /* What the big digits say. A countdown counts down and holds at zero rather
     than going negative — `-4:12` asks you to do the subtraction yourself. */
  const seconds = $derived(
    isDuo
      ? duoTotal(duo, now)
      : down && limit !== null
        ? remaining(run, limit, now)
        : elapsed(run, now),
  );

  /* A ring or a bar needs something to be a fraction *of*. A countdown has its
     length; a stopwatch has nothing, so it fills over the minute in hand — a
     real reading (how long since the last whole minute) rather than a bar that
     is always full or always empty. */
  const fraction = $derived(
    isDuo
      ? duoShare(duo, now)
      : down && limit !== null
        ? progress(run, limit, now)
        : (elapsed(run, now) % 60) / 60,
  );

  const note = $derived.by(() => {
    if (isDuo) {
      const lane = laneRunning(duo);
      return lane === null ? "both held" : lane === "on" ? "on it" : "away";
    }
    if (state === "rung") return `rang ${said(overrun(run, limit ?? 0, now))} ago`;
    if (down) return lengthLabel(textOf(widget, "length", "25m"));
    if (state === "held") return "held";
    return state === "idle" ? "not started" : "counting";
  });

  const C = 100;
  const R = 86;

  function toggle() {
    onrun(isRunning(run) ? hold(run, now) : start(run, now));
  }

  function reset() {
    onrun(IDLE);
  }

  function lane(which: Lane) {
    onduo(switchTo(duo, which, now));
  }

  function resetDuo() {
    onduo({ on: IDLE, off: IDLE });
  }

  /** A rung countdown is acknowledged by being touched — the same gesture that
   *  would start it, since a timer that has run out has nothing left to start.
   *  Acknowledging clears it back to idle rather than to a fresh run: pressing
   *  again is how you say "again". */
  function acknowledge() {
    onrun(IDLE);
  }
</script>

<div class="timer" data-variant={variant} data-face={face} data-state={state}>
  {#if isDuo}
    <!-- Two stopwatches of which exactly one runs. That constraint is the
         instrument: the pair always sums to the time since you started, so the
         share between them is a real reading rather than two unrelated numbers
         side by side. -->
    <div class="lanes">
      {#each [{ key: "on", label: "on it" }, { key: "off", label: "away" }] as l (l.key)}
        <button
          class="lane"
          class:live={laneRunning(duo) === l.key}
          onclick={() => lane(l.key as Lane)}
        >
          <span class="lane-name">{l.label}</span>
          <span class="lane-time">{span(elapsed(duo[l.key as Lane], now))}</span>
        </button>
      {/each}
    </div>
    <div class="split" aria-hidden="true">
      <span class="split-fill" style:width="{fraction * 100}%"></span>
    </div>
  {:else if face === "ring"}
    <svg viewBox="0 0 200 200" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <circle cx={C} cy={C} r={R} class="track" />
      <path d={arcPath(C, C, R, fraction * 360)} class="fill" />
      <text x={C} y={C} class="inner">{span(seconds)}</text>
    </svg>
  {:else if face === "bar"}
    <div class="bar-time">{span(seconds)}</div>
    <div class="bar" aria-hidden="true">
      <span class="bar-fill" style:width="{fraction * 100}%"></span>
    </div>
  {:else}
    <div class="digits">{span(seconds)}</div>
  {/if}

  <div class="foot">
    <span class="note">{note}</span>
    <span class="acts">
      {#if isDuo}
        <button class="act" onclick={resetDuo} disabled={duoTotal(duo, now) === 0}>
          reset
        </button>
      {:else if state === "rung"}
        <button class="act ring" onclick={acknowledge}>done</button>
      {:else}
        <button class="act" onclick={toggle}>
          {isRunning(run) ? "hold" : elapsed(run, now) > 0 ? "carry on" : "start"}
        </button>
        <button class="act" onclick={reset} disabled={elapsed(run, now) === 0}>
          reset
        </button>
      {/if}
    </span>
  </div>
</div>

<style>
  .timer {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    justify-content: center;
    gap: 0.3rem;
    padding: 0.45rem 0.55rem;
    overflow: hidden;
    /* Deliberately paints no background of its own. The wrapper fills — see the
       ambience note in CLAUDE.md for why it does by default — and leaving it
       there is what lets the `frame` knob's `bare` reach this face. */
  }

  svg {
    flex: 1;
    min-height: 0;
    width: 100%;
    display: block;
  }

  /* ── digits ─────────────────────────────────────────── */
  .digits {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    /* Sized off the widget's own box, so a timer dragged large is a large timer
       rather than a small one on a large plate. The container is `.widget`. */
    font-size: min(30cqw, 52cqh);
    line-height: 1;
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
    color: var(--paper);
  }

  /* ── ring ───────────────────────────────────────────── */
  .track {
    fill: none;
    stroke: var(--surface);
    stroke-width: 9;
  }
  .fill {
    fill: none;
    stroke: var(--paper-dim);
    stroke-width: 9;
    stroke-linecap: round;
  }
  .inner {
    text-anchor: middle;
    dominant-baseline: central;
    font-family: var(--mono);
    font-size: 44px;
    font-variant-numeric: tabular-nums;
    fill: var(--paper);
  }

  /* ── bar ────────────────────────────────────────────── */
  .bar-time {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-size: min(22cqw, 34cqh);
    line-height: 1;
    color: var(--paper);
    text-align: center;
  }
  .bar,
  .split {
    height: 5px;
    border-radius: 3px;
    background: var(--surface);
    overflow: hidden;
  }
  .bar-fill,
  .split-fill {
    display: block;
    height: 100%;
    background: var(--paper-dim);
  }

  /* ── the duo ────────────────────────────────────────── */
  .lanes {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .lane {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.4rem;
    padding: 0.15rem 0.4rem;
    background: var(--surface);
    border: 1px solid transparent;
    border-radius: 3px;
    cursor: pointer;
    text-align: left;
  }
  .lane:hover {
    background: var(--raised);
  }
  /* The running lane, marked by weight and a rule rather than by a hue — which
     lane has the clock is not a status of the work. */
  .lane.live {
    border-color: var(--rule);
    background: var(--raised);
  }
  .lane-name {
    font-family: var(--util);
    font-size: min(6cqw, 13cqh);
    letter-spacing: 0.08em;
    color: var(--paper-faint);
  }
  .lane.live .lane-name {
    color: var(--paper-mute);
  }
  .lane-time {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-size: min(11cqw, 24cqh);
    color: var(--paper-mute);
  }
  .lane.live .lane-time {
    color: var(--paper);
  }

  /* ── the foot ───────────────────────────────────────── */
  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem;
    min-height: 0;
  }
  .note {
    font-family: var(--util);
    font-size: min(6cqw, 12cqh);
    color: var(--paper-faint);
    letter-spacing: 0.04em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .acts {
    display: flex;
    gap: 0.25rem;
    flex: 0 0 auto;
  }
  .act {
    font-family: var(--util);
    font-size: min(6cqw, 12cqh);
    color: var(--paper-mute);
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.1rem 0.35rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .act:hover:not(:disabled) {
    color: var(--paper);
    background: var(--raised);
    border-color: var(--rule);
  }
  .act:disabled {
    opacity: 0.35;
    cursor: default;
  }

  /* The one colour on this instrument. A countdown that has run out is waiting
     to be noticed, which is what amber means everywhere else on the wall. */
  .timer[data-state="rung"] .digits,
  .timer[data-state="rung"] .bar-time,
  .timer[data-state="rung"] .note {
    color: var(--st-ask);
  }
  .timer[data-state="rung"] .inner {
    fill: var(--st-ask);
  }
  .timer[data-state="rung"] .fill,
  .timer[data-state="rung"] .bar-fill {
    background: var(--st-ask);
    stroke: var(--st-ask);
  }
  .act.ring {
    color: var(--st-ask);
    border-color: color-mix(in srgb, var(--st-ask) 45%, var(--edge));
  }
  .act.ring:hover {
    color: var(--ink);
    background: var(--st-ask);
  }
</style>
