<script lang="ts">
  /* What is left of the allowance, and what the work has cost.
   *
   * Two readings of two different things, and the knob picks which. The default
   * is the **allowance** — how much of the five-hour window and of the week is
   * gone, and when each comes back — because that is the question anybody
   * actually has at four in the afternoon, and it is what `/usage` answers in
   * the CLI. `cost` and `tokens` are the other reading: what this way of working
   * costs, off the transcripts.
   *
   * **The percentages here are real, and that is new.** This face used to carry
   * a standing note that no percentage of an allowance could be drawn anywhere,
   * because nothing on the machine knew the account's limit — every fraction was
   * drawn against the wall's own recent history instead, the block against the
   * busiest block of the week. That was true of *transcripts* and false of the
   * account: `/api/oauth/usage` names both the utilization and the reset, and
   * `limits.rs` asks it. So the honest-fallback apparatus is still here and is
   * still what `cost` and `tokens` draw — an account with no OAuth sign-in has
   * nothing else — but it is no longer the best answer available.
   *
   * The arithmetic and the words are `limits.ts` and `usage.ts`, both pure and
   * tested; the reading is one shared `Ledger`. Nothing here decides anything. */

  import { clock } from "./conversation.svelte";
  import type { Ledger } from "./ledger.svelte";
  import {
    binding,
    ordered,
    pct,
    planSaid,
    resetIn,
    tierOf,
    until,
    said as windowSaid,
    why as windowWhy,
  } from "./limits";
  import {
    amount,
    leaders,
    left,
    say,
    share,
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

  /** What this face is a reading *of*. Wider than `Measure`, because the
   *  allowance is not a third way of counting tokens — it is a different fact,
   *  off a different source, with a denominator the other two do not have. */
  type Knob = "allowance" | Measure;
  const knob = $derived(textOf(widget, "measure", "allowance") as Knob);
  const allowance = $derived(knob === "allowance");
  /* The cost path still wants a `Measure`, and `cost` is the sane thing to fall
     back to when the knob is on a value it does not understand. */
  const measure = $derived<Measure>(knob === "tokens" ? "tokens" : "cost");

  /* Asking is what makes the reader run at all — with no usage widget up,
     nothing walks a week of transcripts and nothing leaves the machine. The
     measure goes in with the ask, so a wall showing the allowance does not pay
     for a week of transcripts it is not drawing; `Ledger.#retime` starts and
     stops only the half that changed, so turning the knob does not disturb the
     other one. Two effects rather than one, for the reason `Perf.svelte` gives:
     a tracking effect's cleanup fires on every change, and a single one would
     detach on every re-read. */
  $effect(() => {
    ledger.attach(widget.id, allowance ? "allowance" : "spend");
  });
  $effect(() => () => ledger.detach(widget.id));

  /* ── the allowance ───────────────────────────────────────────────────── */

  const windows = $derived(ordered(ledger.limits?.windows ?? []));
  /** The one about to stop you, which is what the header counts down. */
  const soonest = $derived(binding(windows));
  const heading = $derived(
    allowance ? planSaid(ledger.limits?.plan ?? null) : measure === "cost"
      ? "at list rates"
      : "tokens processed",
  );

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
    <span class="what">{heading}</span>
    {#if allowance}
      <!-- The account's own reset, for whichever window runs out first. Unlike
           the block below this is a fact off the wire rather than an inference,
           and it is the half of the question the percentage does not answer. -->
      {#if soonest && resetIn(soonest, now) !== null}
        <span class="rolls" title="{windowSaid(soonest)} comes back then">
          {until(resetIn(soonest, now)!)}
        </span>
      {/if}
    {:else if both.block.resetsIn !== null}
      <!-- The inferred block, and only the block: without the account's answer
           the weekly window resets on a schedule nothing here can see. -->
      <span class="rolls" title="the five-hour window rolls over then">
        {left(both.block.resetsIn)}
      </span>
    {:else}
      <span class="rolls rested" title="nothing said for five hours">rested</span>
    {/if}
  </header>

  {#if allowance}
    {#if !ledger.limits && ledger.limitsFault}
      <p class="fault">{ledger.limitsFault}</p>
    {:else if !ledger.limits}
      <p class="quiet">asking the account…</p>
    {:else if windows.length === 0}
      <p class="quiet">no windows on this account</p>
    {:else if variant === "rings"}
      <div class="dials">
        {#each windows as w (w.kind + (w.scope ?? ""))}
          <div class="dial" title={windowWhy(w, now)}>
            <div class="arc" data-tier={tierOf(w)} style:--v={share(w.used, 100)}></div>
            <span class="val" data-tier={tierOf(w)}>{pct(w.used)}</span>
            <span class="cap">{windowSaid(w)}</span>
          </div>
        {/each}
      </div>
    {:else}
      <ul class="rows" class:bars={variant === "bars"}>
        {#each windows as w (w.kind + (w.scope ?? ""))}
          <li title={windowWhy(w, now)}>
            <span class="row">
              <span class="label">{windowSaid(w)}</span>
              {#if resetIn(w, now) !== null}
                <span class="when">{until(resetIn(w, now)!)}</span>
              {/if}
              <span class="n" data-tier={tierOf(w)}>{pct(w.used)}</span>
            </span>
            {#if variant === "bars"}
              <!-- A fraction of a real limit, which is the whole difference
                   between this reading and the one below it. -->
              <span class="bar" data-tier={tierOf(w)} style:--v={share(w.used, 100)}></span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {:else if ledger.fault}
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
    {#if allowance}
      {#if ledger.limits?.overage?.enabled}
        <!-- Without this, every window pinned full while work carries on
             reads as a broken instrument rather than as a bill. -->
        <span class="note" title="spending past the plan's allowance">
          on extra usage
        </span>
      {:else if ledger.limits}
        <span class="note" title="read from {ledger.limits.source}">
          {windows.length} window{windows.length === 1 ? "" : "s"}
        </span>
      {/if}
      {#if ledger.limits && ledger.limitsFault}
        <!-- A reading is up and the last ask failed, so what is on the face is
             the truth as of some minutes ago. Said rather than silently
             redrawn: a stale percentage that looks live is the one way this
             widget can mislead. -->
        <span class="note odd" title={ledger.limitsFault}>stale</span>
      {/if}
    {:else if quiet && ledger.ready}
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

  /* When a window comes back. Between the label and the figure rather than
     after it, so the column of percentages stays flush right and readable as a
     column — the reset is the sentence, the percentage is the reading. */
  .when {
    font-family: var(--mono);
    font-variant-numeric: tabular-nums;
    font-size: 0.62rem;
    color: var(--paper-faint);
    white-space: nowrap;
  }

  /* Colour is status on this wall and nowhere else, and an allowance running
     out is status in the strictest sense — the same amber and rust a card
     wears, meaning the same thing. Calm takes no colour at all, which is what
     keeps the other two worth noticing. */
  .n[data-tier="warm"],
  .val[data-tier="warm"] {
    color: var(--st-ask);
  }
  .n[data-tier="urgent"],
  .val[data-tier="urgent"] {
    color: var(--st-fail);
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
  .bar[data-tier="warm"]::after {
    background: var(--st-ask);
  }
  .bar[data-tier="urgent"]::after {
    background: var(--st-fail);
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
      var(--arc, var(--paper-dim)) calc(var(--v) * 360deg),
      var(--surface) 0
    );
    mask: radial-gradient(circle, transparent 58%, black 59%);
  }
  .arc[data-tier="warm"] {
    --arc: var(--st-ask);
  }
  .arc[data-tier="urgent"] {
    --arc: var(--st-fail);
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
