/* The clock widget's arithmetic: what time it is, where the hands point, and
 * how to say it in words.
 *
 * Pure, and tested directly. `Clock.svelte` draws these numbers and decides
 * nothing — which is the same split `ambience.ts` has with `Backdrop.svelte`,
 * and for the same reason: geometry is the part that is easy to get subtly
 * wrong and impossible to see wrong at a glance on a wall.
 *
 * Every function takes an epoch millisecond and reads it in *local* time, which
 * is the only time a clock on a wall in a room could sensibly mean. */

export type Reading = { h: number; m: number; s: number; ms: number };

export function reading(at: number): Reading {
  const d = new Date(at);
  return {
    h: d.getHours(),
    m: d.getMinutes(),
    s: d.getSeconds(),
    ms: d.getMilliseconds(),
  };
}

/** Where each hand points, in degrees clockwise from twelve.
 *
 * `sweep` is what separates a clock that ticks from one that glides: with it
 * the second hand carries its milliseconds and the minute hand carries its
 * seconds, so nothing on the face ever sits between two positions looking
 * broken. Without it every hand lands on a whole second — which is what a wall
 * clock does, and what a once-a-second tick can actually keep up with. */
export function handAngles(r: Reading, sweep = false): {
  hour: number;
  minute: number;
  second: number;
} {
  const s = r.s + (sweep ? r.ms / 1000 : 0);
  const m = r.m + s / 60;
  const h = (r.h % 12) + m / 60;
  return { hour: h * 30, minute: m * 6, second: s * 6 };
}

/** How far round each hand is, 0–1. What the abstract face draws instead of
 *  hands, and what any arc needs to know. */
export function turns(r: Reading, sweep = false): {
  hour: number;
  minute: number;
  second: number;
} {
  const a = handAngles(r, sweep);
  return { hour: a.hour / 360, minute: a.minute / 360, second: a.second / 360 };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The digital face, split so the two halves can be sized differently: the
 *  time is the thing you read across the room, the rest is a footnote. */
export function digital(
  r: Reading,
  opts: { h24?: boolean; seconds?: boolean } = {},
): { time: string; seconds: string; suffix: string } {
  const h24 = opts.h24 ?? true;
  const h = h24 ? r.h : r.h % 12 === 0 ? 12 : r.h % 12;
  return {
    /* 24-hour pads the hour, 12-hour does not: `09:41` is a timestamp and
       `9:41` is a clock, and this is the one place the difference is the whole
       point of the setting. */
    time: `${h24 ? pad(h) : h}:${pad(r.m)}`,
    seconds: opts.seconds ?? true ? pad(r.s) : "",
    suffix: h24 ? "" : r.h < 12 ? "am" : "pm",
  };
}

const ONES = [
  "twelve", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven",
];

const MINUTES = [
  "", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "quarter", "sixteen",
  "seventeen", "eighteen", "nineteen", "twenty", "twenty-one", "twenty-two",
  "twenty-three", "twenty-four", "twenty-five", "twenty-six", "twenty-seven",
  "twenty-eight", "twenty-nine",
];

/** The time as somebody would say it out loud.
 *
 * Deliberately not a rounded-to-five approximation: a clock that says "half
 * past three" for 15:32 is a clock you check against another clock. Every
 * minute has a word, and the three that already have names — quarter, half,
 * quarter — use them. Noon and midnight are only themselves on the hour.
 *
 * 24-hour has no bearing here: nobody says "fifteen thirty-two" and means it
 * as a phrase, so the words are always twelve-hour and the half of the day is
 * carried by "morning" / "afternoon" / "evening" / "night" instead. */
export function words(r: Reading): { time: string; part: string } {
  const to = r.m > 30;
  /* Past the half hour the phrase names the hour we are heading *for*. */
  const h = (to ? r.h + 1 : r.h) % 24;
  const name = ONES[h % 12];

  let time: string;
  if (r.m === 0) {
    time = r.h === 0 ? "midnight" : r.h === 12 ? "noon" : `${name} o'clock`;
  } else if (r.m === 30) {
    time = `half past ${name}`;
  } else if (to) {
    time = `${MINUTES[60 - r.m]} to ${name}`;
  } else {
    time = `${MINUTES[r.m]} past ${name}`;
  }

  return { time, part: partOfDay(r.h) };
}

/** Which half of the day it is, for a face with no numerals to say so. */
export function partOfDay(h: number): string {
  if (h < 5) return "night";
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  if (h < 22) return "evening";
  return "night";
}

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov",
  "dec",
];

/** The date, in the wall's own lowercase voice. */
export function dateLine(at: number): string {
  const d = new Date(at);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/* ── geometry ──────────────────────────────────────────────────────────────
 *
 * Screen coordinates, so y grows downwards and twelve o'clock is straight up:
 * an angle of 0 is (cx, cy - r), and every function here takes degrees
 * clockwise from there. Written once because getting the offset wrong makes a
 * clock that is right three times a day. */

export type Point = { x: number; y: number };

export function onFace(cx: number, cy: number, radius: number, deg: number): Point {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) };
}

/** The twelve (or sixty) marks of a face, as inner/outer point pairs. */
export function ticks(
  cx: number,
  cy: number,
  radius: number,
  count: number,
  length: number,
): { a: Point; b: Point; major: boolean }[] {
  const out: { a: Point; b: Point; major: boolean }[] = [];
  for (let i = 0; i < count; i += 1) {
    const deg = (360 / count) * i;
    /* Every third mark of a twelve is a quarter; of a sixty, every fifth is an
       hour. Both read as "the ones that matter are longer". */
    const major = count <= 12 ? i % 3 === 0 : i % 5 === 0;
    const len = major ? length : length * 0.55;
    out.push({
      a: onFace(cx, cy, radius - len, deg),
      b: onFace(cx, cy, radius, deg),
      major,
    });
  }
  return out;
}

/** An SVG arc from twelve o'clock round to `deg`, as a stroked path.
 *
 * A full turn cannot be drawn as one arc — start and end coincide and the
 * renderer draws nothing at all, which is a ring that vanishes for one second
 * in sixty. Clamped just short, which is invisible and always draws. */
export function arcPath(
  cx: number,
  cy: number,
  radius: number,
  deg: number,
  from = 0,
): string {
  const span = Math.max(0, Math.min(359.99, deg - from));
  const a = onFace(cx, cy, radius, from);
  const b = onFace(cx, cy, radius, from + span);
  const large = span > 180 ? 1 : 0;
  const r = round(radius);
  return `M ${round(a.x)} ${round(a.y)} A ${r} ${r} 0 ${large} 1 ${round(b.x)} ${round(b.y)}`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
