/* What a right-click offers, decided away from the DOM.
 *
 * The native menu is suppressed everywhere (see main.ts), so this file owns the
 * whole answer — including the answer "nothing", which is a real outcome rather
 * than a failure: right-clicking bare wall with nothing to say about it should
 * show no menu at all, not an empty box.
 *
 * Pure, so the vocabulary can be tested without a browser. The component turns
 * ids into calls; it never decides what appears. */

export type MenuKind =
  | "card"
  | "image"
  | "widget"
  | "region"
  | "ground"
  | "editable"
  | "prose";

/** One option among several, of which one is in force — a widget's variant. */
export type Pick = { id: string; label: string; on: boolean };

export type MenuTarget = {
  kind: MenuKind;
  /* card */
  dormant?: boolean;
  pinned?: boolean;
  /* region */
  empty?: boolean;
  moved?: boolean;
  /* widget: what it can be switched between, and what it is on. Handed in
     rather than looked up, because the catalogue is the widgets' business and
     this file's only business is what a right-click offers.

     `picks` is the variant — what you are looking at — and `options` is
     everything else it can be told, in one group below. Two groups rather than
     one long list: a clock's face and whether it shows seconds are different
     kinds of question, and a menu that runs them together reads as ten
     unrelated items. */
  picks?: Pick[];
  options?: Pick[];
  /* ground / region: the kinds of instrument that can be hung up. */
  offers?: { id: string; label: string }[];
  /* editable / prose */
  hasSelection?: boolean;
  canPaste?: boolean;
};

export type MenuItem =
  | { kind: "item"; id: string; label: string; danger?: boolean; on?: boolean }
  | { kind: "sep" };

const item = (id: string, label: string, danger = false): MenuItem => ({
  kind: "item",
  id,
  label,
  ...(danger ? { danger: true } : {}),
});

/** An item that is currently in force. Marked rather than labelled — "analog
 *  (showing)" is a sentence, and a menu of five of them is a paragraph. */
const chosen = (id: string, label: string, on: boolean): MenuItem => ({
  kind: "item",
  id,
  label,
  on,
});
const sep: MenuItem = { kind: "sep" };

/** Trailing and leading separators, and runs of them, are artefacts of building
 *  a list conditionally — never something anybody meant. */
function tidy(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const it of items) {
    if (it.kind === "sep" && (!out.length || out[out.length - 1].kind === "sep")) {
      continue;
    }
    out.push(it);
  }
  while (out.length && out[out.length - 1].kind === "sep") out.pop();
  return out;
}

export function menuFor(t: MenuTarget): MenuItem[] {
  switch (t.kind) {
    case "card":
      return tidy([
        t.dormant ? item("wake", "wake it") : null,
        /* The thing that was missing when a card and a terminal wanted the same
           conversation: the session id is what `--resume` takes, and until now
           it appeared nowhere in the UI at all. */
        item("copy-resume", "copy resume command"),
        item("copy-cwd", "copy working directory"),
        t.pinned ? item("unpin", "let it flow again") : null,
        sep,
        item("close", "close", true),
      ].filter(Boolean) as MenuItem[]);

    case "image":
      return [item("front", "bring to front"), sep, item("remove", "remove", true)];

    /* A widget's variants are offered here rather than in a panel of their own,
       for the reason the whole file exists: the native menu is suppressed, so
       this *is* the answer, and a clock has one question worth asking about it.
       The variants come first — it is what you right-clicked it for. */
    case "widget":
      return tidy([
        ...(t.picks ?? []).map((p) => chosen(`set:${p.id}`, p.label, p.on)),
        sep,
        ...(t.options ?? []).map((p) => chosen(p.id, p.label, p.on)),
        sep,
        item("front", "bring to front"),
        sep,
        item("remove", "take it down", true),
      ]);

    case "region":
      return tidy([
        item("new", "new conversation here"),
        item("new-worktree", "new conversation in a worktree"),
        sep,
        item("adopt", "adopt a recorded session…"),
        /* Dropping a file in from outside was the only way to pin something up,
           which is fine until the thing you want is not already in a window you
           can drag from. */
        item("image", "pin up an image…"),
        ...(t.offers ?? []).map((o) => item(`widget:${o.id}`, o.label)),
        /* The way back from carrying a territory off somewhere — a card's "let it
           flow again", one level up. Offered only when it would move something:
           a territory still standing where it was packed has nothing to tidy. */
        t.moved ? sep : null,
        t.moved ? item("reflow", "settle it back in") : null,
        /* Only once it is standing empty. A territory outlives its last card so
           you can start again in it; forgetting is how you say you won't, and
           it is not something to offer next to live work. */
        t.empty ? sep : null,
        t.empty ? item("forget", "forget this project", true) : null,
      ].filter(Boolean) as MenuItem[]);

    case "ground":
      return [
        item("open", "open a folder…"),
        item("adopt", "adopt a recorded session…"),
        item("image", "pin up an image…"),
        ...(t.offers ?? []).map((o) => item(`widget:${o.id}`, o.label)),
        sep,
        item("fit", "fit everything"),
        /* Territories are packed once and then remembered, so a wall that has
           grown into itself is tidied when you say so and never behind your
           back. This is where you say so. */
        item("tidy", "tidy the territories"),
        sep,
        /* The ground is what the ambience is drawn on, so this is where asking
           about it belongs — the chrome button is for reaching it without
           finding bare wall first. */
        item("ambience", "the wall's ambience…"),
      ];

    case "editable":
      return tidy([
        t.hasSelection ? item("cut", "cut") : null,
        t.hasSelection ? item("copy", "copy") : null,
        t.canPaste ? item("paste", "paste") : null,
        sep,
        item("select-all", "select all"),
      ].filter(Boolean) as MenuItem[]);

    /* Read-only text: the transcript. Offering "copy" with nothing selected
       would be a menu item that does nothing, so there is simply no menu. */
    case "prose":
      return t.hasSelection ? [item("copy", "copy")] : [];

    default:
      return [];
  }
}
