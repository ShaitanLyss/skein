/* Instruments you hang on the wall.
 *
 * A widget is furniture in the room rather than part of the work: it belongs to
 * no project, never enters the auto-layout, and is always placed by hand — the
 * same bargain a reference image has, and for the same reason. What makes it a
 * different thing is that Skein *draws* it: a clock is not a picture of a clock,
 * and the performance meter is reading this machine as you watch.
 *
 * Pure — no runes, no DOM — so the catalogue, the defaults and the validation
 * can be tested directly. `widgets.svelte.ts` owns the wall's copies and
 * `WidgetNode.svelte` draws them.
 *
 * The catalogue is the whole vocabulary. A new knob is one line here, a new
 * variant is one entry in a `choice`, and a new kind of widget is one spec plus
 * one arm in `WidgetNode`'s switch — nothing in Rust ever hears about it, which
 * is what the opaque `config_json` column buys (see `store.rs::migrate_v5`). */

import {
  DEFAULT_LENGTH,
  LENGTHS,
  lengthOf,
  type Duo,
  type Run,
} from "./timing";
import { spotOf } from "./glass";

export type WidgetKind =
  | "clock"
  | "performance"
  | "timer"
  | "pomodoro"
  | "usage"
  | "pipelines"
  | "reviews"
  | "billboard";

export type Choice = { value: string; label: string };

/** A knob that only means something when another one is set a certain way.
 *
 * A stopwatch has no length to count down from, and a menu offering one would be
 * a knob that does nothing — which is worse than a missing knob, because it
 * reads as broken rather than as absent. Declarative rather than a predicate so
 * the catalogue stays data: `only` is checked against the config, never called.
 * The value is still *stored* while hidden, so flipping a timer to counting down
 * and back does not lose the length you had chosen. */
export type Guard = { key: string; is: string[] };

/** What one knob is. Deliberately three shapes rather than a number and a
 *  convention: a variant is a name, not a slider position, and reading `2` back
 *  as "artistic" would be a wall that changed meaning when the list was
 *  reordered. */
export type WidgetParam =
  | {
      key: string;
      kind: "choice";
      label: string;
      options: Choice[];
      def: string;
      only?: Guard;
    }
  | { key: string; kind: "toggle"; label: string; def: boolean; only?: Guard }
  | {
      key: string;
      kind: "number";
      label: string;
      min: number;
      max: number;
      step: number;
      def: number;
      only?: Guard;
    };

/** A key a widget writes as it runs, rather than one anybody turns.
 *
 * A timer's state is two numbers — the epoch its run began and the seconds it
 * has banked — and they belong in the config for the reason everything else
 * does: `config_json` is one opaque column, so persisting a running timer costs
 * no migration and no new command. What they must *not* do is turn up in the
 * right-click menu, or be clamped to a spec's range on the way back in. Hence a
 * second list: `params` is the vocabulary of the menu, `state` is the vocabulary
 * of the instrument. */
export type WidgetState = { key: string; def: number };

export type WidgetSpec = {
  kind: WidgetKind;
  label: string;
  /** One sentence, lowercase, for the menu that offers it. */
  note: string;
  /** How big it arrives, in canvas units. */
  box: { w: number; h: number };
  /** How small it may be dragged before it stops saying anything. */
  min: { w: number; h: number };
  params: WidgetParam[];
  state?: WidgetState[];
};

export type WidgetConfig = Record<string, string | number | boolean>;

export type Widget = {
  id: string;
  kind: WidgetKind;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  /** Where it is drawn if it has been stuck to the glass, in screen pixels, or
   *  null for one standing on the wall. Never a substitute for `x`/`y` — see
   *  the note at the top of `glass.ts`. */
  glassX: number | null;
  glassY: number | null;
  config: WidgetConfig;
};

const choice = (
  key: string,
  label: string,
  options: Choice[],
  def: string,
  only?: Guard,
): WidgetParam => ({ key, kind: "choice", label, options, def, ...(only ? { only } : {}) });

const toggle = (key: string, label: string, def: boolean): WidgetParam => ({
  key,
  kind: "toggle",
  label,
  def,
});

/** The two numbers every running instrument keeps. Shared, so a timer and a
 *  duo's first lane are the same pair of keys and `runIn` reads either. */
const RUN: WidgetState[] = [
  { key: "since", def: 0 },
  { key: "banked", def: 0 },
];

/* A `number` param is part of the vocabulary — `normalizeParam` clamps one to
   its own range — but nothing in the catalogue uses one yet: the two knobs that
   wanted to be numbers were both better answered by the size of the box. */

/** The variant is the first parameter of every widget by convention: it is the
 *  one knob that changes what you are looking at rather than how much of it. */
export const VARIANT = "variant";

/** How much of a frame a widget wears. */
export const FRAME = "frame";

/** The knobs every widget has, whatever it draws.
 *
 * Kept out of the specs and appended by `paramsOf`, so a new kind of instrument
 * gets them by existing rather than by remembering — the same argument
 * `widgetOffers` makes for the menu that hangs one up. Five copies of the same
 * three lines is five places for the wording to drift.
 *
 * The frame is a `choice` rather than two toggles because the fourth state the
 * pair would allow is the one nobody wants: an outline with nothing behind it is
 * a hole cut in the wall, not an instrument. So the three values are an ordered
 * retreat — outline and fill, fill alone, then neither — and each step takes one
 * layer off.
 *
 * `bare` is the deliberate exception to "nothing on the wall may be
 * transparent" (see the ambience note in CLAUDE.md). That rule exists because a
 * leaf drifting through a dormant card reads as broken; a clock you have
 * *asked* to sit in the weather is the opposite — it is the reading you chose,
 * and the wall behind it is what makes it furniture rather than a panel. The
 * default is unchanged, so nothing already on a wall moves. */
export const COMMON: WidgetParam[] = [
  choice(
    FRAME,
    "frame",
    [
      { value: "framed", label: "an outline and a fill" },
      { value: "plate", label: "a fill, no outline" },
      { value: "bare", label: "neither — the wall shows through" },
    ],
    "framed",
  ),
];

export const WIDGETS: WidgetSpec[] = [
  {
    kind: "clock",
    label: "clock",
    note: "the time, in whichever hand suits the wall",
    box: { w: 190, h: 190 },
    min: { w: 76, h: 56 },
    params: [
      choice(
        VARIANT,
        "face",
        [
          { value: "analog", label: "analog" },
          { value: "digital", label: "digital" },
          { value: "words", label: "words" },
          { value: "artistic", label: "artistic" },
          { value: "abstract", label: "abstract" },
        ],
        "analog",
      ),
      toggle("seconds", "seconds", true),
      /* 24-hour by default: this is a studio wall next to a terminal, and every
         timestamp anywhere near it is already 24-hour. */
      toggle("h24", "24-hour", true),
      toggle("date", "the date", false),
    ],
  },
  {
    kind: "performance",
    label: "performance",
    note: "what this studio's own processes are costing",
    box: { w: 300, h: 210 },
    min: { w: 176, h: 96 },
    params: [
      choice(
        VARIANT,
        "reading",
        [
          { value: "list", label: "list" },
          { value: "bars", label: "bars" },
          { value: "gauges", label: "gauges" },
        ],
        "list",
      ),
      /* Skein's own tree first, because that is the question this wall raises —
         "what is all of this costing me" — and the machine's full process list
         is a click away for when it isn't. */
      choice(
        "scope",
        "scope",
        [
          { value: "skein", label: "this studio" },
          { value: "machine", label: "the whole machine" },
        ],
        "skein",
      ),
    ],
  },
  {
    /* Counting up, counting down, or two lanes of which one runs. Those are the
       variant rather than the face, because they are what you are looking at:
       a stopwatch and a countdown answer different questions with the same
       digits, and the reference implementation kept them as separate pages for
       exactly that reason. How it is *drawn* is the knob below. */
    kind: "timer",
    label: "timer",
    note: "how long this has taken, or how long is left",
    box: { w: 220, h: 132 },
    min: { w: 118, h: 66 },
    params: [
      choice(
        VARIANT,
        "counting",
        [
          { value: "up", label: "up, from zero" },
          { value: "down", label: "down, to zero" },
          { value: "duo", label: "two lanes, one at a time" },
        ],
        "up",
      ),
      choice(
        "face",
        "drawn as",
        [
          { value: "digits", label: "digits" },
          { value: "ring", label: "a ring" },
          { value: "bar", label: "a bar" },
        ],
        "digits",
      ),
      /* Only a countdown has a length. Stored while hidden, so flipping to
         counting up and back does not lose what you had chosen. */
      choice("length", "how long", LENGTHS.map(({ value, label }) => ({ value, label })), DEFAULT_LENGTH, {
        key: VARIANT,
        is: ["down"],
      }),
    ],
    /* A duo's second lane. The first is `since`/`banked`, so an `up` timer
       switched to `duo` carries its time into the `on` lane rather than
       starting again — which is what anybody switching would expect. */
    state: [...RUN, { key: "sinceOff", def: 0 }, { key: "bankedOff", def: 0 }],
  },
  {
    /* A view, not the thing itself. The cycle is one per studio and lives in
       `pomodoro.svelte.ts` — two of these on the wall are two readings of one
       afternoon, and a second widget holding its own phase would be two clocks
       telling different times. So the config here is the face and nothing
       else, and the cadence is reached through the same menu but written
       through to the shared cycle. */
    kind: "pomodoro",
    label: "pomodoro",
    note: "focus and breaks, with the breaks actually taken",
    box: { w: 216, h: 206 },
    min: { w: 128, h: 92 },
    params: [
      choice(
        VARIANT,
        "reading",
        [
          { value: "ring", label: "a ring" },
          { value: "beads", label: "the cycle" },
          { value: "digits", label: "digits" },
        ],
        "ring",
      ),
    ],
  },
  {
    /* The other meter, and the one that reads a clock rather than a machine:
       what Claude Code has spent against the two windows its limits run on.
       Deliberately not scoped to this studio — the limits are per account and
       count every turn taken on this machine, terminal ones included, so a
       reading of Skein's own cards would answer a different question with the
       same numerals. See `usage.ts`. */
    kind: "usage",
    label: "usage",
    note: "how much of the allowance is gone, and when it comes back",
    box: { w: 264, h: 152 },
    min: { w: 142, h: 76 },
    params: [
      choice(
        VARIANT,
        "reading",
        [
          { value: "bars", label: "bars" },
          { value: "rings", label: "rings" },
          { value: "digits", label: "digits" },
        ],
        "bars",
      ),
      /* The allowance is the default, and it is a different *fact* from the
         two below it rather than a third way of counting the same one: a
         percentage of the account's own limit, off `/api/oauth/usage`, with a
         reset the server names. It leads because it is the question anybody
         actually has — how much of the five hours is gone, and when does it
         come back — and because it is the only one of the three with a real
         denominator.

         Cost stays, and stays ahead of tokens, because it is the only reading
         that weights the five kinds of token against each other: a cache read
         is a tenth of an input token and an output token is five times one, so
         a raw total is very nearly a count of cache reads and says almost
         nothing about how hard the wall has been worked. It is also the only
         reading available at all on an account with no OAuth sign-in — see
         `limits.ts`. */
      choice(
        "measure",
        "counted in",
        [
          { value: "allowance", label: "what is left of the allowance" },
          { value: "cost", label: "what it would cost" },
          { value: "tokens", label: "tokens" },
        ],
        "allowance",
      ),
    ],
  },
  {
    /* The two Azure DevOps instruments, and they are two rather than one with a
       variant switching between them — which is the question this feature was
       asked as. A variant on this wall means a different *reading of the same
       fact*: a clock's five faces are all the time, a timer's three are all the
       run. Pipelines and pull requests are different facts, off different
       endpoints, on different clocks, and answering different questions ("is it
       green" and "who is waiting on whom"). Decisively, they are wanted on the
       wall *at the same time*, and a variant is exclusive — picking one would
       mean losing the other. What they genuinely share is the connection, and
       that is shared, in `devops.svelte.ts`.

       Wider than they are tall, both, and the widest things in the catalogue: a
       row here is a project, a pipeline and a branch, and none of the three can
       be dropped without the row ceasing to say where it is from. */
    kind: "pipelines",
    label: "pipelines",
    note: "what is building, across every project at once",
    box: { w: 340, h: 210 },
    min: { w: 190, h: 84 },
    params: [
      choice(
        VARIANT,
        "reading",
        [
          { value: "list", label: "list" },
          { value: "lanes", label: "lanes, by project" },
          { value: "dots", label: "dots" },
        ],
        "list",
      ),
      /* `live` first, because it is the view Azure DevOps itself will not give
         you without picking a project — the whole reason this is worth drawing
         on a wall rather than opening in a tab. It keeps runs that have just
         finished, or the row you most want would vanish as it landed; see
         `SETTLING_MS`. */
      choice(
        "scope",
        "showing",
        [
          { value: "live", label: "what is running, and what just finished" },
          { value: "mine", label: "the ones I started" },
          { value: "all", label: "everything recent" },
        ],
        "live",
      ),
    ],
  },
  {
    kind: "reviews",
    label: "reviews",
    note: "open pull requests, and which of them want you",
    box: { w: 340, h: 210 },
    min: { w: 190, h: 84 },
    params: [
      choice(
        VARIANT,
        "reading",
        [
          { value: "list", label: "list" },
          { value: "lanes", label: "lanes, by repository" },
          { value: "dots", label: "dots" },
        ],
        "list",
      ),
      /* `mine` rather than `waiting`, deliberately. A widget that only ever
         showed what is blocked on you would be empty most of the day and
         therefore ignored — and the pull requests you opened and are waiting on
         somebody else for are the other half of the same question. */
      choice(
        "scope",
        "showing",
        [
          { value: "mine", label: "mine, and the ones I was asked about" },
          { value: "waiting", label: "only what is waiting on me" },
          { value: "all", label: "every open pull request" },
        ],
        "mine",
      ),
    ],
  },
  {
    kind: "billboard",
    label: "billboard",
    note: "what the agents have said they are working on",
    box: { w: 320, h: 220 },
    min: { w: 200, h: 96 },
    params: [
      /* Two readings of the same board, and the difference is whether you have
         to ask. A list is for a board you glance at — it fits eight notices in
         the height four notes take — and the notes are for one hung where you
         are actually working, where the point is to have read them without
         clicking anything. */
      choice(
        VARIANT,
        "reading",
        [
          { value: "list", label: "list" },
          { value: "notes", label: "notes, opened out" },
        ],
        "list",
      ),
      /* And this one is about *hiding* rather than reading. There is no `scope`
         here on purpose: a widget belongs to no project (see the note at the
         top of this file), so "this project" has no referent to resolve
         against — and the split that matters is the agents', who must not be
         shown another project's work. You want the wall. */
      choice(
        "showing",
        "showing",
        [
          { value: "all", label: "everything up" },
          { value: "current", label: "only what is still fresh" },
        ],
        "all",
      ),
    ],
  },
];

/* How many lines a meter of this height has room for.
 *
 * Not a parameter, on purpose: the box you drag it to is the answer, and a
 * number in a menu that disagreed with the height would be a widget arguing
 * with itself. Measured against the same constants the face is styled with —
 * change `.rows`'s font size and this comes with it.
 *
 * Shared by the process meter, the pipelines face and the reviews face, which
 * is why it is not named for any of them: all three are a header over a list of
 * one-line rows at the same size, and three copies of this arithmetic would be
 * three places for a row height to drift from the CSS it describes. */
const PERF_HEAD = 26;
const PERF_ROW = 18;

export function rowsFor(h: number): number {
  return Math.max(1, Math.floor((h - PERF_HEAD - 8) / PERF_ROW));
}

export function specFor(kind: string): WidgetSpec | null {
  return WIDGETS.find((w) => w.kind === kind) ?? null;
}

/** Every knob this widget has — its own, then the ones everything has.
 *
 * The one place `COMMON` is joined on, and therefore the definition of "a
 * widget's vocabulary": the menu, the defaults and the read back off disk all
 * ask this rather than reading `spec.params`, or a shared knob would be offered
 * without being persisted (or persisted without being reachable). Common last,
 * which is also what keeps the variant first — a convention `variantOf` and the
 * menu both lean on. */
export function paramsOf(spec: WidgetSpec): WidgetParam[] {
  return [...spec.params, ...COMMON];
}

/** The variants a kind offers, for the menu that switches between them. */
export function variantsOf(kind: string): Choice[] {
  const p = specFor(kind)?.params.find((p) => p.key === VARIANT);
  return p?.kind === "choice" ? p.options : [];
}

/** Everything a widget can be told that is not its variant, as marked options.
 *
 * Built off the catalogue so a knob added there is reachable by hand the same
 * day — a parameter with no way to reach it is a parameter that does not exist.
 * A toggle is one item that flips; a choice is one item per value, of which one
 * is marked. Numbers are deliberately absent: a menu is a poor slider, and the
 * one number a widget has (how many rows a meter shows) is answered better by
 * the box you drag it to. */
export function optionsOf(w: Widget): { id: string; label: string; on: boolean }[] {
  const spec = specFor(w.kind);
  if (!spec) return [];
  const out: { id: string; label: string; on: boolean }[] = [];
  for (const p of paramsOf(spec)) {
    if (p.key === VARIANT) continue;
    if (!allows(w, p)) continue;
    if (p.kind === "toggle") {
      out.push({ id: `cfg:${p.key}`, label: p.label, on: onOf(w, p.key, p.def) });
    } else if (p.kind === "choice") {
      const now = textOf(w, p.key, p.def);
      for (const o of p.options) {
        out.push({ id: `cfg:${p.key}:${o.value}`, label: o.label, on: o.value === now });
      }
    }
  }
  return out;
}

/** Does this widget's current config let that knob mean anything? A guard that
 *  names a key nothing sets is treated as satisfied — a knob is better shown
 *  than silently lost when a spec is edited. */
export function allows(w: Widget, p: WidgetParam): boolean {
  if (!p.only) return true;
  const now = w.config[p.only.key];
  if (typeof now !== "string") return true;
  return p.only.is.includes(now);
}

/** What a menu id asks for. `cfg:<key>` flips a toggle; `cfg:<key>:<value>`
 *  sets a choice. Parsed here so the component turning ids into calls stays a
 *  component. */
export function optionFor(
  w: Widget,
  id: string,
): { key: string; value: string | boolean } | null {
  if (!id.startsWith("cfg:")) return null;
  const [key, ...rest] = id.slice(4).split(":");
  if (!key) return null;
  if (rest.length) return { key, value: rest.join(":") };
  return { key, value: !onOf(w, key) };
}

export function uid(): string {
  return crypto.randomUUID();
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function defaultConfig(kind: string): WidgetConfig {
  const spec = specFor(kind);
  if (!spec) return {};
  const out: WidgetConfig = {};
  for (const p of paramsOf(spec)) out[p.key] = p.def;
  for (const s of spec.state ?? []) out[s.key] = s.def;
  return out;
}

/** One knob, coerced onto its spec. Anything unreadable becomes the default —
 *  a widget with a NaN in it is a hole in the wall, and there is nothing here
 *  worth failing over. */
function normalizeParam(p: WidgetParam, raw: unknown): string | number | boolean {
  if (p.kind === "choice") {
    return typeof raw === "string" && p.options.some((o) => o.value === raw)
      ? raw
      : p.def;
  }
  if (p.kind === "toggle") return typeof raw === "boolean" ? raw : p.def;
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : p.def;
  return clamp(Math.round(n / p.step) * p.step, p.min, p.max);
}

/** A widget as it came off disk, made drawable.
 *
 * Every read goes through here, which is the other half of the opaque column:
 * a knob that was renamed, a variant that was deleted, or a whole config that
 * would not parse degrades to something that draws rather than to a NaN inside
 * a frame loop. Returns null only for a kind nothing knows how to draw — that
 * is a widget from a newer build, and pretending it is a clock would be worse
 * than leaving it off the wall. */
export function normalizeWidget(raw: unknown): Widget | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const spec = typeof r.kind === "string" ? specFor(r.kind) : null;
  if (!spec) return null;

  const num = (v: unknown, def: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : def;
  const cfg = (r.config ?? {}) as Record<string, unknown>;
  const spot = spotOf(r as { glassX?: number | null; glassY?: number | null });

  const config: WidgetConfig = {};
  for (const p of paramsOf(spec)) config[p.key] = normalizeParam(p, cfg[p.key]);
  /* State is checked for being a finite number and otherwise left exactly as it
     was written. Emphatically not clamped the way a `number` knob is: an epoch
     has no range a catalogue could know, and rounding one to a step would move
     a timer's start by up to half a step every time it was read back. */
  for (const s of spec.state ?? []) {
    const raw = cfg[s.key];
    config[s.key] =
      typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, raw) : s.def;
  }

  return {
    id: typeof r.id === "string" && r.id ? r.id : uid(),
    kind: spec.kind,
    x: num(r.x, 0),
    y: num(r.y, 0),
    w: Math.max(spec.min.w, num(r.w, spec.box.w)),
    h: Math.max(spec.min.h, num(r.h, spec.box.h)),
    z: Math.round(num(r.z, 0)),
    /* Both or neither — half a pair is a row an older build wrote, and reads as
       being on the wall. Deliberately not clamped to the window the way a
       `number` knob is clamped to its range: a widget stuck to the glass on a
       wide screen has to come back where it was left when the window is wide
       again, so the squeeze belongs where it is drawn (`glassAt`). */
    glassX: spot?.x ?? null,
    glassY: spot?.y ?? null,
    config,
  };
}

/** A fresh widget of a kind, centred on a point — you aimed at a spot on the
 *  wall, not at a corner. */
export function newWidget(kind: WidgetKind, atX: number, atY: number, z = 0): Widget {
  const spec = specFor(kind);
  const box = spec?.box ?? { w: 190, h: 190 };
  return {
    id: uid(),
    kind,
    x: atX - box.w / 2,
    y: atY - box.h / 2,
    w: box.w,
    h: box.h,
    z,
    /* On the wall, like everything else that arrives — the glass is somewhere
       you put a thing on purpose, never somewhere a thing lands. */
    glassX: null,
    glassY: null,
    config: defaultConfig(kind),
  };
}

/* ── reading a config ──────────────────────────────────────────────────────
 *
 * A config is `Record<string, string | number | boolean>` because that is what
 * survives a JSON column honestly. These three keep the assertion in one place
 * instead of at every use. */

export function variantOf(w: Widget): string {
  const v = w.config[VARIANT];
  return typeof v === "string" ? v : (specFor(w.kind)?.params[0] as { def: string })?.def ?? "";
}

export function textOf(w: Widget, key: string, fallback = ""): string {
  const v = w.config[key];
  return typeof v === "string" ? v : fallback;
}

export function onOf(w: Widget, key: string, fallback = false): boolean {
  const v = w.config[key];
  return typeof v === "boolean" ? v : fallback;
}

export function numOf(w: Widget, key: string, fallback = 0): number {
  const v = w.config[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** How much of a frame this widget wears, as one word.
 *
 * It goes onto the node as `data-frame` and the whole of the styling hangs off
 * that attribute — one enum in the DOM rather than a pair of booleans, so the
 * state the pair would allow and nobody wants (an outline with the wall showing
 * through it) cannot be written. It is also then readable from a wall test,
 * which is the only way to see from outside that the knob reached a rule. */
export function frameOf(w: Widget): string {
  return textOf(w, FRAME, "framed");
}

/* ── instruments that run ──────────────────────────────────────────────────
 *
 * The bridge between a widget's flat config and `timing.ts`'s shapes. It is
 * here rather than in `timing.ts` so that file can stay import-free and the
 * catalogue can be built off its tables; and it is a handful of named functions
 * rather than inline indexing so a key spelled wrong is one place to fix rather
 * than four. */

/** The primary run — an `up` timer, a `down` timer, or a duo's `on` lane. */
export function runIn(w: Widget): Run {
  return { since: numOf(w, "since"), banked: numOf(w, "banked") };
}

export function duoIn(w: Widget): Duo {
  return {
    on: runIn(w),
    off: { since: numOf(w, "sinceOff"), banked: numOf(w, "bankedOff") },
  };
}

export function runPatch(run: Run): WidgetConfig {
  return { since: run.since, banked: run.banked };
}

export function duoPatch(duo: Duo): WidgetConfig {
  return {
    since: duo.on.since,
    banked: duo.on.banked,
    sinceOff: duo.off.since,
    bankedOff: duo.off.banked,
  };
}

/** What this timer counts down from, or null when it counts up.
 *
 * Null rather than zero, and it matters: `standing` reads null as "cannot ring"
 * and zero as "rang the instant it was hung up". A duo has no limit either — two
 * lanes racing a deadline is a different instrument, and not one anybody asked
 * for. */
export function limitIn(w: Widget): number | null {
  if (w.kind !== "timer" || variantOf(w) !== "down") return null;
  return lengthOf(textOf(w, "length", DEFAULT_LENGTH));
}

/** Does this kind of widget carry a clock that has to be held at launch and
 *  banked on the beat? Asked of the spec rather than of a list of kinds, so a
 *  future instrument that runs gets both by declaring `since`. */
export function runs(kind: string): boolean {
  return (specFor(kind)?.state ?? []).some((s) => s.key === "since");
}
