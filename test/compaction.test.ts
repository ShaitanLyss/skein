import { expect, test, describe } from "bun:test";
import {
  FLOOR_S,
  MAX_ESTIMATE_S,
  MAX_SEEN,
  MIN_ESTIMATE_S,
  NEARLY,
  TILT_AT,
  compactEstimate,
  compactFill,
  compactLate,
  normalizeSeen,
  priorFor,
  recordCompaction,
  type Compaction,
} from "../src/lib/compaction";

/** The eight real compactions this machine had recorded on 2026-08-17, read out
 *  of `compactMetadata.preTokens` / `durationMs`. The prior is fitted to these,
 *  so they are the thing it has to stay honest about. */
const REAL: Compaction[] = [
  { tokens: 47_260, seconds: 70.2 },
  { tokens: 47_424, seconds: 64.8 },
  { tokens: 339_871, seconds: 187.7 },
  { tokens: 431_578, seconds: 157.1 },
  { tokens: 452_871, seconds: 117.4 },
  { tokens: 469_734, seconds: 102.5 },
  { tokens: 624_414, seconds: 125.2 },
  { tokens: 981_095, seconds: 117.4 },
];

describe("the prior, which is nearly a constant and says so", () => {
  test("it is a floor plus a tilt that saturates", () => {
    expect(priorFor(0)).toBe(FLOOR_S);
    expect(priorFor(TILT_AT)).toBe(130);
    /* Above the knee, knowing more about the size buys nothing — the four
       largest real folds ran 981k, 624k, 470k and 453k tokens and took 117,
       125, 103 and 117 seconds, in that order. */
    expect(priorFor(981_095)).toBe(priorFor(TILT_AT));
  });

  test("it is within a minute of every compaction actually measured", () => {
    /* Eight points with ±40s of scatter and no ordering by size. Anything that
       fitted them more tightly would be fitting the noise. */
    for (const r of REAL) {
      expect(Math.abs(priorFor(r.tokens) - r.seconds)).toBeLessThan(60);
    }
  });

  test("nonsense in does not become nonsense out", () => {
    expect(priorFor(-1)).toBe(FLOOR_S);
  });
});

describe("the estimate learns from what this wall has watched", () => {
  test("with nothing seen it is the prior", () => {
    expect(compactEstimate([], 400_000)).toBe(priorFor(400_000));
  });

  test("a machine that folds slowly is believed, gradually", () => {
    // Twice the prior every time. One observation must not double the estimate.
    const slow = (n: number) =>
      Array.from({ length: n }, () => ({ tokens: 400_000, seconds: priorFor(400_000) * 2 }));
    const one = compactEstimate(slow(1), 400_000);
    const four = compactEstimate(slow(4), 400_000);
    const prior = priorFor(400_000);
    expect(one).toBeGreaterThan(prior);
    expect(one).toBeLessThan(four);
    expect(four).toBeLessThan(prior * 2);
    /* n/(n+2), so one observation moves it a third of the way. */
    expect(one).toBeCloseTo(prior * (1 + 1 / 3), 5);
  });

  test("the size tilt survives calibration", () => {
    /* Calibrating on a *ratio* rather than on a mean of durations is what keeps
       this true: observe only huge folds, and a small one is still predicted
       smaller. Averaging the raw seconds would flatten that away. */
    const seen = [{ tokens: 900_000, seconds: 260 }];
    expect(compactEstimate(seen, 10_000)).toBeLessThan(compactEstimate(seen, 900_000));
  });

  test("one wild fold does not move the next twelve", () => {
    const seen = [...REAL.map((r) => ({ ...r })), { tokens: 400_000, seconds: 880 }];
    const withIt = compactEstimate(seen, 400_000);
    const without = compactEstimate(REAL, 400_000);
    // The median absorbs it; a mean would not.
    expect(Math.abs(withIt - without)).toBeLessThan(20);
  });

  test("it is never absurd, whatever it is fed", () => {
    const daft = [{ tokens: 1, seconds: 1e9 }];
    expect(compactEstimate(daft, 500_000)).toBeLessThanOrEqual(MAX_ESTIMATE_S);
    expect(compactEstimate([{ tokens: 1, seconds: 0.001 }], 0)).toBeGreaterThanOrEqual(
      MIN_ESTIMATE_S,
    );
    expect(compactEstimate([{ tokens: 0, seconds: NaN }], 0)).toBe(priorFor(0));
  });
});

describe("the bar never fills, which is the whole honesty of it", () => {
  test("it stops short at the predicted moment", () => {
    expect(compactFill(0, 100)).toBe(0);
    expect(compactFill(50, 100)).toBeCloseTo(NEARLY / 2, 6);
    /* Arriving at the prediction must not look like arriving at the end: a
       tenth of the bar is deliberately still to go. */
    expect(compactFill(100, 100)).toBeCloseTo(NEARLY, 6);
  });

  test("past the prediction it creeps and never arrives", () => {
    const over = [110, 150, 300, 1200].map((e) => compactFill(e, 100));
    for (let i = 1; i < over.length; i++) expect(over[i]).toBeGreaterThan(over[i - 1]);
    for (const f of over) expect(f).toBeLessThan(1);
  });

  test("it does not fill even when the arithmetic would let it", () => {
    /* `1 - exp(-x)` is exactly 1 in a double once x passes ~37, which a fold
       ten times its prediction reaches — so the asymptote alone let the bar
       complete at the worst possible moment, on the one fold that had gone
       badly wrong. */
    for (const e of [10_000, 100_000, 1e12]) {
      expect(compactFill(e, 100)).toBeLessThan(1);
    }
  });

  test("it only ever goes forwards", () => {
    let last = -1;
    for (let t = 0; t <= 600; t += 3) {
      const f = compactFill(t, 120);
      expect(f).toBeGreaterThanOrEqual(last);
      last = f;
    }
  });

  test("it stays drawable whatever it is handed", () => {
    for (const [e, est] of [[-5, 100], [10, 0], [10, -1], [0, 0]] as const) {
      const f = compactFill(e, est);
      expect(Number.isFinite(f)).toBe(true);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });

  test("a NaN estimate is not clamped away by Math.max, and was", () => {
    /* `Math.max` does not guard against NaN, it *propagates* it — `Math.max(1,
       NaN)` is NaN — so the clamp that made every other bad input drawable let
       this one straight through to `width: NaN%`, which draws as an empty bar
       with nothing anywhere saying why. The case above never fed it one, so
       the hole was invisible. Non-finite has to be tested for, not clamped. */
    for (const [e, est] of [[30, NaN], [NaN, 100], [NaN, NaN]] as const) {
      const f = compactFill(e, est);
      expect(Number.isFinite(f)).toBe(true);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });
});

describe("being late is said in words, not left to the bar", () => {
  test("a fold landing a little over does not accuse itself", () => {
    expect(compactLate(100, 100)).toBe(false);
    expect(compactLate(112, 100)).toBe(false);
  });

  test("a fold well past its prediction says so", () => {
    expect(compactLate(200, 100)).toBe(true);
  });
});

describe("what gets remembered", () => {
  test("a completed fold is kept, newest last", () => {
    const out = recordCompaction([{ tokens: 1, seconds: 60 }], { tokens: 2, seconds: 90 });
    expect(out).toEqual([
      { tokens: 1, seconds: 60 },
      { tokens: 2, seconds: 90 },
    ]);
  });

  test("a measurement nobody believes is dropped rather than clamped", () => {
    /* Two seconds is not a fast compaction, it is a fold whose start was
       missed — and averaged in it would poison the estimate for the session.
       The same list back, so the caller knows nothing was written. */
    const seen = [{ tokens: 1, seconds: 60 }];
    expect(recordCompaction(seen, { tokens: 2, seconds: 2 })).toBe(seen);
    expect(recordCompaction(seen, { tokens: 2, seconds: 1e6 })).toBe(seen);
  });

  test("it forgets the oldest, so a machine that got faster is believed", () => {
    let seen: Compaction[] = [];
    for (let i = 0; i < MAX_SEEN + 5; i++) {
      seen = recordCompaction(seen, { tokens: i * 1000, seconds: 60 + i });
    }
    expect(seen.length).toBe(MAX_SEEN);
    expect(seen[seen.length - 1].seconds).toBe(60 + MAX_SEEN + 4);
  });
});

describe("what was stored degrades rather than reaching a frame loop", () => {
  test("anything at all is readable", () => {
    expect(normalizeSeen(null)).toEqual([]);
    expect(normalizeSeen("not an array")).toEqual([]);
    expect(normalizeSeen([1, null, "x", {}])).toEqual([]);
  });

  test("a NaN never becomes a width", () => {
    expect(normalizeSeen([{ tokens: NaN, seconds: 90 }])).toEqual([
      { tokens: 0, seconds: 90 },
    ]);
    expect(normalizeSeen([{ tokens: 5, seconds: NaN }])).toEqual([]);
    expect(normalizeSeen([{ tokens: 5, seconds: Infinity }])).toEqual([]);
  });

  test("a longer list than we keep is cut to what we keep", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ tokens: i, seconds: 60 }));
    expect(normalizeSeen(many).length).toBe(MAX_SEEN);
  });
});
