<script lang="ts">
  /* Five faces over one set of numbers.
   *
   * All the arithmetic is in `clock.ts` and all of it is tested; this decides
   * only what is drawn. The variants are genuinely different readings of the
   * same instant rather than five skins — an analog face is read by angle, a
   * worded one by sentence, an abstract one by how far round three arcs have
   * gone — which is the point of being able to hang two of them up.
   *
   * Achromatic, like everything else that is not status. A clock that glowed
   * amber would be a clock that looked like a card wanting attention. */

  import { clock } from "./conversation.svelte";
  import {
    arcPath,
    dateLine,
    digital,
    handAngles,
    onFace,
    reading,
    ticks,
    turns,
    words,
  } from "./clock";
  import { onOf, variantOf, type Widget } from "./widgets";

  let { widget }: { widget: Widget } = $props();

  /* The one-second tick the whole wall already runs on. A clock is the most
     obvious thing in the app to give its own timer, and it is exactly what the
     shared rune is for — a second clock would be a second wake-up per second
     for a machine that is otherwise idle. Nothing here sweeps: with a
     once-a-second reading, a swept hand would sit between positions for most of
     every second, which reads as broken rather than as smooth. */
  const now = $derived(clock.t);
  const r = $derived(reading(now));
  const variant = $derived(variantOf(widget));
  const wantSeconds = $derived(onOf(widget, "seconds", true));
  const h24 = $derived(onOf(widget, "h24", true));
  const wantDate = $derived(onOf(widget, "date", false));

  const angles = $derived(handAngles(r));
  const t = $derived(turns(r));
  const d = $derived(digital(r, { h24, seconds: wantSeconds }));
  const said = $derived(words(r));

  /* A square viewBox with the widget's own aspect handled by the SVG: the box
     you drag is yours, and a face drawn into an oval is a broken clock. */
  const C = 100;
  const R = 92;

  /* Every point the faces draw, worked out here rather than inline: `{@const}`
     is only legal as the immediate child of a block, and an SVG is not one. */
  const hourTip = $derived(onFace(C, C, R * 0.52, angles.hour));
  const hourTail = $derived(onFace(C, C, 14, angles.hour + 180));
  const minTip = $derived(onFace(C, C, R * 0.76, angles.minute));
  const secTip = $derived(onFace(C, C, R * 0.82, angles.second));
  const secTail = $derived(onFace(C, C, 20, angles.second + 180));
  const sweepTip = $derived(onFace(C, C, R - 4, angles.minute));
  const hour12 = $derived(h24 ? r.h : r.h % 12 === 0 ? 12 : r.h % 12);
  const rings = $derived([
    { r: R, k: t.hour, w: 9 },
    { r: R - 22, k: t.minute, w: 6 },
    ...(wantSeconds ? [{ r: R - 40, k: t.second, w: 3 }] : []),
  ]);
</script>

<div class="clock" data-variant={variant}>
  {#if variant === "analog"}
    <svg viewBox="0 0 200 200" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <circle cx={C} cy={C} r={R} class="rim" />
      {#each ticks(C, C, R - 6, 12, 11) as m (m.b.x + "," + m.b.y)}
        <line x1={m.a.x} y1={m.a.y} x2={m.b.x} y2={m.b.y} class="tick" class:major={m.major} />
      {/each}

      <line
        x1={hourTail.x}
        y1={hourTail.y}
        x2={hourTip.x}
        y2={hourTip.y}
        class="hand hour"
      />
      <line x1={C} y1={C} x2={minTip.x} y2={minTip.y} class="hand minute" />
      {#if wantSeconds}
        <line
          x1={secTail.x}
          y1={secTail.y}
          x2={secTip.x}
          y2={secTip.y}
          class="hand second"
        />
      {/if}
      <circle cx={C} cy={C} r="3.4" class="pin" />
    </svg>
    {#if wantDate}<span class="date">{dateLine(now)}</span>{/if}

  {:else if variant === "digital"}
    <div class="digits">
      <span class="time">{d.time}</span>
      {#if d.seconds}<span class="sec">{d.seconds}</span>{/if}
      {#if d.suffix}<span class="suffix">{d.suffix}</span>{/if}
    </div>
    {#if wantDate}<span class="date">{dateLine(now)}</span>{/if}

  {:else if variant === "words"}
    <div class="said">
      <span class="phrase">{said.time}</span>
      <span class="part">in the {said.part}</span>
      {#if wantDate}<span class="date">{dateLine(now)}</span>{/if}
    </div>

  {:else if variant === "artistic"}
    <!-- The hour as a numeral behind, the minute as a brush sweep round it.
         The same gesture the ambience's flourishes are drawn with, which is why
         it belongs on this wall and a chrome bezel would not. -->
    <svg viewBox="0 0 200 200" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <text x={C} y={C} class="numeral">{hour12}</text>
      <path d={arcPath(C, C, R - 4, angles.minute)} class="sweep" />
      {#if wantSeconds}
        <path d={arcPath(C, C, R - 18, angles.second)} class="thread" />
      {/if}
      <circle cx={sweepTip.x} cy={sweepTip.y} r="4" class="bead" />
    </svg>
    {#if wantDate}<span class="date">{dateLine(now)}</span>{/if}

  {:else}
    <!-- Abstract: three rings and not one numeral. Read as proportions — how
         far through the half-day, the hour, the minute — which is the reading
         you actually want from a wall you are not looking straight at. -->
    <svg viewBox="0 0 200 200" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {#each rings as ring (ring.r)}
        <circle cx={C} cy={C} r={ring.r} class="track" style:stroke-width="{ring.w}px" />
        <path
          d={arcPath(C, C, ring.r, ring.k * 360)}
          class="fill"
          style:stroke-width="{ring.w}px"
        />
      {/each}
    </svg>
    {#if wantDate}<span class="date">{dateLine(now)}</span>{/if}
  {/if}
</div>

<style>
  .clock {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.2rem;
    padding: 0.4rem;
    overflow: hidden;
    /* Not transparent: the backdrop is behind everything on the wall, and a
       leaf drifting through the middle of a clock face is the same wrong as one
       drifting through a card. See the ambience note in CLAUDE.md. */
    background: var(--ink);
  }

  svg {
    flex: 1;
    min-height: 0;
    width: 100%;
    display: block;
  }

  /* ── analog ─────────────────────────────────────────── */
  .rim {
    fill: none;
    stroke: var(--edge);
    stroke-width: 1.5;
  }
  .tick {
    stroke: var(--paper-faint);
    stroke-width: 2;
    stroke-linecap: round;
  }
  .tick.major {
    stroke: var(--paper-mute);
    stroke-width: 3.5;
  }
  .hand {
    stroke: var(--paper);
    stroke-linecap: round;
  }
  .hand.hour {
    stroke-width: 6.5;
  }
  .hand.minute {
    stroke-width: 4;
  }
  /* The one hand that is only a hint: it moves every second and would otherwise
     be the loudest thing in a room full of quiet cards. */
  .hand.second {
    stroke: var(--paper-mute);
    stroke-width: 1.4;
  }
  .pin {
    fill: var(--paper);
  }

  /* ── digital ────────────────────────────────────────── */
  .digits {
    flex: 1;
    display: flex;
    align-items: baseline;
    justify-content: center;
    gap: 0.28em;
    min-height: 0;
    /* Sized off the widget's own box (cqw), so the time fills whatever you drag
       it to rather than sitting in the middle of a large empty plate. The
       container is `.widget` in WidgetNode. */
    font-size: min(30cqw, 46cqh);
    line-height: 1;
  }
  .time {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    color: var(--paper);
    letter-spacing: -0.02em;
  }
  .sec,
  .suffix {
    font-family: var(--mono);
    font-size: 0.36em;
    color: var(--paper-mute);
  }

  /* ── words ──────────────────────────────────────────── */
  .said {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 0.15em;
  }
  .phrase {
    font-family: var(--display);
    font-size: min(13cqw, 22cqh);
    line-height: 1.15;
    color: var(--paper);
    text-wrap: balance;
  }
  .part {
    font-family: var(--body);
    font-size: min(6.5cqw, 11cqh);
    color: var(--paper-mute);
  }

  /* ── artistic ───────────────────────────────────────── */
  .numeral {
    text-anchor: middle;
    dominant-baseline: central;
    font-family: var(--display);
    font-size: 96px;
    fill: var(--raised);
  }
  .sweep {
    fill: none;
    stroke: var(--paper);
    stroke-width: 7;
    stroke-linecap: round;
  }
  .thread {
    fill: none;
    stroke: var(--paper-faint);
    stroke-width: 1.5;
    stroke-linecap: round;
  }
  .bead {
    fill: var(--paper);
  }

  /* ── abstract ───────────────────────────────────────── */
  .track {
    fill: none;
    stroke: var(--surface);
  }
  .fill {
    fill: none;
    stroke: var(--paper-dim);
    stroke-linecap: round;
  }

  .date {
    font-family: var(--util);
    font-size: min(7cqw, 12cqh);
    color: var(--paper-mute);
    letter-spacing: 0.06em;
    white-space: nowrap;
  }
</style>
