/* The wall's ink, as a set of overrides rather than as a second stylesheet.
 *
 * `tokens.css` stays the ground truth and is not touched by any of this: a
 * theme is a *diff* against it, applied to `document.documentElement` as CSS
 * custom properties and taken off again by removing them. That shape is chosen
 * for one property above all the others — **reverting has to be exact**. A
 * theme that swapped one stylesheet for another could only promise to look
 * like the original; one that removes the properties it set leaves the cascade
 * resolving against `tokens.css` and nothing else, which is the same thing the
 * app draws with no theme code in it at all. Hence `REST`, whose override map
 * is deliberately empty and whose whole job is to be a name for "as it always
 * was" — a default you can choose, rather than the absence of a choice.
 *
 * It is not a palette switcher and must not become one. Skein is a single warm
 * ink studio wall on purpose, and colour on it means status; a theme here
 * changes how the *reading* is set — its ink, its size, its air, its rag — and
 * every knob below exists because it was a hard-coded number somewhere that
 * turned out to be worth arguing about. `KNOBS` is closed and no `--st-*` is
 * in it, so a theme cannot say that a failed card is a different kind of
 * failed depending on how somebody likes to read.
 *
 * Pure, and tested in `test/theme.test.ts`. The applying half — the DOM write
 * and the storage — is `theme.svelte.ts`.
 */

/** Every property a theme is allowed to set.
 *
 *  A closed list, and `resolve` filters against it, for the reason the rest of
 *  the front end normalizes anything opaque it reads back: this is data that
 *  outlives the build that wrote it, and once custom themes exist it is data a
 *  person typed. A name from an older version, a knob since renamed, a
 *  typo — all of them arrive as a string that is nobody's property, and the
 *  answer is to drop it rather than to write it onto the root element where it
 *  will sit forever doing nothing and confusing the next person to read the
 *  computed style.
 *
 *  Each has a default in `tokens.css` that is exactly what the panel drew
 *  before any of this existed, so `REST` is a no-op by construction. */
export const KNOBS = [
  /* ink */
  "--tx-prose",
  "--tx-you",
  "--paper-note",
  /* type */
  "--tx-size",
  "--tx-leading",
  "--tx-code",
  /* air and rag */
  "--tx-round",
  "--tx-round-rule",
  "--tx-wrap",
  "--tx-head-wrap",
  "--tx-hyphens",
] as const;

export type Knob = (typeof KNOBS)[number];
export type Overrides = Partial<Record<Knob, string>>;

/** What each knob is called where somebody is turning it, and what it takes.
 *
 *  Here rather than in the editor component for the reason the rest of this
 *  file is here: it is a property of the catalogue, it is the thing that goes
 *  stale when a knob is added, and a test can hold it to that. `KNOB_GROUPS`
 *  below asserts every knob is spoken for, so adding one to `KNOBS` and
 *  forgetting to describe it is a red suite rather than a blank row.
 *
 *  `takes` is a placeholder and a hint, not a validator — `okValue` is the only
 *  gate, and it is deliberately about size and control characters rather than
 *  about CSS grammar. A knob given nonsense costs that one declaration, which
 *  is a cheaper failure than an editor that refuses a value the browser would
 *  have understood. */
export const KNOB_INFO: Record<Knob, { label: string; takes: string; note: string }> = {
  "--tx-prose": {
    label: "the agent's prose",
    takes: "var(--paper-dim)",
    note: "what an answer is set in — the long-form reading",
  },
  "--tx-you": {
    label: "your prompts",
    takes: "var(--paper)",
    note: "your half of the column, against its left rule",
  },
  "--paper-note": {
    label: "notes",
    takes: "var(--paper-faint)",
    note: "the seam, the meta line, the meta-bar, a fence's tag and copy",
  },
  "--tx-size": {
    label: "size",
    takes: "0.86rem",
    note: "what the wall is set in; ctrl+wheel is the other one",
  },
  "--tx-leading": {
    label: "leading",
    takes: "1.55",
    note: "light on dark blooms, so it wants a little more than paper does",
  },
  "--tx-code": {
    label: "fence size",
    takes: "0.78em",
    note: "relative to the line; 0.86em is level with inline code",
  },
  "--tx-round": {
    label: "air above a prompt",
    takes: "0rem",
    note: "what marks where one round ends and the next begins",
  },
  "--tx-round-rule": {
    label: "rule above a prompt",
    takes: "transparent",
    note: "the stronger version of the same; var(--edge) to turn it on",
  },
  "--tx-wrap": {
    label: "rag",
    takes: "wrap",
    note: "pretty to kill the one-word last lines",
  },
  "--tx-head-wrap": {
    label: "heading rag",
    takes: "wrap",
    note: "balance, so a two-line heading stops breaking 90/10",
  },
  "--tx-hyphens": {
    label: "hyphenation",
    takes: "manual",
    note: "auto calms the rag and reads as print; people feel it either way",
  },
};

/** The knobs in the order an editor should show them, under the headings the
 *  rest of this file already argues in. */
export const KNOB_GROUPS: { title: string; knobs: Knob[] }[] = [
  { title: "ink", knobs: ["--tx-prose", "--tx-you", "--paper-note"] },
  { title: "type", knobs: ["--tx-size", "--tx-leading", "--tx-code"] },
  {
    title: "air and rag",
    knobs: ["--tx-round", "--tx-round-rule", "--tx-wrap", "--tx-head-wrap", "--tx-hyphens"],
  },
];

const KNOB_SET: ReadonlySet<string> = new Set(KNOBS);

export function isKnob(name: string): name is Knob {
  return KNOB_SET.has(name);
}

export type Theme = {
  id: string;
  /** What the chip says when you switch to it. Lowercase, like the rest. */
  label: string;
  /** One line on what it is for — the tooltip, and the argument for keeping it. */
  note: string;
  /** The theme this one is layered over, or null for one that stands alone.
   *
   *  This is the whole of "derived": resolution walks the chain root-first and
   *  a child's knobs win. A `from` naming a theme that no longer exists is not
   *  an error — see `resolve`. */
  from: string | null;
  over: Overrides;
  /** True for the three that ship. Built-ins are never written to storage and
   *  cannot be edited in place; you derive from one instead, which is what
   *  keeps "as it always was" able to mean it. */
  builtin?: boolean;
};

/** The theme that changes nothing. Its emptiness is load-bearing: see the head
 *  of this file. */
export const REST = "paper";

/** How deep a `from` chain may go before it is treated as malformed.
 *
 *  `resolve` already refuses to revisit a theme, so a cycle terminates on its
 *  own and this is not what stops one. It is a bound on how much work a
 *  hand-written store can ask for on every switch, and a limit worth having
 *  because nothing in the UI encourages a chain this long — a theme eight
 *  removed from its base is not derived from anything anybody can picture. */
export const MAX_CHAIN = 8;

/* The contrast figures quoted below are computed from `tokens.css` against
   `--well` (#0f0d0c), which is what the panel is drawn on:

     --paper       #ede4d8   15.4:1
     --paper-dim   #b4a89c    8.3:1
     --paper-mute  #8a7e74    4.9:1
     --paper-faint #615850    2.8:1

   The first three are a clean ramp. The fourth is not a text colour — it is
   below AA at any size — and `tokens.css` was using it for the seam label at
   10.2px, the meta-bar at 10.9px and the meta line at 12.2px. `--paper-note`
   is the knob that lets that be argued about without disturbing the ninety-odd
   places where `--paper-faint` is correctly drawing a mark or a rule. */

export const BUILTINS: Theme[] = [
  {
    id: REST,
    label: "paper",
    note: "as it always was",
    from: null,
    /* Empty on purpose, and it is the whole revert guarantee — see the head of
       this file. Anything added here stops this being a name for the untouched
       app, at which point there is no way back to it. */
    over: {},
    builtin: true,
  },
  {
    id: "readable",
    label: "readable",
    note: "notes lifted to a text contrast, a larger fence, air above a prompt",
    from: null,
    over: {
      /* 2.8:1 → 4.9:1 for the four small things that were text rather than
         marks. `--paper-faint` itself is untouched, so every dash, marker and
         hairline on the wall stays exactly where it was. */
      "--paper-note": "var(--paper-mute)",
      /* The fence was 0.78em of a 13.8px line — 10.7px, smaller than the tool
         lines above it and the smallest thing in the panel bar the seam. A
         fence is the densest and most literal thing in an answer and was set
         the smallest. 0.86em puts it level with inline code, which was already
         at 0.86em and disagreeing with it by a pixel. */
      "--tx-code": "0.86em",
      /* Light on dark blooms — the glyphs optically thicken and the counters
         close up — so a serif that wants 1.55 on paper wants a little more
         here. */
      "--tx-leading": "1.62",
      /* The structural one. Two paragraphs inside one answer sat 7.6px apart
         (0.55em margins, collapsed); a prompt and the answer to it sat 9.6px
         apart (`.lines`' gap). A 2px difference between "next paragraph" and
         "a whole new thing was said" is proximity saying nothing at all, and
         it is why finding where a round starts wanted the rail. The left rule
         on a prompt was already the landmark; this is the room it needs to act
         as one. */
      "--tx-round": "0.6rem",
      /* Orphans are constant at this measure — around 53 characters at the
         default panel width. Chromium only reflows the last few lines for
         `pretty`, so it is cheap, and it is the one wrap change with no
         aesthetic cost. `balance` on headings for the same reason: a two-line
         heading in this column breaks 90/10 without it. */
      "--tx-wrap": "pretty",
      "--tx-head-wrap": "balance",
    },
    builtin: true,
  },
  {
    id: "prose",
    label: "prose",
    note: "readable, and the answer is the loudest thing on the page",
    /* The first demonstration of the feature, and the reason it is worth
       having: this used to repeat every one of `readable`'s six knobs, with a
       test asserting the two stayed in step by hand. Now it says what it
       actually is — `readable`, plus two decisions — and the duplication and
       the test that policed it are both gone. */
    from: "readable",
    over: {
      /* The inversion. Your prompt was `--paper` at 15.4:1 and the agent's
         prose — the thing you are here to read, at length — was `--paper-dim`
         at 8.3:1, so the brightest thing on the page was the half you wrote
         and already know. The prompt is over-marked as it is: a 2px rule, its
         own margin, and a rail devoted to listing it. This lets the rule do
         the landmarking alone and gives the reading the top of the ramp.
         Neither is a defect — 8.3:1 is fine by any standard — which is
         precisely why it is a theme and not a fix. */
      "--tx-prose": "var(--paper)",
      "--tx-you": "var(--paper-dim)",
      /* At 40–53 characters the rag is real and hyphenation calms it
         measurably. It lives only here because it is the one knob that reads
         as a printed page rather than as a screen, and people feel that
         immediately and in both directions. `index.html` carries `lang="en"`,
         without which this would silently do nothing. */
      "--tx-hyphens": "auto",
    },
    builtin: true,
  },
  {
    id: "temper",
    label: "temper",
    note: "prose, held a step back so bold is still bold",
    /* `prose` answers "the answer is muted" by giving the reading the top of
       the ramp. That works, and it costs something the complaint did not ask
       to spend: `strong`, `.h` and `.link` are all `--paper` too, so prose at
       `--paper` is prose at exactly the brightness of every emphasis inside
       it. Bold is then carried by weight and face alone — 600, and the display
       serif for a heading — with no brightness step at all. In an answer
       written as run-in bold labels, which is how an agent writes most of
       them, that flattens the thing the labels are for.

       Measured against `--well`, and the second column is the one this theme
       exists for — how much brighter bold still is than the prose around it:

         --paper-dim   8.3:1   1.85   (paper, readable — muted, but bold reads)
         40% toward   10.8:1   1.42
         60% toward   12.2:1   1.26   (here)
         --paper      15.4:1   1.00   (prose, column — no step at all)

       So this is the ramp lifted clear of muted while leaving emphasis a
       step to stand on. It is one knob different from `prose` on purpose —
       nothing else moves, so switching between the two answers exactly one
       question — and it sits beside `prose` in the ring for the same reason,
       since the ring order is the order you compare in.

       `color-mix` rather than a literal, because the number is not a colour
       somebody picked: it is a position on the ramp `tokens.css` already
       declares. A literal would sit slightly off that ramp and would stay
       where it was if the two ends were ever retuned. */
    from: "prose",
    over: {
      "--tx-prose": "color-mix(in srgb, var(--paper) 60%, var(--paper-dim))",
    },
    builtin: true,
  },
  {
    id: "column",
    label: "column",
    note: "prose, and every round is ruled off rather than only spaced",
    /* The one issue the other two only half-answer, taken at its stronger
       setting. `readable` gives a prompt real air above it and argues — rightly
       — that the left rule was always the landmark and only wanted room to act
       as one. That is true while you are reading forwards. It stops being true
       when you are *hunting*: scrolling back through a long card for the round
       where something was decided, whitespace is a difference you have to
       measure against the paragraph spacing beside it, and a rule is one you
       see without reading. The rails answer the same question and want a hand
       on the mouse, which is exactly what you do not have while scrolling.

       Deferred at the time — "a lot of rules down a long card, and I'd try the
       whitespace first" — and that is the right order to have tried them in
       and the reason both exist rather than one replacing the other. This is
       the version for a card with forty rounds on it. */
    from: "prose",
    over: {
      /* `--edge`, so it is the same hairline the seam and the meta-bar already
         draw. A round boundary is the same kind of event as the boundary
         between restored scrollback and the live stream — one thing ending and
         another starting — and it should not invent a second weight of rule to
         say so. Against the left rule already there it closes into a bracket
         opening the round, which is why this reads as structure rather than as
         one more horizontal line every screenful. */
      "--tx-round-rule": "var(--edge)",
      /* Nearly double `readable`'s air, and it buys two different things here.
         Half of it sits above the rule and half below (see `.line.you`), so the
         rule gets clear space on both sides instead of being crowded by the
         answer above it — an under-led rule reads as an underline belonging to
         the paragraph over it rather than as a divider between two things. */
      "--tx-round": "1.1rem",
    },
    builtin: true,
  },
];

export const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTINS.map((t) => t.id));

/* ── reading a store back ──────────────────────────────────────────────────
 *
 * Everything below this line assumes its input is hostile, because it is: a
 * custom theme is authored by a person, kept in storage across builds, and
 * exported and pasted back in as text. The bargain is the one the rest of the
 * front end strikes with `widget.config_json` and the ambience's layers — a
 * normalizer runs on every read and degrades to something drawable, so a
 * renamed knob or a newer build's data costs no migration and cannot put a
 * NaN inside a frame loop. */

/** The longest a knob's value may be. Not a security boundary — CSS custom
 *  properties are substituted after the stylesheet is parsed, so a value
 *  containing `;` or `}` cannot close a declaration and open another; the worst
 *  it can do is make its own declaration invalid at computed-value time. This
 *  is a sanity bound, so a corrupt store cannot write a megabyte onto the root
 *  element's inline style on every switch. */
const MAX_VALUE = 200;

/** Whether a value is worth writing. Rejects the empty, the enormous, and
 *  anything carrying a control character — none of which any real declaration
 *  needs, and all of which make a computed style unreadable when you are
 *  trying to work out why a theme looks wrong. */
export function okValue(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!s || s.length > MAX_VALUE) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x1f\x7f]/.test(s);
}

/** An override map with everything that is not a knob, or not a usable value,
 *  dropped. */
export function cleanOverrides(raw: unknown): Overrides {
  const out: Overrides = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isKnob(k) && okValue(v)) out[k] = v.trim();
  }
  return out;
}

/** A stored id, reduced to the shape ids are allowed to have.
 *
 *  Lowercase, alphanumeric and dashes. Not for safety — ids never reach a
 *  selector or a query — but because an id is what the export carries between
 *  machines and what a person types into a control op, and one with a space or
 *  a quote in it is a thing you get wrong once and cannot see. */
export function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** A free id for a new theme, given what is already taken. Built-ins always
 *  count as taken — a custom theme called `paper` would shadow the one name
 *  that has to keep meaning "untouched". */
export function freeId(want: string, taken: Iterable<string>): string {
  const used = new Set<string>([...BUILTIN_IDS, ...taken]);
  const base = slugify(want) || "theme";
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const tryId = `${base}-${n}`;
    if (!used.has(tryId)) return tryId;
  }
  return `${base}-${used.size + 1}`;
}

/** One stored theme, normalized, or null if there is nothing usable in it.
 *
 *  Null rather than a repaired stub for the one case that matters: an entry
 *  with no id is not a theme somebody wrote and lost the name of, it is a
 *  fragment, and inventing a name for it puts an entry in the list that nobody
 *  can account for. Everything else degrades — a missing label becomes the id,
 *  a `from` that is not a string becomes null. */
export function cleanTheme(raw: unknown): Theme | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? slugify(r.id) : "";
  /* A stored theme may not claim a built-in's name: `themeAt` looks built-ins
     up first, so such an entry would be invisible and uneditable — present in
     the store, absent from the wall, and impossible to explain. */
  if (!id || BUILTIN_IDS.has(id)) return null;
  const label = typeof r.label === "string" && r.label.trim() ? r.label.trim().slice(0, 60) : id;
  const note = typeof r.note === "string" ? r.note.trim().slice(0, 200) : "";
  const from = typeof r.from === "string" && r.from.trim() ? slugify(r.from) : null;
  return { id, label, note, from: from === id ? null : from, over: cleanOverrides(r.over) };
}

/** Every custom theme in a stored blob, normalized, with duplicates by id
 *  resolved last-wins and anything unusable dropped. */
export function cleanThemes(raw: unknown): Theme[] {
  const list = Array.isArray(raw) ? raw : [];
  const byId = new Map<string, Theme>();
  for (const entry of list) {
    const t = cleanTheme(entry);
    if (t) byId.set(t.id, t);
  }
  return [...byId.values()];
}

/* ── looking one up ────────────────────────────────────────────────────── */

/** Built-ins first, then customs. The order is the order they cycle in, and it
 *  puts `paper` at the head so the way back is always one known place. */
export function allThemes(customs: Theme[] = []): Theme[] {
  return [...BUILTINS, ...customs];
}

/** The theme a name means, or null. Unlike `themeAt` this does not substitute
 *  a default, which is what lets `themeFor` tell "no such theme" from "the
 *  theme that changes nothing". */
export function findTheme(id: string | null | undefined, customs: Theme[] = []): Theme | null {
  if (typeof id !== "string") return null;
  return allThemes(customs).find((t) => t.id === id) ?? null;
}

/** The name a stored choice means, degraded to `REST` if it means nothing.
 *
 *  A theme that was deleted, or renamed between builds, must cost a session
 *  its ink and not its start-up. */
export function themeFor(id: string | null | undefined, customs: Theme[] = []): string {
  return findTheme(id, customs) ? (id as string) : REST;
}

/** The theme itself, never null — `themeFor` has already had its say. */
export function themeAt(id: string | null | undefined, customs: Theme[] = []): Theme {
  return findTheme(id, customs) ?? BUILTINS[0];
}

/** The chain a theme resolves through, root first, ending with the theme
 *  itself.
 *
 *  Exported because it is the honest answer to "where did this value come
 *  from", which is the first thing anybody asks of a derived theme that is not
 *  drawing what they expected — and because it is the clearest thing to test.
 *
 *  Two ways it stops early, and they are different failures. A `from` naming
 *  nothing is a **broken link** — the base was deleted out from under a child
 *  — and the child still resolves, using its own overrides alone, because a
 *  theme you can no longer select is worse than one that lost a layer. A
 *  `from` that revisits a theme already in the chain is a **cycle**, and it
 *  stops at the revisit for the obvious reason. Neither throws: this runs on
 *  every switch and on start-up, and a store that has gone strange must not be
 *  able to stop the app drawing. */
export function chainOf(id: string | null | undefined, customs: Theme[] = []): Theme[] {
  const chain: Theme[] = [];
  const seen = new Set<string>();
  let at = findTheme(id, customs);
  while (at && !seen.has(at.id) && chain.length < MAX_CHAIN) {
    seen.add(at.id);
    chain.push(at);
    at = at.from ? findTheme(at.from, customs) : null;
  }
  return chain.reverse();
}

/** What to write onto the root for a theme: the whole chain merged root-first,
 *  so a child's knobs win over the base's, with anything that is not a knob
 *  already dropped. */
export function resolve(id: string | null | undefined, customs: Theme[] = []): Overrides {
  const out: Overrides = {};
  for (const t of chainOf(id, customs)) {
    for (const k of KNOBS) {
      const v = t.over[k];
      if (okValue(v)) out[k] = v.trim();
    }
  }
  return out;
}

/* ── making one ────────────────────────────────────────────────────────── */

/** How a new theme relates to the one it came from.
 *
 *  Both were asked for and they are genuinely different things, which is why
 *  this is a word and not a boolean:
 *
 *  - `"extend"` keeps the link. The new theme holds only what you changed, and
 *    editing the base later moves the child with it. This is the one to want
 *    when the base is a theme you also use — `prose` is `readable` plus two
 *    decisions, and it should stay that way when `readable` is retuned.
 *  - `"copy"` cuts it. The base's resolved values are inlined and `from` is
 *    null, so the new theme is a standalone snapshot that nothing can move
 *    under you. This is the one to want when you are taking a built-in as a
 *    starting point and going your own way.
 *
 *  The failure each avoids is the other's behaviour arriving unasked: an
 *  extend you thought was a copy changes under you, and a copy you thought was
 *  an extend quietly stops tracking a base you are still editing. */
export type Derivation = "extend" | "copy";

/** A new theme from an existing one. Pure — the caller stores it.
 *
 *  The base is resolved through its own chain first, so copying a theme that
 *  was itself derived gives you everything it draws with rather than only the
 *  layer it happened to add. */
export function derive(
  baseId: string | null | undefined,
  opts: { label: string; how: Derivation; customs?: Theme[]; note?: string },
): Theme {
  const customs = opts.customs ?? [];
  const base = themeAt(baseId, customs);
  const id = freeId(opts.label, customs.map((t) => t.id));
  const extending = opts.how === "extend";
  return {
    id,
    label: opts.label.trim().slice(0, 60) || id,
    note: (opts.note ?? (extending ? `extends ${base.label}` : `from ${base.label}`)).slice(0, 200),
    from: extending ? base.id : null,
    over: extending ? {} : resolve(base.id, customs),
  };
}

/** A theme with one knob set, or cleared when `value` is null. Pure, and
 *  returns a new object rather than mutating — the holder swaps the entry.
 *
 *  Clearing matters as much as setting on a derived theme, and means something
 *  different there: a knob removed from an extending child falls back to the
 *  base's value, not to `tokens.css`. That is the point of extending, and it
 *  is why this is a delete rather than a write of the default. */
export function withKnob(theme: Theme, knob: string, value: string | null): Theme {
  if (!isKnob(knob)) return theme;
  const over = { ...theme.over };
  if (value === null) delete over[knob];
  else if (okValue(value)) over[knob] = value.trim();
  else return theme;
  return { ...theme, over };
}

/** The next theme round the ring.
 *
 *  A cycle rather than a picker because the whole point of this is comparison:
 *  a picker costs two gestures per look and puts a menu over the thing you are
 *  trying to see. Wraps both ways, and an unknown current name enters the ring
 *  at `REST` rather than throwing. */
export function nextTheme(
  id: string | null | undefined,
  customs: Theme[] = [],
  dir: number = 1,
): string {
  const ring = allThemes(customs);
  const at = ring.findIndex((t) => t.id === themeFor(id, customs));
  const step = dir < 0 ? -1 : 1;
  return ring[(at + step + ring.length) % ring.length].id;
}

/** Themes that would break if this one went — the children pointing at it.
 *
 *  Asked before a delete so the answer can be said out loud rather than
 *  discovered: `resolve` degrades a broken link to "no base", which is the
 *  right behaviour and a bad surprise. Direct children only; a grandchild is
 *  reached through a child that is itself still fine. */
export function dependents(id: string, customs: Theme[] = []): Theme[] {
  return customs.filter((t) => t.from === id);
}

/* ── carrying one between machines ─────────────────────────────────────────
 *
 * Custom themes live in localStorage, which is the wrong home for a thing you
 * made — the rest of the app puts what you authored in SQLite and keeps
 * localStorage for what is per-machine and disposable. It is there because
 * this machine has no MSVC toolchain, so a schema rung and the commands to
 * reach it could be written but not compiled or tested, and untested Rust in a
 * tree somebody else is working in is a worse trade than a storage seam that
 * has to move later. `theme.svelte.ts` keeps that seam to one pair of
 * functions. These two are the mitigation in the meantime: your themes can
 * leave the machine as text, which is what makes the wrong home survivable. */

export const EXPORT_VERSION = 1;

export function exportThemes(customs: Theme[]): string {
  return JSON.stringify({ skeinThemes: EXPORT_VERSION, themes: customs }, null, 2);
}

/** Themes out of exported text, normalized like anything else read back.
 *
 *  Accepts the wrapper `exportThemes` writes, a bare array, or a single theme
 *  object, because all three are things a person plausibly pastes and refusing
 *  two of them teaches nothing. Returns an empty list rather than throwing on
 *  text that is not JSON at all — the caller reports "nothing in that", which
 *  is the same message a valid document with no themes in it deserves. */
export function importThemes(text: string): Theme[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r.themes)) return cleanThemes(r.themes);
    return cleanThemes([raw]);
  }
  return cleanThemes(raw);
}

/** Merge imported themes into the ones already here, renaming rather than
 *  overwriting on a collision.
 *
 *  Overwriting is the wrong default for an import: the themes already on this
 *  machine are the ones you have been using, and the paste is the guess. A
 *  rename costs a moment's confusion; an overwrite costs work with no way
 *  back. The rename is `freeId`, so `dusk` arriving twice becomes `dusk-2`.
 *
 *  A `from` pointing inside the incoming set is rewritten to follow the
 *  rename, or a derived theme would silently re-base onto whatever happened to
 *  already hold that name here. One pointing outside it is left alone and may
 *  well be broken, which `resolve` degrades and `chainOf` shows. */
export function mergeThemes(existing: Theme[], incoming: Theme[]): Theme[] {
  const out = [...existing];
  const taken = new Set(out.map((t) => t.id));
  const renamed = new Map<string, string>();
  for (const t of incoming) {
    const id = freeId(t.id, taken);
    taken.add(id);
    if (id !== t.id) renamed.set(t.id, id);
    out.push({ ...t, id });
  }
  return out.map((t) =>
    t.from && renamed.has(t.from) ? { ...t, from: renamed.get(t.from)! } : t,
  );
}
