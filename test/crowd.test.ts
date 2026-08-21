import { expect, test, describe } from "bun:test";
import {
  FIGURES_MAX,
  UNKNOWN_CROWD,
  allHome,
  figuresFor,
  tallyOf,
  type Progress,
} from "../src/lib/crowd";

/* What a workflow's crowd draws, given the two numbers its journal holds.
 *
 * The whole risk in here is saying more than is known. A workflow's agents run
 * on a stream the app never sees, so every reading below is a function of `out`
 * and `back` and of nothing else — no phase, no label, and no inference about
 * whether the run is finished. `workflow.rs` has the measurement that says those
 * two numbers are all there is. */

const p = (out: number, back: number): Progress => ({ out, back });

describe("a crowd draws what the journal counted", () => {
  test("a subagent is one figure, whatever else is known", () => {
    expect(figuresFor(false, null)).toEqual([false]);
    expect(figuresFor(false, p(9, 3))).toEqual([false]);
    expect(tallyOf(null)).toBeNull();
  });

  /* The first seconds of every run: the journal does not exist yet. Three
     figures says "a crowd, size unknown", which is what is known — one would
     say "a subagent" and none would say the card is idle, which is the bug the
     whole seam exists to fix. */
  test("nothing counted yet is a crowd of unknown size, not a crowd of none", () => {
    expect(figuresFor(true, null)).toEqual([false, false, false]);
    expect(figuresFor(true, null)).toHaveLength(UNKNOWN_CROWD);
    expect(figuresFor(true, undefined)).toEqual(figuresFor(true, null));
    /* A run whose journal exists and names nobody reads the same way — it has
       convened a crowd and started none of it. */
    expect(figuresFor(true, p(0, 0))).toEqual(figuresFor(true, null));
  });

  test("an absence is said as an absence and never as a zero", () => {
    expect(tallyOf(null)).toBeNull();
    expect(tallyOf(p(0, 0))).toBeNull();
    expect(tallyOf(p(4, 0))).toBe("0 of 4 back");
  });

  /* Returned first, so the crowd fills from the back as the run goes on. Drawn
     in journal order instead, figures would change state in the middle of the
     row and read as shuffling rather than as work coming home. */
  test("the ones that are back are drawn first", () => {
    expect(figuresFor(true, p(4, 0))).toEqual([false, false, false, false]);
    expect(figuresFor(true, p(4, 2))).toEqual([true, true, false, false]);
    expect(figuresFor(true, p(4, 4))).toEqual([true, true, true, true]);
    expect(tallyOf(p(4, 2))).toBe("2 of 4 back");
  });

  /* A journal caught between two writes can name more results than starts.
     Unclamped, that draws every figure returned and then asks for one more. */
  test("more back than out cannot draw a figure that is not there", () => {
    expect(figuresFor(true, p(3, 5))).toEqual([true, true, true]);
    expect(tallyOf(p(3, 5))).toBe("3 of 3 back");
    /* And a negative, which nothing should ever write and which must not make
       an array of length NaN if something does. */
    expect(figuresFor(true, p(3, -2))).toEqual([false, false, false]);
    expect(tallyOf(p(3, -1))).toBe("0 of 3 back");
  });

  /* The cap is on the drawing only: what is cut is still said, which is the
     same bargain the transcript's result clamp strikes. */
  test("a large fan-out is abbreviated in figures and exact in words", () => {
    expect(figuresFor(true, p(40, 12))).toHaveLength(FIGURES_MAX);
    expect(figuresFor(true, p(40, 12)).filter(Boolean)).toHaveLength(FIGURES_MAX);
    expect(tallyOf(p(40, 12))).toBe("12 of 40 back");
    /* At the cap exactly, nothing is abbreviated. */
    expect(figuresFor(true, p(FIGURES_MAX, 1))).toHaveLength(FIGURES_MAX);
  });

  /* `back` scaled down with `out` would be a lie in the other direction: with
     40 out and 12 back, 9 figures of which 2 are home says "most are still
     running", and the truth is nearer a third home. Capping rather than scaling
     means the *figures* stop being a proportion past the cap, and the words
     carry it instead — which is why the tally is not optional. */
  test("past the cap the figures stop being a proportion, and say so in words", () => {
    const drawn = figuresFor(true, p(40, 30));
    expect(drawn).toHaveLength(FIGURES_MAX);
    expect(drawn.every(Boolean)).toBe(true);
    expect(tallyOf(p(40, 30))).toBe("30 of 40 back");
  });

  /* Emphatically not "the workflow has finished". A pipeline stage that has
     returned is one whose next stage is about to start, so a crowd can be
     entirely home twice in a run with ten minutes left. Only the notification
     ends a workflow. */
  test("everybody home is a moment, not an ending", () => {
    expect(allHome(p(4, 4))).toBe(true);
    expect(allHome(p(4, 3))).toBe(false);
    expect(allHome(p(0, 0))).toBe(false);
    expect(allHome(null)).toBe(false);
    /* Which is why it is true again after the next stage comes home, and the
       card must not have been marked done the first time. */
    expect(allHome(p(9, 9))).toBe(true);
  });
});
