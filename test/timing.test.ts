import { expect, test, describe } from "bun:test";
import {
  CADENCES,
  CYCLE,
  IDLE,
  LENGTHS,
  PERS,
  SNOOZE_S,
  bank,
  beads,
  begin,
  cadenceOf,
  completed,
  duoShare,
  duoTotal,
  elapsed,
  finish,
  hold,
  isRunning,
  laneRunning,
  lengthOf,
  normalizeCycle,
  overrun,
  pause,
  phaseAt,
  phaseOf,
  phraseFor,
  posture,
  progress,
  push,
  remaining,
  ring,
  restNote,
  restTitle,
  resume,
  runOfCycle,
  said,
  settle,
  settleCycle,
  span,
  standing,
  start,
  step,
  switchTo,
  type CycleState,
  type Duo,
  type Run,
} from "../src/lib/timing";
import {
  allows,
  defaultConfig,
  limitIn,
  newWidget,
  normalizeWidget,
  optionsOf,
  runIn,
  runs,
  specFor,
  variantsOf,
  type Widget,
} from "../src/lib/widgets";

/* A real epoch, because `since: 0` is the sentinel for "not running" — a test
   built on `now = 0` would be testing the sentinel rather than the arithmetic. */
const T = 1_700_000_000_000;
const s = (n: number) => n * 1000;
const m = (n: number) => n * 60_000;

/* ── the run ───────────────────────────────────────────────────────────── */

describe("a timer is an epoch and a number, never a counter", () => {
  test("elapsed is what was banked plus what has run since", () => {
    expect(elapsed({ since: T, banked: 0 }, T + s(30))).toBe(30);
    expect(elapsed({ since: T, banked: 12 }, T + s(30))).toBe(42);
    /* Not running: the epoch is ignored entirely, whatever it says. */
    expect(elapsed({ since: 0, banked: 42 }, T + m(99))).toBe(42);
    expect(elapsed(IDLE, T)).toBe(0);
  });

  /* A system clock that steps backwards — an NTP correction, a timezone tool,
     somebody setting the clock — must not make a timer run backwards with it. */
  test("a clock that goes backwards does not rewind a timer", () => {
    expect(elapsed({ since: T, banked: 10 }, T - m(5))).toBe(10);
    expect(elapsed({ since: T, banked: -99 }, T + s(5))).toBe(5);
  });

  test("starting a running timer changes nothing, and holding banks it", () => {
    const run = { since: T, banked: 0 };
    expect(start(run, T + m(1))).toBe(run);
    expect(hold(run, T + s(90))).toEqual({ since: 0, banked: 90 });
    /* Holding twice is not a way to lose time. */
    const held = hold(run, T + s(90));
    expect(hold(held, T + m(9))).toBe(held);
  });

  test("carrying on adds to what was banked rather than starting again", () => {
    const held = { since: 0, banked: 90 };
    const again = start(held, T);
    expect(elapsed(again, T + s(10))).toBe(100);
  });

  /* The whole reason the persisted state can be trusted: nothing writes to a
     widget's row while it merely runs, so the beat has to bring the derived
     reading into the stored one — without the timer noticing. */
  test("banking moves time into store without changing the reading", () => {
    const run = { since: T, banked: 5 };
    const banked = bank(run, T + s(55));
    expect(banked).toEqual({ since: T + s(55), banked: 60 });
    expect(elapsed(banked, T + s(55))).toBe(elapsed(run, T + s(55)));
    expect(elapsed(banked, T + m(2))).toBe(elapsed(run, T + m(2)));
  });

  test("banking a held timer is a no-op", () => {
    const held = { since: 0, banked: 30 };
    expect(bank(held, T)).toBe(held);
  });

  /* The app not running is not the same as the timer running. */
  test("a timer running at shutdown comes back held at what it had earned", () => {
    expect(settle({ since: T, banked: 120 })).toEqual({ since: 0, banked: 120 });
    /* And a held one is left exactly alone. */
    const held = { since: 0, banked: 7 };
    expect(settle(held)).toBe(held);
  });
});

describe("where a timer stands", () => {
  const run = (since: number, banked: number): Run => ({ since, banked });

  test("the four states are told apart by the two numbers", () => {
    expect(standing(IDLE, null, T)).toBe("idle");
    expect(standing(run(T, 0), null, T + s(1))).toBe("running");
    expect(standing(run(0, 30), null, T)).toBe("held");
    expect(standing(run(T, 0), 60, T + s(61))).toBe("rung");
  });

  /* Null rather than zero, and it matters: a stopwatch has no limit, and zero
     would mean "rang the instant it was hung up". */
  test("a stopwatch can never ring, however long it runs", () => {
    expect(standing(run(T, 0), null, T + m(600))).toBe("running");
    expect(standing(IDLE, 0, T)).toBe("idle");
  });

  test("remaining holds at zero and the overrun says how long ago", () => {
    const r = run(T, 0);
    expect(remaining(r, 300, T + s(100))).toBe(200);
    expect(remaining(r, 300, T + s(400))).toBe(0);
    expect(overrun(r, 300, T + s(400))).toBe(100);
    expect(overrun(r, 300, T + s(100))).toBe(0);
  });

  test("progress is a fraction that never exceeds one", () => {
    expect(progress(run(T, 0), 100, T + s(25))).toBe(0.25);
    expect(progress(run(T, 0), 100, T + s(900))).toBe(1);
    expect(progress(IDLE, 0, T)).toBe(0);
  });
});

describe("an alarm rings once, and only for a countdown we watched run out", () => {
  const alarm = (id: string, overrun: number) => ({ id, overrun });

  /* The ladder is driven off the one-second tick, so without this a rung
     countdown left alone would ring sixty times a minute until acknowledged. */
  test("a countdown standing rung sounds on the first tick and no other", () => {
    const first = ring([alarm("a", 0)], [], 300);
    expect(first.fresh).toEqual(["a"]);
    expect(first.sounded).toEqual(["a"]);

    const second = ring([alarm("a", 1)], first.sounded, 301);
    expect(second.fresh).toEqual([]);
    const later = ring([alarm("a", 600)], second.sounded, 900);
    expect(later.fresh).toEqual([]);
  });

  /* What comes back is what is ringing *now*, not everything ever rung — so
     pressing `done` and setting the thing again is a second appointment. */
  test("acknowledging forgets it, and setting it again rings again", () => {
    const rung = ring([alarm("a", 0)], [], 300);
    const acknowledged = ring([], rung.sounded, 310);
    expect(acknowledged.sounded).toEqual([]);
    expect(ring([alarm("a", 0)], acknowledged.sounded, 400).fresh).toEqual(["a"]);
  });

  /* A countdown whose length passed while Skein was closed comes back rung —
     it did ring, you were not there — and a bell at launch for an appointment
     from last night is noise. The amber face is the honest report of it. */
  test("one that ran out before the window was up is silent, forever", () => {
    const cold = ring([alarm("a", 8 * 3600)], [], 4);
    expect(cold.fresh).toEqual([]);
    /* Still silent an hour later: both numbers grow at the same rate, so an
       overrun that started ahead of uptime stays ahead of it. */
    expect(ring([alarm("a", 8 * 3600 + 3600)], cold.sounded, 3604).fresh).toEqual([]);
  });

  /* The widgets arrive from SQLite several ticks after the ladder is built, so
     the wall is empty for the first few syncs — which is exactly why this is
     decided by arithmetic rather than by priming a set on the first tick. */
  test("an empty first tick does not make a stale alarm fresh", () => {
    const empty = ring([], [], 0);
    expect(empty.fresh).toEqual([]);
    expect(ring([alarm("a", 900)], empty.sounded, 2).fresh).toEqual([]);
  });

  test("several going off at once are all remembered", () => {
    const both = ring([alarm("a", 0), alarm("b", 1)], [], 300);
    expect(both.fresh).toEqual(["a", "b"]);
    expect(ring([alarm("a", 5), alarm("b", 6)], both.sounded, 305).fresh).toEqual([]);
  });
});

describe("saying how long", () => {
  /* `0:04:12` for four minutes is a stopwatch pretending to be a clock. */
  test("the hour is dropped until there is one", () => {
    expect(span(0)).toBe("0:00");
    expect(span(7)).toBe("0:07");
    expect(span(252)).toBe("4:12");
    expect(span(1500)).toBe("25:00");
    expect(span(3600)).toBe("1:00:00");
    expect(span(3661)).toBe("1:01:01");
  });

  test("seconds are padded and minutes are not", () => {
    expect(span(65)).toBe("1:05");
    expect(span(600)).toBe("10:00");
  });

  test("a negative span is zero rather than a minus sign", () => {
    expect(span(-40)).toBe("0:00");
  });

  /* Coarse on purpose: a rest screen counting your break down to the second is
     a rest screen you watch. */
  test("words are what somebody would say, not what a clock would", () => {
    expect(said(12)).toBe("under a minute");
    expect(said(60)).toBe("a minute");
    expect(said(240)).toBe("4 minutes");
    expect(said(3600)).toBe("an hour");
    expect(said(4200)).toBe("an hour and 10");
    expect(said(7200)).toBe("2 hours");
  });
});

/* ── the duo ───────────────────────────────────────────────────────────── */

describe("the duo runs exactly one lane", () => {
  const fresh: Duo = { on: IDLE, off: IDLE };

  test("handing the clock over holds the lane that had it", () => {
    const a = switchTo(fresh, "on", T);
    expect(laneRunning(a)).toBe("on");

    const b = switchTo(a, "off", T + s(60));
    expect(laneRunning(b)).toBe("off");
    expect(elapsed(b.on, T + m(9))).toBe(60);
    expect(isRunning(b.on)).toBe(false);
  });

  /* The way out of a duo is to stop, not to have to start a third thing. */
  test("clicking the lane already running holds both", () => {
    const a = switchTo(fresh, "on", T);
    const stopped = switchTo(a, "on", T + s(30));
    expect(laneRunning(stopped)).toBeNull();
    expect(elapsed(stopped.on, T + m(5))).toBe(30);
  });

  /* The constraint is the instrument: the pair sums to the time since you
     started, which is what makes the share a real reading. */
  test("the two lanes account for all of the time between them", () => {
    let d = switchTo(fresh, "on", T);
    d = switchTo(d, "off", T + s(75));
    expect(duoTotal(d, T + s(100))).toBe(100);
    expect(duoShare(d, T + s(100))).toBe(0.75);
  });

  test("a duo nobody has started is zero rather than a NaN in a bar", () => {
    expect(duoShare(fresh, T)).toBe(0);
    expect(duoTotal(fresh, T)).toBe(0);
  });
});

/* ── the catalogue's tables ────────────────────────────────────────────── */

describe("the menu and the arithmetic agree about what a value means", () => {
  test("every length the menu offers resolves to its own seconds", () => {
    for (const l of LENGTHS) expect(lengthOf(l.value)).toBe(l.seconds);
    expect(LENGTHS.every((l) => l.seconds > 0)).toBe(true);
  });

  /* Degrading rather than failing is the whole bargain of the opaque column:
     a length retired since a row was written must not become a NaN. */
  test("a length this build has never heard of is the default", () => {
    expect(lengthOf("37m")).toBe(lengthOf("25m"));
    expect(cadenceOf("nonsense").value).toBe("25/5");
  });

  test("no two lengths or cadences share a value", () => {
    expect(new Set(LENGTHS.map((l) => l.value)).size).toBe(LENGTHS.length);
    expect(new Set(CADENCES.map((c) => c.value)).size).toBe(CADENCES.length);
  });

  test("a cadence's long break is never shorter than its short one", () => {
    for (const c of CADENCES) {
      expect(c.long).toBeGreaterThanOrEqual(c.short);
      expect(c.focus).toBeGreaterThan(0);
    }
  });
});

/* ── the pomodoro cycle ────────────────────────────────────────────────── */

const cad = cadenceOf("25/5");

describe("the phase sequence", () => {
  test("focus and break alternate, and a focus is an even count", () => {
    expect(phaseAt(cad, 0, 4)).toEqual({ kind: "focus", seconds: 1500, number: 1 });
    expect(phaseAt(cad, 1, 4)).toEqual({ kind: "short", seconds: 300, number: 1 });
    expect(phaseAt(cad, 2, 4)).toEqual({ kind: "focus", seconds: 1500, number: 2 });
  });

  test("the break after every fourth pomodoro is the long one", () => {
    expect(phaseAt(cad, 7, 4).kind).toBe("long");
    expect(phaseAt(cad, 7, 4).seconds).toBe(900);
    expect(phaseAt(cad, 5, 4).kind).toBe("short");
    /* And a different `per` moves it. */
    expect(phaseAt(cad, 5, 3).kind).toBe("long");
  });

  test("the cycle carries on past the long break", () => {
    expect(phaseAt(cad, 8, 4)).toEqual({ kind: "focus", seconds: 1500, number: 5 });
    expect(phaseAt(cad, 15, 4).kind).toBe("long");
  });

  test("nonsense counts are floored rather than allowed into the arithmetic", () => {
    expect(phaseAt(cad, -3, 4).kind).toBe("focus");
    expect(phaseAt(cad, 1, 0).kind).toBe("long");
  });

  test("a phase is called something a person would say", () => {
    expect(phraseFor(phaseAt(cad, 0, 4))).toBe("focus · 1");
    expect(phraseFor(phaseAt(cad, 1, 4))).toBe("a short break");
    expect(phraseFor(phaseAt(cad, 7, 4))).toBe("a long break");
  });
});

describe("the beads show the cycle in hand", () => {
  test("the row fills as the cycle is worked through", () => {
    expect(beads(0, 4)).toEqual(["now", "todo", "todo", "todo"]);
    expect(beads(1, 4)).toEqual(["done", "todo", "todo", "todo"]);
    expect(beads(2, 4)).toEqual(["done", "now", "todo", "todo"]);
    expect(beads(7, 4)).toEqual(["done", "done", "done", "done"]);
  });

  /* It always shows the cycle in hand rather than growing without limit — the
     row answers "how far through the afternoon", not "how many ever". */
  test("a new cycle starts the row again", () => {
    expect(beads(8, 4)).toEqual(beads(0, 4));
    expect(beads(9, 4)).toEqual(beads(1, 4));
  });

  test("the row is as long as the cadence says", () => {
    expect(beads(0, 3)).toHaveLength(3);
    expect(beads(0, 6)).toHaveLength(6);
    expect(beads(0, 0)).toHaveLength(1);
  });

  /* What the beads deliberately forget. */
  test("the tally counts every pomodoro finished, cycles included", () => {
    expect(completed(0)).toBe(0);
    expect(completed(1)).toBe(1);
    expect(completed(2)).toBe(1);
    expect(completed(3)).toBe(2);
    expect(completed(8)).toBe(4);
  });
});

/* ── the machine ───────────────────────────────────────────────────────── */

const started = (): CycleState => begin({ ...CYCLE }, T);

describe("the cycle steps itself", () => {
  test("nothing is due, so nothing is written", () => {
    const c = started();
    /* The same object, which is what lets the studio call this every second. */
    expect(step(c, T + m(10))).toBe(c);
  });

  test("a cycle that is off or paused never steps", () => {
    expect(step({ ...CYCLE }, T + m(99))).toEqual({ ...CYCLE });
    const held = pause(started(), T + m(5));
    expect(step(held, T + m(500))).toBe(held);
    expect(held.paused).toBe(true);
    expect(held.banked).toBe(300);
  });

  test("when the focus rings the break is owed but not yet running", () => {
    const rung = step(started(), T + m(25));
    expect(rung.done).toBe(1);
    expect(phaseOf(rung).kind).toBe("short");
    /* Unstarted — this is the whole of what makes a push-back a delay. */
    expect(isRunning(runOfCycle(rung))).toBe(false);
    expect(rung.banked).toBe(0);
    expect(posture(rung, T + m(25))).toBe("resting");
  });

  test("the break's clock starts on the next tick, once the wall is resting", () => {
    const owed = step(started(), T + m(25));
    const resting = step(owed, T + m(25) + s(1));
    expect(isRunning(runOfCycle(resting))).toBe(true);
    expect(remaining(runOfCycle(resting), 300, T + m(25) + s(1))).toBe(300);
  });

  test("a break taken through sends you back to work, already running", () => {
    let c = step(started(), T + m(25));
    c = step(c, T + m(25) + s(1));
    const back = step(c, T + m(30) + s(1));
    expect(back.done).toBe(2);
    expect(phaseOf(back).kind).toBe("focus");
    expect(isRunning(runOfCycle(back))).toBe(true);
    expect(posture(back, T + m(30) + s(1))).toBe("working");
  });
});

describe("a push-back delays a break and never spends it", () => {
  /* The failure this whole feature exists to fix: a break that ran while you
     carried on working is a break you did not take. */
  test("a pushed break stops counting and the wall is let go", () => {
    let c = step(started(), T + m(25));
    c = step(c, T + m(25) + s(1)); // resting, break running
    const pushed = push(c, T + m(26));

    expect(posture(pushed, T + m(26))).toBe("pushed");
    expect(isRunning(runOfCycle(pushed))).toBe(false);
    expect(pushed.pushed).toBe(1);
    /* And it stays let go for exactly as long as the snooze buys. */
    expect(step(pushed, T + m(27))).toBe(pushed);
    expect(posture(pushed, T + m(27))).toBe("pushed");
  });

  test("the minute already rested is kept, not thrown away", () => {
    let c = step(started(), T + m(25));
    c = step(c, T + m(25) + s(1));
    const pushed = push(c, T + m(26) + s(1)); // one minute of break taken
    expect(pushed.banked).toBe(60);

    /* When it comes round again there are four minutes left, not five. */
    const back = step(pushed, T + m(26) + s(1) + s(SNOOZE_S));
    expect(isRunning(runOfCycle(back))).toBe(true);
    expect(remaining(runOfCycle(back), 300, T + m(26) + s(1) + s(SNOOZE_S))).toBe(240);
  });

  test("pushing it back twice is counted and said", () => {
    let c = push(step(started(), T + m(25)), T + m(25));
    c = push(c, T + m(29));
    expect(c.pushed).toBe(2);
    expect(restNote(phaseOf(c), c.done, c.pushed)).toBe(
      "one pomodoro behind you · pushed back twice",
    );
  });

  /* A break is owed at full length even if it was never begun. */
  test("a break pushed back before it started is still five minutes", () => {
    const owed = step(started(), T + m(25));
    const pushed = push(owed, T + m(25));
    expect(pushed.banked).toBe(0);
    const back = step(pushed, T + m(25) + s(SNOOZE_S));
    expect(remaining(runOfCycle(back), 300, T + m(25) + s(SNOOZE_S))).toBe(300);
  });

  /* The count is about *this* break, so it clears when the phase turns. */
  test("the push count resets when the break is finally taken", () => {
    let c = push(step(started(), T + m(25)), T + m(25));
    c = step(c, T + m(25) + s(SNOOZE_S));
    const back = step(c, T + m(31) + s(SNOOZE_S));
    expect(back.done).toBe(2);
    expect(back.pushed).toBe(0);
    expect(back.snoozedUntil).toBe(0);
  });
});

describe("stopping, pausing and coming back", () => {
  test("ending the cycle keeps what you got through", () => {
    const c = finish(step(started(), T + m(25)));
    expect(c.on).toBe(false);
    expect(c.done).toBe(1);
    expect(posture(c, T + m(30))).toBe("off");
    /* Beginning again is what clears it. */
    expect(begin(c, T).done).toBe(0);
  });

  test("pausing banks the focus and resuming carries it on", () => {
    const held = pause(started(), T + m(10));
    expect(held.banked).toBe(600);
    const again = resume(held, T + m(90));
    expect(isRunning(runOfCycle(again))).toBe(true);
    expect(elapsed(runOfCycle(again), T + m(95))).toBe(900);
  });

  /* A break resumes by resting, not by running in the background — otherwise
     un-pausing would silently spend a break nobody was taking. */
  test("resuming into a break leaves its clock for the rest screen to start", () => {
    const owed = step(started(), T + m(25));
    const held = pause(owed, T + m(25));
    const again = resume(held, T + m(60));
    expect(again.paused).toBe(false);
    expect(isRunning(runOfCycle(again))).toBe(false);
    expect(posture(again, T + m(60))).toBe("resting");
  });

  /* What `Cycle.watched` does when the last pomodoro widget comes down: it
     pauses rather than ends, so hanging one back up carries on. The wiring is in
     `cycle.svelte.ts`, but the promise it rests on is this one — pausing loses
     neither the phase nor a break already owed. */
  test("pausing an owed break keeps it owed at its full length", () => {
    const owed = step(started(), T + m(25));
    expect(phaseOf(owed).kind).toBe("short");

    /* Away from the wall for an hour, then back. */
    const away = pause(owed, T + m(25));
    const back = resume(away, T + m(85));
    expect(back.done).toBe(1);
    expect(phaseOf(back).kind).toBe("short");

    /* The hour away was not a break. */
    const resting = step(back, T + m(85) + s(1));
    expect(remaining(runOfCycle(resting), 300, T + m(85) + s(1))).toBe(300);
  });

  test("pausing twice is not a way to lose the phase", () => {
    const held = pause(started(), T + m(10));
    expect(pause(held, T + m(40))).toBe(held);
    expect(held.banked).toBe(600);
  });

  /* A cycle that rolled forward across a night would come back four pomodoros
     deep and owing a long break for work nobody did. */
  test("a cycle read back at launch is always paused", () => {
    const c = settleCycle(started());
    expect(c.paused).toBe(true);
    expect(isRunning(runOfCycle(c))).toBe(false);
    expect(c.snoozedUntil).toBe(0);
    expect(posture(c, T + m(600))).toBe("paused");
    /* And an untouched studio is left alone. */
    expect(settleCycle({ ...CYCLE })).toEqual({ ...CYCLE });
  });
});

describe("a cycle read back off disk is always usable", () => {
  test("a whole state survives the round trip", () => {
    const c = normalizeCycle({
      cadence: "50/10",
      per: 3,
      done: 5,
      since: T,
      banked: 42,
      snoozedUntil: T + 1000,
      pushed: 2,
      on: true,
      paused: false,
    });
    expect(c.cadence).toBe("50/10");
    expect(c.per).toBe(3);
    expect(c.done).toBe(5);
    expect(c.banked).toBe(42);
  });

  /* The opaque column's other half: the row outlives the vocabulary it was
     written against. */
  test("a retired cadence degrades to one that exists", () => {
    expect(normalizeCycle({ cadence: "13/2" }).cadence).toBe("25/5");
    expect(normalizeCycle({ per: 99 }).per).toBe(4);
    expect(normalizeCycle({ done: "seven" }).done).toBe(0);
    expect(normalizeCycle({ banked: NaN }).banked).toBe(0);
  });

  test("nothing at all is a studio that has never run one", () => {
    expect(normalizeCycle(null)).toEqual({ ...CYCLE });
    expect(normalizeCycle("cycle")).toEqual({ ...CYCLE });
    expect(normalizeCycle(undefined).on).toBe(false);
  });

  test("every cadence and per the menu offers survives normalising", () => {
    for (const c of CADENCES) {
      expect(normalizeCycle({ cadence: c.value }).cadence).toBe(c.value);
    }
    for (const p of PERS) {
      expect(normalizeCycle({ per: Number(p.value) }).per).toBe(Number(p.value));
    }
  });
});

describe("what the rest screen says", () => {
  test("it names the break rather than the phase number", () => {
    expect(restTitle(phaseAt(cad, 1, 4))).toBe("a short break");
    expect(restTitle(phaseAt(cad, 7, 4))).toBe("a long break");
  });

  /* A screen that only nags has nothing to say once you have obeyed it. */
  test("with nothing pushed back it reports only what you have done", () => {
    expect(restNote(phaseAt(cad, 1, 4), 1, 0)).toBe("one pomodoro behind you");
    expect(restNote(phaseAt(cad, 5, 4), 5, 0)).toBe("3 pomodoros behind you");
    expect(restNote(phaseAt(cad, 1, 4), 1, 1)).toBe(
      "one pomodoro behind you · pushed back once",
    );
    expect(restNote(phaseAt(cad, 1, 4), 1, 5)).toContain("pushed back 5 times");
  });
});

/* ── the widgets that carry one ────────────────────────────────────────── */

describe("the catalogue and the arithmetic meet at the widget", () => {
  const timer = (over: Record<string, unknown> = {}): Widget =>
    normalizeWidget({
      id: "w1",
      kind: "timer",
      x: 0,
      y: 0,
      w: 220,
      h: 132,
      z: 0,
      config: { ...defaultConfig("timer"), ...over },
    })!;

  test("only a countdown has something to count down from", () => {
    expect(limitIn(timer({ variant: "up" }))).toBeNull();
    expect(limitIn(timer({ variant: "duo" }))).toBeNull();
    expect(limitIn(timer({ variant: "down", length: "10m" }))).toBe(600);
    expect(limitIn(newWidget("clock", 0, 0))).toBeNull();
  });

  /* A knob that does nothing is worse than a missing one — it reads as broken
     rather than as absent. */
  test("the length is offered only when it would mean something", () => {
    const ids = (w: Widget) => optionsOf(w).map((o) => o.id);
    expect(ids(timer({ variant: "up" })).some((i) => i.startsWith("cfg:length"))).toBe(
      false,
    );
    expect(ids(timer({ variant: "down" })).some((i) => i.startsWith("cfg:length"))).toBe(
      true,
    );
    /* The face is offered either way — it is not guarded. */
    expect(ids(timer({ variant: "up" })).some((i) => i.startsWith("cfg:face"))).toBe(true);
  });

  /* Hidden is not lost: flipping to counting up and back must not throw away
     the length you chose. */
  test("a hidden knob keeps its value", () => {
    const w = timer({ variant: "up", length: "90m" });
    expect(w.config.length).toBe("90m");
    expect(limitIn({ ...w, config: { ...w.config, variant: "down" } })).toBe(5400);
  });

  test("an unguarded knob is always allowed", () => {
    const spec = specFor("timer")!;
    const face = spec.params.find((p) => p.key === "face")!;
    expect(allows(timer(), face)).toBe(true);
  });

  /* State is stored but never clamped the way a `number` knob is: an epoch has
     no range a catalogue could know. */
  test("a timer's own state rides in its config untouched", () => {
    const w = timer({ since: T, banked: 42.5 });
    expect(runIn(w)).toEqual({ since: T, banked: 42.5 });
    expect(elapsed(runIn(w), T + s(10))).toBe(52.5);
  });

  test("state that is not a number falls back rather than becoming a NaN", () => {
    const w = timer({ since: "yesterday", banked: NaN });
    expect(runIn(w)).toEqual({ since: 0, banked: 0 });
  });

  test("a fresh timer starts at zero and idle", () => {
    const w = newWidget("timer", 0, 0);
    expect(runIn(w)).toEqual(IDLE);
    expect(standing(runIn(w), limitIn(w), T)).toBe("idle");
  });

  /* Asked of the spec rather than of a list of kinds, so a future instrument
     that runs gets the launch-time hold and the beat by declaring `since`. */
  test("which widgets carry a clock is read off the catalogue", () => {
    expect(runs("timer")).toBe(true);
    expect(runs("clock")).toBe(false);
    expect(runs("performance")).toBe(false);
    expect(runs("nothing-of-the-sort")).toBe(false);
  });

  test("the timer offers the three instruments and the pomodoro three readings", () => {
    expect(variantsOf("timer").map((v) => v.value)).toEqual(["up", "down", "duo"]);
    expect(variantsOf("pomodoro").map((v) => v.value)).toEqual([
      "ring",
      "beads",
      "digits",
    ]);
  });

  /* The cycle is one per studio, so a view of it must not carry a phase of its
     own — two widgets holding their own would be two clocks telling different
     times. */
  test("a pomodoro widget holds nothing but how it is drawn", () => {
    /* Its own knobs, plus the frame every widget on the wall has — both are
       matters of drawing, which is the whole of what a view is allowed to keep.
       Named rather than enumerated, so the shared knobs can grow without this
       reading as the cycle leaking into a widget: what must never appear is a
       phase, a cadence, or a count of pomodoros done. */
    const config = defaultConfig("pomodoro");
    expect(Object.keys(config).sort()).toEqual(["frame", "variant"]);
    for (const own of ["done", "cadence", "per", "phase", "since", "banked"]) {
      expect(config[own]).toBeUndefined();
    }
    expect(specFor("pomodoro")!.state).toBeUndefined();
  });
});
