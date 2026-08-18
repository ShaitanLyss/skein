/* Which ink the wall is set in, and the writing of it onto the root element.
 *
 * The catalogue and all the arithmetic are pure and live in ./theme.ts; this
 * file is the three things that cannot be — a `$state` the components read,
 * the `setProperty`/`removeProperty` pair that is the whole of "apply", and
 * the storage the themes you wrote are kept in.
 *
 * That last one is a seam and is meant to be seen as one. `readCustoms` and
 * `writeCustoms` are the only two functions in the front end that know where
 * an authored theme lives; everything else goes through `ink`. localStorage is
 * the wrong home for a thing you made — the rest of the app puts authored work
 * in SQLite — and it is there because this machine cannot build the Rust half
 * to test a schema rung. When that changes, those two functions become
 * invokes and nothing else in this file or above it moves.
 */

import {
  KNOBS,
  REST,
  resolve,
  nextTheme,
  themeAt,
  themeFor,
  cleanThemes,
  allThemes,
  derive,
  withKnob,
  dependents,
  exportThemes,
  importThemes,
  mergeThemes,
  type Theme,
  type Derivation,
} from "./theme";

export * from "./theme";

const INK_KEY = "skein.theme.v1";
const CUSTOM_KEY = "skein.themes.v1";

/* ── the seam ──────────────────────────────────────────────────────────── */

function readCustoms(): Theme[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    return raw ? cleanThemes(JSON.parse(raw)) : [];
  } catch {
    /* Unparseable, or storage refused outright. Both mean the same thing here
       and neither is worth a start-up failure: the wall comes up on the
       built-ins, which is the app as it shipped. `cleanThemes` handles the
       third and commonest case — parseable JSON full of entries a newer or
       older build wrote — by dropping what it cannot use rather than by
       throwing, so a half-recognised store keeps the half it recognises. */
    return [];
  }
}

function writeCustoms(list: Theme[]) {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
  } catch {
    /* Quota, or a browser refusing storage. Nothing to do and nothing worth
       interrupting a switch for — the themes stand for this session. */
  }
}

/* ── applying ──────────────────────────────────────────────────────────── */

/** Write an override map onto the root element.
 *
 *  Every knob is visited, not only the ones this theme names: a knob the
 *  incoming theme is silent about is *removed*, so the cascade resolves it
 *  against `tokens.css` again. Setting only what the new theme names would
 *  leave the outgoing theme's values behind on every knob the two did not
 *  share, and the wall would drift a little further from any of its themes
 *  with each switch — which is exactly the failure this whole arrangement
 *  exists to make impossible. Reverting is `REST`, whose map is empty, so this
 *  loop removes every one and leaves the document as `tokens.css` wrote it. */
function paint(over: Partial<Record<(typeof KNOBS)[number], string>>) {
  const root = document.documentElement;
  for (const k of KNOBS) {
    const v = over[k];
    if (v === undefined) root.style.removeProperty(k);
    else root.style.setProperty(k, v);
  }
}

/** The wall's ink, and the themes you wrote.
 *
 *  A module singleton rather than something the studio constructs, for two
 *  reasons. It has to be applied *before the first paint* or the app shows the
 *  base theme and re-themes itself a frame later, which is a flash on every
 *  launch; importing this module from `main.ts` ahead of `mount` is the
 *  earliest point that exists. And the peek is a second window with its own
 *  document and its own root component, so a holder owned by `App.svelte`
 *  would leave the notification surface permanently untheming itself — both
 *  roots load the same bundle, so both get this by importing it.
 *
 *  It holds no subscription and no timer, which is what makes a singleton safe
 *  here where `Skein`, `Attention` and `Control` all need releasing. If
 *  anything is ever added to it that listens, that stops being true and it
 *  needs a place in `Listeners` like the rest.
 *
 *  Two windows do mean two copies of this state, and they do not hear about
 *  each other: theme a card on the wall and the peek keeps the ink it started
 *  with until it is next created. Left alone deliberately — the peek is
 *  short-lived and re-reads storage every time it appears, so the divergence
 *  cannot outlive one notification, and a `storage` listener to close it would
 *  cost this class the "holds nothing" property above. */
class Ink {
  /** What you wrote. `$state` and not a getter over storage: every reader on
   *  the wall re-derives from this, and a list that is re-parsed per read
   *  would hand each of them a fresh array of fresh objects. */
  customs = $state<Theme[]>([]);
  id = $state(REST);

  constructor() {
    this.customs = readCustoms();
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(INK_KEY);
    } catch {
      /* a browser refusing storage is not a reason to start untheme */
    }
    /* Normalized on the way in, so a key edited by hand or naming a theme that
       has since been deleted costs a session its ink rather than its
       start-up. */
    this.id = themeFor(stored, this.customs);
    paint(resolve(this.id, this.customs));
  }

  /** The ring, in the order it cycles: built-ins first, then yours. */
  get all(): Theme[] {
    return allThemes(this.customs);
  }

  get theme(): Theme {
    return themeAt(this.id, this.customs);
  }

  /** What is actually on the root element — the whole chain flattened. The
   *  editor draws against this, so a knob a derived theme inherits reads as
   *  the value it inherits rather than as blank. */
  get over() {
    return resolve(this.id, this.customs);
  }

  set(id: string) {
    this.id = themeFor(id, this.customs);
    paint(resolve(this.id, this.customs));
    /* Same side of the line as the panel's width and the reading size:
       per-machine, disposable, about this screen and this pair of eyes, and no
       business being in the database. Written on the switch rather than
       deferred — a theme change is one discrete gesture and there is no
       pointerup afterwards to hang a save on. */
    try {
      localStorage.setItem(INK_KEY, this.id);
    } catch {}
  }

  /** Round the ring. The gesture is Ctrl+Shift+T in `App.svelte`. */
  cycle(dir: number = 1) {
    this.set(nextTheme(this.id, this.customs, dir));
  }

  /* ── authoring ───────────────────────────────────────────────────────── */

  #save(list: Theme[]) {
    this.customs = list;
    writeCustoms(list);
    /* The current theme may have just changed underneath the document — an
       edit to it, or a delete of the base it extends. Repainting from the new
       list unconditionally is cheaper than working out whether this write
       touched the chain being drawn, and `themeFor` catches the one case where
       the theme itself has gone. */
    this.id = themeFor(this.id, list);
    paint(resolve(this.id, list));
  }

  /** A new theme from the current one, and switch to it. Returns its id.
   *
   *  `extend` keeps the link and starts empty; `copy` flattens the chain in
   *  and stands alone. Both are useful and they fail differently — an extended
   *  theme follows its base when the base is edited, which is what you want
   *  while you are still moving the base and not what you want once you have
   *  given the thing away. */
  create(label: string, how: Derivation = "extend", baseId: string = this.id): string {
    const t = derive(baseId, { label, how, customs: this.customs });
    this.#save([...this.customs, t]);
    this.set(t.id);
    return t.id;
  }

  /** Set or clear one knob on a custom theme.
   *
   *  A built-in cannot be edited, and this does not quietly refuse: it derives
   *  an extending child first and edits that. Refusing would be the honest
   *  thing if there were anywhere for the gesture to be explained, but this is
   *  a knob being dragged — the answer to "you cannot edit `readable`" is
   *  always "then make one from it", and doing it costs nothing recoverable
   *  while a dead control costs the drag. The new theme says where it came
   *  from in its own note. */
  tweak(knob: string, value: string | null) {
    const cur = this.theme;
    const id = cur.builtin ? this.create(`${cur.label} mine`, "extend", cur.id) : cur.id;
    this.#save(this.customs.map((t) => (t.id === id ? withKnob(t, knob, value) : t)));
  }

  /** Rename, renote. The id never moves — it is what `from` and the stored ink
   *  key point at, and rewriting those to follow a label somebody is still
   *  typing is how a chain gets broken halfway through a word. */
  rename(id: string, label: string, note?: string) {
    this.#save(
      this.customs.map((t) =>
        t.id === id
          ? {
              ...t,
              label: label.trim().slice(0, 60) || t.label,
              note: note === undefined ? t.note : note.trim().slice(0, 200),
            }
          : t,
      ),
    );
  }

  /** What would break if `id` went. Ask before offering the delete — see
   *  `dependents`. */
  children(id: string): Theme[] {
    return dependents(id, this.customs);
  }

  /** Drop a theme. Its children are left pointing at a name that is gone,
   *  which `resolve` degrades to "no base" rather than treating as an error —
   *  so a mistaken delete costs those themes their inherited layer and not
   *  their existence. `children` is how the cost is said out loud first. */
  remove(id: string) {
    this.#save(this.customs.filter((t) => t.id !== id));
  }

  /* ── carrying them off the machine ───────────────────────────────────── */

  /** Every custom theme as text, for the clipboard. */
  text(): string {
    return exportThemes(this.customs);
  }

  /** Take pasted text in, renaming rather than overwriting on a collision.
   *  Returns how many arrived — zero is the answer for text that is not JSON,
   *  for a document with no themes in it, and for one whose themes were all
   *  unusable, because from here those are the same event. */
  paste(text: string): number {
    const incoming = importThemes(text);
    if (!incoming.length) return 0;
    this.#save(mergeThemes(this.customs, incoming));
    return incoming.length;
  }
}

export const ink = new Ink();
