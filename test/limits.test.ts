import { describe, expect, test } from "bun:test";
import {
  binding,
  ordered,
  pct,
  planSaid,
  resetIn,
  said,
  tierOf,
  until,
  why,
  type Window,
} from "../src/lib/limits";

/** A window, with only the fields a case cares about spelled out. */
function win(over: Partial<Window> = {}): Window {
  return {
    kind: "session",
    group: "session",
    used: 0,
    severity: "normal",
    resetsAt: null,
    scope: null,
    active: false,
    ...over,
  };
}

const T0 = Date.UTC(2026, 7, 17, 6, 49, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** What `/api/oauth/usage` actually answered on 2026-08-17, as `limits.rs` hands
 *  it over. The reference case for everything below. */
const SESSION = win({
  kind: "session",
  group: "session",
  used: 8,
  active: true,
  resetsAt: Date.UTC(2026, 7, 17, 11, 39, 59, 968),
});
const WEEK = win({
  kind: "weekly_all",
  group: "weekly",
  used: 8,
  resetsAt: Date.UTC(2026, 7, 23, 4, 59, 59, 968),
});
const SCOPED = win({
  kind: "weekly_scoped",
  group: "weekly",
  used: 0,
  scope: "Fable",
});

describe("what a window is called", () => {
  test("the two everybody has", () => {
    expect(said(SESSION)).toBe("5 hours");
    expect(said(WEEK)).toBe("7 days");
  });

  test("a scoped window carries the model it is scoped to", () => {
    expect(said(SCOPED)).toBe("7 days · Fable");
  });

  test("a codename this build has never heard of is drawn, not dropped", () => {
    /* The same response carried seven null windows called things like
       `nimbus_quill` and `iguana_necktie`. One of them becoming real must show
       up, even under an ugly name — not appearing is the worse failure. */
    expect(said(win({ kind: "nimbus_quill", group: "other" }))).toBe("nimbus quill");
    /* One that at least says which clock it runs on is titled by that. */
    expect(said(win({ kind: "seven_day_cowork", group: "weekly" }))).toBe("7 days");
  });
});

describe("the order they are read in", () => {
  test("the five hours lead, then the week, then anything scoped", () => {
    expect(ordered([SCOPED, WEEK, SESSION]).map(said)).toEqual([
      "5 hours",
      "7 days",
      "7 days · Fable",
    ]);
  });

  test("the order does not change as the day goes on", () => {
    /* A list that reorders itself by how full each window is would have to be
       re-read from the top at every glance. */
    const busy = { ...SESSION, used: 2 };
    const fuller = { ...WEEK, used: 97 };
    expect(ordered([fuller, busy]).map(said)).toEqual(["5 hours", "7 days"]);
  });

  test("scoped windows sort by name, so two of them do not swap about", () => {
    const opus = win({ kind: "weekly_scoped", group: "weekly", scope: "Opus" });
    const sonnet = win({ kind: "weekly_scoped", group: "weekly", scope: "Sonnet" });
    expect(ordered([sonnet, opus]).map(said)).toEqual([
      "7 days · Opus",
      "7 days · Sonnet",
    ]);
  });
});

describe("how close is close", () => {
  test("a quiet window earns no colour", () => {
    expect(tierOf(win({ used: 8 }))).toBe("calm");
    expect(tierOf(win({ used: 74.9 }))).toBe("calm");
  });

  test("amber from three-quarters, rust from nine-tenths", () => {
    expect(tierOf(win({ used: 75 }))).toBe("warm");
    expect(tierOf(win({ used: 89 }))).toBe("warm");
    expect(tierOf(win({ used: 90 }))).toBe("urgent");
    expect(tierOf(win({ used: 100 }))).toBe("urgent");
  });

  test("the server can escalate a figure that looks calm", () => {
    /* It knows things this does not — an org restriction, a spend limit, a
       rejection already issued. */
    expect(tierOf(win({ used: 20, severity: "warning" }))).toBe("warm");
    expect(tierOf(win({ used: 20, severity: "allowed_warning" }))).toBe("warm");
    expect(tierOf(win({ used: 20, severity: "rejected" }))).toBe("urgent");
  });

  test("but it can never talk one down", () => {
    /* `severity` is `normal` right up until the server decides otherwise, so a
       window at 89% has to earn its colour from the figure alone. */
    expect(tierOf(win({ used: 89, severity: "normal" }))).toBe("warm");
    expect(tierOf(win({ used: 96, severity: "normal" }))).toBe("urgent");
    expect(tierOf(win({ used: 96, severity: "something-new" }))).toBe("urgent");
  });
});

describe("which window will actually stop you", () => {
  test("the fullest one, whatever clock it runs on", () => {
    expect(binding([SESSION, WEEK, SCOPED])).toBe(SESSION);
    const fullWeek = { ...WEEK, used: 94 };
    expect(binding([SESSION, fullWeek, SCOPED])).toBe(fullWeek);
  });

  test("not the one the server marks active", () => {
    /* On a quiet account the five-hour window is the binding one at 8% while
       the week sits at 94%. The question is "am I about to be cut off", and
       that is answered by whichever runs out first. */
    const quiet = win({ kind: "session", used: 8, active: true });
    const nearlyGone = win({ kind: "weekly_all", group: "weekly", used: 94 });
    expect(binding([quiet, nearlyGone])).toBe(nearlyGone);
  });

  test("nothing to read is null rather than a guess", () => {
    expect(binding([])).toBe(null);
  });
});

describe("saying a percentage", () => {
  test("whole numbers — a redraw from 27.4 to 27.5 means nothing", () => {
    expect(pct(8)).toBe("8%");
    expect(pct(27.4)).toBe("27%");
    expect(pct(27.9)).toBe("27%");
  });

  test("rounded down, so nothing reads 100% with allowance left", () => {
    expect(pct(99.6)).toBe("99%");
    expect(pct(100)).toBe("100%");
  });

  test("and never past 100, however the account is billed", () => {
    expect(pct(112)).toBe("100%");
  });

  test("an untouched window is a plain zero", () => {
    expect(pct(0)).toBe("0%");
    expect(pct(-1)).toBe("0%");
  });
});

describe("how long until it comes back", () => {
  test("days above a day — a weekly window is why", () => {
    /* `left` from usage.ts would print `142h 12m` here. */
    expect(until(5 * DAY + 3 * HOUR)).toBe("5d 3h");
    expect(until(2 * DAY)).toBe("2d");
  });

  test("below a day it is worded exactly as `left` words it", () => {
    /* The two sit on the same face and must not disagree about what four hours
       is called. */
    expect(until(4 * HOUR + 51 * MIN)).toBe("4h 51m");
    expect(until(3 * HOUR)).toBe("3h");
    expect(until(30 * MIN)).toBe("30m");
    expect(until(20_000)).toBe("under a minute");
  });

  test("a window already rolling says so rather than counting into the negative", () => {
    expect(until(0)).toBe("any moment");
    expect(until(-5 * MIN)).toBe("any moment");
  });
});

describe("the reset", () => {
  test("measured from the moment the server named", () => {
    expect(resetIn(SESSION, T0)).toBe(4 * HOUR + 50 * MIN + 59_968);
    expect(until(resetIn(SESSION, T0)!)).toBe("4h 51m");
    expect(until(resetIn(WEEK, T0)!)).toBe("5d 22h");
  });

  test("a reading that predates its own rollover clamps rather than going negative", () => {
    /* The endpoint is asked twice a minute at most, so the stretch between a
       window rolling and the next reading landing is real. */
    expect(resetIn(win({ resetsAt: T0 - MIN }), T0)).toBe(0);
    expect(until(resetIn(win({ resetsAt: T0 - MIN }), T0)!)).toBe("any moment");
  });

  test("no reset is a real answer, not a missing one", () => {
    expect(resetIn(SCOPED, T0)).toBe(null);
  });
});

describe("what the reading is of", () => {
  test("the plan gives the percentages a denominator", () => {
    expect(planSaid("team")).toBe("team allowance");
    expect(planSaid("max")).toBe("max allowance");
  });

  test("an unknown plan still says what kind of number this is", () => {
    /* The token can come from the environment, which carries no plan. */
    expect(planSaid(null)).toBe("allowance");
  });
});

describe("the whole row, said in full", () => {
  test("a window with a reset", () => {
    expect(why(SESSION, T0)).toBe("5 hours — 8% used, resets in 4h 51m");
    expect(why(WEEK, T0)).toBe("7 days — 8% used, resets in 5d 22h");
  });

  test("a window without one", () => {
    expect(why(SCOPED, T0)).toBe("7 days · Fable — 0% used");
  });
});
