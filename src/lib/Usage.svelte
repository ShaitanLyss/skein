<script lang="ts">
  /* What Claude Code has spent, on the wall it was spent from.
   *
   * Two readings, always both: the five-hour block the limits run on, and the
   * past seven days. They are drawn together rather than switchable because
   * neither answers the other's question — the block says whether you are about
   * to be told to wait, the week says what this way of working costs.
   *
   * The arithmetic and the words are `usage.ts` and tested; the reading is one
   * shared `Ledger` for however many of these are up. Nothing here decides
   * anything.
   *
   * **No percentage of an allowance is drawn anywhere**, and that is the whole
   * discipline of this face. Nothing on this machine knows the account's limit
   * — see the note at the top of `usage.ts` — so a bar has to be drawn against
   * something real, and what is real here is the wall's own recent history: the
   * block against the busiest block of the week, the week against the week
   * before. Every fraction says what it is measured against, right beside it. */

  import { clock } from "./conversation.svelte";
  import type { Ledger } from "./ledger.svelte";
  import {
    amount,
    leaders,
    left,
    say,
    shortModel,
    WEEK_MS,
    type Measure,
    type Reading,
    readings,
  } from "./usage";
  import { textOf, variantOf, type Widget } from "./widgets";

  let { widget, ledger }: { widget: Widget; ledger: Ledger } = $props();

  /* The one-second tick the wall already runs on, taken directly rather than
     passed down — the same rune `Clock.svelte` reads, and the reason neither of
     them adds a second wake-up per second to an otherwise idle machine. The
     reading only changes once a minute (`left`), so a tick that changes nothing
     costs a recompute and no DOM. */
  const now = $derived(clock.t);
  const variant = $derived(variantOf(widget));
  const measure = $derived(textOf(widget, "measure", "cost") as Measure);

  /* Asking is what makes the reader run at all — with no usage widget up,
     nothing walks a week of transcripts. Two effects rather than one, for the
     reason `Perf.svelte` gives: a tracking effect's cleanup fires on every
     change, so a single one would stop and restart the reader every time the
     measure was switched. */
  $effect(() => {
    ledger.attach(widget.id);
  });
  $effect(() => () => ledger.detach(widget.id));

  const both = $derived(readings(ledger.slices, now, measure));
  const rows = $derived<Reading[]>([both.block, both.week]);

  /* Where the week's money went. Only ever the top one — a widget this size has
     room for a name, not a table, and the name is the useful half. */
  const top = $derived(
    leaders(ledger.slices, now - WEEK_MS, now + 1, measure)[0] ?? null,
  );
  const quiet = $derived(both.week.totals.tokens === 0);
  const unpriced = $derived(both.week.totals.unpriced);

  function head(r: Reading): string {
    return say(amount(r.totals, measure), measure);
  }

  /** What a row is measured against, said in full — the tooltip carries the
   *  sentence the face has no room for. */
  function why(r: Reading): string {
    const own = `${r.said} — ${head(r)}`;
    if (!r.against) return own;
    return `${own}, against the ${r.against.said} (${say(r.against.amount, measure)})`;
  }
</script>

<div class="usage" data-variant={variant}>
  <header>
    <span class="what">
      {measure === "cost" ? "at list rates" : "tokens processed"}
    </span>
    {#if both.block.resetsIn !== null}
      <!-- The only countdown here, and only on the block: the weekly window
           resets on the account's own schedule, which nothing on this machine
           can see. -->
      <span class="rolls" title="the five-hour window rolls over then">
        {left(both.block.resetsIn)}
      </span>
    {:else}
      <span class="rolls rested" title="nothing said for five hours">rested</span>
    {/if}
  </header>

  {#if ledger.fault}
    <p class="fault">{ledger.fault}</p>
  {:else if !ledger.ready}
    <p class="quiet">reading the transcripts…</p>
  {:else if variant === "rings"}
    <div class="dials">
      {#each rows as r (r.key)}
        <div class="dial" title={why(r)}>
          <div class="arc" style:--v={r.frac}></div>
          <span class="val">{head(r)}</span>
          <span class="cap">{r.key === "block" ? "5 hours" : "7 days"}</span>
        </div>
      {/each}
    </div>
  {:else}
    <ul class="rows" class:bars={variant === "bars"}>
      {#each rows as r (r.key)}
        <li title={why(r)}>
          <span class="row">
            <span class="label">{r.said}</span>
            <span class="n">{head(r)}</span>
          </span>
          {#if variant === "bars"}
            <span class="bar" style:--v={r.frac}></span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <footer>
    {#if quiet && ledger.ready}
      <span class="note">nothing spent this week</span>
    {:else if top}
      <span class="note" title="most of the week's {measure === 'cost' ? 'spend' : 'tokens'}">
        mostly <b>{shortModel(top.model)}</b>
      </span>
    {/if}
    {#if unpriced > 0}
      <!-- Said out loud rather than folded in: a model this build has no rate
           for contributes nothing to the cost, and a total quietly missing a
           model is worse than a total that admits it. -->
      <span class="note odd" title="a model with no rate in this build">unpriced</span>
    {/if}
  </footer>
</div>

<style>
  .usage {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 0.34rem 0.4rem 0.32rem;
    /* Deliberately paints no background of its own. The wrapper is opaque
       already — see the ambience note — so this is the same fill either way,
       and leaving it to the wrapper means the `frame` knob's `bare` reaches
       this face rather than being covered over by it. */
    font-family: var(--util);
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 0.5ch;
    padding: 0 0.2rem 0.26rem;
    border-bottom: 1px solid var(--edge);
    font-size: 0.66rem;
    color: var(--paper-mute);
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .what {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rolls {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    color: var(--paper-dim);
  }
  .rolls.rested {
    font-family: inherit;
    color: var(--paper-faint);
  }

  .rows {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0.3rem;
    margin: 0;
    padding: 0.24rem 0 0;
    list-style: none;
  }
  .rows li {
    position: relative;
  }

  .row {
    display: flex;
    align-items: baseline;
    gap: 0.6ch;
    padding: 0.1rem 0.2rem;
    color: var(--paper-dim);
    font-size: 0.7rem;
    white-space: nowrap;
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .n {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-size: 0.78rem;
    color: var(--paper);
  }

  /* Under the row rather than inside it, so the numbers never move as it grows
     — the same arrangement the process meter's bar has. */
  .bar {
    position: absolute;
    left: 0.2rem;
    right: 0.2rem;
    bottom: -0.1rem;
    height: 1px;
    background: var(--edge);
  }
  .bar::after {
    content: "";
    position: absolute;
    inset: 0 auto 0 0;
    width: calc(var(--v) * 100%);
    background: var(--paper-faint);
  }

  .dials {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: space-evenly;
    gap: 0.5rem;
    padding: 0.3rem 0;
  }
  .dial {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.1rem;
  }
  /* Drawn in CSS rather than as an SVG, like the process meter's dials: one
     shape, no glyph, nothing to fall through to a font. */
  .arc {
    width: min(15cqw, 32cqh);
    height: min(15cqw, 32cqh);
    border-radius: 50%;
    background: conic-gradient(
      var(--paper-dim) calc(var(--v) * 360deg),
      var(--surface) 0
    );
    mask: radial-gradient(circle, transparent 58%, black 59%);
  }
  .val {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-size: 0.72rem;
    color: var(--paper);
  }
  .cap {
    font-size: 0.58rem;
    color: var(--paper-mute);
    letter-spacing: 0.06em;
  }

  footer {
    display: flex;
    align-items: baseline;
    gap: 0.6ch;
    padding: 0.2rem 0.2rem 0;
    white-space: nowrap;
    overflow: hidden;
  }
  .note {
    font-size: 0.62rem;
    color: var(--paper-mute);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .note b {
    font-weight: 500;
    color: var(--paper-dim);
  }
  /* Achromatic on purpose: colour on this wall is status, and a model nobody
     has a price for is a gap in the reading rather than a fault. */
  .note.odd {
    margin-left: auto;
    color: var(--paper-faint);
    letter-spacing: 0.04em;
  }

  .quiet,
  .fault {
    flex: 1;
    margin: 0;
    padding: 0.5rem 0.3rem;
    font-size: 0.66rem;
    color: var(--paper-mute);
    text-align: center;
  }
  .fault {
    color: var(--st-fail);
    text-align: left;
  }
</style>
