/* Timers: how long this has taken, how long is left, and when to make you stop.
 *
 * Pure, and tested directly — the same split `clock.ts` has with `Clock.svelte`
 * and `ambience.ts` has with `Backdrop.svelte`. Nothing here imports anything,
 * which is what lets `widgets.ts` build its catalogue off the tables below
 * without the two files pointing at each other.
 *
 * The one idea the whole file rests on: **a timer is an epoch and a number of
 * banked seconds, never a counter something increments.** Elapsed is
 * `banked + (now - since)`, so there is no interval to run, no drift to
 * accumulate, and the wall keeps the single one-second tick it already has
 * (`clock` in `conversation.svelte.ts`) rather than growing one wake-up per
 * timer per frame. It also means the state survives a restart by being written
 * down rather than by being reconstructed.
 *
 * Lifted from `life-to-the-fullest`, whose `Timer`/`Countdown`/`Pomodoro` kept a
 * list of start/end intervals summed on every read and drove them from
 * `setInterval(…, 20)` — fifty wake-ups a second, per timer. Two epochs say the
 * same thing and go on saying it after a reboot. */

/** A stopwatch's whole state: when the current run began (0 when it is not
 *  running) and what earlier runs already earned. */
export type Run = { since: number; banked: number };

export const IDLE: Run = { since: 0, banked: 0 };

export function isRunning(run: Run): boolean {
  return run.since > 0;
}

/** Seconds on the clock. Clamped at the low end because a system clock that
 *  steps backwards must not make a timer run backwards with it. */
export function elapsed(run: Run, now: number): number {
  const live = run.since > 0 ? Math.max(0, (now - run.since) / 1000) : 0;
  return Math.max(0, run.banked) + live;
}

export function start(run: Run, now: number): Run {
  return run.since > 0 ? run : { since: now, banked: Math.max(0, run.banked) };
}

export function hold(run: Run, now: number): Run {
  return run.since > 0 ? { since: 0, banked: elapsed(run, now) } : run;
}

/** Bring what a running timer has earned into `banked` without stopping it.
 *
 * The whole reason the persisted state can be trusted after a crash. Nothing
 * writes to a widget's row while it merely *runs* — the reading is derived — so
 * a row written when the timer started says nothing about how far it got.
 * Called on a slow beat (`Widgets.beat`), which bounds what a launch can lose to
 * that beat rather than to however long the timer had been going. */
export function bank(run: Run, now: number): Run {
  return run.since > 0 ? { since: now, banked: elapsed(run, now) } : run;
}

/** A timer left running when Skein last closed, brought back held.
 *
 * The app not running is not the same as the timer running. A stopwatch here is
 * measuring your attention on something, and that stopped when the window did —
 * so coming back to "you have been at this for sixteen hours" after a night is a
 * reading nobody wants and nobody can correct. Held at what was last banked is
 * honest about both halves: it kept the time it can prove, and it is not
 * pretending to have watched the gap.
 *
 * A countdown whose length passed inside that gap comes back `rung`, which falls
 * straight out of `standing` and is right: it did ring, you just were not
 * there. */
export function settle(run: Run): Run {
  return run.since > 0 ? { since: 0, banked: Math.max(0, run.banked) } : run;
}

/* Where a timer stands.
 *
 * `rung` is the one that earns its place: a countdown whose time is up has not
 * merely finished, it is *waiting to be noticed*, which on this wall is exactly
 * what amber means and exactly what the peek is for. A stopwatch has no limit
 * and so can never ring. */
export type Standing = "idle" | "running" | "held" | "rung";

export function standing(run: Run, limit: number | null, now: number): Standing {
  if (limit !== null && limit > 0 && elapsed(run, now) >= limit) return "rung";
  if (run.since > 0) return "running";
  return run.banked > 0 ? "held" : "idle";
}

export function remaining(run: Run, limit: number, now: number): number {
  return Math.max(0, limit - elapsed(run, now));
}

/** How long ago it rang. What the peek prints as the age of the item, and what a
 *  face says instead of showing a negative number: a countdown reading `-4:12`
 *  is asking you to do the subtraction yourself. */
export function overrun(run: Run, limit: number, now: number): number {
  return Math.max(0, elapsed(run, now) - limit);
}

/** How far through, 0–1. What a ring or a bar draws. */
export function progress(run: Run, limit: number, now: number): number {
  if (limit <= 0) return 0;
  return Math.min(1, elapsed(run, now) / limit);
}

/** A countdown that has run out, and how long ago. */
export type Alarm = { id: string; overrun: number };

/** Which alarms should sound now, and what to remember for next time.
 *
 * Here rather than in `attention.svelte.ts` because both rules in it are
 * arithmetic with a bug behind them, and neither is reachable from a test if it
 * lives inside the class that owns the audio:
 *
 * - **An alarm sounds once**, however long it stands unacknowledged. The ladder
 *   is driven off the one-second tick, so a rung countdown left alone would
 *   otherwise ring sixty times a minute until you pressed `done`.
 * - **An alarm that ran out before we were watching does not sound at all.** A
 *   countdown whose length passed while Skein was closed comes back `rung` (see
 *   `settle`) — it did ring, you were not there — and a bell at launch for an
 *   appointment from last night is noise. The amber face already reports it
 *   honestly, which is the whole of what that reading is for. Decided by
 *   comparing the overrun against how long the window has been up, rather than
 *   by priming a set on the first tick: the widgets arrive from SQLite several
 *   ticks after the ladder is built, so a first-tick prime would look at an
 *   empty wall and suppress nothing.
 *
 * `sounded` is carried rather than mutated, and what comes back is *what is
 * ringing now* rather than everything ever rung — so acknowledging a countdown
 * and setting it again is a second appointment and rings again. */
export function ring(
  alarms: Alarm[],
  sounded: readonly string[],
  uptime: number,
): { fresh: string[]; sounded: string[] } {
  const known = new Set(sounded);
  const fresh: string[] = [];
  for (const a of alarms) {
    if (known.has(a.id)) continue;
    if (a.overrun > uptime) continue;
    fresh.push(a.id);
  }
  return { fresh, sounded: alarms.map((a) => a.id) };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A span of time, said the way a stopwatch says it.
 *
 * The hour is dropped until there is one: `0:04:12` for four minutes is a
 * stopwatch pretending to be a clock, and the leading zeros are two characters
 * of noise on the number you are reading. Minutes are unpadded for the same
 * reason — `4:07`, not `04:07` — but seconds always are, or the digits shuffle
 * sideways every ten seconds. */
export function span(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** The same span in words, for the places that are speaking rather than
 *  counting — the rest screen's own line, and the peek's detail. Coarse on
 *  purpose: "four minutes" is what somebody would say, and a rest screen
 *  counting your break down to the second is a rest screen you watch. */
export function said(seconds: number): string {
  const t = Math.max(0, Math.round(seconds));
  if (t < 45) return "under a minute";
  const m = Math.round(t / 60);
  if (m <= 1) return "a minute";
  if (m < 60) return `${m} minutes`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  const hours = h === 1 ? "an hour" : `${h} hours`;
  return rest === 0 ? hours : `${hours} and ${rest}`;
}

/* ── the duo ───────────────────────────────────────────────────────────────
 *
 * Two stopwatches of which exactly one runs. That constraint is the whole
 * instrument: the pair always sums to the time since you started, so the share
 * between them is a real reading rather than two unrelated numbers side by side
 * — which is the thing the reference implementation's double timer was missing,
 * and the thing worth having.
 *
 * The lanes are `on` and `off` rather than anything typed, because no widget on
 * this wall has a text field and the useful pair is always the same one: time
 * spent at it against time spent away. */
export type Lane = "on" | "off";

export type Duo = { on: Run; off: Run };

/** Which lane is running, or null while both are held. */
export function laneRunning(duo: Duo): Lane | null {
  if (isRunning(duo.on)) return "on";
  if (isRunning(duo.off)) return "off";
  return null;
}

/** Hand the clock to one lane. Clicking the lane already running holds both —
 *  the way out of a duo is to stop, not to have to start a third thing. */
export function switchTo(duo: Duo, lane: Lane, now: number): Duo {
  const held: Duo = { on: hold(duo.on, now), off: hold(duo.off, now) };
  if (laneRunning(duo) === lane) return held;
  return { ...held, [lane]: start(held[lane], now) };
}

export function duoTotal(duo: Duo, now: number): number {
  return elapsed(duo.on, now) + elapsed(duo.off, now);
}

/** What fraction of the whole went to `on`, 0–1. Zero total reads as zero
 *  rather than as a NaN inside a bar's width. */
export function duoShare(duo: Duo, now: number): number {
  const total = duoTotal(duo, now);
  return total > 0 ? elapsed(duo.on, now) / total : 0;
}

/* ── how long ──────────────────────────────────────────────────────────────
 *
 * Named intervals rather than a number you type, which is the catalogue's "no
 * numbers among the knobs" rule (see `widgets.ts`) and not merely a concession
 * to it: a menu is a poor spinner, and nobody has ever wanted a countdown of
 * thirty-seven minutes. The labels are words for the same reason the clock's
 * worded face exists — this wall says things out loud. */
export type Length = { value: string; label: string; seconds: number };

export const LENGTHS: Length[] = [
  { value: "1m", label: "a minute", seconds: 60 },
  { value: "5m", label: "five minutes", seconds: 5 * 60 },
  { value: "10m", label: "ten minutes", seconds: 10 * 60 },
  { value: "15m", label: "a quarter of an hour", seconds: 15 * 60 },
  { value: "20m", label: "twenty minutes", seconds: 20 * 60 },
  { value: "25m", label: "twenty-five minutes", seconds: 25 * 60 },
  { value: "30m", label: "half an hour", seconds: 30 * 60 },
  { value: "45m", label: "three quarters of an hour", seconds: 45 * 60 },
  { value: "60m", label: "an hour", seconds: 60 * 60 },
  { value: "90m", label: "an hour and a half", seconds: 90 * 60 },
];

export const DEFAULT_LENGTH = "25m";

export function lengthOf(value: string): number {
  const found = LENGTHS.find((l) => l.value === value);
  return (found ?? LENGTHS.find((l) => l.value === DEFAULT_LENGTH)!).seconds;
}

/** What a length is called, for a face's own note and for the peek. */
export function lengthLabel(value: string): string {
  return (LENGTHS.find((l) => l.value === value) ?? { label: "" }).label;
}

/* ── the pomodoro cycle ────────────────────────────────────────────────────
 *
 * A cadence is a named pair rather than four number fields, for the reason the
 * lengths are named: the four numbers in the reference implementation are only
 * ever set to one of about three combinations, and each of those combinations is
 * a way of working that people already have a name for. */
export type Cadence = {
  value: string;
  label: string;
  /** Minutes. */
  focus: number;
  short: number;
  long: number;
};

export const CADENCES: Cadence[] = [
  { value: "25/5", label: "twenty-five on, five off", focus: 25, short: 5, long: 15 },
  { value: "50/10", label: "fifty on, ten off", focus: 50, short: 10, long: 30 },
  { value: "90/20", label: "ninety on, twenty off", focus: 90, short: 20, long: 30 },
  { value: "15/3", label: "fifteen on, three off", focus: 15, short: 3, long: 12 },
];

export const DEFAULT_CADENCE = "25/5";

export function cadenceOf(value: string): Cadence {
  return (
    CADENCES.find((c) => c.value === value) ??
    CADENCES.find((c) => c.value === DEFAULT_CADENCE)!
  );
}

/** How many pomodoros before the long break. A choice rather than a number
 *  field, and worded, so it reads as a way of working rather than a setting. */
export const PERS = [
  { value: "3", label: "a long break every third" },
  { value: "4", label: "a long break every fourth" },
  { value: "5", label: "a long break every fifth" },
  { value: "6", label: "a long break every sixth" },
];

export const DEFAULT_PER = "4";

export type PhaseKind = "focus" | "short" | "long";

export type Phase = {
  kind: PhaseKind;
  /** How long this phase runs, in seconds. */
  seconds: number;
  /** Which pomodoro this is — or, on a break, the one it follows. */
  number: number;
};

/** Which phase a cycle stands in, after `done` phases have been finished.
 *
 * The sequence is focus, break, focus, break — so a focus is an even `done` and
 * a break an odd one, and the break after every `per`-th pomodoro is the long
 * one. Keeping the count as a single number rather than an `isOnBreak` flag
 * beside a `pomodoroNumber` means there is exactly one thing to persist and
 * exactly one thing that can be wrong. */
export function phaseAt(cadence: Cadence, done: number, per: number): Phase {
  const d = Math.max(0, Math.floor(done));
  const p = Math.max(1, Math.floor(per));
  const number = Math.floor(d / 2) + 1;
  if (d % 2 === 0) return { kind: "focus", seconds: cadence.focus * 60, number };
  const long = number % p === 0;
  return {
    kind: long ? "long" : "short",
    seconds: (long ? cadence.long : cadence.short) * 60,
    number,
  };
}

/** What a phase is called on a face. Lowercase and sentence-shaped, like
 *  everything else the wall says. */
export function phraseFor(phase: Phase): string {
  if (phase.kind === "focus") return `focus · ${phase.number}`;
  return phase.kind === "long" ? "a long break" : "a short break";
}

export type Bead = "done" | "now" | "todo";

/** The cycle in hand, one entry per pomodoro before the long break.
 *
 * A different reading from the ring rather than a decoration of it: the ring
 * answers "how long is left of this", the beads answer "how far through the
 * afternoon am I" — which is the question a pomodoro is kept for. The row always
 * shows the cycle currently being worked through, so it fills and starts again
 * rather than growing without limit. */
export function beads(done: number, per: number): Bead[] {
  const p = Math.max(1, Math.floor(per));
  const d = Math.max(0, Math.floor(done));
  /* Whole cycles are behind us; a cycle is `per` pomodoros and `per` breaks. */
  const inCycle = d % (p * 2);
  const out: Bead[] = [];
  for (let i = 0; i < p; i += 1) {
    if (i * 2 < inCycle) out.push("done");
    else if (i * 2 === inCycle) out.push("now");
    else out.push("todo");
  }
  return out;
}

/** How many pomodoros have actually been finished, every cycle included. What a
 *  face prints beside the beads, since the beads deliberately forget. */
export function completed(done: number): number {
  return Math.floor((Math.max(0, Math.floor(done)) + 1) / 2);
}

/* ── the machine ───────────────────────────────────────────────────────────
 *
 * One cycle for the whole studio, not one per widget: a pomodoro widget is a
 * *view*, and two of them on the wall disagreeing about which phase it is would
 * be two clocks telling different times. The shared state is why this lives in
 * its own row rather than in a widget's config (`pomodoro.svelte.ts`,
 * schema v8).
 *
 * The part worth reading twice is what a break *is* here. In the reference
 * implementation a break is a phase that starts counting the moment the focus
 * ends, whether or not anybody noticed — which is exactly the failure it was
 * written to fix, since a break you did not notice starting is a break you did
 * not take, and it then interrupts the work you carried on doing to send you
 * back to work. Here the break is **owed** when the focus rings and only runs
 * while the wall is actually resting. */
export type CycleState = {
  cadence: string;
  per: number;
  /** Phases finished. Even means a focus is in hand, odd means a break is. */
  done: number;
  /** The run of the phase in hand. A break's run only advances while resting. */
  since: number;
  banked: number;
  /** Epoch the rest screen is held off until; 0 when nothing is pushed back. */
  snoozedUntil: number;
  /** How many times *this* break has been pushed back. Shown, not enforced. */
  pushed: number;
  /** Is there a cycle at all. */
  on: boolean;
  /** Set by hand, and on every launch — see `settleCycle`. */
  paused: boolean;
};

export const CYCLE: CycleState = {
  cadence: DEFAULT_CADENCE,
  per: 4,
  done: 0,
  since: 0,
  banked: 0,
  snoozedUntil: 0,
  pushed: 0,
  on: false,
  paused: false,
};

/** How long one push-back buys. Deliberately short: "soon" is the whole
 *  contract, and a snooze long enough to finish what you were doing is a
 *  snooze that has cancelled the break. */
export const SNOOZE_S = 180;

export function runOfCycle(c: CycleState): Run {
  return { since: c.since, banked: c.banked };
}

export function phaseOf(c: CycleState): Phase {
  return phaseAt(cadenceOf(c.cadence), c.done, c.per);
}

/** What the studio is doing, which is the only thing outside this file needs to
 *  ask. `resting` is the one that takes the wall. */
export type Posture = "off" | "paused" | "working" | "pushed" | "resting";

export function posture(c: CycleState, now: number): Posture {
  if (!c.on) return "off";
  if (c.paused) return "paused";
  if (phaseOf(c).kind === "focus") return "working";
  return now < c.snoozedUntil ? "pushed" : "resting";
}

/** One step of the machine, given the time.
 *
 * Pure, and returns the *same object* when nothing is due — which is what lets
 * the studio call it on every one-second tick and only write when something
 * actually changed. All the transitions live here rather than spread across the
 * screen that draws them, so the rule "a snooze delays a break and never spends
 * it" is one function to read and one function to test. */
export function step(c: CycleState, now: number): CycleState {
  if (!c.on || c.paused) return c;
  const phase = phaseOf(c);
  const run = runOfCycle(c);

  if (phase.kind === "focus") {
    if (elapsed(run, now) < phase.seconds) return c;
    /* The focus is over and a break is owed. It is deliberately left *unstarted*
       — a break begins when the wall rests, not when the previous phase ended,
       which is the whole of what makes a push-back a delay. */
    return { ...c, done: c.done + 1, since: 0, banked: 0, pushed: 0, snoozedUntil: 0 };
  }

  /* A break. Its clock runs only while the rest screen is up. */
  if (now < c.snoozedUntil) {
    return isRunning(run) ? { ...c, ...hold(run, now) } : c;
  }
  if (!isRunning(run)) return { ...c, ...start(run, now) };
  if (elapsed(run, now) < phase.seconds) return c;
  /* Break taken. Back to it, and the next focus starts now rather than waiting
     to be pressed — the rest screen going away is the gesture. */
  return { ...c, done: c.done + 1, since: now, banked: 0, pushed: 0, snoozedUntil: 0 };
}

/** Push the break back. The partial break already taken is banked rather than
 *  discarded, so three snoozes two minutes apart do not each restart a five
 *  minute break — you are delaying what is left of it, which is what was
 *  promised. */
export function push(c: CycleState, now: number): CycleState {
  if (!c.on) return c;
  return {
    ...c,
    ...hold(runOfCycle(c), now),
    snoozedUntil: now + SNOOZE_S * 1000,
    pushed: c.pushed + 1,
  };
}

export function begin(c: CycleState, now: number): CycleState {
  return {
    ...c,
    on: true,
    paused: false,
    done: 0,
    since: now,
    banked: 0,
    pushed: 0,
    snoozedUntil: 0,
  };
}

/** Stop the cycle. `done` is kept: what you got through this afternoon is worth
 *  reading afterwards, and beginning again is what clears it. */
export function finish(c: CycleState): CycleState {
  return { ...c, on: false, paused: false, since: 0, banked: 0, pushed: 0, snoozedUntil: 0 };
}

export function pause(c: CycleState, now: number): CycleState {
  return c.on && !c.paused ? { ...c, ...hold(runOfCycle(c), now), paused: true } : c;
}

export function resume(c: CycleState, now: number): CycleState {
  if (!c.on || !c.paused) return c;
  /* A break resumes by resting, not by running in the background: leave its run
     alone and let `step` start it when the screen goes up. */
  const focus = phaseOf(c).kind === "focus";
  return focus
    ? { ...c, ...start(runOfCycle(c), now), paused: false }
    : { ...c, paused: false };
}

/** A cycle read back at launch. Paused, always.
 *
 * The same argument `settle` makes for a stopwatch, with more force: a cycle
 * that rolled forward across a night would come back four pomodoros deep and
 * owing a long break for work nobody did. Coming back paused is the honest
 * reading, and picking it up is one press. */
export function settleCycle(c: CycleState): CycleState {
  if (!c.on) return c;
  return { ...c, ...settle(runOfCycle(c)), paused: true, snoozedUntil: 0 };
}

/** A cycle as it came off disk, made usable — the same bargain
 *  `normalizeWidget` strikes, and for the same reason: the row outlives the
 *  vocabulary it was written against, and a cadence that has since been retired
 *  must degrade to one that exists rather than to a NaN inside a phase. */
export function normalizeCycle(raw: unknown): CycleState {
  if (!raw || typeof raw !== "object") return { ...CYCLE };
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, def: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : def;
  const flag = (v: unknown, def: boolean) => (typeof v === "boolean" ? v : def);
  const cadence =
    typeof r.cadence === "string" && CADENCES.some((c) => c.value === r.cadence)
      ? r.cadence
      : DEFAULT_CADENCE;
  const per = PERS.some((p) => p.value === String(r.per))
    ? Number(r.per)
    : Number(DEFAULT_PER);
  return {
    cadence,
    per,
    done: Math.max(0, Math.floor(num(r.done, 0))),
    since: Math.max(0, num(r.since, 0)),
    banked: Math.max(0, num(r.banked, 0)),
    snoozedUntil: Math.max(0, num(r.snoozedUntil, 0)),
    pushed: Math.max(0, Math.floor(num(r.pushed, 0))),
    on: flag(r.on, false),
    paused: flag(r.paused, false),
  };
}

/** What the rest screen says it is asking of you. Written from the break's own
 *  point of view, since that is the thing standing in front of you. */
export function restTitle(phase: Phase): string {
  return phase.kind === "long" ? "a long break" : "a short break";
}

/** The line under it. Two readings — how many you have done, and how many times
 *  you have pushed this one back — because the second is the honest pressure and
 *  a screen that only nags has nothing to say once you have obeyed it. */
export function restNote(phase: Phase, done: number, pushed: number): string {
  const n = completed(done);
  const got = n === 1 ? "one pomodoro behind you" : `${n} pomodoros behind you`;
  if (pushed === 0) return got;
  const back =
    pushed === 1 ? "pushed back once" : pushed === 2 ? "pushed back twice" : `pushed back ${pushed} times`;
  return `${got} · ${back}`;
}
