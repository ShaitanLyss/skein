import { describe, expect, test } from "bun:test";

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUILTINS,
  KNOB_GROUPS,
  KNOB_INFO,
  BUILTIN_IDS,
  KNOBS,
  MAX_CHAIN,
  REST,
  chainOf,
  cleanOverrides,
  cleanTheme,
  cleanThemes,
  dependents,
  derive,
  exportThemes,
  findTheme,
  freeId,
  importThemes,
  isKnob,
  mergeThemes,
  nextTheme,
  okValue,
  resolve,
  slugify,
  themeAt,
  themeFor,
  withKnob,
  type Theme,
} from "../src/lib/theme";

const custom = (over: Partial<Theme> = {}): Theme => ({
  id: "mine",
  label: "mine",
  note: "",
  from: null,
  over: {},
  ...over,
});

describe("the revert guarantee", () => {
  /* If this fails, there is no way back to the untouched app — see the head of
     theme.ts. It is the one assertion in here that is about a value rather
     than about behaviour. */
  test("paper sets nothing", () => {
    expect(resolve(REST)).toEqual({});
  });

  test("and is first in the ring, so the way back is one known place", () => {
    expect(BUILTINS[0].id).toBe(REST);
  });

  test("every built-in only touches knobs", () => {
    for (const t of BUILTINS) {
      for (const k of Object.keys(t.over)) expect(isKnob(k)).toBe(true);
    }
  });

  test("no knob is a status colour", () => {
    for (const k of KNOBS) expect(k.startsWith("--st-")).toBe(false);
  });
});

describe("okValue", () => {
  test("takes an ordinary declaration", () => {
    expect(okValue("var(--paper-mute)")).toBe(true);
  });

  test("refuses the empty and the blank", () => {
    expect(okValue("")).toBe(false);
    expect(okValue("   ")).toBe(false);
  });

  test("refuses what is not a string", () => {
    expect(okValue(13)).toBe(false);
    expect(okValue(null)).toBe(false);
    expect(okValue(undefined)).toBe(false);
  });

  test("refuses the enormous", () => {
    expect(okValue("a".repeat(500))).toBe(false);
  });

  test("refuses a control character inside the value", () => {
    expect(okValue("var(--a" + String.fromCharCode(10) + ")")).toBe(false);
    expect(okValue(String.fromCharCode(0) + "red")).toBe(false);
  });

  /* Trailing whitespace is not a control character problem, it is a typing
     one, and the trim happens first on purpose: a value pasted with a newline
     on the end is a value, and refusing it would be the module being clever at
     somebody who did nothing wrong. */
  test("but trims one off the end rather than refusing it", () => {
    expect(okValue("1.5" + String.fromCharCode(10))).toBe(true);
  });
});

describe("cleanOverrides", () => {
  test("drops a name that is nobody's knob", () => {
    expect(cleanOverrides({ "--tx-size": "15px", "--tx-nonsense": "1" })).toEqual({
      "--tx-size": "15px",
    });
  });

  test("drops a knob with an unusable value", () => {
    expect(cleanOverrides({ "--tx-size": 15 })).toEqual({});
  });

  test("survives being handed rubbish", () => {
    expect(cleanOverrides(null)).toEqual({});
    expect(cleanOverrides("theme")).toEqual({});
  });

  test("trims, since the value is written onto an element", () => {
    expect(cleanOverrides({ "--tx-size": "  15px " })).toEqual({ "--tx-size": "15px" });
  });
});

describe("cleanTheme", () => {
  test("an entry with no id is a fragment, not a theme", () => {
    expect(cleanTheme({ label: "dusk", over: {} })).toBeNull();
  });

  test("and one claiming a built-in's name is dropped, not shadowed", () => {
    /* It would be present in the store, absent from the wall and impossible to
       explain — themeAt looks built-ins up first. */
    expect(cleanTheme({ id: REST, label: "not really paper" })).toBeNull();
  });

  test("a missing label becomes the id", () => {
    expect(cleanTheme({ id: "dusk" })?.label).toBe("dusk");
  });

  test("a from that is not a string becomes null", () => {
    expect(cleanTheme({ id: "dusk", from: 7 })?.from).toBeNull();
  });

  test("a theme cannot be its own base", () => {
    expect(cleanTheme({ id: "dusk", from: "dusk" })?.from).toBeNull();
  });

  test("ids are slugged, so a hand-typed one is still a name", () => {
    expect(cleanTheme({ id: "My Dusk!" })?.id).toBe("my-dusk");
  });
});

describe("cleanThemes", () => {
  test("keeps the half it recognises", () => {
    const list = cleanThemes([{ id: "a" }, null, { label: "no id" }, { id: "b" }]);
    expect(list.map((t) => t.id)).toEqual(["a", "b"]);
  });

  test("duplicates by id are last-wins", () => {
    const list = cleanThemes([
      { id: "a", label: "first" },
      { id: "a", label: "second" },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe("second");
  });

  test("anything that is not a list is no themes", () => {
    expect(cleanThemes({ id: "a" })).toEqual([]);
    expect(cleanThemes(null)).toEqual([]);
  });
});

describe("freeId", () => {
  test("takes the name when it is free", () => {
    expect(freeId("Dusk", [])).toBe("dusk");
  });

  test("numbers it when it is not", () => {
    expect(freeId("dusk", ["dusk"])).toBe("dusk-2");
    expect(freeId("dusk", ["dusk", "dusk-2"])).toBe("dusk-3");
  });

  test("a built-in's name is always taken", () => {
    expect(freeId(REST, [])).toBe(`${REST}-2`);
    for (const id of BUILTIN_IDS) expect(freeId(id, [])).not.toBe(id);
  });

  test("a label with nothing sluggable in it still gets an id", () => {
    expect(freeId("!!!", [])).toBe("theme");
  });
});

describe("themeFor", () => {
  test("a name that means nothing costs the ink, not the start-up", () => {
    expect(themeFor("deleted-last-week")).toBe(REST);
    expect(themeFor(null)).toBe(REST);
    expect(themeFor(undefined)).toBe(REST);
  });

  test("a custom name means itself once its themes are in hand", () => {
    const customs = [custom()];
    expect(themeFor("mine", customs)).toBe("mine");
    /* and not before — the same stored key, read without them, is the failure
       above rather than an error */
    expect(themeFor("mine")).toBe(REST);
  });

  test("themeAt never returns null", () => {
    expect(themeAt("nonsense").id).toBe(REST);
    expect(findTheme("nonsense")).toBeNull();
  });
});

describe("the chain", () => {
  const base = custom({ id: "base", over: { "--tx-size": "15px", "--tx-round": "2px" } });
  const child = custom({ id: "child", from: "base", over: { "--tx-size": "17px" } });

  test("resolves root-first, so a child's knob wins", () => {
    expect(resolve("child", [base, child])).toEqual({
      "--tx-size": "17px",
      "--tx-round": "2px",
    });
  });

  test("and reads as the chain it walked", () => {
    expect(chainOf("child", [base, child]).map((t) => t.id)).toEqual(["base", "child"]);
  });

  test("a broken link loses the layer, not the theme", () => {
    /* The base was deleted out from under it. A theme you can no longer select
       is worse than one that lost a layer. */
    expect(resolve("child", [child])).toEqual({ "--tx-size": "17px" });
    expect(chainOf("child", [child]).map((t) => t.id)).toEqual(["child"]);
  });

  test("a cycle terminates rather than hanging the app", () => {
    const a = custom({ id: "a", from: "b", over: { "--tx-size": "15px" } });
    const b = custom({ id: "b", from: "a", over: { "--tx-round": "2px" } });
    const chain = chainOf("a", [a, b]);
    expect(chain.length).toBeLessThanOrEqual(2);
    expect(() => resolve("a", [a, b])).not.toThrow();
  });

  test("and a long one is bounded", () => {
    const deep = Array.from({ length: 30 }, (_, i) =>
      custom({ id: `t${i}`, from: i ? `t${i - 1}` : null }),
    );
    expect(chainOf("t29", deep).length).toBeLessThanOrEqual(MAX_CHAIN);
  });

  test("a knob a base sets and a child does not is inherited", () => {
    const bare = custom({ id: "bare", from: "base", over: {} });
    expect(resolve("bare", [base, bare])).toEqual(resolve("base", [base]));
  });
});

describe("derive", () => {
  const customs = [custom({ id: "base", label: "base", over: { "--tx-size": "15px" } })];

  test("extending keeps the link and starts empty", () => {
    const t = derive("base", { label: "warmer", how: "extend", customs });
    expect(t.from).toBe("base");
    expect(t.over).toEqual({});
    /* which is what makes it follow the base when the base is retuned */
    expect(resolve(t.id, [...customs, t])).toEqual({ "--tx-size": "15px" });
  });

  test("copying cuts it and inlines what the base drew", () => {
    const t = derive("base", { label: "warmer", how: "copy", customs });
    expect(t.from).toBeNull();
    expect(t.over).toEqual({ "--tx-size": "15px" });
  });

  test("copying a derived theme takes everything it drew, not just its layer", () => {
    const child = custom({ id: "child", from: "base", over: { "--tx-round": "2px" } });
    const t = derive("child", { label: "flat", how: "copy", customs: [...customs, child] });
    expect(t.over).toEqual({ "--tx-size": "15px", "--tx-round": "2px" });
  });

  test("names do not collide", () => {
    const a = derive(REST, { label: "dusk", how: "copy" });
    const b = derive(REST, { label: "dusk", how: "copy", customs: [a] });
    expect(b.id).not.toBe(a.id);
  });

  test("a built-in base is fine and a missing one degrades to paper", () => {
    expect(derive("nonsense", { label: "x", how: "extend" }).from).toBe(REST);
  });
});

describe("withKnob", () => {
  const t = custom({ over: { "--tx-size": "15px" } });

  test("sets", () => {
    expect(withKnob(t, "--tx-round", "2px").over["--tx-round"]).toBe("2px");
  });

  test("clears, which on a child means falling back to its base", () => {
    expect(withKnob(t, "--tx-size", null).over).toEqual({});
  });

  test("ignores a name that is not a knob", () => {
    expect(withKnob(t, "--st-fail", "red")).toBe(t);
  });

  test("and a value that is not usable, rather than storing it", () => {
    expect(withKnob(t, "--tx-size", "")).toBe(t);
  });

  test("does not mutate", () => {
    withKnob(t, "--tx-round", "2px");
    expect(t.over).toEqual({ "--tx-size": "15px" });
  });
});

describe("nextTheme", () => {
  test("wraps both ways", () => {
    const first = BUILTINS[0].id;
    const last = BUILTINS[BUILTINS.length - 1].id;
    expect(nextTheme(last)).toBe(first);
    expect(nextTheme(first, [], -1)).toBe(last);
  });

  test("customs are on the ring, after the built-ins", () => {
    const customs = [custom()];
    const ids: string[] = [];
    let at = REST;
    for (let i = 0; i < BUILTINS.length + 1; i++) {
      at = nextTheme(at, customs);
      ids.push(at);
    }
    expect(ids).toContain("mine");
    expect(at).toBe(REST);
  });

  test("an unknown current name enters at paper rather than throwing", () => {
    expect(nextTheme("deleted", [], -1)).toBe(BUILTINS[BUILTINS.length - 1].id);
  });
});

describe("dependents", () => {
  test("names the children a delete would break", () => {
    const child = custom({ id: "child", from: "base" });
    const other = custom({ id: "other" });
    expect(dependents("base", [child, other]).map((t) => t.id)).toEqual(["child"]);
  });

  test("direct children only — a grandchild is reached through one", () => {
    const child = custom({ id: "child", from: "base" });
    const grand = custom({ id: "grand", from: "child" });
    expect(dependents("base", [child, grand])).toHaveLength(1);
  });
});

describe("carrying them between machines", () => {
  const mine = [
    custom({ id: "dusk", label: "dusk", over: { "--tx-size": "15px" } }),
    custom({ id: "dusker", from: "dusk", over: { "--tx-round": "0px" } }),
  ];

  test("a round trip is the same themes", () => {
    expect(importThemes(exportThemes(mine))).toEqual(mine);
  });

  test("a bare array is accepted, because people paste one", () => {
    expect(importThemes(JSON.stringify(mine))).toEqual(mine);
  });

  test("so is a single theme object", () => {
    expect(importThemes(JSON.stringify(mine[0]))).toEqual([mine[0]]);
  });

  test("text that is not JSON is nothing in that, not a throw", () => {
    expect(importThemes("what")).toEqual([]);
    expect(importThemes("")).toEqual([]);
  });

  test("and neither is a document full of unusable entries", () => {
    expect(importThemes(JSON.stringify({ themes: [{ label: "no id" }] }))).toEqual([]);
  });

  test("an import renames rather than overwriting what is here", () => {
    const merged = mergeThemes([custom({ id: "dusk", label: "the one I use" })], [mine[0]]);
    expect(merged).toHaveLength(2);
    expect(merged[0].label).toBe("the one I use");
    expect(merged[1].id).toBe("dusk-2");
  });

  test("and a from inside the incoming set follows the rename", () => {
    const merged = mergeThemes([custom({ id: "dusk" })], mine);
    const child = merged.find((t) => t.id === "dusker")!;
    /* not "dusk" — that is this machine's theme, and re-basing onto it
       silently is the failure this exists to avoid */
    expect(child.from).toBe("dusk-2");
  });

  test("a from pointing outside it is left alone, broken or not", () => {
    const orphan = custom({ id: "loose", from: "somewhere-else" });
    expect(mergeThemes([], [orphan])[0].from).toBe("somewhere-else");
  });

  test("nothing imported leaves the list as it was", () => {
    const here = [custom()];
    expect(mergeThemes(here, [])).toEqual(here);
  });
});

describe("slugify", () => {
  test("folds everything that is not alphanumeric", () => {
    expect(slugify("Dusk — the good one")).toBe("dusk-the-good-one");
  });

  test("and does not leave a dash on either end", () => {
    expect(slugify("  dusk  ")).toBe("dusk");
  });

  test("is bounded", () => {
    expect(slugify("a".repeat(200)).length).toBeLessThanOrEqual(40);
  });
});


/* ── the knobs are real ───────────────────────────────────────────────────
 *
 * These are the tests that earn their keep, because the failure they catch is
 * completely silent: a theme sets a property, `paint` writes it onto the root
 * element, `getComputedStyle` reports it faithfully — and nothing draws with
 * it, because no rule ever says `var(--tx-…)`. Every assertion above this line
 * passes with the entire feature inert.
 *
 * It shipped that way. `--tx-size` and `--tx-leading` were consumed and the
 * other eight were not, so `readable` and `prose` differed from `paper` by a
 * size and a leading and were otherwise identical to it and to each other. The
 * catalogue was right, the storage was right, the arithmetic was tested to
 * three decimal places, and the panel drew the same thing whatever you picked.
 *
 * Hence a test that reads the stylesheets. It is not elegant and it is the only
 * thing standing between a knob and that, since a knob is a *contract between
 * two files* and nothing in either half can see the other. */

/* `fileURLToPath`, not `new URL(…).pathname`: on Windows the latter is
   `/C:/Users/…`, whose leading slash makes every `readdirSync` an ENOENT. */
const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** Every .svelte and .css file under src/, as text. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const at = join(dir, e.name);
      if (e.isDirectory()) walk(at);
      else if (/\.(svelte|css)$/.test(e.name)) out.push(readFileSync(at, "utf8"));
    }
  };
  walk(SRC);
  return out;
}

describe("a knob reaches a rule", () => {
  const all = sources().join("\n");

  test("tokens.css declares every knob, so paper is exactly the untouched app", () => {
    /* The base value has to live in the stylesheet rather than in the themes.
       `paper`'s override map is empty, so choosing it *removes* the property
       from the root element — and if nothing declared it, the cascade would
       land on the `var()` fallback in each rule instead. That still draws
       correctly, but it puts the base value in as many places as there are
       rules using it, which is how two of them drift apart. */
    const tokens = readFileSync(join(SRC, "lib/tokens.css"), "utf8");
    for (const k of KNOBS) expect(tokens).toContain(`${k}:`);
  });

  test("and some rule actually reads every one of them", () => {
    /* `var(--knob` — a declaration consuming it, anywhere in the front end.
       tokens.css's own declaration is `--knob:` and does not match, so a knob
       that is merely declared and never used still fails here. */
    for (const k of KNOBS) {
      const used = all.includes(`var(${k}`);
      expect(used, `${k} is declared but no rule draws with it`).toBe(true);
    }
  });

  test("every knob carries its own base value as the var() fallback", () => {
    /* `var(--tx-code, 0.78em)` rather than a bare `var(--tx-code)`, which is
       the bargain `var(--read, 1)` already strikes in Markdown.svelte: the
       component renders correctly outside the panel and outside tokens.css.
       A bare var() resolving to nothing makes the declaration invalid at
       computed-value time, which for `font-size` is an inherited size and for
       `color` is black on a dark wall. */
    /* A plain substring rather than a regex: the only spelling that occurs in
       practice is the one prettier leaves, and a pattern permitting whitespace
       inside the parens would be a pattern nobody can read for the sake of a
       formatting nobody writes. */
    for (const k of KNOBS) {
      expect(all.includes(`var(${k})`), `${k} is read with no fallback`).toBe(false);
    }
  });
});

describe("the editor's copy", () => {
  /* An editor draws one row per knob off these two, so a knob added to KNOBS
     without a word written for it is a blank row and an ungrouped control. */
  test("every knob is described", () => {
    for (const k of KNOBS) {
      expect(KNOB_INFO[k]?.label, `${k} has no label`).toBeTruthy();
      expect(KNOB_INFO[k]?.note, `${k} has no note`).toBeTruthy();
    }
  });

  test("and appears in exactly one group", () => {
    const seen = KNOB_GROUPS.flatMap((g) => g.knobs);
    expect([...seen].sort()).toEqual([...KNOBS].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });
});

describe("the temper theme", () => {
  test("stands on prose and differs from it by exactly one knob", () => {
    /* The whole point of it: switching between the two answers one question,
       so anything else creeping into `over` here makes the comparison
       meaningless rather than merely different. */
    const t = BUILTINS.find((x) => x.id === "temper")!;
    expect(t.from).toBe("prose");
    expect(Object.keys(t.over)).toEqual(["--tx-prose"]);
  });

  test("and lands between paper-dim and paper rather than at either end", () => {
    const over = resolve("temper");
    /* On the ramp by construction — a literal would sit beside it and would
       stay put if the two ends were retuned. */
    expect(over["--tx-prose"]).toContain("color-mix");
    expect(over["--tx-prose"]).toContain("var(--paper)");
    expect(over["--tx-prose"]).toContain("var(--paper-dim)");
    expect(over["--tx-prose"]).not.toBe("var(--paper)");
    /* Everything else is prose's, including the inversion it exists inside. */
    expect(over["--tx-you"]).toBe("var(--paper-dim)");
    expect(over["--tx-code"]).toBe("0.86em");
  });

  test("sits next to prose in the ring, because that is what it is compared against", () => {
    expect(nextTheme("prose")).toBe("temper");
  });
});

describe("the column theme", () => {
  test("stands on prose, and so on readable", () => {
    expect(chainOf("column").map((t) => t.id)).toEqual(["readable", "prose", "column"]);
  });

  test("keeps what it stands on and turns the rule on", () => {
    const over = resolve("column");
    /* Inherited three layers down — the whole argument for `from`. */
    expect(over["--tx-code"]).toBe("0.86em");
    expect(over["--tx-prose"]).toBe("var(--paper)");
    /* Its own two. */
    expect(over["--tx-round-rule"]).toBe("var(--edge)");
    expect(over["--tx-round"]).toBe("1.1rem");
  });

  test("and is the only built-in that draws a rule", () => {
    for (const t of BUILTINS) {
      if (t.id === "column") continue;
      expect(resolve(t.id)["--tx-round-rule"]).toBeUndefined();
    }
  });
});
