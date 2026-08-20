<script lang="ts">
  /* A dev server's output, on the wall it is being written for.
   *
   * The panel already shows every group's log, folded away behind a `log`
   * button per group. What a widget adds is that you did not have to ask: the
   * thing you are waiting for — the recompile, the port binding, the stack
   * trace — is on the wall beside the card whose agent caused it.
   *
   * Three things about it are deliberate:
   *
   * - **A start button, and nothing else.** A group that is down is a group you
   *   want to bring up, and that gesture belongs here — it is what the widget
   *   is *for* half the time you look at it. Stop and remove do not: this is
   *   furniture on a wall you drag things around on, and a stop under the
   *   pointer where a reading used to be is a server killed by a mis-drag. The
   *   panel has both, spelled out, next to the × that deletes the group.
   *
   * - **It reads a crash as down.** `running` is a flag the wall sets when it
   *   asks for a start, so a server that exited on its own is `running: true`
   *   with an `exited` health — see `standing` in `serverlog.ts`.
   *
   * - **No scrollback, and that is the wheel's fault rather than a choice about
   *   logs.** `Canvas` preventDefaults every wheel on the surface to zoom, so
   *   nothing on the wall can be scrolled with it; `linesFor` draws what the
   *   height fits, anchored to the newest line. Reaching further back is the
   *   panel's job, and the panel scrolls.
   *
   * The colour is the server's own — `ansi.ts` renders the sixteen it is sent,
   * which the pipes keep by asking rather than by being a terminal (see
   * `.claude/rules/servers.md`). That is the one place decorative-looking colour
   * on this wall is not ours to reserve: it is what the program said. */

  import { ANSI_PALETTE, parseAnsi } from "./ansi";
  import {
    FOLLOW,
    latest,
    linesFor,
    nameOf,
    standing,
    subjectOf,
    tail,
    type Reading,
  } from "./serverlog";
  import { textOf, variantOf, type Widget } from "./widgets";

  let {
    widget,
    groups,
    onstart,
  }: {
    widget: Widget;
    /** Every dev server group on the wall, flattened in `App.svelte` beside the
     *  `chipsFor` that already does this for a territory's chips. Plain data
     *  rather than the `GroupRuntime`s themselves, so nothing between here and
     *  there has to hold a rune class. */
    groups: Reading[];
    /** Bring one up. Routed out rather than invoked here, the way every other
     *  gesture a widget offers is — the face knows what it is looking at and
     *  `Skein` knows what starting means. */
    onstart: (groupId: string) => void;
  } = $props();

  const variant = $derived(variantOf(widget));
  const showing = $derived(textOf(widget, "showing", "all"));
  const subject = $derived(subjectOf(textOf(widget, "group", FOLLOW), groups));
  const group = $derived(subject.group);
  /* Read off as its own value rather than narrowed at the markup: `group` is a
     separate `$derived`, so testing it tells the compiler nothing about which
     arm of `subjectOf`'s union `subject` is. */
  const because = $derived("because" in subject ? subject.because : null);
  const rows = $derived(linesFor(widget.h));

  /* Named `stand` rather than `state`, which in a file full of runes reads as
     something it is not. */
  const stand = $derived(group ? standing(group) : null);
  const cut = $derived(
    group ? tail(group.log, showing, rows) : { lines: [], hidden: 0 },
  );
  const lasts = $derived(
    group ? latest(group.servers, group.log, showing) : [],
  );
</script>

<div class="slog" data-variant={variant}>
  <header>
    <span class="dot {group?.overall ?? 'idle'}"></span>
    {#if group}
      <span class="who" title={nameOf(group)}>
        <b>{group.label}</b><i>{group.project}</i>
      </span>
      {#each group.servers as s (s.label)}
        <span class="svc" data-h={group.health[s.label] ?? "idle"}>
          {s.label}{#if s.port}<em>:{s.port}</em>{/if}
        </span>
      {/each}
    {:else}
      <span class="who"><b>no server</b></span>
    {/if}
  </header>

  {#if !group}
    <!-- The two absences are different things to say, and neither is a fault:
         one is a wall with nothing to point this at yet, the other is a group
         that has been deleted out from under a widget that named it. -->
    <p class="quiet">
      {#if because === "gone"}
        the group this was set to is not on the wall any more — right-click to
        pick another
      {:else}
        no dev server groups yet — the servers panel is where a project gets one
      {/if}
    </p>
  {:else if stand?.down}
    <div class="down">
      <span class="word">{stand.word}</span>
      <button class="go" onclick={() => onstart(group.id)}>{stand.verb}</button>
    </div>
  {:else if variant === "latest"}
    <!-- One line each rather than a scroll: what a log dropped to the size of a
         card can still say. The silent server gets a row too — it is the
         interesting one. -->
    <ul class="lasts">
      {#each lasts as l (l.label)}
        <li>
          <span class="src">{l.label}</span>
          {#if l.line === null}
            <span class="none">nothing yet</span>
          {:else}
            <span class="said" class:err={l.stderr}>
              {#each parseAnsi(l.line) as s}<span
                  style:color={s.color === null ? null : ANSI_PALETTE[s.color]}
                  style:font-weight={s.bold ? "600" : null}
                  style:opacity={s.dim ? 0.6 : null}>{s.text}</span
                >{/each}
            </span>
          {/if}
        </li>
      {/each}
    </ul>
  {:else if cut.lines.length}
    <pre class="log">{#each cut.lines as l, i (i)}<span class="ln"
          ><span class="src" data-err={l.stderr}>{l.label}</span> {#each parseAnsi(l.line) as s}<span
            style:color={s.color === null ? null : ANSI_PALETTE[s.color]}
            style:font-weight={s.bold ? "600" : null}
            style:opacity={s.dim ? 0.6 : null}>{s.text}</span
          >{/each}</span
      >{/each}</pre>
  {:else}
    <!-- An empty pane that cannot say why reads as a widget that has broken, so
         a filter that emptied it says so with the count it dropped. -->
    <p class="quiet">
      {#if cut.hidden}
        nothing on stderr — {cut.hidden}
        {cut.hidden === 1 ? "line" : "lines"} went to stdout
      {:else}
        nothing yet
      {/if}
    </p>
  {/if}
</div>

<style>
  .slog {
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
  /* The group first at full strength and the project after it, dimmer: on a
     wall with one project the second word is furniture, and on a wall with
     three it is the whole answer. Both, in that weighting, rather than a knob. */
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

  /* The same reading the panel's chips carry, so a server that is up looks the
     same in both places. Colour is status here and nowhere else on this face. */
  .svc {
    flex: 0 0 auto;
    color: var(--paper-mute);
    border: 1px solid var(--edge);
    border-radius: 999px;
    padding: 0.02rem 0.4rem;
    font-size: 0.6rem;
  }
  .svc em {
    font-style: normal;
    color: var(--paper-faint);
  }
  .svc[data-h="up"] {
    border-color: color-mix(in srgb, var(--st-work) 50%, var(--edge));
    color: var(--paper-dim);
  }
  .svc[data-h="exited"] {
    border-color: color-mix(in srgb, var(--st-fail) 50%, var(--edge));
    color: var(--st-fail);
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--paper-faint);
    flex: 0 0 auto;
    align-self: center;
  }
  .dot.up {
    background: var(--st-work);
  }
  .dot.starting {
    background: var(--st-soft);
  }
  .dot.exited {
    background: var(--st-fail);
  }

  .log {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 0.16rem 0.2rem 0;
    font-family: var(--mono);
    /* `linesFor` is measured against this pair. Changing either means changing
       it, or the widget draws a line more than it has room for and the newest
       one is the one clipped. */
    font-size: 0.62rem;
    line-height: 1.5;
    color: var(--paper-mute);
    /* Never scrolls — the wheel belongs to the wall's zoom, so what is drawn is
       what fits, and `linesFor` is what decides how much that is.
       `justify-content: flex-end` is what makes being wrong about it survivable:
       the column is anchored to its bottom, so a line more than there is room
       for spills off the *top*, where it is merely old. Without it the overflow
       goes off the bottom and the one line the whole widget exists to show is
       the one clipped — and that would be decided by how a font happened to
       round, which is not a thing to bet the reading on. */
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    overflow: hidden;
    /* `pre` rather than `pre-wrap`: a long line is cut rather than wrapped,
       because a stack trace that wrapped to four lines would push three real
       ones off the bottom of a small widget — and on a face whose height is the
       setting, the line that gets pushed off is the newest. */
    white-space: pre;
  }
  .ln {
    display: block;
    flex: 0 0 auto;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .src {
    color: var(--paper-faint);
  }
  /* Which pipe a line came down, and the only mark on it. Not a colour on the
     text itself — that space belongs to whatever the program printed, and a
     rust-coloured line would be Skein overruling a server that had said
     something perfectly calm on stderr, which is where half of them log
     everything. */
  .src[data-err="true"] {
    color: color-mix(in srgb, var(--st-fail) 60%, var(--paper-faint));
  }

  .lasts {
    flex: 1;
    min-height: 0;
    margin: 0;
    padding: 0.2rem 0.2rem 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    overflow: hidden;
  }
  .lasts li {
    display: flex;
    align-items: baseline;
    gap: 0.6ch;
    min-width: 0;
    font-family: var(--mono);
    font-size: 0.68rem;
  }
  .lasts .src {
    flex: 0 0 auto;
    font-size: 0.6rem;
  }
  .said {
    flex: 1;
    min-width: 0;
    color: var(--paper-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .said.err {
    color: color-mix(in srgb, var(--st-fail) 40%, var(--paper-dim));
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

  /* The same absence said inline, on a row that is already a flex line. */
  .none {
    color: var(--paper-faint);
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
