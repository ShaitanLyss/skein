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

export type WidgetKind = "clock" | "performance";

export type Choice = { value: string; label: string };

/** What one knob is. Deliberately three shapes rather than a number and a
 *  convention: a variant is a name, not a slider position, and reading `2` back
 *  as "artistic" would be a wall that changed meaning when the list was
 *  reordered. */
export type WidgetParam =
  | { key: string; kind: "choice"; label: string; options: Choice[]; def: string }
  | { key: string; kind: "toggle"; label: string; def: boolean }
  | {
      key: string;
      kind: "number";
      label: string;
      min: number;
      max: number;
      step: number;
      def: number;
    };

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
  config: WidgetConfig;
};

const choice = (
  key: string,
  label: string,
  options: Choice[],
  def: string,
): WidgetParam => ({ key, kind: "choice", label, options, def });

const toggle = (key: string, label: string, def: boolean): WidgetParam => ({
  key,
  kind: "toggle",
  label,
  def,
});

/* A `number` param is part of the vocabulary — `normalizeParam` clamps one to
   its own range — but nothing in the catalogue uses one yet: the two knobs that
   wanted to be numbers were both better answered by the size of the box. */

/** The variant is the first parameter of every widget by convention: it is the
 *  one knob that changes what you are looking at rather than how much of it. */
export const VARIANT = "variant";

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
];

/* How many lines a meter of this height has room for.
 *
 * Not a parameter, on purpose: the box you drag it to is the answer, and a
 * number in a menu that disagreed with the height would be a widget arguing
 * with itself. Measured against the same constants the face is styled with —
 * change `.rows`'s font size and this comes with it. */
const PERF_HEAD = 26;
const PERF_ROW = 18;

export function rowsFor(h: number): number {
  return Math.max(1, Math.floor((h - PERF_HEAD - 8) / PERF_ROW));
}

export function specFor(kind: string): WidgetSpec | null {
  return WIDGETS.find((w) => w.kind === kind) ?? null;
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
  for (const p of spec.params) {
    if (p.key === VARIANT) continue;
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
  for (const p of spec.params) out[p.key] = p.def;
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

  const config: WidgetConfig = {};
  for (const p of spec.params) config[p.key] = normalizeParam(p, cfg[p.key]);

  return {
    id: typeof r.id === "string" && r.id ? r.id : uid(),
    kind: spec.kind,
    x: num(r.x, 0),
    y: num(r.y, 0),
    w: Math.max(spec.min.w, num(r.w, spec.box.w)),
    h: Math.max(spec.min.h, num(r.h, spec.box.h)),
    z: Math.round(num(r.z, 0)),
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
