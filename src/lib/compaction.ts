/* How long a compaction will take, and how much of a bar to fill.
 *
 * This file exists because the wire will not say. `tools/probe-compact.ts`
 * watched a real 65-second fold emit two events and nothing between them — no
 * deltas, no percentage, no phase. The CLI's own bar is fed by `compact_progress`
 * and `response_length`, both of which the SDK path filters out of its message
 * stream. So a bar here is a *prediction*, and the whole design problem is how
 * to draw a guess without it reading as a measurement.
 *
 * Three rules follow, and they are the file:
 *
 *   1. The prediction comes from what compactions have actually cost, starting
 *      with eight real ones and recalibrating against every one this wall sees.
 *   2. The bar never fills. It reaches `NEARLY` at the predicted moment and
 *      creeps asymptotically after — so a bar at the end of its bar is still
 *      visibly unfinished, and only the closing status completes it.
 *   3. Past the prediction it says so in words, because a bar that has been
 *      nearly full for ninety seconds is a bar that has stopped telling you
 *      anything.
 *
 * Pure, and tested directly (test/compaction.test.ts).
 */

/** One compaction that actually happened: how much it was holding, and how long
 *  it took. Seconds rather than ms — nothing here needs the precision, and the
 *  numbers are read by people in the rules file. */
export type Compaction = {
  /** Context occupancy when the fold began. */
  tokens: number;
  seconds: number;
};

/** How many are kept. Enough to have a median that means something, few enough
 *  that a machine which got faster is believed within a working day. */
export const MAX_SEEN = 12;

/* ── the prior ────────────────────────────────────────────────────────────
 *
 * Every compaction records its own `durationMs` in the session file. Read out
 * of the 97 transcripts on this machine on 2026-08-17, all eight of them:
 *
 *   preTokens   seconds   trigger
 *      47,260      70.2   manual
 *      47,424      64.8   manual
 *     339,871     187.7   manual
 *     431,578     157.1   manual
 *     452,871     117.4   manual
 *     469,734     102.5   manual
 *     624,414     125.2   manual
 *     981,095     117.4   manual
 *
 * The striking thing is what is *not* there: a twentyfold range in tokens gives
 * a 2.9× range in seconds, and past ~340k the times fall as often as they rise.
 * A least-squares line over the lot is `96 + 0.051s per 1k tokens`, which is to
 * say very nearly a constant — the fold is dominated by writing a summary of
 * roughly fixed length, not by reading the context.
 *
 * So the prior is a floor plus a tilt that saturates: the two small folds are
 * genuinely the two fastest, and above `TILT_AT` knowing more about the size
 * buys nothing. Fitting anything more elaborate to eight points with ±40s of
 * scatter would be false precision dressed as a model.
 */

/** What the smallest folds cost. */
export const FLOOR_S = 65;
/** What the tilt adds, at and above `TILT_AT`. */
export const TILT_S = 65;
/** Where knowing more about the size stops helping. */
export const TILT_AT = 300_000;

/** The untuned guess, before this wall's own experience is applied. */
export function priorFor(tokens: number): number {
  const t = Math.max(0, tokens);
  return FLOOR_S + TILT_S * Math.min(1, t / TILT_AT);
}

/** Nothing is believed outside this, however the arithmetic comes out — a bar
 *  predicting eleven seconds or forty minutes is worse than no bar. */
export const MIN_ESTIMATE_S = 20;
export const MAX_ESTIMATE_S = 900;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** How long this fold will take, in seconds.
 *
 *  The prior is scaled by the *median ratio* of actual to predicted across what
 *  this wall has watched — a ratio rather than a mean of durations, so the size
 *  tilt survives calibration instead of being flattened by whatever sizes
 *  happened to be observed. The median rather than the mean because one fold
 *  that stalled on a slow network should not move the next twelve.
 *
 *  It is pulled toward 1 by `n/(n+2)`, so the first observation moves the
 *  estimate a third of the way rather than replacing it outright. Eight real
 *  measurements are not a lot, but they are more than one. */
export function compactEstimate(seen: Compaction[], tokens: number): number {
  const prior = priorFor(tokens);
  const usable = seen.filter((s) => s.seconds > 0 && Number.isFinite(s.seconds));
  if (usable.length === 0) return clampEstimate(prior);
  const ratios = usable.map((s) => s.seconds / priorFor(s.tokens));
  const n = usable.length;
  const adjusted = 1 + (median(ratios) - 1) * (n / (n + 2));
  return clampEstimate(prior * adjusted);
}

function clampEstimate(s: number): number {
  if (!Number.isFinite(s)) return FLOOR_S;
  return Math.min(MAX_ESTIMATE_S, Math.max(MIN_ESTIMATE_S, s));
}

/** How full the bar is at the predicted moment.
 *
 *  Not 1, and this is the whole honesty of the thing: the prediction is a guess,
 *  so arriving at it must not look like arriving at the end. A tenth of the bar
 *  is deliberately left, and the fold running exactly to prediction still shows
 *  a bar with something visibly to go. */
export const NEARLY = 0.9;

/** How much of the remaining tenth is eaten per further `estimate` of overrun.
 *  It is a fraction of what is *left*, so the bar approaches 1 and never gets
 *  there — the only thing that fills it is the compaction actually ending. */
const CREEP = 0.63;

/** As full as the bar is ever drawn.
 *
 *  The asymptote alone is not enough, and that is a floating-point fact rather
 *  than a design one: `1 - exp(-x)` is exactly 1 in a double once x passes ~37,
 *  which a fold ten times its prediction reaches — so a bar that could never
 *  fill in the arithmetic filled anyway, at the worst possible moment, on the
 *  one fold that had gone badly wrong. A hard ceiling means the claim holds for
 *  every input rather than for the ones anybody thought of. */
const CEILING = 0.995;

/** How full to draw the bar, 0–1, after `elapsed` seconds against `estimate`.
 *
 *  Linear to `NEARLY`, then asymptotic. Linear first because the early part of
 *  the wait is the part being predicted and a bar that eases the whole way is a
 *  bar that spends its useful range crawling; asymptotic after because past the
 *  prediction there is nothing left to predict *with*, and the only honest thing
 *  a bar can do is slow down. */
export function compactFill(elapsed: number, estimate: number): number {
  /* `Math.max` is not a guard against NaN — it *returns* it, so `Math.max(1,
     NaN)` is NaN and the whole expression below becomes `width: NaN%`, which
     draws as a bar of zero with no error anywhere to say why. Non-finite has to
     be tested for, not clamped away. */
  const e = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  const est = Number.isFinite(estimate) ? Math.max(1, estimate) : FLOOR_S;
  if (e <= est) return NEARLY * (e / est);
  const over = (e - est) / est;
  return Math.min(CEILING, NEARLY + (1 - NEARLY) * (1 - Math.exp(-CREEP * over)));
}

/** Is this fold past what was predicted for it?
 *
 *  Drawn in words rather than left to the bar. A bar sitting at 97% for ninety
 *  seconds has stopped saying anything, and worse, it is saying the wrong thing
 *  — the reader concludes it is nearly done when what is actually true is that
 *  the prediction was wrong. There is slack in it so that a fold landing a few
 *  seconds over does not accuse itself. */
export function compactLate(elapsed: number, estimate: number): boolean {
  return elapsed > estimate * 1.15 + 5;
}

/** Add a completed fold to what this wall has seen, newest last.
 *
 *  Absurd measurements are dropped rather than clamped: a fold recorded as
 *  taking two seconds is not a fast compaction, it is a fold whose start was
 *  missed, and averaging it in would poison the estimate for the rest of the
 *  session. */
export function recordCompaction(
  seen: Compaction[],
  next: Compaction,
): Compaction[] {
  if (!(next.seconds > 5) || next.seconds > MAX_ESTIMATE_S * 2) return seen;
  return [...seen, { tokens: Math.max(0, next.tokens), seconds: next.seconds }].slice(
    -MAX_SEEN,
  );
}

/** Read back what was stored, degrading to nothing rather than to a NaN inside
 *  a frame loop.
 *
 *  The same bargain every opaque JSON column in this app strikes: a normalizer
 *  runs on every read, so a shape written by an older build costs no migration
 *  and cannot put a `width: NaN%` on a bar. */
export function normalizeSeen(raw: unknown): Compaction[] {
  if (!Array.isArray(raw)) return [];
  const out: Compaction[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const { tokens, seconds } = r as Record<string, unknown>;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) continue;
    const t = typeof tokens === "number" && Number.isFinite(tokens) ? tokens : 0;
    out.push({ tokens: Math.max(0, t), seconds });
  }
  return out.slice(-MAX_SEEN);
}
