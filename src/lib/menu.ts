/* What a right-click offers, decided away from the DOM.
 *
 * The native menu is suppressed everywhere (see main.ts), so this file owns the
 * whole answer — including the answer "nothing", which is a real outcome rather
 * than a failure: right-clicking bare wall with nothing to say about it should
 * show no menu at all, not an empty box.
 *
 * Pure, so the vocabulary can be tested without a browser. The component turns
 * ids into calls; it never decides what appears. */

export type MenuKind = "card" | "image" | "region" | "ground" | "editable" | "prose";

export type MenuTarget = {
  kind: MenuKind;
  /* card */
  dormant?: boolean;
  pinned?: boolean;
  /** Has anything been said in this session? Nothing to clear if not. */
  spoken?: boolean;
  /* region */
  empty?: boolean;
  moved?: boolean;
  /* editable / prose */
  hasSelection?: boolean;
  canPaste?: boolean;
};

export type MenuItem =
  | { kind: "item"; id: string; label: string; danger?: boolean }
  | { kind: "sep" };

const item = (id: string, label: string, danger = false): MenuItem => ({
  kind: "item",
  id,
  label,
  ...(danger ? { danger: true } : {}),
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
        /* Beside `close`, because both end the conversation — but not marked
           danger, and the difference is real: closing takes the card off the
           wall, while clearing keeps it and its place, and the session it was
           holding stays on disk to be adopted back. Offered only once there is
           something to clear; on a card that has never spoken it would do
           nothing but mint an id. */
        t.spoken ? item("clear", "clear it — start fresh") : null,
        item("close", "close", true),
      ].filter(Boolean) as MenuItem[]);

    case "image":
      return [item("front", "bring to front"), sep, item("remove", "remove", true)];

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
