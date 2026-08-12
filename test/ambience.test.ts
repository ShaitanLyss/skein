import { expect, test, describe } from "bun:test";
import {
  EFFECTS,
  defaultLayer,
  defaultParams,
  due,
  hexRgb,
  leaf,
  leafStep,
  living,
  mix,
  normalizeLayer,
  normalizeProfile,
  pickName,
  rgba,
  ripple,
  rippleDone,
  rippleRadius,
  rng,
  shippedProfiles,
  specFor,
  stepOn,
  strokeEnvelope,
  swirlPoints,
  walkedOut,
  walkIn,
  windAt,
  wrapLeaf,
  type Leaf,
} from "../src/lib/ambience";

/* ── the catalogue ─────────────────────────────────────────────────────── */

describe("an effect describes itself well enough to be driven blind", () => {
  /* The panel builds its controls off `params` and knows nothing about what any
     effect is. A spec that lies about its own range is a slider that writes a
     value the renderer then has to survive. */
  test("every parameter's default sits inside its own range", () => {
    for (const e of EFFECTS) {
      for (const q of e.params) {
        expect(q.min).toBeLessThan(q.max);
        expect(q.def).toBeGreaterThanOrEqual(q.min);
        expect(q.def).toBeLessThanOrEqual(q.max);
        expect(q.step).toBeGreaterThan(0);
      }
    }
  });

  test("no effect lists the same knob twice", () => {
    for (const e of EFFECTS) {
      const keys = e.params.map((q) => q.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  /* `ink` is a lightness between two of the theme's tones, and it is the only
     thing standing between an ambience layer and decorative colour. Every
     effect must have one. */
  test("every effect is drawn in the theme's ink and nothing else", () => {
    for (const e of EFFECTS) {
      expect(e.params.map((q) => q.key)).toContain("ink");
    }
  });

  test("a fresh layer is on, opaque, and complete", () => {
    const l = defaultLayer("leaves", "l1");
    expect(l).toMatchObject({ id: "l1", kind: "leaves", on: true, opacity: 1 });
    expect(Object.keys(l.params).sort()).toEqual(
      specFor("leaves")!.params.map((q) => q.key).sort(),
    );
  });
});

/* ── what comes back off disk ───────────────────────────────────────────── */

describe("a profile read back from the database is made drawable first", () => {
  test("a knob that has been added since gets its default", () => {
    const l = normalizeLayer({ id: "x", kind: "swirls", params: { size: 200 } })!;
    expect(l.params.size).toBe(200);
    expect(l.params.curl).toBe(defaultParams("swirls").curl);
  });

  test("a value outside the range is pulled back into it, not honoured", () => {
    const l = normalizeLayer({ kind: "ripples", params: { max: 99999, rate: -4 } })!;
    const spec = specFor("ripples")!;
    expect(l.params.max).toBe(spec.params.find((q) => q.key === "max")!.max);
    expect(l.params.rate).toBe(0);
  });

  /* Anything could be in that column — an older build's shape, a hand edit, a
     half-written row. None of it may reach a frame loop as NaN. */
  test("nonsense becomes the default rather than a NaN in the canvas", () => {
    const l = normalizeLayer({ kind: "swirls", params: { width: "wide", curl: null } })!;
    expect(l.params.width).toBe(defaultParams("swirls").width);
    expect(l.params.curl).toBe(defaultParams("swirls").curl);
    for (const v of Object.values(l.params)) expect(Number.isFinite(v)).toBe(true);
  });

  test("a knob no effect has any more is dropped", () => {
    const l = normalizeLayer({ kind: "swirls", params: { hue: 200 } })!;
    expect(l.params).not.toHaveProperty("hue");
  });

  test("an effect that no longer exists is dropped, and takes nothing with it", () => {
    expect(normalizeLayer({ kind: "fireflies", params: {} })).toBeNull();
    const p = normalizeProfile({
      id: "p",
      name: "old",
      layers: [{ kind: "fireflies" }, { kind: "leaves" }],
    });
    expect(p.layers.map((l) => l.kind)).toEqual(["leaves"]);
  });

  /* `on` is younger than the layers written before it. Absent has to mean the
     layer was drawing, or an upgrade would silently switch the wall off. */
  test("a layer written before there was an off switch is on", () => {
    expect(normalizeLayer({ kind: "leaves" })!.on).toBe(true);
    expect(normalizeLayer({ kind: "leaves", on: false })!.on).toBe(false);
  });

  test("an unnamed profile is still nameable", () => {
    expect(normalizeProfile({}).name).toBe("untitled");
    expect(normalizeProfile({ name: "  dusk  " }).name).toBe("dusk");
  });

  test("every shipped profile survives its own normalisation unchanged", () => {
    for (const p of shippedProfiles()) {
      expect(normalizeProfile(JSON.parse(JSON.stringify(p)))).toEqual(p);
    }
  });

  /* The frame loop is stopped when nothing is drawing — an empty profile must
     not cost sixty clears a second. */
  test("a profile draws only if some layer is on and visible", () => {
    expect(living(null)).toBe(false);
    expect(living({ id: "p", name: "bare", layers: [] })).toBe(false);
    const l = defaultLayer("swirls", "a");
    expect(living({ id: "p", name: "x", layers: [{ ...l, on: false }] })).toBe(false);
    expect(living({ id: "p", name: "x", layers: [{ ...l, opacity: 0 }] })).toBe(false);
    expect(living({ id: "p", name: "x", layers: [l] })).toBe(true);
  });
});

/* ── the shared machinery ───────────────────────────────────────────────── */

describe("spawning is a rate, not a coin toss", () => {
  test("the same number arrive however the frames fall", () => {
    let acc = 0;
    let n = 0;
    for (let i = 0; i < 600; i += 1) {
      const d = due(acc, 60, 1 / 60);
      acc = d.acc;
      n += d.n;
    }
    // 60 a minute, ten seconds of frames.
    expect(n).toBe(10);

    let acc2 = 0;
    let n2 = 0;
    for (let i = 0; i < 20; i += 1) {
      const d = due(acc2, 60, 0.5);
      acc2 = d.acc;
      n2 += d.n;
    }
    expect(n2).toBe(10);
  });

  /* Zero has to mean zero. A probability-per-frame version drew occasionally at
     the bottom of the slider, which reads as a bug in the slider. */
  test("nothing at all is a rate you can ask for", () => {
    expect(due(0.99, 0, 10)).toEqual({ n: 0, acc: 0 });
  });

  test("a long frame owes the same as the frames it swallowed", () => {
    expect(due(0, 120, 1).n).toBe(2);
  });
});

describe("the wind keeps changing its mind", () => {
  const q = { base: 40, gust: 30, period: 11 };

  test("it never blows harder than the gust allows", () => {
    for (let t = 0; t < 200; t += 0.05) {
      const w = windAt(t, q.base, q.gust, q.period);
      expect(w).toBeGreaterThanOrEqual(q.base - q.gust - 1e-9);
      expect(w).toBeLessThanOrEqual(q.base + q.gust + 1e-9);
    }
  });

  test("no gust is a steady draught", () => {
    expect(windAt(3.2, 40, 0, 11)).toBe(40);
    expect(windAt(97.5, 40, 0, 11)).toBe(40);
  });

  /* One sine is a metronome you notice inside a minute. Two that don't divide
     each other should not repeat over one period. */
  test("it does not simply repeat every period", () => {
    const a = windAt(0.4, 0, 30, 10);
    const b = windAt(10.4, 0, 30, 10);
    expect(Math.abs(a - b)).toBeGreaterThan(1);
  });

  test("a period of zero does not divide by it", () => {
    expect(Number.isFinite(windAt(1, 10, 5, 0))).toBe(true);
  });
});

describe("a seeded stroke is the same stroke every frame", () => {
  /* Load-bearing: a flourish is generated once and redrawn for as long as it
     lives. Re-rolling per frame would boil the line instead of drawing it. */
  test("the same seed gives the same polyline", () => {
    const q = { size: 300, curl: 1.2, wobble: 0.4, width: 3, taper: 0.7 };
    expect(swirlPoints(7, q)).toEqual(swirlPoints(7, q));
    expect(swirlPoints(8, q)).not.toEqual(swirlPoints(7, q));
  });
});

/* ── swirls ─────────────────────────────────────────────────────────────── */

describe("a flourish is as long as it says it is", () => {
  const q = { size: 400, curl: 1.4, wobble: 0.5, width: 3, taper: 0.7 };
  const length = (pts: { x: number; y: number }[]) => {
    let d = 0;
    for (let i = 1; i < pts.length; i += 1) {
      d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    return d;
  };

  /* The pen moves at a constant speed and only its heading turns, which is what
     makes `size` mean something. A spiral drawn by radius shrinks as it curls,
     so the parameter would mean one thing at curl 0 and another at curl 3. */
  test("curling it up does not shorten it", () => {
    for (const curl of [0, 0.5, 1.5, 3]) {
      const len = length(swirlPoints(11, { ...q, curl }));
      expect(len).toBeGreaterThan(q.size * 0.7);
      expect(len).toBeLessThan(q.size * 1.15);
    }
  });

  test("no curl and a steady hand draws a straight line", () => {
    const pts = swirlPoints(3, { ...q, curl: 0, wobble: 0 });
    const [a, b] = pts;
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    for (const pt of pts) {
      /* Cross product against the first segment — zero everywhere or it bends. */
      expect(Math.abs((pt.x - a.x) * uy - (pt.y - a.y) * ux)).toBeLessThan(1e-6);
    }
  });

  test("the nib lifts at both ends and never reaches zero width", () => {
    const pts = swirlPoints(5, q);
    const mid = pts[Math.floor(pts.length / 2)];
    expect(pts[0].w).toBeLessThan(mid.w);
    expect(pts[pts.length - 1].w).toBeLessThan(mid.w);
    for (const pt of pts) expect(pt.w).toBeGreaterThan(0);
  });

  test("no taper is an even line", () => {
    const pts = swirlPoints(5, { ...q, taper: 0 });
    for (const pt of pts) expect(pt.w).toBeCloseTo(q.width, 6);
  });
});

describe("a stroke is drawn, held, and then let go", () => {
  const env = (age: number) => strokeEnvelope(age, 2, 1, 4);

  test("it arrives by being drawn rather than by appearing", () => {
    expect(env(0).drawn).toBe(0);
    expect(env(1).drawn).toBeCloseTo(0.5, 6);
    expect(env(2).drawn).toBe(1);
    expect(env(9).drawn).toBe(1);
  });

  test("it is at full strength until it has been held its time", () => {
    expect(env(0).alpha).toBe(1);
    expect(env(2.9).alpha).toBe(1);
    expect(env(3.5).alpha).toBeLessThan(1);
  });

  test("it is gone when the fade is over, and not before", () => {
    expect(env(6.9).done).toBe(false);
    expect(env(7).done).toBe(true);
    expect(env(7).alpha).toBe(0);
  });

  /* Eased, not linear: a straight alpha ramp reads as a light switch at the end
     rather than as ink losing itself in the wall. */
  test("the fade eases rather than stepping off a cliff", () => {
    const half = env(5).alpha;
    expect(half).toBeGreaterThan(0.4);
    expect(half).toBeLessThan(0.6);
    expect(env(3.2).alpha).toBeGreaterThan(0.9);
    expect(env(6.8).alpha).toBeLessThan(0.1);
  });

  test("zero for a duration is survivable, not a division", () => {
    for (const e of [strokeEnvelope(1, 0, 0, 0), strokeEnvelope(0, 0, 0, 0)]) {
      expect(Number.isFinite(e.alpha)).toBe(true);
      expect(Number.isFinite(e.drawn)).toBe(true);
    }
  });
});

/* ── ripples ────────────────────────────────────────────────────────────── */

describe("rings open from a point and lose themselves", () => {
  const q = { rings: 3, speed: 80, max: 240 };

  test("the rings arrive one after another, not all at once", () => {
    expect(ripple(0.01, q).length).toBe(1);
    expect(ripple(1, q).length).toBe(3);
  });

  /* Spaced in distance rather than in time: opening a ripple faster should not
     also spread its rings apart. */
  test("the gap between rings is a distance, whatever the speed", () => {
    for (const speed of [40, 80, 300]) {
      /* Read at the moment the leading ring is 100px out, whatever that took. */
      const rings = ripple(100 / speed, { ...q, speed });
      expect(rings.length).toBe(3);
      expect(rings[0].radius - rings[1].radius).toBeCloseTo(26, 6);
      expect(rings[1].radius - rings[2].radius).toBeCloseTo(26, 6);
    }
  });

  test("a ring thins out towards the edge it never reaches", () => {
    const near = ripple(0.6, q)[0].alpha;
    const far = ripple(2.6, q)[0].alpha;
    expect(far).toBeLessThan(near);

    /* The leading ring reaches 240 at three seconds and is not drawn past it;
       the two behind it are still coming. */
    const late = ripple(240 / 80 + 0.01, q);
    expect(late.length).toBe(2);
    for (const r of late) expect(r.radius).toBeLessThan(240);
  });

  test("nothing is drawn at full strength the instant it is born", () => {
    expect(ripple(0.02, q)[0].alpha).toBeLessThan(0.2);
  });

  test("it is over once the last ring has reached its radius", () => {
    expect(rippleDone(1, q)).toBe(false);
    expect(rippleDone(20, q)).toBe(true);
  });

  test("out of round, but not oval", () => {
    const at = (angle: number) => rippleRadius(100, angle, 1, 0.7);
    /* An oval is two extremes per turn and reads as a mistake; this has more. */
    const rs = Array.from({ length: 64 }, (_, i) => at((i / 64) * Math.PI * 2));
    let turns = 0;
    for (let i = 1; i < rs.length - 1; i += 1) {
      if ((rs[i] - rs[i - 1]) * (rs[i + 1] - rs[i]) < 0) turns += 1;
    }
    expect(turns).toBeGreaterThan(3);
    expect(rippleRadius(100, 1.2, 0, 0.7)).toBe(100);
  });
});

/* ── leaves ─────────────────────────────────────────────────────────────── */

describe("a leaf is carried, and comes back when it leaves the room", () => {
  const q = { wind: 50, gust: 0, period: 10, fall: 12, sway: 0, spin: 30 };
  const one = (over: Partial<Leaf> = {}): Leaf => ({
    ...leaf(rng(4), 100, 100),
    ride: 1,
    phase: 0,
    ...over,
  });

  test("it goes where the wind and the fall take it", () => {
    const l = one({ x: 10, y: 10 });
    const next = leafStep(l, 1, q.wind, q);
    expect(next.x).toBeCloseTo(60, 6);
    expect(next.y).toBeCloseTo(22, 6);
  });

  test("a leaf catches its own share of the wind", () => {
    const light = leafStep(one({ x: 0, ride: 1.3 }), 1, 50, q).x;
    const heavy = leafStep(one({ x: 0, ride: 0.7 }), 1, 50, q).x;
    expect(light).toBeGreaterThan(heavy);
  });

  /* Sway as a velocity, not an offset on the position: adding a sine to x makes
     every leaf snap back when the wind turns, where a swaying drift wanders and
     keeps its place. */
  test("sway moves it and does not spring it back", () => {
    const swaying = { ...q, sway: 40 };
    let a = one({ x: 0, y: 0, phase: 0 });
    for (let i = 0; i < 40; i += 1) a = leafStep(a, 1 / 30, 0, swaying);
    expect(Math.abs(a.y)).toBeGreaterThan(1);
  });

  test("it tumbles more in a wind than in still air", () => {
    const still = leafStep(one({ a: 0, spin: 1 }), 1, 0, q).a;
    const blown = leafStep(one({ a: 0, spin: 1 }), 1, 120, q).a;
    expect(Math.abs(blown)).toBeGreaterThan(Math.abs(still));
  });

  test("blown out one side it comes back in the other", () => {
    const r = rng(9);
    const out = one({ x: 140, y: 40 });
    const back = wrapLeaf(out, 100, 100, 20, r);
    expect(back.x).toBe(-20);
    /* Re-rolled across the wind, or a steady draught turns the flock into one
       stripe crossing at a single height. */
    expect(back.y).not.toBe(40);

    const up = wrapLeaf(one({ x: 50, y: -40 }), 100, 100, 20, rng(2));
    expect(up.y).toBe(120);
  });

  test("a leaf still in the room is left exactly as it was", () => {
    const inside = one({ x: 50, y: 50 });
    expect(wrapLeaf(inside, 100, 100, 20, rng(1))).toBe(inside);
  });

  test("the population is the count, however long the wind blows", () => {
    /* Wrapping rather than respawning is what guarantees this — and it is the
       reason `count` can be a slider rather than a spawn rate. */
    const r = rng(3);
    let flock = Array.from({ length: 12 }, () => leaf(r, 200, 200));
    for (let i = 0; i < 500; i += 1) {
      flock = flock.map((l) =>
        wrapLeaf(leafStep(l, 1 / 30, windAt(i / 30, 120, 40, 6), q), 200, 200, 30, r),
      );
    }
    expect(flock.length).toBe(12);
    for (const l of flock) {
      expect(Number.isFinite(l.x)).toBe(true);
      expect(l.x).toBeGreaterThan(-40);
      expect(l.x).toBeLessThan(240);
    }
  });
});

/* ── footsteps ──────────────────────────────────────────────────────────── */

describe("somebody crosses the wall", () => {
  const q = { stride: 30, spread: 12, wander: 0 };
  const straight = () => 0.5; // no turn: (r() - 0.5) is zero

  test("a step is a stride along the path, wherever the print lands", () => {
    const a = stepOn({ x: 0, y: 0, heading: 0, foot: 0 }, q, straight);
    const b = stepOn(a.walk, q, straight);
    expect(Math.hypot(b.walk.x - a.walk.x, b.walk.y - a.walk.y)).toBeCloseTo(30, 6);
  });

  /* Two prints on the same side is somebody hopping. */
  test("the feet alternate, and land either side of the path", () => {
    let w = { x: 0, y: 0, heading: 0, foot: 0 as 0 | 1 };
    const prints = [];
    for (let i = 0; i < 4; i += 1) {
      const s = stepOn(w, q, straight);
      w = s.walk;
      prints.push(s.print);
    }
    expect(prints.map((p) => p.foot)).toEqual([0, 1, 0, 1]);
    /* Walking along +x, so the offset is in y, and it flips every step. */
    expect(prints[0].y).toBeCloseTo(-6, 6);
    expect(prints[1].y).toBeCloseTo(6, 6);
    expect(prints[2].y).toBeCloseTo(-6, 6);
  });

  test("the print is beside the path, not on it", () => {
    const s = stepOn({ x: 0, y: 0, heading: 0, foot: 0 }, q, straight);
    /* Perpendicular: the print keeps the walker's distance along the path. */
    expect(s.print.x).toBeCloseTo(s.walk.x, 6);
    expect(Math.abs(s.print.y - s.walk.y)).toBeCloseTo(6, 6);
    expect(s.print.a).toBeCloseTo(s.walk.heading, 6);
  });

  test("a steady walker holds their heading; a wandering one does not", () => {
    const r = rng(5);
    let steady = { x: 0, y: 0, heading: 0.4, foot: 0 as 0 | 1 };
    for (let i = 0; i < 20; i += 1) steady = stepOn(steady, q, r).walk;
    expect(steady.heading).toBeCloseTo(0.4, 6);

    let loose = { x: 0, y: 0, heading: 0.4, foot: 0 as 0 | 1 };
    for (let i = 0; i < 20; i += 1) {
      loose = stepOn(loose, { ...q, wander: 1 }, r).walk;
    }
    expect(Math.abs(loose.heading - 0.4)).toBeGreaterThan(0.1);
  });

  /* Beyond a quarter turn a step reads as somebody lost rather than strolling. */
  test("nobody turns more than a quarter circle in one step", () => {
    const r = rng(7);
    let w = { x: 0, y: 0, heading: 0, foot: 0 as 0 | 1 };
    for (let i = 0; i < 300; i += 1) {
      const next = stepOn(w, { ...q, wander: 1 }, r).walk;
      expect(Math.abs(next.heading - w.heading)).toBeLessThanOrEqual(Math.PI / 4 + 1e-9);
      w = next;
    }
  });

  /* A trail that starts mid-wall reads as prints appearing out of nowhere,
     which is a different and much worse effect than somebody walking through. */
  test("they come in from an edge, not out of the middle", () => {
    const r = rng(11);
    for (let i = 0; i < 40; i += 1) {
      const w = walkIn(r, 400, 300, 30);
      const onAnEdge =
        Math.abs(w.x + 30) < 1e-6 ||
        Math.abs(w.x - 430) < 1e-6 ||
        Math.abs(w.y + 30) < 1e-6 ||
        Math.abs(w.y - 330) < 1e-6;
      expect(onAnEdge).toBe(true);
    }
  });

  /* Inwards across the edge they arrived at — not towards the middle, which a
     walker entering near a corner at a slant is entitled not to do. */
  test("they walk inwards from wherever they came in", () => {
    const r = rng(13);
    for (let i = 0; i < 60; i += 1) {
      const w = walkIn(r, 400, 300, 30);
      const on = stepOn(w, { stride: 40, spread: 0, wander: 0 }, straight).walk;
      if (w.x === -30) expect(on.x).toBeGreaterThan(w.x);
      else if (w.x === 430) expect(on.x).toBeLessThan(w.x);
      else if (w.y === -30) expect(on.y).toBeGreaterThan(w.y);
      else expect(on.y).toBeLessThan(w.y);
    }
  });

  test("a walker who has left the room stops making prints", () => {
    const room = { w: 400, h: 300, m: 40 };
    const inside = { x: 10, y: 10, heading: 0, foot: 0 as const };
    expect(walkedOut(inside, room.w, room.h, room.m)).toBe(false);
    /* Still on: prints are made right up to the edge of the margin, or a trail
       stops short of the side it was clearly heading for. */
    expect(walkedOut({ ...inside, x: -39 }, room.w, room.h, room.m)).toBe(false);
    expect(walkedOut({ ...inside, x: -41 }, room.w, room.h, room.m)).toBe(true);
    expect(walkedOut({ ...inside, y: 341 }, room.w, room.h, room.m)).toBe(true);
  });

  /* The names are the cards on the wall. An empty wall gets unnamed prints
     rather than invented ones — flavour text on a working surface is worse than
     no text at all. */
  test("a trail is named after something actually on the wall, or not at all", () => {
    expect(pickName(rng(2), [])).toBeNull();
    expect(pickName(rng(2), ["skein"])).toBe("skein");
    const names = ["skein", "caravan", "nova"];
    for (let i = 0; i < 50; i += 1) {
      expect(names).toContain(pickName(rng(i), names)!);
    }
  });

  /* A print presses in rather than being drawn, so it reuses the stroke
     envelope with a very short draw — one envelope, two uses. */
  test("a print presses in, sits, and fades like everything else", () => {
    const e = (age: number) => strokeEnvelope(age, 0.12, 2, 6);
    expect(e(0).drawn).toBe(0);
    expect(e(0.12).drawn).toBe(1);
    expect(e(2).alpha).toBe(1);
    expect(e(8.2).done).toBe(true);
  });
});

/* ── colour ─────────────────────────────────────────────────────────────── */

describe("ink is a lightness between two of the theme's own tones", () => {
  test("the endpoints are read as written in tokens.css", () => {
    expect(hexRgb("#ede4d8")).toEqual([237, 228, 216]);
    expect(hexRgb("ede4d8")).toEqual([237, 228, 216]);
    expect(hexRgb("#fff")).toEqual([255, 255, 255]);
  });

  /* getComputedStyle can hand back anything, including "" for a token that has
     been renamed. A missing colour must not become NaN in a fillStyle. */
  test("something that is not a colour falls back rather than poisoning a frame", () => {
    expect(hexRgb("rgb(1,2,3)", [9, 9, 9])).toEqual([9, 9, 9]);
    expect(hexRgb("", [9, 9, 9])).toEqual([9, 9, 9]);
  });

  test("nothing is drawn outside the two tones it was given", () => {
    const dark = hexRgb("#151210");
    const paper = hexRgb("#ede4d8");
    expect(mix(dark, paper, 0)).toEqual(dark);
    expect(mix(dark, paper, 1)).toEqual(paper);
    expect(mix(dark, paper, -3)).toEqual(dark);
    expect(mix(dark, paper, 9)).toEqual(paper);
    const half = mix(dark, paper, 0.5);
    expect(half[0]).toBeGreaterThan(dark[0]);
    expect(half[0]).toBeLessThan(paper[0]);
  });

  test("an alpha out of range is clamped, not printed", () => {
    expect(rgba([1, 2, 3], 0.5)).toBe("rgba(1, 2, 3, 0.500)");
    expect(rgba([1, 2, 3], 4)).toBe("rgba(1, 2, 3, 1.000)");
    expect(rgba([1, 2, 3], -1)).toBe("rgba(1, 2, 3, 0.000)");
  });
});
