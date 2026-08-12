/* The two rails beside the transcript.
 *
 * A long answer is a document — headings, sections, a shape you want to skim —
 * and a long conversation is a list of the things you asked. Both are navigable
 * and both want exactly the same three things: a list of places, one of them
 * marked as where you are, and a click that goes there. So neither owns any of
 * it. `Transcript.svelte` collects the marks off the panel's own DOM, one
 * `Rail.svelte` draws either list, and the only two decisions with any judgement
 * in them live here, pure and tested — see test/outline.test.ts.
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
 *  actually lives: a plan, a set of options, a list of files. */
export type Kind = "you" | "msg" | "h" | "li";

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
 *  nesting — and it is not an indent: a list under an `h3` sits deeper than the
 *  same list under an `h1`, though both are `rank` 1. So the indent is carried
 *  along the run instead, each heading setting the floor for whatever follows it.
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
  let base = 0;
  for (const m of marks) {
    const keep = m.label !== "";
    if (m.kind === "you") {
      base = 0;
      out.push(keep ? 0 : null);
    } else if (m.kind === "msg") {
      /* A message that opens with a heading or a list has no start of its own to
         show — the mark a line below carries those very words. What it does
         still do is put the floor back on the ground. */
      base = keep ? 1 : 0;
      out.push(keep ? 0 : null);
    } else if (m.kind === "h") {
      base = m.rank;
      out.push(keep ? Math.min(m.rank - 1, MAX_DEPTH) : null);
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
