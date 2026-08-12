<script lang="ts">
  import { untrack } from "svelte";
  import type { Conversation } from "./conversation.svelte";
  import Markdown from "./Markdown.svelte";
  import Rail from "./Rail.svelte";
  import { parseMarkdown } from "./markdown";
  import { nest, readingAt, stub, type Kind, type Mark } from "./outline";

  let {
    conv,
    onhistory,
    onlink,
  }: {
    conv: Conversation;
    /** Ask for the scrollback that predates this card's process. Routed out
     *  rather than invoked here: `skein.svelte.ts` is the only thing that talks
     *  to Rust. */
    onhistory?: (c: Conversation) => void;
    /** Open a link the agent wrote. Routed out for the same reason. */
    onlink?: (href: string) => void;
  } = $props();

  /* The agent speaks markdown — headings, lists, fenced code, tables — and it
     used to arrive here as literal asterisks and hashes. Parsed per line rather
     than once per render: `lines` only ever grows, so a line is folded the once.
     Everything else is left exactly as it is. `you` is what *you* typed, shown
     character for character; a tool call and an error are already terse and
     already monospaced. */
  const streamed = $derived(parseMarkdown(conv.streaming));

  let scroller: HTMLDivElement | undefined = $state();

  /** How far from the bottom still counts as "following the tail". One line of
   *  slack, so a rounding error mid-stream doesn't read as having scrolled away. */
  const STICK_PX = 32;

  /** How long after the last scroll event a view being carried counts as having
   *  arrived. Chromium's smooth scroll emits all the way to the end, so this is
   *  measured from the last of them, not from the click. */
  const SETTLE_MS = 120;

  /** Whether the view is parked at the tail. Recomputed on every scroll, so
   *  scrolling back down by hand resumes following without a control to click. */
  let following = $state(true);

  /** Non-zero while the rail is carrying the view somewhere. */
  let carrying = 0;

  function atTail(el: HTMLElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
  }

  /** Take the reading once the movement stops. */
  function settle() {
    carrying = 0;
    if (scroller) following = atTail(scroller);
  }

  function onScroll() {
    if (!scroller) return;
    measure();
    /* A carried view's own scroll events say nothing about where you want to
       be. This is not a nicety: the first event of a smooth scroll fires with
       the panel barely moved, so a panel parked at the tail — which is where
       every panel starts — read as still following, and the follow below
       promptly dragged it back down. Clicking a rail entry looked like clicking
       nothing at all. */
    if (carrying) {
      clearTimeout(carrying);
      carrying = window.setTimeout(settle, SETTLE_MS);
      return;
    }
    following = atTail(scroller);
  }

  /* ── the rails ────────────────────────────────────────────────────────────
     Two floating lists over the wall, and they are lists of different things.

     `you said` is the conversation: everything you have asked, from the top.
     `contents` is one answer — the one you are reading — laid out as its
     opening words, its headings and the start of each of its list items. A
     table of contents for a dozen answers at once is not a table of contents;
     it is the transcript again, in a narrower column.

     Both are collected off this panel's own DOM: every navigable thing carries
     `data-nav`, so one query in document order finds the lot, and an element's
     offset is what a click needs anyway. See outline.ts. */
  type Place = Mark & {
    el: HTMLElement;
    /** Which answer this belongs to, counted down the panel. What scopes the
     *  contents rail — and the reason marks are collected for every message
     *  rather than only the one on screen: which message that *is* falls out of
     *  the same measurement that lights an entry. */
    msg: number;
  };

  /* Raw: these hold DOM elements and are replaced wholesale on every collect,
     so there is nothing for a deep proxy to earn. */
  let places = $state.raw<Place[]>([]);
  let headAt = $state(-1);
  let saidAt = $state(-1);

  const marks = $derived(places.filter((p) => p.kind !== "you"));
  const said = $derived(places.filter((p) => p.kind === "you"));

  /** How many answers the panel holds. Indices ascend down the column, so the
   *  last mark's is the count — every message contributes at least one mark,
   *  since a message with no opening words of its own has them because a
   *  heading or a list item took them. */
  const answers = $derived(marks.length ? marks[marks.length - 1].msg + 1 : 0);

  /** The answer being read: whichever one holds the mark the reader is at.
   *  Above the first mark there is nothing to go on, so the first answer stands
   *  — an empty rail at the top of a transcript would just look broken. */
  const answer = $derived(marks[headAt]?.msg ?? marks[0]?.msg ?? -1);

  const contents = $derived(marks.filter((p) => p.msg === answer));
  /** Where the reader is *within* the answer on show. It is the same mark
   *  `headAt` found, so the lit entry is always one of the ones listed. */
  const contentsAt = $derived(headAt < 0 ? -1 : contents.indexOf(marks[headAt]));

  /* Which of several, when there are several. The rail is scoped and should
     say so — otherwise an answer whose contents look short reads as an answer
     that lost half its headings. */
  const contentsCap = $derived(
    answers > 1 ? `contents · ${answer + 1}/${answers}` : "contents",
  );

  /** The text a container carries *before* its first nested mark.
   *
   *  What "the start of" a message or a list item means: everything past the
   *  first mark inside it is that mark's own to label, and taking it here would
   *  print the same words twice, one line apart. It is also why a message
   *  opening with a heading gets no entry of its own — there is nothing in front
   *  of the heading to show. */
  function startText(el: HTMLElement): string {
    let out = "";
    for (const kid of el.children) {
      if (kid.matches("[data-nav]") || kid.querySelector("[data-nav]")) break;
      out += ` ${kid.textContent ?? ""}`;
      // Long enough to cut from; the rest is read in the panel, not the rail.
      if (out.length > 400) break;
    }
    return out;
  }

  /** How many lists a list item is inside — its `rank`, which `nest` turns into
   *  an indent once it knows what heading it fell under. */
  function listDepth(el: HTMLElement): number {
    let n = 0;
    for (let p = el.parentElement; p && p !== scroller; p = p.parentElement) {
      if (p.tagName === "UL" || p.tagName === "OL") n++;
    }
    return n;
  }

  function collect() {
    if (!scroller) return;
    /* Counted here rather than in `nest`, which is about depth and has no
       business knowing where one answer stops. A mark ahead of the first
       message — there are none today — would be −1 and belong to nothing. */
    let msg = -1;
    const found = [...scroller.querySelectorAll<HTMLElement>("[data-nav]")].map(
      (el) => {
        const kind = (el.dataset.nav ?? "h") as Kind;
        if (kind === "msg") msg++;
        /* A heading and a line you typed are whole; a message and a list item
           are containers, and only their opening is theirs. */
        const text =
          kind === "h" || kind === "you" ? (el.textContent ?? "") : startText(el);
        return {
          el,
          kind,
          msg,
          rank:
            kind === "h"
              ? Number(el.dataset.level ?? 1)
              : kind === "li"
                ? listDepth(el)
                : 0,
          label: stub(text),
          // Capped too: a tooltip carrying a whole pasted file is not a tooltip.
          full: stub(text, 300),
        };
      },
    );

    /* Indents come from the run, not from any one tag — and `nest` drops the
       marks with nothing to show, after it has used them for their place. */
    const levels = nest(found);
    const next: Place[] = [];
    for (let i = 0; i < found.length; i++) {
      const level = levels[i];
      if (level === null) continue;
      next.push({ ...found[i], level });
    }
    places = next;
  }

  /** Where the reader is, in each rail. Measured rather than remembered: the
   *  column above a mark grows all through a turn, so an offset cached when the
   *  mark was collected would be wrong a second later. */
  function measure() {
    const el = scroller;
    if (!el) return;
    const { scrollTop, clientHeight, scrollHeight } = el;
    /* Against every mark in the panel, not only the ones on show: this is what
       decides *which* answer is on show. `offsetTop` is measured against
       `.lines`, which is positioned for exactly this. */
    headAt = readingAt(
      marks.map((p) => p.el.offsetTop),
      scrollTop,
      clientHeight,
      scrollHeight,
    );
    saidAt = readingAt(
      said.map((p) => p.el.offsetTop),
      scrollTop,
      clientHeight,
      scrollHeight,
    );
  }

  /** Recollect, after the DOM the change caused actually exists. Never sooner:
   *  mid-effect the panel is still the old one, so the list and every offset in
   *  it would be a frame stale — the same reason the follow below waits.
   *
   *  A soon-enough collect already coming is left alone; a sooner one takes its
   *  place. Only ever *shortening* the wait is what keeps this from starving:
   *  a stream asking again every few milliseconds asks for the same 160ms it
   *  already has, and gets it. */
  let recollect = 0;
  let waiting = Infinity;
  function refresh(delay: number) {
    if (recollect && waiting <= delay) return;
    clearTimeout(recollect);
    waiting = delay;
    recollect = window.setTimeout(() => {
      recollect = 0;
      waiting = Infinity;
      collect();
      measure();
    }, delay);
  }

  $effect(() => {
    void conv.lines.length;
    void conv.history.length;
    refresh(0);
  });

  /* A different card is a different panel. The marks go the moment it changes
     rather than when the next collect lands: they point at elements that are no
     longer in the document, so left up they would list the previous answer and
     measure it at an offset of zero. */
  $effect(() => {
    void conv.id;
    places = [];
    headAt = -1;
    saidAt = -1;
    refresh(0);
  });

  /* A turn's own text is throttled rather than followed frame by frame: a
     collect walks every mark in the panel, `thinking_delta` outnumbers
     `text_delta` about 8:1 so there are a great many of them, and a heading that
     joins the rail a sixth of a second late is not something anybody sees. Where
     you *are* stays exact regardless — `measure` runs on every scroll, and
     following the tail scrolls. */
  const STREAM_MS = 160;
  $effect(() => {
    void conv.streaming;
    refresh(STREAM_MS);
  });

  /* The timers are the one thing here that outlives the panel. */
  $effect(() => () => {
    clearTimeout(recollect);
    clearTimeout(carrying);
  });

  /** Go to a mark. */
  function jump(p: Place) {
    const el = scroller;
    if (!el) return;
    /* Clicking a rail is asking to read something, so it lets go of the tail —
       otherwise a live turn drags the view straight back down. `settle` takes
       it up again if the view came to rest at the bottom after all. */
    following = false;
    clearTimeout(carrying);
    carrying = window.setTimeout(settle, SETTLE_MS);
    /* Where the mark sits inside the scroller, whatever it is nested in:
       `offsetTop` would answer for the nearest positioned ancestor, and the
       panel is free to grow one. A little air above it, too — a heading flush
       against the top edge reads as cropped. */
    const to =
      el.scrollTop +
      (p.el.getBoundingClientRect().top - el.getBoundingClientRect().top) -
      12;
    el.scrollTo({ top: Math.max(0, to), behavior: "smooth" });
  }

  /* Focusing a different card is a fresh view, and a fresh view starts at the
     tail — otherwise the scroll position you left behind on one card decides
     where you land on the next one. */
  $effect(() => {
    void conv.id;
    following = true;
  });

  /* The panel opening is what pays for reading a multi-megabyte file: the wall
     itself never needs the scrollback, and reading every card's transcript at
     launch would undo lazy restore.

     Untracked, because the loader's own first act is to read `historyState` to
     see whether it has already run — inside a tracking scope that would make
     this effect depend on the very field it is about to write. */
  $effect(() => {
    const c = conv;
    void c.id;
    untrack(() => onhistory?.(c));
  });

  /* Follow the tail while text streams in — but only if that is where you
     already were. Scrolling up during a live turn is how you read what has just
     gone past, and pinning the view to the bottom on every token made that
     impossible: the line you were reading left the screen before you finished
     it, several times a second. */
  $effect(() => {
    void conv.streaming;
    void conv.lines.length;
    /* History arrives all at once and lands *above* everything, so without this
       the view would sit at what is suddenly the top of a long column. */
    void conv.history.length;
    const el = scroller;
    if (!el || !following) return;
    /* On the next frame rather than now: mid-effect the DOM still has its old
       height, so scrolling to `scrollHeight` here would stop one line short of
       the text that triggered this.
       Asked again when it fires, because a frame is long enough to have let go:
       a rail click during a live turn lands between the two, and this would
       otherwise carry out a decision that had already been reversed. */
    requestAnimationFrame(() => {
      if (following) el.scrollTop = el.scrollHeight;
    });
  });
</script>

<section class="detail">
  <!-- Over the wall rather than in the panel: what is being read keeps its full
       column, and the gaps between the rails stay wall you can pan. -->
  <div class="rails">
    <Rail label="you said" marks={said} active={saidAt} onpick={(i) => jump(said[i])} />
    <Rail
      label={contentsCap}
      marks={contents}
      active={contentsAt}
      onpick={(i) => jump(contents[i])}
    />
  </div>

  <div class="lines" bind:this={scroller} onscroll={onScroll}>
    <!-- What was said before this card had a process listening. Drawn in the
         same column and the same kinds as the live fold, so the seam is a rule
         and a label rather than a change of voice. -->
    {#if conv.history.length}
      <div class="seam">
        <span>
          {conv.historyPartial
            ? "earlier — read from the transcript, from partway in"
            : "earlier — read from the transcript"}
        </span>
      </div>
      {#each conv.history as line, i (i)}
        {#if line.kind === "text"}
          <!-- `data-nav` is the rail's whole handle on the panel: this one is
               the answer itself, and the marks inside it are its shape. -->
          <div class="line text md" data-nav="msg">
            <Markdown blocks={parseMarkdown(line.text)} {onlink} />
          </div>
        {:else}
          <!-- `data-nav` is what the rail collects; the line is drawn exactly as
               it was. `pre-wrap` here, so the text stays glued to its tags. -->
          <div class="line {line.kind}" data-nav={line.kind === "you" ? "you" : null}>{line.text}</div>
        {/if}
      {/each}
      {#if conv.lines.length || conv.streaming}
        <div class="seam rule"></div>
      {/if}
    {:else if conv.historyState === "loading"}
      <div class="line meta">reading the transcript…</div>
    {/if}

    {#each conv.lines as line, i (i)}
      {#if line.kind === "text"}
        <div class="line text md" data-nav="msg">
          <Markdown blocks={parseMarkdown(line.text)} {onlink} />
        </div>
      {:else}
        <div class="line {line.kind}" data-nav={line.kind === "you" ? "you" : null}>{line.text}</div>
      {/if}
    {/each}
    {#if conv.streaming}
      <div class="line text md" data-nav="msg">
        <Markdown blocks={streamed} caret {onlink} />
      </div>
    {/if}
    <!-- An empty card should read as a beginning, not as a missing component.
         The theme is ink on paper down to its token names, so a card with
         nothing on it is a sheet with nothing on it — and one that has spoken
         but whose pages are not on disk is a different thing again, worth
         saying rather than dressing up as new. -->
    {#if conv.lines.length === 0 && !conv.streaming && conv.historyState !== "loading" && !conv.history.length}
      <div class="line meta">
        {#if !conv.dormant}
          the page is open — say something
        {:else if conv.everSpoke}
          its earlier pages aren't here — speak and it picks up where it left off
        {:else}
          a fresh sheet — it wakes when you speak
        {/if}
      </div>
    {/if}
  </div>

  <footer class="meta-bar">
    <span>{Math.round(conv.ctx * 100)}% context</span>
    <span class="sep">·</span>
    <span>{conv.ctxTokens.toLocaleString()} tok</span>
    <span class="sep">·</span>
    <span>{conv.turns} {conv.turns === 1 ? "turn" : "turns"}</span>
    {#if conv.costUsd > 0}
      <span class="sep">·</span>
      <span>${conv.costUsd.toFixed(3)}</span>
    {/if}
    <span class="grow"></span>
    {#if conv.model}<span class="model">{conv.model}</span>{/if}
  </footer>
</section>

<style>
  .detail {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    border: 1px solid var(--edge);
    border-radius: 4px;
    background: var(--well);
    padding: 0.75rem 0.85rem 0.6rem;
    /* The rails hang off this. */
    position: relative;
  }

  /* Beside the panel, over the wall. Only the rails themselves take the mouse:
     the gaps around them are wall, and the wall pans. */
  .rails {
    position: absolute;
    top: 0;
    bottom: 0;
    right: calc(100% + 0.7rem);
    width: clamp(9rem, 13vw, 15rem);
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.6rem;
    pointer-events: none;
    z-index: 2;
  }
  .lines {
    flex: 1 1 auto;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    min-height: 0;
    padding-right: 0.3rem;
    /* What a mark's `offsetTop` is measured against — see `measure`. */
    position: relative;
  }
  .line {
    font-size: 0.86rem;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-width: 78ch;
  }
  .line.text {
    color: var(--paper-dim);
  }
  /* A folded line brings its own layout: paragraphs keep the agent's newlines,
     but a heading, a list and a table must not be held in pre-wrap. */
  .line.md {
    white-space: normal;
  }
  /* Your half of the conversation. Set in against a rule rather than in a
     bubble: the transcript is one column of speech, and what distinguishes you
     is the margin, not a container. */
  .line.you {
    color: var(--paper);
    border-left: 2px solid var(--paper-faint);
    padding-left: 0.6rem;
    margin-left: -0.05rem;
  }
  .line.tool {
    font-family: var(--mono);
    font-size: 0.7rem;
    color: var(--paper-mute);
  }
  .line.tool::before {
    content: "▸ ";
    color: var(--paper-faint);
  }
  .line.error {
    font-family: var(--mono);
    font-size: 0.7rem;
    color: var(--st-fail);
  }
  .line.meta {
    font-family: var(--util);
    font-size: 0.76rem;
    color: var(--paper-faint);
  }

  /* Where the file stops and the stream starts. Achromatic — this is chrome,
     not status. */
  .seam {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 0 0 auto;
    font-family: var(--util);
    font-size: 0.64rem;
    color: var(--paper-faint);
  }
  .seam::before,
  .seam::after {
    content: "";
    flex: 1 1 auto;
    height: 1px;
    background: var(--edge);
  }
  /* The closing seam carries no label: the history above it already said what
     it was, and the live lines below need no announcement. */
  .seam.rule {
    gap: 0;
  }

  .meta-bar {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    border-top: 1px solid var(--edge);
    padding-top: 0.45rem;
    font-family: var(--util);
    font-size: 0.68rem;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
    flex: 0 0 auto;
  }
  .meta-bar .grow {
    flex: 1 1 auto;
  }
  .meta-bar .sep {
    color: var(--edge);
  }
  .meta-bar .model {
    font-family: var(--mono);
    font-size: 0.64rem;
  }
</style>
