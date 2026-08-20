import { expect, test, describe } from "bun:test";
import { PRESETS, presetById, presetPicks } from "../src/lib/presets";
import { EFFORT_LEVELS, isEffort } from "../src/lib/commands";
import { contextWindowFor } from "../src/lib/classify";
import { menuFor, type MenuItem } from "../src/lib/menu";

const items = (m: MenuItem[]) =>
  m.filter((i): i is Extract<MenuItem, { kind: "item" }> => i.kind === "item");

describe("what the + offers before a card is opened", () => {
  test("every preset names a level this build knows", () => {
    /* The level goes to `--effort`, which takes these five and nothing else —
       a preset naming a sixth would spawn a card that fails at startup. */
    for (const p of PRESETS) expect(isEffort(p.effort)).toBe(true);
    expect(EFFORT_LEVELS.length).toBe(5);
  });

  test("the ids are unique and stable, since rows are opened under them", () => {
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    expect(presetById("bug")?.model).toBe("opus");
    expect(presetById("nothing-like-this")).toBeUndefined();
    expect(presetById(undefined)).toBeUndefined();
  });

  test("the note says the pair, so the menu is read rather than remembered", () => {
    for (const p of PRESETS) {
      expect(p.note).toContain(p.model);
      expect(p.note).toContain(p.effort);
    }
  });

  test("only the presets asking for room ask for the 1M window", () => {
    /* `contextWindowFor` reads the tier out of the alias, which is what sizes
       the ring before `system/init` has said anything. A preset that meant to
       be cheap and quietly carries `[1m]` is one that costs five times what
       its note implies. */
    const wide = PRESETS.filter((p) => contextWindowFor(p.model) === 1_000_000);
    expect(wide.map((p) => p.id)).toEqual(["read", "deep"]);
  });

  test("they run cheapest to dearest, which is the only order the menu implies", () => {
    const rank = (p: (typeof PRESETS)[number]) =>
      ["haiku", "sonnet", "sonnet[1m]", "opus", "opus[1m]"].indexOf(p.model);
    const ranks = PRESETS.map(rank);
    expect(ranks).not.toContain(-1);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });
});

describe("the menu the + puts up", () => {
  test("every preset is offered, and the plain opening last", () => {
    const m = items(menuFor({ kind: "spawn", presets: presetPicks() }));
    expect(m.map((i) => i.id)).toEqual([
      ...PRESETS.map((p) => `preset:${p.id}`),
      "new",
    ]);
    /* The one that needs no reading is the one you get by not right-clicking,
       so it sits under the five that are worth looking at. */
    expect(m[m.length - 1].label).toBe("as claude code is set up");
  });

  test("the notes ride the items, and nothing else in the app has one", () => {
    const m = items(menuFor({ kind: "spawn", presets: presetPicks() }));
    expect(m.filter((i) => i.note).length).toBe(PRESETS.length);
    expect(items(menuFor({ kind: "card" })).some((i) => i.note)).toBe(false);
  });

  test("with no presets it is still the plain opening, not an empty box", () => {
    /* `tidy` drops the separator that would otherwise open the menu. */
    expect(menuFor({ kind: "spawn" })).toEqual([
      { kind: "item", id: "new", label: "as claude code is set up" },
    ]);
  });
});
