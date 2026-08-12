import { expect, test, describe } from "bun:test";
import { menuFor, type MenuItem } from "../src/lib/menu";

const ids = (items: MenuItem[]) =>
  items.filter((i) => i.kind === "item").map((i) => (i as { id: string }).id);

describe("a menu offers only what the target can actually do", () => {
  test("a dormant card can be woken; a live one has nothing to wake", () => {
    expect(ids(menuFor({ kind: "card", dormant: true }))).toContain("wake");
    expect(ids(menuFor({ kind: "card", dormant: false }))).not.toContain("wake");
  });

  test("only a pinned card can be let go", () => {
    expect(ids(menuFor({ kind: "card", pinned: true }))).toContain("unpin");
    expect(ids(menuFor({ kind: "card", pinned: false }))).not.toContain("unpin");
  });

  /* The session id is what `--resume` takes and it appears nowhere else in the
     UI, so this is the one bridge between a card and a terminal. */
  test("every card can hand over its resume command", () => {
    expect(ids(menuFor({ kind: "card" }))).toContain("copy-resume");
  });

  test("copy needs something selected, or there is no menu at all", () => {
    expect(menuFor({ kind: "prose", hasSelection: false })).toEqual([]);
    expect(ids(menuFor({ kind: "prose", hasSelection: true }))).toEqual(["copy"]);
  });

  test("an input offers paste only when there is a clipboard to read", () => {
    expect(ids(menuFor({ kind: "editable", canPaste: true }))).toContain("paste");
    expect(ids(menuFor({ kind: "editable", canPaste: false }))).not.toContain("paste");
    // select all needs neither a selection nor a clipboard.
    expect(ids(menuFor({ kind: "editable" }))).toEqual(["select-all"]);
  });
});

describe("the list is shaped like something a person meant", () => {
  test("conditional items never leave a rule hanging", () => {
    /* Built by filtering, so the separators have to be swept up afterwards —
       a menu that opens with a horizontal rule reads as a missing item. */
    for (const t of [
      { kind: "card" as const, dormant: false, pinned: false },
      { kind: "card" as const, dormant: true, pinned: true },
      { kind: "editable" as const, hasSelection: false, canPaste: false },
      { kind: "editable" as const, hasSelection: true, canPaste: true },
    ]) {
      const items = menuFor(t);
      expect(items[0]?.kind).toBe("item");
      expect(items[items.length - 1]?.kind).toBe("item");
      for (let i = 1; i < items.length; i++) {
        expect(items[i].kind === "sep" && items[i - 1].kind === "sep").toBe(false);
      }
    }
  });

  test("destructive things are marked, so the menu can draw them apart", () => {
    const close = menuFor({ kind: "card" }).find(
      (i) => i.kind === "item" && i.id === "close",
    );
    expect(close).toMatchObject({ danger: true });
    const remove = menuFor({ kind: "image" }).find(
      (i) => i.kind === "item" && i.id === "remove",
    );
    expect(remove).toMatchObject({ danger: true });
  });

  test("the ground and a territory both lead somewhere", () => {
    expect(ids(menuFor({ kind: "ground" }))).toEqual([
      "open",
      "adopt",
      "image",
      "fit",
      "tidy",
      "ambience",
    ]);
    expect(ids(menuFor({ kind: "region" }))).toEqual([
      "new",
      "new-worktree",
      "adopt",
      "image",
    ]);
  });

  /* Dropping a file in from another window was the only way to pin one up,
     which is no help when what you want is a file rather than something
     already on screen. */
  test("an image can be pinned up from anywhere on the wall", () => {
    expect(ids(menuFor({ kind: "ground" }))).toContain("image");
    expect(ids(menuFor({ kind: "region", empty: true }))).toContain("image");
  });

  /* The ground is the thing the ambience is drawn on, so right-clicking bare
     wall is the shortest way to ask about it. */
  test("the wall's own backdrop is reachable from the wall", () => {
    expect(ids(menuFor({ kind: "ground" }))).toContain("ambience");
  });

  /* The way back from carrying a territory off into the far wall — and, like
     every other conditional item here, absent when it would do nothing. */
  test("only a territory that has been moved offers to be tidied back", () => {
    expect(ids(menuFor({ kind: "region", moved: true }))).toContain("reflow");
    expect(ids(menuFor({ kind: "region", moved: false }))).not.toContain("reflow");
  });

  /* A territory outlives its last card so you can begin again in it — which
     means the wall would otherwise collect every folder ever opened. */
  test("only an empty territory can be forgotten", () => {
    expect(ids(menuFor({ kind: "region", empty: true }))).toContain("forget");
    expect(ids(menuFor({ kind: "region", empty: false }))).not.toContain("forget");
    const forget = menuFor({ kind: "region", empty: true }).find(
      (i) => i.kind === "item" && i.id === "forget",
    );
    expect(forget).toMatchObject({ danger: true });
  });
});
