<script lang="ts">
  /* Lines, newest at the bottom, in the space there is.
   *
   * The one reading all three log widgets share, and the reason `logface.ts`
   * exists: `linesFor` is measured against the font size below, so a second copy
   * of this markup would be a second place for that arithmetic to be wrong
   * about the CSS it describes. What the subjects differ on — which lines, what
   * the gutter mark says, whether a tone means anything — arrives as `Row[]`
   * already decided.
   *
   * No scrollback, and that is the wheel's fault rather than a choice about
   * logs: `Canvas` preventDefaults every wheel on the surface to zoom, so
   * nothing standing on the wall can be scrolled. Reaching further back is a
   * panel's job, and panels scroll. */

  import { ANSI_PALETTE, parseAnsi } from "./ansi";
  import type { Row } from "./logface";

  let {
    rows,
    tint = false,
  }: {
    rows: Row[];
    /** Whether a tone reaches the *text* as well as the gutter mark.
     *
     *  False for anything a program printed itself, which is the server log and
     *  the build log: that space belongs to whatever the compiler said, and a
     *  rust-coloured line would be Skein overruling something perfectly calm
     *  that happened to come down stderr — where half of everything logs. True
     *  for the editor log, where the verbosity is a claim the *writer* made
     *  (`LogTemp: Error:`) and the file carries no colour of its own to
     *  overrule. */
    tint?: boolean;
  } = $props();
</script>

<!-- Keyed by index rather than by content: a log repeats itself constantly —
     `[3/9] Compile Foo.cpp` twice in one build is ordinary — and a key that
     collided would drop the second one. -->
<pre class="log" class:tint>{#each rows as r, i (i)}<span class="ln" data-tone={r.tone}
    >{#if r.mark}<span class="src">{r.mark}</span> {/if}{#each parseAnsi(r.text) as s}<span
      style:color={s.color === null ? null : ANSI_PALETTE[s.color]}
      style:font-weight={s.bold ? "600" : null}
      style:opacity={s.dim ? 0.6 : null}>{s.text}</span
    >{/each}</span
  >{/each}</pre>

<style>
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
  /* The gutter: which server, which action, which log category. Dim by
     default — it is an index into the line rather than part of it.
     `--st-soft` for a warning rather than `--st-ask`: full amber on this wall
     means a card is asking you something, and a log full of deprecation notices
     must not read as a question. Half-amber is the register for "worth your eye,
     not waiting on you". */
  .src {
    color: var(--paper-faint);
  }
  .ln[data-tone="warn"] .src {
    color: color-mix(in srgb, var(--st-soft) 70%, var(--paper-faint));
  }
  .ln[data-tone="fail"] .src {
    color: color-mix(in srgb, var(--st-fail) 60%, var(--paper-faint));
  }
  /* And the text itself, only where the tone was the writer's own claim. */
  .tint .ln[data-tone="warn"] {
    color: color-mix(in srgb, var(--st-soft) 55%, var(--paper-mute));
  }
  .tint .ln[data-tone="fail"] {
    color: color-mix(in srgb, var(--st-fail) 45%, var(--paper-mute));
  }
</style>
