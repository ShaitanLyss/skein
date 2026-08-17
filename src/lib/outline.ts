/* The two rails beside the transcript.
 *
 * A long answer is a document — headings, sections, a shape you want to skim —
 * and a long conversation is a list of the things you asked. Both are navigable
 * and both want exactly the same three things: a list of places, one of them
 * marked as where you are, and a click that goes there. So neither owns any of
 * it. `Transcript.svelte` collects the marks off the panel's own DOM, one
 * `Rail.svelte` draws either list, and every decision with any judgement in it
 * lives here, pure and tested — see test/outline.test.ts.
 *
 * Collecting from the DOM rather than parsing the markdown a second time is
 * deliberate: the headings a table of contents lists are exactly the ones drawn,
 * so read off the elements they cannot drift from what is on screen — and the
 * element's offset is the number a click needs anyway.
 */

/** What a rail lists.
 *
 *  `msg` is the start of an answer — an agent does not always open with a
 *  heading, and a message with none at all still has to be reachable. `li` is
 *  the start of a list item, which is where a good deal of what an agent says
 *  actually lives: a plan, a set of options, a list of files. `lead` is a
 *  paragraph's bold opening — see `runIn` in markdown.ts for why that is a
 *  heading whatever it is made of. */
export type Kind = "you" | "msg" | "h" | "li" | "lead";

export type Mark = {
  kind: Kind;
  /** How far the rail indents this one. Assigned by `nest`, not by the tag. */
  level: number;
  /** One line, cut to fit the column. */
  label: string;
  /** More of it, for the hover — a rail is narrow and a question you asked an
   *  hour ago is often unrecognisable from its first six words. */
  full: string;
};

/** How deep the column will indent before it stops. Past this an entry is more
 *  ellipsis than text, and the nesting has stopped telling you anything. */
const MAX_DEPTH = 4;

/** Give every mark its indent, in document order.
 *
 *  `rank` is what the tag knows on its own — a heading's 1–6, a list item's
 *  nesting, a run-in label's nothing — and it is not an indent: a list under an `h3` sits deeper than the
 *  same list under an `h1`, though both are `rank` 1. So the indent is carried
 *  along the run instead, each heading setting the floor for whatever follows it.
 *
 *  A run-in label is where a section starts without being a heading, so it sits
 *  *on* the floor and a list written under it hangs off it — but it must not
 *  move the floor itself, or each bold paragraph would step one further right
 *  than the one above until the answer ran off the edge of the column.
 *
 *  Returns one entry per mark, `null` for the ones to drop: a mark whose label
 *  came out empty says nothing a rail could show. They are passed in anyway
 *  rather than filtered first, because an empty `msg` is still where one message
 *  ends and the next begins — it is what stops a list at the top of an answer
 *  from being indented under the answer before it. */
export function nest(
  marks: { kind: Kind; rank: number; label: string }[],
): (number | null)[] {
  const out: (number | null)[] = [];
  /** Where the headings have put the ground. */
  let floor = 0;
  /** What a list item adds its own depth to — the floor, or one under the
   *  run-in label the list was written beneath. */
  let base = 0;
  for (const m of marks) {
    const keep = m.label !== "";
    if (m.kind === "you") {
      floor = base = 0;
      out.push(keep ? 0 : null);
    } else if (m.kind === "msg") {
      /* A message that opens with a heading, a list or a bold label has no start
         of its own to show — the mark a line below carries those very words.
         What it does still do is put the floor back on the ground. */
      floor = base = keep ? 1 : 0;
      out.push(keep ? 0 : null);
    } else if (m.kind === "h") {
      floor = base = m.rank;
      out.push(keep ? Math.min(m.rank - 1, MAX_DEPTH) : null);
    } else if (m.kind === "lead") {
      base = floor + 1;
      out.push(keep ? Math.min(floor, MAX_DEPTH) : null);
    } else {
      out.push(keep ? Math.min(base + m.rank - 1, MAX_DEPTH) : null);
    }
  }
  return out;
}

/** One line of a thing, short enough to read down a narrow column.
 *
 *  Whitespace is collapsed first: a pasted stack trace or a heading wrapped
 *  across a `<code>` span arrives with newlines in it, and a rail entry two
 *  lines tall stops being a list you can scan. */
export function stub(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  /* Cut on a word — unless the only word boundary is near the start, in which
     case one long token (a path, a url) is better shown truncated than reduced
     to the two words in front of it. */
  return (space > max * 0.6 ? cut.slice(0, space) : cut.trimEnd()) + "…";
}

/** Which answer the `contents` rail should show, given where the reader is.
 *
 *  A round is not a message. An agent asked to do something says a line, calls
 *  four tools, says another line, calls three more, and *then* explains what it
 *  did — so one thing you asked for is a dozen `msg` marks, eleven of which are
 *  "right, now the store" and one of which is the answer. Scoping the rail to
 *  the message being read meant scrolling back through a round you had just
 *  watched replaced its table of contents with those eleven, one after another.
 *
 *  So the scope is the round — everything since you last spoke — and what it
 *  lists is that round's *last* message, whichever part of it you are reading.
 *  Mid-round that is the latest thing said, which is the best available answer
 *  to "what did this come to"; once the round settles it is the summing-up.
 *
 *  `marks` is in document order; `at` is the mark the reader is at, `-1` for
 *  above the first one — where the opening round stands, since an empty rail at
 *  the top of a transcript would just look broken. `nth`/`of` are for the cap:
 *  a scoped rail has to say it is scoped, or an answer whose contents look
 *  short reads as an answer that lost half its headings. */
export function conclusionAt(
  marks: { round: number; msg: number }[],
  at: number,
): { msg: number; nth: number; of: number } {
  /* Rounds you asked for but that answered nothing yet contribute no marks, so
     they are not counted: the cap counts the rounds the rail can show. */
  const last = new Map<number, number>();
  const order: number[] = [];
  for (const m of marks) {
    if (!last.has(m.round)) order.push(m.round);
    last.set(m.round, m.msg);
  }
  const here = marks[at] ?? marks[0];
  if (!here) return { msg: -1, nth: 0, of: 0 };
  return {
    msg: last.get(here.round) ?? -1,
    nth: order.indexOf(here.round) + 1,
    of: order.length,
  };
}

/** How near the top edge counts as reached. Roughly a line, so a heading
 *  scrolled flush to the top lights itself rather than the one above it. */
const LEAD = 28;

/** The tail is never quite exact — the same slack the panel's own follow uses. */
const TAIL = 32;

/** Which mark the reader is at, given each mark's offset within the scroller.
 *
 *  `-1` for "above the first one", which is a real answer: the top of a
 *  transcript is before anything, and lighting the first heading there would
 *  claim you were reading a section you have not reached.
 *
 *  `tops` is in document order, which is the order the rail draws. */
export function readingAt(
  tops: number[],
  scrollTop: number,
  viewportH: number,
  contentH: number,
): number {
  if (!tops.length) return -1;
  /* Parked at the bottom, the answer is the last mark whatever the arithmetic
     says. A final section shorter than the viewport never reaches the top edge,
     so scrolling all the way down would otherwise leave the rail pointing at
     something well above what fills the screen. */
  if (scrollTop + viewportH >= contentH - TAIL) return tops.length - 1;
  let at = -1;
  for (let i = 0; i < tops.length; i++) if (tops[i] <= scrollTop + LEAD) at = i;
  return at;
}

/* ── reading it from the keyboard ────────────────────────────────────────────
   The panel is where the answer is, and until now the only ways down it were
   the wheel and the rails — both of which want a hand on the mouse, at exactly
   the moment the other hand has just finished typing the prompt. So ctrl+arrow
   moves the reading and ctrl+page moves it faster; `Transcript.step` does it and
   this is the arithmetic. */

/** How many lines one press moves. Three rather than one: a key that moves a
 *  single line has to be held down to be worth pressing, and this panel is prose
 *  rather than a grid where one line is one record. */
export const STEP_LINES = 3;

/** How many lines a page keeps. A page that moved a whole viewport would leave
 *  nothing on screen that was there a moment ago, so the eye has to find its
 *  place again from cold; two lines of overlap is the join. */
export const PAGE_KEEP = 2;

/** How far one press moves, in pixels.
 *
 *  Measured in *lines*, never in a fixed number of pixels: the transcript is
 *  scaled by `--read`, so a step of sixty pixels is three lines at 100% and one
 *  at 300% — the same key would move a different amount of reading depending on
 *  how large you had set the reading, which is precisely backwards.
 *
 *  A page is floored at a single step, or a panel shorter than the overlap it
 *  keeps would compute a negative distance and the page keys would run
 *  backwards. */
export function stepBy(
  kind: "line" | "page",
  lineH: number,
  viewportH: number,
): number {
  const step = STEP_LINES * lineH;
  return kind === "line" ? step : Math.max(step, viewportH - PAGE_KEEP * lineH);
}

/** Where a step lands, clamped to the column.
 *
 *  The browser clamps an out-of-range `scrollTop` on its own, so this is not
 *  what keeps the panel in bounds; doing the arithmetic here is what makes a
 *  step testable without a DOM, and it keeps both ends of the column answered by
 *  the same line. A column shorter than its viewport has nowhere to go, hence
 *  the second `max` — without it a short transcript would scroll to a negative
 *  ceiling and the panel would jump to its top on the first press. */
export function landing(
  scrollTop: number,
  delta: number,
  contentH: number,
  viewportH: number,
): number {
  return Math.max(
    0,
    Math.min(scrollTop + delta, Math.max(0, contentH - viewportH)),
  );
}

/** How far from the bottom still counts as being stuck to it. One line of slack,
 *  so a rounding error mid-stream is not read as having scrolled away. */
export const STICK_PX = 32;

/** Whether a scroll event that just arrived means the tail has been let go of.
 *
 *  In here rather than in the panel because it is the panel's most consequential
 *  three lines and it was wrong for as long as the follow has existed. A write to
 *  `scrollTop` does not dispatch its scroll event synchronously — the event lands
 *  a beat later, and the handler then asks "are we still at the bottom?". A turn
 *  writing in bursts moves the bottom inside that beat, so the answer was about a
 *  column that had grown rather than about anything you did: the panel decided you
 *  had scrolled away, stopped following, and stayed stopped. Nothing re-arms it
 *  while the window keeps focus, so a card roused at launch stranded the reading
 *  two thirds of the way down its own transcript.
 *
 *  `pinned` is where the follow last put the view, or `-1` for "not ours". It is
 *  compared rather than trusted as a flag: content landing *below* the view does
 *  not change `scrollTop`, so the event reporting our own write reports exactly
 *  the number we wrote, and anything else is a hand on the wheel. That is what
 *  keeps a step landing precisely on the tail readable as yours — `pinned` is
 *  cleared by every gesture that moves the view on purpose.
 *
 *  Returns what `following` should become. The caller keeps the flag; this only
 *  answers the question, which is what makes it testable with no DOM. */
export function stillFollowing(view: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  /** Where the follow last wrote, or -1 if the last movement was not ours. */
  pinned: number;
  /** Whether the panel was following before this event. */
  following: boolean;
}): boolean {
  /* Ours, reported late. Keep the tail rather than re-deciding it: the bottom may
     have moved since, and the next follow run aims at the new one. */
  if (view.pinned >= 0 && view.scrollTop === view.pinned) return true;
  return view.scrollHeight - view.scrollTop - view.clientHeight <= STICK_PX;
}
