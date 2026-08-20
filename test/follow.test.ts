import { expect, test, describe } from "bun:test";
import { Tail, slack, stillFollowing, STICK_PX } from "../src/lib/follow";

describe("holding the tail through a scroll event", () => {
  /* A panel writes `scrollTop = scrollHeight` to follow a growing column, and
     that write's scroll event arrives a beat later. Everything here is about what
     the handler is allowed to conclude from an event whose cause it cannot see. */
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

  test("slack is what is left below the fold", () => {
    expect(slack({ scrollTop: 9400, scrollHeight: 10000, clientHeight: 600 })).toBe(0);
    expect(slack({ scrollTop: 0, scrollHeight: 10000, clientHeight: 600 })).toBe(9400);
    /* Over-scrolled, which a browser will not do but a resize can leave behind. */
    expect(slack({ scrollTop: 0, scrollHeight: 300, clientHeight: 600 })).toBe(-300);
  });
});

describe("one scroller's follow state", () => {
  /* The three numbers a real element would have given it, at the bottom of a
     10000px column in a 600px box. */
  const bottom = { scrollTop: 9400, scrollHeight: 10000, clientHeight: 600 };

  test("a log opens on its tail", () => {
    expect(new Tail().following).toBe(true);
  });

  test("scrolling away stops the follow, scrolling back resumes it", () => {
    const t = new Tail();
    t.scrolled({ ...bottom, scrollTop: 2000 });
    expect(t.following).toBe(false);
    /* No control to click: being at the bottom again *is* asking to follow. */
    t.scrolled(bottom);
    expect(t.following).toBe(true);
  });

  /* The whole sequence the panel actually lives through, which neither the
     console nor the servers panel survived. A group prints; the follow writes;
     the group prints ten more lines before the event for that write arrives. */
  test("a burst landing between the write and its event keeps the tail", () => {
    const t = new Tail();
    t.landed(9400);
    t.scrolled({ ...bottom, scrollTop: 9400, scrollHeight: 40000 });
    expect(t.following).toBe(true);
  });

  test("and the pin is spent, so the next event is judged on its own", () => {
    const t = new Tail();
    t.landed(9400);
    /* Ours, reported late — pin held. */
    t.scrolled({ ...bottom, scrollTop: 9400, scrollHeight: 40000 });
    /* Then a hand on the wheel, from a place that is nowhere near the new
       bottom. Without clearing the pin the second event would be read as ours
       too and the reader would be dragged back down. */
    t.scrolled({ ...bottom, scrollTop: 20000, scrollHeight: 40000 });
    expect(t.following).toBe(false);
  });

  test("a pin the reader moved off is cleared", () => {
    const t = new Tail();
    t.landed(9400);
    t.scrolled({ ...bottom, scrollTop: 2000 });
    expect(t.following).toBe(false);
    /* The pin is gone with it: landing back on 9400 later must be measured
       rather than mistaken for the write we made before you scrolled. */
    t.scrolled({ ...bottom, scrollTop: 9400, scrollHeight: 40000 });
    expect(t.following).toBe(false);
  });

  test("released stays released until something asks for the tail", () => {
    const t = new Tail();
    t.release();
    expect(t.following).toBe(false);
    t.resume();
    expect(t.following).toBe(true);
  });

  test("resuming forgets where the follow last wrote", () => {
    const t = new Tail();
    t.landed(9400);
    t.resume();
    /* A sent command jumps to the tail and re-arms; the stale pin must not then
       vouch for a position the reader could have scrolled to. */
    t.scrolled({ ...bottom, scrollTop: 9400, scrollHeight: 40000 });
    expect(t.following).toBe(false);
  });
});
