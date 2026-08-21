<script lang="ts">
  /* The frame every log widget stands in: a header that names what it is
   * reading, and a body that is either the reading, one sentence about why there
   * is none, or a button that would produce some.
   *
   * Cut out of `ServerLog.svelte` when the build log and the editor log turned
   * out to want the same three-state body and the same header, and kept as its
   * own component for the reason `Dock.svelte` was: **a component is the only
   * CSS scope this codebase has.** `.dot`, `.who`, `.quiet`, `.go` are the
   * vocabulary of a log's chrome, and three files defining them would be three
   * places for a border colour to drift — and one of them would drift silently,
   * because they would still all look right in isolation.
   *
   * What it does not hold is the lines (`LogTail.svelte`, whose CSS `linesFor`
   * is measured against) or any judgement about a subject: which thing is being
   * watched, what down means, what the button does when pressed, are each their
   * own face's. This draws what it is handed. */

  import type { Snippet } from "svelte";

  let {
    pulse = "idle",
    name,
    sub = "",
    title = undefined,
    chips = undefined,
    down = null,
    note = null,
    children,
  }: {
    /** The dot, in the one place a log is allowed colour of its own. Five
     *  states rather than each subject's own vocabulary, so a group that is up
     *  and a build that is running read identically — they are the same news. */
    pulse?: "idle" | "live" | "pending" | "rest" | "dead";
    /** What this is a log of, at full strength. */
    name: string;
    /** Whose it is, dimmer. On a wall with one project the second word is
     *  furniture; on a wall with three it is the whole answer. Both, in that
     *  weighting, rather than a knob. */
    sub?: string;
    title?: string;
    /** Whatever else the header carries — a group's ports, a run's elapsed, an
     *  editor's tally. Right of the name and allowed to be clipped. */
    chips?: Snippet;
    /** Something is not running and pressing this would start it. Wins over
     *  `note`: a filter that emptied the pane is not the news when the thing
     *  producing the lines has stopped.
     *
     *  A start button and nothing else, in all three faces. Stop and remove do
     *  not belong here: this is furniture on a wall you drag things around on,
     *  and a stop under the pointer where a reading used to be is a server
     *  killed by a mis-drag. The panels have both, spelled out.
     *
     *  A null `verb` is the word without the button, for the one case where
     *  there is something to say and nothing to press — a project that offers
     *  no build at all. Saying it beats a widget that looks broken, and a
     *  button labelled with nothing would be worse than both. */
    down?: { word: string; verb: string | null; press: () => void } | null;
    /** One sentence instead of a reading — nothing yet, a filter that dropped
     *  everything, a subject that has been deleted out from under the widget.
     *  An empty pane that cannot say why reads as a widget that has broken. */
    note?: string | null;
    children: Snippet;
  } = $props();
</script>

<div class="face">
  <header>
    <span class="dot" data-pulse={pulse}></span>
    <span class="who" {title}>
      <b>{name}</b>{#if sub}<i>{sub}</i>{/if}
    </span>
    {@render chips?.()}
  </header>

  {#if down}
    <div class="down">
      <span class="word">{down.word}</span>
      {#if down.verb}
        <button class="go" onclick={down.press}>{down.verb}</button>
      {/if}
    </div>
  {:else if note}
    <p class="quiet">{note}</p>
  {:else}
    {@render children()}
  {/if}
</div>

<style>
  .face {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 0.34rem 0.4rem 0.4rem;
    /* Paints no background of its own — the wrapper fills, which is what lets
       the `frame` knob's `bare` reach this face. See `widgets.md`. */
    font-family: var(--util);
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 0.45ch;
    padding: 0 0.2rem 0.26rem;
    border-bottom: 1px solid var(--edge);
    font-size: 0.64rem;
    white-space: nowrap;
    overflow: hidden;
  }
  .who {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--paper-mute);
  }
  .who b {
    color: var(--paper);
    font-weight: 600;
  }
  .who i {
    font-style: normal;
    color: var(--paper-faint);
    margin-left: 0.6ch;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--paper-faint);
    flex: 0 0 auto;
    align-self: center;
  }
  .dot[data-pulse="live"] {
    background: var(--st-work);
  }
  .dot[data-pulse="pending"] {
    background: var(--st-soft);
  }
  .dot[data-pulse="rest"] {
    background: var(--st-rest);
  }
  .dot[data-pulse="dead"] {
    background: var(--st-fail);
  }

  .down {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
  }
  .word {
    font-size: 0.7rem;
    color: var(--paper-mute);
    text-align: center;
    padding: 0 0.4rem;
  }
  .go {
    font-family: var(--util);
    font-size: 0.7rem;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper);
    padding: 0.22rem 0.7rem;
    cursor: pointer;
  }
  .go:hover {
    border-color: var(--rule);
    background: var(--raised);
  }

  .quiet {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 0.3rem 0.2rem 0;
    font-size: 0.66rem;
    line-height: 1.45;
    color: var(--paper-faint);
    overflow: hidden;
  }
</style>
