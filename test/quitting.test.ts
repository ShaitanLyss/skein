import { describe, expect, test } from "bun:test";

import {
  QUIT_NOTE,
  busyCount,
  quitLines,
  quitTitle,
} from "../src/lib/quitting";

const card = (name: string, ...jobs: string[]) => ({ name, jobs });

describe("quitTitle", () => {
  test("one card is a card, not '1 cards'", () => {
    expect(quitTitle([card("nova", "pnpm test")])).toBe(
      "a card still has work running",
    );
  });

  test("more than one is counted", () => {
    expect(quitTitle([card("a", "x"), card("b", "y")])).toBe(
      "2 cards still have work running",
    );
  });

  test("it counts cards rather than jobs", () => {
    /* A card is the thing you recognise and the thing you would go and look
       at. Six jobs on one card is still one place to look. */
    expect(quitTitle([card("rise", "a", "b", "c", "d", "e", "f")])).toBe(
      "a card still has work running",
    );
  });
});

describe("quitLines", () => {
  test("names the card and what it is running", () => {
    expect(quitLines([card("rise", "sdp import")])).toEqual([
      "rise — sdp import",
    ]);
  });

  test("a card with several jobs says how many more", () => {
    expect(quitLines([card("rise", "sdp import", "pnpm test", "tsc")])).toEqual([
      "rise — sdp import +2",
    ]);
  });

  test("a card with no label still gets a line", () => {
    /* A job registered from the call before its receipt landed has a label,
       but nothing guarantees one downstream — and a card silently missing from
       the list is the one failure this dialog cannot afford. */
    expect(quitLines([card("chat")])).toEqual(["chat"]);
  });

  test("the list is capped and the remainder is counted, never dropped", () => {
    /* "and 4 more" is a different sentence from silence, and the difference
       matters when you are deciding whether to lose it. */
    const many = Array.from({ length: 9 }, (_, i) => card(`c${i}`, "work"));
    const lines = quitLines(many);
    expect(lines).toHaveLength(6);
    expect(lines[5]).toBe("and 4 more");
  });

  test("exactly at the cap, nothing is added", () => {
    const five = Array.from({ length: 5 }, (_, i) => card(`c${i}`, "work"));
    const lines = quitLines(five);
    expect(lines).toHaveLength(5);
    expect(lines.some((l) => l.includes("more"))).toBe(false);
  });

  test("nothing running is no lines", () => {
    expect(quitLines([])).toEqual([]);
    expect(busyCount([])).toBe(0);
  });
});

describe("QUIT_NOTE", () => {
  test("it says the process dies and the work on disk does not", () => {
    /* Two genuinely different outcomes, and only one of them is a loss. A note
       that said only the first would read as "you are about to lose all of
       this", which is not true and would stop people quitting. */
    expect(QUIT_NOTE).toContain("stops it where it stands");
    expect(QUIT_NOTE).toContain("stays on disk");
  });

  test("it promises the card will be told, which only the job table can honour", () => {
    /* If job persistence is ever removed this sentence becomes a lie, and this
       is the test that says so. See `turns.md`, "jobs that outlive the
       process". */
    expect(QUIT_NOTE).toContain("told where to look");
  });
});
