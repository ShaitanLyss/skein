import { expect, test, describe } from "bun:test";
import { nest, readingAt, stub, type Kind } from "../src/lib/outline";

describe("a rail entry is one readable line", () => {
  test("short text is left exactly as it is", () => {
    expect(stub("Fix the supervisor")).toBe("Fix the supervisor");
  });

  test("newlines and runs of space collapse — a rail is scanned, not read", () => {
    expect(stub("what  broke\n\nin the\tstore?")).toBe("what broke in the store?");
  });

  test("a long message is cut on a word", () => {
    const said =
      "the wall reflows every time a conversation opens and the pinned cards end up standing where the territory used to be";
    const out = stub(said, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith("…")).toBe(true);
    /* Cut between words: half of one is noise in a column this narrow. */
    expect(out).toBe("the wall reflows every time a…");
  });

  /* A pasted path has no word boundary worth cutting at, and backing up to the
     last space would leave two words in front of a stub that says nothing. */
  test("one long token is cut through rather than thrown away", () => {
    expect(stub("see C--atelier-skein--scratch-wall-and-more", 20)).toBe(
      "see C--atelier-skei…",
    );
  });

  test("whitespace alone is nothing at all", () => {
    expect(stub("   \n  ")).toBe("");
  });
});

describe("how deep a mark sits", () => {
  /* `label` is what decides whether a mark survives; the text itself is never
     read here. `-` stands for a mark with nothing to show. */
  const mark = (kind: Kind, rank = 0, label = "x") => ({ kind, rank, label });
  const gone = (kind: Kind, rank = 0) => mark(kind, rank, "");

  test("a message opens at the root and its list hangs one step under it", () => {
    expect(
      nest([mark("msg"), mark("li", 1), mark("li", 2), mark("li", 1)]),
    ).toEqual([0, 1, 2, 1]);
  });

  /* The whole reason `rank` is not an indent: both lists are `rank` 1, and one
     of them is three levels into the answer. */
  test("a list sits under the heading it was written beneath", () => {
    expect(
      nest([mark("msg"), mark("h", 1), mark("li", 1), mark("h", 3), mark("li", 1)]),
    ).toEqual([0, 0, 1, 2, 3]);
  });

  test("a message that opens with a heading shows no start of its own", () => {
    expect(nest([gone("msg"), mark("h", 2), mark("li", 1)])).toEqual([null, 1, 2]);
  });

  /* An empty `msg` still does its work: without it the list at the top of this
     answer would keep the indent of the answer before it. */
  test("an answer that is nothing but a list starts at the root", () => {
    expect(
      nest([mark("msg"), mark("h", 3), mark("li", 1), gone("msg"), mark("li", 1)]),
    ).toEqual([0, 2, 3, null, 0]);
  });

  test("what you said is flat, and puts the floor back", () => {
    expect(
      nest([mark("h", 4), mark("you"), gone("msg"), mark("li", 1)]),
    ).toEqual([3, 0, null, 0]);
  });

  /* The shape most answers actually have: no `#` anywhere, and every section
     named by the bold at the head of its paragraph. */
  test("run-in labels sit under the answer's opening line", () => {
    expect(
      nest([mark("msg"), mark("lead"), mark("lead"), mark("lead")]),
    ).toEqual([0, 1, 1, 1]);
  });

  /* Not a heading, so it must not raise the floor: the alternative is an answer
     that steps one indent further right with every paragraph it has. */
  test("a run of labels stays at one depth", () => {
    expect(nest([gone("msg"), mark("lead"), mark("lead"), mark("lead")])).toEqual([
      null, 0, 0, 0,
    ]);
  });

  test("a list written under a label hangs off it", () => {
    expect(
      nest([mark("msg"), mark("lead"), mark("li", 1), mark("lead"), mark("li", 1)]),
    ).toEqual([0, 1, 2, 1, 2]);
  });

  test("a label under a heading takes the heading's floor", () => {
    expect(nest([mark("h", 2), mark("lead"), mark("li", 1)])).toEqual([1, 2, 3]);
  });

  test("indent stops before an entry is more ellipsis than text", () => {
    expect(nest([mark("h", 6), mark("li", 4)])).toEqual([4, 4]);
  });
});

describe("which mark the reader is at", () => {
  /* A column taller than the viewport, so the bottom rule doesn't fire. */
  const tall = (tops: number[], scrollTop: number) =>
    readingAt(tops, scrollTop, 400, 100000);

  test("nothing to list, nothing to light", () => {
    expect(readingAt([], 0, 400, 400)).toBe(-1);
  });

  test("above the first mark is a real answer, not the first mark", () => {
    expect(tall([600, 1200], 0)).toBe(-1);
  });

  test("the last mark passed is the one lit", () => {
    expect(tall([100, 600, 1200], 620)).toBe(1);
    expect(tall([100, 600, 1200], 1190)).toBe(2);
  });

  /* Within a line of the top edge counts as reached — a heading scrolled flush
     to the top should light itself, not the section above it. */
  test("a mark just under the top edge has been reached", () => {
    expect(tall([100, 600], 580)).toBe(1);
  });

  /* A final section shorter than the viewport never reaches the top edge, so
     without this the rail would point well above what fills the screen. */
  test("parked at the bottom is always the last mark", () => {
    expect(readingAt([100, 5000, 5980], 5600, 400, 6000)).toBe(2);
  });
});
