/* What the wall does when nobody is asking it anything.
 *
 * The studio's ground was one flat colour with two fixed gradients on it — a
 * bloom from above and the spend horizon below. This is the third thing: a stack
 * of effects that *move*, layered in a profile you can build up, adjust while
 * you watch it, and keep.
 *
 * Everything here is pure. The renderer (`Ambience.svelte`) owns a canvas and a
 * frame loop and does nothing but call into this file: the geometry of a brush
 * flourish, the envelope that draws it and fades it out, how the wind varies,
 * where a leaf is a moment later, which rings of a ripple are alive. That split
 * is the same one `layout.ts` has, and for the same reason — this is the part
 * with rules worth asserting, and a canvas is the part you can only look at.
 *
 * Two constraints from the design shape all of it:
 *
 * 1. **Colour is status.** Nothing here may introduce a hue, so every effect
 *    draws in one thing mixed between two of the theme's own tones — the
 *    `ink` parameter is a *lightness*, from below the ground to bone. The
 *    endpoints are read off `tokens.css` at runtime and passed in, so the
 *    palette stays in one file.
 *
 * 2. **Position is memory, and the wall pans.** Ambience is deliberately drawn
 *    in *screen* space rather than canvas space. Panning the wall does not drag
 *    the weather along with it, which is right — this is the light in the room,
 *    not something pinned up — and it means an effect never has to answer where
 *    to spawn on a surface with no edges. */

export type EffectKind = "swirls" | "leaves" | "ripples" | "footsteps";

/** One knob, and everything the panel needs to draw it without knowing what
 *  effect it belongs to. `def` is also what a missing value normalizes to. */
export type ParamSpec = {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  def: number;
  /** Shown after the value. Empty for a plain 0–1 amount. */
  unit?: string;
  /** A switch rather than a slider. Still a number — everything persisted here
   *  is — but 0 or 1 and drawn as a checkbox, because a two-position slider is
   *  a worse control than a checkbox in every way. */
  toggle?: true;
};

export type EffectSpec = {
  kind: EffectKind;
  label: string;
  /** One quiet line, in the UI's voice, saying what it does. */
  note: string;
  params: ParamSpec[];
};

export type Layer = {
  id: string;
  kind: EffectKind;
  /** Off keeps the layer and its settings but draws nothing — the same bargain
   *  a dev-server group has, and much better than deleting it to look. */
  on: boolean;
  /** 0–1 over whatever the effect itself decided. */
  opacity: number;
  params: Record<string, number>;
};

export type Profile = { id: string; name: string; layers: Layer[] };

const p = (
  key: string,
  label: string,
  min: number,
  max: number,
  step: number,
  def: number,
  unit = "",
): ParamSpec => ({ key, label, min, max, step, def, unit });

/** The `ink` knob every effect carries: where between the ground and the paper
 *  this layer is drawn. Same key everywhere, so the panel reads consistently. */
const ink = (def: number) => p("ink", "ink", 0, 1, 0.01, def);

/* ── the catalogue ─────────────────────────────────────────────────────────
 *
 * Adding an effect means an entry here and an arm in the renderer's draw
 * switch. The panel needs nothing: it builds its controls off `params`, so a
 * new knob is one line and appears with a label and a range. */
export const EFFECTS: EffectSpec[] = [
  {
    kind: "swirls",
    label: "brush swirls",
    note: "curls drawn across the wall, held, then let go",
    params: [
      p("rate", "how often", 0, 40, 0.5, 7, "/min"),
      p("size", "length", 60, 900, 10, 320, "px"),
      p("curl", "curl", 0, 3, 0.05, 1.15, "turns"),
      p("wobble", "unsteadiness", 0, 1, 0.01, 0.35),
      p("width", "brush", 0.4, 14, 0.1, 3, "px"),
      p("taper", "taper", 0, 1, 0.01, 0.7),
      p("draw", "drawn over", 0.3, 8, 0.1, 2.4, "s"),
      p("hold", "held", 0, 20, 0.1, 1.4, "s"),
      p("fade", "fades over", 0.5, 30, 0.5, 7, "s"),
      ink(0.72),
    ],
  },
  {
    kind: "leaves",
    label: "drifting leaves",
    note: "drawn leaves carried on a wind that keeps changing its mind",
    params: [
      p("count", "how many", 0, 80, 1, 14),
      p("wind", "wind", -160, 160, 2, 46, "px/s"),
      p("gust", "gusts", 0, 140, 2, 34, "px/s"),
      p("period", "gusts every", 2, 60, 0.5, 11, "s"),
      p("fall", "fall", -60, 90, 1, 15, "px/s"),
      p("sway", "sway", 0, 60, 1, 20, "px/s"),
      p("spin", "tumble", 0, 180, 2, 28, "°/s"),
      p("size", "size", 4, 60, 0.5, 15, "px"),
      p("curl", "curl", 0, 1, 0.01, 0.5),
      ink(0.46),
    ],
  },
  {
    kind: "ripples",
    label: "water rings",
    note: "rings opening from a point and losing themselves",
    params: [
      p("rate", "how often", 0, 60, 0.5, 9, "/min"),
      p("rings", "rings", 1, 5, 1, 2),
      p("speed", "opens at", 10, 400, 5, 80, "px/s"),
      p("max", "reaches", 40, 900, 10, 260, "px"),
      p("width", "line", 0.3, 8, 0.1, 1.3, "px"),
      p("wobble", "out of round", 0, 1, 0.01, 0.25),
      ink(0.4),
    ],
  },
  {
    kind: "footsteps",
    label: "footprints",
    note: "somebody crosses the wall and the prints fade behind them",
    params: [
      p("rate", "sets off", 0, 30, 0.5, 5, "/min"),
      p("pace", "pace", 0.4, 8, 0.1, 2.2, "steps/s"),
      p("stride", "stride", 10, 90, 1, 34, "px"),
      p("spread", "feet apart", 4, 40, 0.5, 13, "px"),
      p("size", "print", 4, 40, 0.5, 13, "px"),
      p("wander", "wanders", 0, 1, 0.01, 0.35),
      p("hold", "held", 0, 30, 0.5, 2, "s"),
      p("fade", "fades over", 0.5, 40, 0.5, 9, "s"),
      { ...p("names", "name them", 0, 1, 1, 1), toggle: true },
      ink(0.55),
    ],
  },
];

export function specFor(kind: EffectKind): EffectSpec | null {
  return EFFECTS.find((e) => e.kind === kind) ?? null;
}

/* ── profiles ──────────────────────────────────────────────────────────────
 *
 * A profile is rows in SQLite, which means what comes back is whatever was
 * written by whichever version of this file wrote it. Every read goes through
 * `normalizeProfile`, so a knob that has been renamed, a range that has
 * tightened, or an effect that no longer exists degrades to something drawable
 * rather than to a NaN somewhere inside a frame loop. */

export function uid(): string {
  return crypto.randomUUID();
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Every knob of an effect at its default. */
export function defaultParams(kind: EffectKind): Record<string, number> {
  const spec = specFor(kind);
  if (!spec) return {};
  return Object.fromEntries(spec.params.map((q) => [q.key, q.def]));
}

export function defaultLayer(kind: EffectKind, id = uid()): Layer {
  return { id, kind, on: true, opacity: 1, params: defaultParams(kind) };
}

/** Coerce one persisted layer into something the renderer can trust.
 *
 *  Unknown kinds are dropped (null), unknown keys are dropped, missing keys
 *  take their default, and every value is clamped into the spec's range. */
export function normalizeLayer(raw: unknown): Layer | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const spec = specFor(r.kind as EffectKind);
  if (!spec) return null;
  const params: Record<string, number> = {};
  const given = (r.params ?? {}) as Record<string, unknown>;
  for (const q of spec.params) {
    const raw = given[q.key];
    /* `Number(null)` is 0 and `Number("")` is 0, and neither of those is a
       value anybody wrote — a null in that column means the knob was not there,
       so it takes its default rather than the bottom of its range. */
    const v = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
    params[q.key] = Number.isFinite(v) ? clamp(v, q.min, q.max) : q.def;
  }
  return {
    id: typeof r.id === "string" && r.id ? r.id : uid(),
    kind: spec.kind,
    /* Absent means on: a layer written before this field existed was drawing. */
    on: r.on === undefined ? true : !!r.on,
    opacity: Number.isFinite(Number(r.opacity)) ? clamp(Number(r.opacity), 0, 1) : 1,
    params,
  };
}

export function normalizeProfile(raw: unknown): Profile {
  const r = (raw ?? {}) as Record<string, unknown>;
  const layers = Array.isArray(r.layers) ? r.layers : [];
  return {
    id: typeof r.id === "string" && r.id ? r.id : uid(),
    name: typeof r.name === "string" && r.name.trim() ? r.name.trim() : "untitled",
    layers: layers.map(normalizeLayer).filter((l): l is Layer => l !== null),
  };
}

/** A layer with some of its parameters overridden, for the shipped profiles. */
function layer(kind: EffectKind, over: Record<string, number> = {}): Layer {
  const l = defaultLayer(kind);
  return { ...l, params: { ...l.params, ...over } };
}

/** What the wall offers before anybody has built anything.
 *
 *  Written to the database on first load rather than kept as a special case in
 *  the renderer: they are ordinary profiles from the moment they exist, so the
 *  first thing you do with one can be to change it. The first is the one that
 *  gets switched on — quiet enough to work in front of all day. */
export function shippedProfiles(): Profile[] {
  return [
    {
      id: uid(),
      name: "atelier",
      layers: [
        layer("swirls", { rate: 5, size: 340, curl: 1.2, ink: 0.66, fade: 9 }),
      ],
    },
    {
      id: uid(),
      name: "late october",
      layers: [
        layer("leaves", { count: 18, wind: 52, gust: 40, size: 15 }),
        layer("swirls", { rate: 2, size: 260, ink: 0.5, width: 2, fade: 12 }),
      ],
    },
    {
      id: uid(),
      name: "still water",
      layers: [
        layer("ripples", { rate: 12, rings: 3, max: 320, ink: 0.38 }),
        layer("swirls", { rate: 1.5, curl: 2, size: 420, ink: 0.45, width: 1.6 }),
      ],
    },
    {
      id: uid(),
      name: "marauder's map",
      layers: [
        layer("footsteps", { rate: 7, pace: 2, ink: 0.6 }),
        layer("swirls", { rate: 1, size: 500, curl: 0.6, ink: 0.34, width: 1.4, fade: 16 }),
      ],
    },
  ];
  /* No empty profile is shipped: "nothing at all" is reachable without one, by
     having no profile showing — which is a state the database keeps, since
     `activate_ambience(null)` is a row change like any other. A "bare wall"
     profile sitting beside the panel's own `bare` chip was two ways to say the
     same thing, one of which you could then accidentally stack a layer onto. */
}

/* ── colour ────────────────────────────────────────────────────────────────
 *
 * The two endpoints come from `tokens.css` — read off the document by the
 * renderer and handed in — so this file holds no palette of its own and the
 * single warm-ink theme stays defined in one place. */

export type Rgb = [number, number, number];

export function hexRgb(hex: string, fallback: Rgb = [0, 0, 0]): Rgb {
  const s = hex.trim().replace(/^#/, "");
  const full = s.length === 3 ? s.replace(/./g, (c) => c + c) : s;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return fallback;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const u = clamp(t, 0, 1);
  return [
    Math.round(a[0] + (b[0] - a[0]) * u),
    Math.round(a[1] + (b[1] - a[1]) * u),
    Math.round(a[2] + (b[2] - a[2]) * u),
  ];
}

export function rgba(c: Rgb, alpha: number): string {
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${clamp(alpha, 0, 1).toFixed(3)})`;
}

/* ── the shared machinery ──────────────────────────────────────────────── */

/** A small deterministic generator, so a stroke is a function of its seed.
 *
 *  Which matters for more than tests: a flourish is generated once and then
 *  redrawn on every frame of its life, and re-rolling it each time would boil
 *  the line rather than draw it. */
export function rng(seed: number): () => number {
  let a = (seed | 0) + 0x6d2b79f5;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How many of something to spawn this frame, and what to carry forward.
 *
 *  An accumulator rather than a per-frame coin toss: at 6/min you get one every
 *  ten seconds regardless of the frame rate, and a slider at zero spawns
 *  nothing at all rather than nothing *usually*. */
export function due(
  acc: number,
  perMinute: number,
  dt: number,
): { n: number; acc: number } {
  if (perMinute <= 0) return { n: 0, acc: 0 };
  const next = acc + (perMinute / 60) * dt;
  const n = Math.floor(next);
  return { n, acc: next - n };
}

/** The wind at a moment: a base with two slow, incommensurate swings on it.
 *
 *  One sine would be a metronome you notice within a minute. Two whose periods
 *  do not divide each other read as a wind that keeps changing its mind, which
 *  is the whole point of the parameter. Stays inside base ± gust. */
export function windAt(t: number, base: number, gust: number, period: number): number {
  const T = Math.max(0.5, period);
  const a = Math.sin((2 * Math.PI * t) / T);
  const b = Math.sin((2 * Math.PI * t) / (T * 0.37) + 1.7);
  return base + gust * (a * 0.62 + b * 0.38);
}

/* ── swirls ───────────────────────────────────────────────────────────────
 *
 * A flourish, not a spiral. The pen keeps moving at a steady speed while its
 * heading turns — accelerating, so the curl tightens as it goes, the way a hand
 * finishing a stroke does — with a slow waver on top. That gives a curve whose
 * arc length is the `size` you asked for, which is what makes the parameter
 * mean anything: a spiral drawn by radius would shrink as it curled. */

export type StrokePoint = { x: number; y: number; w: number };

export type SwirlParams = {
  size: number;
  curl: number;
  wobble: number;
  width: number;
  taper: number;
};

/** The whole flourish, in local coordinates around its own start.
 *
 *  Deterministic in `seed`, so this is called once per stroke and the polyline
 *  is what gets redrawn. `n` is segments; the default is enough that a 900px
 *  stroke has no visible corners. */
export function swirlPoints(
  seed: number,
  q: SwirlParams,
  n = 96,
): StrokePoint[] {
  const r = rng(seed);
  const heading0 = r() * Math.PI * 2;
  /* Curl either way, or every stroke on the wall leans the same direction. */
  const turn = q.curl * Math.PI * 2 * (r() < 0.5 ? -1 : 1);
  const waver = r() * Math.PI * 2;
  const waves = 2 + Math.floor(r() * 3);
  /* Not every flourish is the full length asked for. */
  const len = q.size * (0.72 + r() * 0.42);
  const step = len / n;

  const out: StrokePoint[] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i <= n; i += 1) {
    const u = i / n;
    const heading =
      heading0 +
      /* u^1.4: the turn arrives late, so the stroke opens and then curls. */
      turn * Math.pow(u, 1.4) +
      q.wobble * Math.sin(u * waves * Math.PI * 2 + waver) * 0.9;
    /* Pressure: nothing at the ends, full in the middle, scaled by taper. */
    const press = 1 - q.taper * (1 - Math.pow(Math.sin(Math.PI * u), 0.7));
    out.push({ x, y, w: Math.max(0.05, q.width * press) });
    x += Math.cos(heading) * step;
    y += Math.sin(heading) * step;
  }
  return out;
}

export type Envelope = { drawn: number; alpha: number; done: boolean };

/** Where a stroke is in its life: how much of it has been drawn, and how much
 *  of it is left to see.
 *
 *  Three phases, because "shows up drawn, then fades" is three things: the nib
 *  travelling, a moment where it simply is, and the wall taking it back. The
 *  fade is eased rather than linear — a linear alpha ramp reads as a light
 *  switch at the end. */
export function strokeEnvelope(
  age: number,
  draw: number,
  hold: number,
  fade: number,
): Envelope {
  const d = Math.max(0.01, draw);
  const f = Math.max(0.01, fade);
  const drawn = clamp(age / d, 0, 1);
  const into = age - d - Math.max(0, hold);
  if (into <= 0) return { drawn, alpha: 1, done: false };
  const u = clamp(into / f, 0, 1);
  /* Smoothstep out: sits, then goes. */
  return { drawn, alpha: 1 - u * u * (3 - 2 * u), done: u >= 1 };
}

/* ── ripples ─────────────────────────────────────────────────────────────── */

export type RippleParams = { rings: number; speed: number; max: number };
export type Ring = { radius: number; alpha: number };

/** Which rings of one ripple are alive, and how strongly.
 *
 *  Rings are spaced in *distance* rather than in time — a constant 26px apart —
 *  so speeding a ripple up opens it faster without also spreading the rings out,
 *  which is what a time-staggered version got wrong. Each ring behind the first
 *  is fainter; all of them thin out towards the radius they never quite reach. */
export function ripple(age: number, q: RippleParams): Ring[] {
  const speed = Math.max(1, q.speed);
  const max = Math.max(1, q.max);
  const gap = 26 / speed;
  const out: Ring[] = [];
  for (let i = 0; i < Math.max(1, Math.round(q.rings)); i += 1) {
    const t = age - i * gap;
    if (t <= 0) continue;
    const radius = t * speed;
    if (radius >= max) continue;
    const fall = 1 - radius / max;
    out.push({
      radius,
      /* A ring is not born at full strength — a hard edge appearing from
         nothing reads as a dot, not a ripple opening. */
      alpha: Math.min(1, t / 0.22) * fall * fall * (1 / (1 + i * 0.9)),
    });
  }
  return out;
}

/** Is this ripple over? Cheaper than asking for the rings and counting. */
export function rippleDone(age: number, q: RippleParams): boolean {
  const gap = 26 / Math.max(1, q.speed);
  const last = (Math.max(1, Math.round(q.rings)) - 1) * gap;
  return (age - last) * Math.max(1, q.speed) >= Math.max(1, q.max);
}

/** The radius of a ring at one angle, wobbled out of round.
 *
 *  Two harmonics, because one makes an oval and an oval reads as a mistake. */
export function rippleRadius(
  radius: number,
  angle: number,
  wobble: number,
  phase: number,
): number {
  const w = clamp(wobble, 0, 1);
  return (
    radius *
    (1 + w * 0.07 * Math.sin(3 * angle + phase) + w * 0.045 * Math.sin(5 * angle - phase * 1.7))
  );
}

/* ── leaves ──────────────────────────────────────────────────────────────── */

export type Leaf = {
  x: number;
  y: number;
  /** Which way it is facing, in radians. */
  a: number;
  /** Turns per second, signed. */
  spin: number;
  /** 0.6–1.4 — how much of the wind this one catches, so a flock of them
   *  doesn't move as a single sheet. */
  ride: number;
  /** Its own sway timing, for the same reason. */
  phase: number;
  swayRate: number;
  /** 0.7–1.3 on the layer's size, and how solidly it draws. */
  scale: number;
};

export type LeafParams = {
  wind: number;
  gust: number;
  period: number;
  fall: number;
  sway: number;
  spin: number;
};

/** One leaf, somewhere, facing somewhere. */
export function leaf(r: () => number, w: number, h: number): Leaf {
  return {
    x: r() * w,
    y: r() * h,
    a: r() * Math.PI * 2,
    spin: (r() - 0.5) * 2,
    ride: 0.6 + r() * 0.8,
    phase: r() * Math.PI * 2,
    swayRate: 0.5 + r() * 1.1,
    scale: 0.7 + r() * 0.6,
  };
}

/** Move a leaf on by `dt`, in the wind of the moment.
 *
 *  Returns a new leaf rather than mutating, so a step can be asserted. Sway is
 *  a velocity rather than an offset: adding a sine to the position makes every
 *  leaf snap back when the wind reverses, where a swaying *drift* keeps its
 *  place and just wanders. */
export function leafStep(l: Leaf, dt: number, wind: number, q: LeafParams): Leaf {
  const t = l.phase + l.swayRate * dt;
  const across = q.sway * Math.cos(l.phase);
  const along = q.sway * 0.45 * Math.sin(l.phase * 1.7);
  return {
    ...l,
    x: l.x + (wind * l.ride + along) * dt,
    y: l.y + (q.fall * l.ride + across) * dt,
    /* Tumbling depends on how hard the air is moving: a leaf in still air
       settles rather than pirouetting on the spot. */
    a: l.a + l.spin * ((q.spin * Math.PI) / 180) * (0.35 + Math.abs(wind) / 90) * dt,
    phase: t,
  };
}

/** Put a leaf that has left the room back into it, on the side it came from.
 *
 *  Wrapping rather than respawning keeps the population exactly what the count
 *  says, and re-rolling the cross-axis means a wind blowing steadily right does
 *  not turn into a single stripe of leaves crossing at one height. */
export function wrapLeaf(
  l: Leaf,
  w: number,
  h: number,
  m: number,
  r: () => number,
): Leaf {
  let { x, y } = l;
  if (x > w + m) {
    x = -m;
    y = r() * (h + 2 * m) - m;
  } else if (x < -m) {
    x = w + m;
    y = r() * (h + 2 * m) - m;
  }
  if (y > h + m) {
    y = -m;
    x = r() * (w + 2 * m) - m;
  } else if (y < -m) {
    y = h + m;
    x = r() * (w + 2 * m) - m;
  }
  return x === l.x && y === l.y ? l : { ...l, x, y };
}

/* ── footsteps ────────────────────────────────────────────────────────────
 *
 * Somebody walks across the wall and the prints fade behind them — the
 * Marauder's Map, on a studio wall. Nobody is drawn: a trail of prints with a
 * name floating over the leading pair says more about an unseen someone than any
 * figure would.
 *
 * The walk is a heading that drifts, one stride per step, with the print set
 * half a `spread` to the side of the path and the side alternating. That is the
 * whole of it — the effect is in the pacing and the fade, not in the geometry.
 *
 * The names are the cards on the wall, handed in by the renderer. Nothing is
 * invented: a name that means nothing would be flavour text on a working
 * surface, and an empty wall simply gets unnamed prints. */

export type Print = {
  x: number;
  y: number;
  /** Which way the toes point, in radians. */
  a: number;
  /** 0 left, 1 right — only so consecutive prints can differ. */
  foot: 0 | 1;
  /** Seconds since it was pressed, kept by the renderer. */
  age: number;
};

/** Where the walker is, rather than where the prints are. */
export type Walk = { x: number; y: number; heading: number; foot: 0 | 1 };

export type StepParams = { stride: number; spread: number; wander: number };

/** Take one step: the walker moves on, and a print is left beside the path.
 *
 *  The print is offset *perpendicular* to the heading, alternating sides, so a
 *  turn banks the track rather than crossing it. Consumes one number from `r`,
 *  which is what makes a walk reproducible from its seed. */
export function stepOn(
  w: Walk,
  q: StepParams,
  r: () => number,
): { walk: Walk; print: Omit<Print, "age"> } {
  /* Up to a quarter turn per step at wander 1 — beyond that a walk reads as
     somebody lost rather than somebody strolling. */
  const heading = w.heading + (r() - 0.5) * q.wander * (Math.PI / 2);
  const x = w.x + Math.cos(heading) * q.stride;
  const y = w.y + Math.sin(heading) * q.stride;
  const side = w.foot === 0 ? -1 : 1;
  const off = (q.spread / 2) * side;
  return {
    walk: { x, y, heading, foot: w.foot === 0 ? 1 : 0 },
    print: {
      /* Perpendicular to the heading: (-sin, cos). */
      x: x - Math.sin(heading) * off,
      y: y + Math.cos(heading) * off,
      a: heading,
      foot: w.foot,
    },
  };
}

/** Has the walker left the room? Prints already down go on fading where they
 *  are; this only decides when to stop making more. */
export function walkedOut(w: Walk, width: number, height: number, m: number): boolean {
  return w.x < -m || w.x > width + m || w.y < -m || w.y > height + m;
}

/** Somebody arrives at an edge, heading roughly inwards.
 *
 *  Off the edge rather than at a random point on the wall: a trail that begins
 *  mid-air reads as prints appearing from nowhere, which is a different and much
 *  worse effect than somebody walking through. */
export function walkIn(r: () => number, width: number, height: number, m: number): Walk {
  const edge = Math.floor(r() * 4);
  const along = r();
  /* Aimed across, with up to ±50° of slant, so paths are not all parallel. */
  const slant = (r() - 0.5) * (Math.PI * 5) / 9;
  if (edge === 0) return { x: -m, y: along * height, heading: slant, foot: 0 };
  if (edge === 1) return { x: width + m, y: along * height, heading: Math.PI + slant, foot: 0 };
  if (edge === 2) return { x: along * width, y: -m, heading: Math.PI / 2 + slant, foot: 0 };
  return { x: along * width, y: height + m, heading: -Math.PI / 2 + slant, foot: 0 };
}

/** Whose feet these are, or null when the wall has nobody on it.
 *
 *  The list is the cards; an empty one is not a failure, it is a wall with
 *  nothing open, and unnamed prints are the honest answer. */
export function pickName(r: () => number, names: string[]): string | null {
  if (!names.length) return null;
  return names[Math.min(names.length - 1, Math.floor(r() * names.length))];
}

/** Is anything in this profile actually drawing?
 *
 *  The frame loop stops when this is false. Nothing on this wall polls, and a
 *  requestAnimationFrame that clears a canvas sixty times a second to show an
 *  empty profile is a poll. */
export function living(profile: Profile | null): boolean {
  return !!profile?.layers.some((l) => l.on && l.opacity > 0);
}
