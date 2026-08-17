import { expect, test, describe } from "bun:test";
import {
  conclusionAt,
  landing,
  nest,
  readingAt,
  stepBy,
  stillFollowing,
  STICK_PX,
  stub,
  type Kind,
} from "../src/lib/outline";

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

describe("what the contents rail is a contents of", () => {
  /* A round the way one actually arrives: the agent says a line, works, says
     another, works, and sums up. Three messages, one round. */
  const round = (r: number, msgs: number[]) =>
    msgs.map((msg) => ({ round: r, msg }));

  test("nothing collected, nothing to show", () => {
    expect(conclusionAt([], -1)).toEqual({ msg: -1, nth: 0, of: 0 });
  });

  /* The whole point: reading the middle of a round still lists how it came out,
     rather than swapping to the "right, now the store" the agent said in
     passing between two tool calls. */
  test("a round is listed by its last message, wherever in it you are", () => {
    const marks = round(1, [0, 1, 2]);
    for (const at of [0, 1, 2]) expect(conclusionAt(marks, at).msg).toBe(2);
  });

  test("scrolling back into the round before swaps to that round's answer", () => {
    const marks = [...round(1, [0, 1]), ...round(2, [2, 3, 4])];
    expect(conclusionAt(marks, 1).msg).toBe(1);
    expect(conclusionAt(marks, 2).msg).toBe(4);
  });

  /* Above the first mark there is nothing to go on, and an empty rail at the
     top of a transcript would just look broken. */
  test("above everything, the opening round stands", () => {
    expect(conclusionAt([...round(0, [0, 1]), ...round(1, [2])], -1).msg).toBe(1);
  });

  /* Mid-round the summing-up has not been written yet, so the latest thing said
     is the best available answer to what this came to. */
  test("a round still running is listed by as far as it has got", () => {
    const marks = round(1, [0, 1]);
    expect(conclusionAt(marks, 1).msg).toBe(1);
  });

  test("the cap counts rounds, not messages", () => {
    const marks = [...round(1, [0, 1, 2]), ...round(2, [3]), ...round(3, [4, 5])];
    expect(conclusionAt(marks, 0)).toEqual({ msg: 2, nth: 1, of: 3 });
    expect(conclusionAt(marks, 3)).toEqual({ msg: 3, nth: 2, of: 3 });
    expect(conclusionAt(marks, 5)).toEqual({ msg: 5, nth: 3, of: 3 });
  });

  /* You can ask twice before the agent answers once, and a prompt still being
     thought about has nothing for the rail to show. Counting those would make
     the cap read 2/4 on the last of four things when only two have answers. */
  test("rounds that answered nothing are not counted", () => {
    const marks = [...round(1, [0]), ...round(4, [1])];
    expect(conclusionAt(marks, 1)).toEqual({ msg: 1, nth: 2, of: 2 });
  });

  /* Read from disk, a transcript can open partway in — what the agent was
     saying then belongs to a round whose prompt is not on the page. */
  test("an answer with no prompt above it is still a round", () => {
    const marks = [...round(0, [0]), ...round(1, [1, 2])];
    expect(conclusionAt(marks, 0)).toEqual({ msg: 0, nth: 1, of: 2 });
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

describe("reading it from the keyboard", () => {
  /* A line at rest: 0.86rem against a 1.55 line-height. */
  const LH = 21;

  test("a step is three lines, whatever the panel is", () => {
    expect(stepBy("line", LH, 600)).toBe(63);
    expect(stepBy("line", LH, 2000)).toBe(63);
  });

  /* The whole reason a step is measured in lines: at 300% the same key has to
     move three lines of *that* text, not the sixty pixels three lines came to
     when the reading was at rest. */
  test("the step grows with the reading", () => {
    expect(stepBy("line", LH * 3, 600)).toBe(189);
  });

  test("a page keeps two lines of what you were reading", () => {
    expect(stepBy("page", LH, 600)).toBe(600 - 42);
  });

  /* Without the floor the subtraction goes negative on a very short panel and
     the page keys run backwards. */
  test("a page never comes out shorter than a step", () => {
    expect(stepBy("page", LH, 30)).toBe(stepBy("line", LH, 30));
    expect(stepBy("page", LH, 0)).toBeGreaterThan(0);
  });

  test("a step lands where it was aimed", () => {
    expect(landing(500, 63, 4000, 600)).toBe(563);
    expect(landing(500, -63, 4000, 600)).toBe(437);
  });

  test("the ends of the column are exact, not approached", () => {
    /* The last press of a run down has to land *on* the tail: the panel reads
       its own position to decide whether it is still following a live turn. */
    expect(landing(3300, 600, 4000, 600)).toBe(3400);
    expect(landing(20, -600, 4000, 600)).toBe(0);
  });

  /* A transcript that does not fill its panel has nowhere to go, and must not
     be sent to a negative ceiling. */
  test("a column shorter than its panel does not move", () => {
    expect(landing(0, 600, 300, 600)).toBe(0);
    expect(landing(0, -600, 300, 600)).toBe(0);
  });
});

describe("holding the tail through a scroll event", () => {
  /* The panel writes `scrollTop = scrollHeight` to follow a live turn, and that
     write's scroll event arrives a beat later. Everything here is about what the
     handler is allowed to conclude from an event whose cause it cannot see. */
  const view = (over: Partial<Parameters<typeof stillFollowing>[0]> = {}) => ({
    scrollTop: 9400,
    scrollHeight: 10000,
    clientHeight: 600,
    pinned: -1,
    following: true,
    ...over,
  });

  test("parked at the bottom is following", () => {
    expect(stillFollowing(view())).toBe(true);
  });

  test("a line of slack still counts as the bottom", () => {
    /* Mid-stream rounding must not read as a hand on the wheel. */
    expect(stillFollowing(view({ scrollTop: 9400 - STICK_PX }))).toBe(true);
    expect(stillFollowing(view({ scrollTop: 9400 - STICK_PX - 1 }))).toBe(false);
  });

  test("scrolling up lets go of it", () => {
    expect(stillFollowing(view({ scrollTop: 4000 }))).toBe(false);
  });

  /* The bug this exists for. The follow wrote 9400 — the bottom as it was — and
     by the time the event arrived a burst of deltas had made the column 40000
     tall. Asking "are we at the bottom?" answers about the growth, not about the
     reader, and answering it cost the panel the tail for the rest of the turn. */
  test("our own write is not a letting go, even when the bottom has moved", () => {
    expect(
      stillFollowing(view({ scrollTop: 9400, pinned: 9400, scrollHeight: 40000 })),
    ).toBe(true);
  });

  test("a stale pin does not hold the tail against you", () => {
    /* Same pin, but the view is somewhere we never put it — so it is a hand on
       the wheel and the column's own arithmetic decides. */
    expect(
      stillFollowing(view({ scrollTop: 4000, pinned: 9400, scrollHeight: 40000 })),
    ).toBe(false);
  });

  test("a step landing exactly on the tail is read as yours", () => {
    /* `pinned` is cleared by every deliberate gesture, so a keyboard step that
       lands on the very pixel the follow last wrote is still measured, not
       assumed — and being at the bottom, it takes the tail back up. */
    expect(stillFollowing(view({ scrollTop: 9400, pinned: -1 }))).toBe(true);
  });

  test("a column shorter than its panel is always at the bottom", () => {
    expect(stillFollowing(view({ scrollTop: 0, scrollHeight: 300, clientHeight: 600 }))).toBe(true);
  });
});
