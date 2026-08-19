import { describe, expect, test } from "bun:test";
import {
  author,
  covering,
  isEmpty,
  normalize,
  normalizeAll,
  reading,
  since,
  type Notice,
} from "../src/lib/board";

const row = (over: Record<string, unknown> = {}) => ({
  id: "n1",
  scope: "project",
  projectId: "skein",
  from: "aaaaaaaa-1111-4111-8111-111111111111",
  subject: "reworking the store",
  body: "leave store.rs alone until I say",
  paths: ["src-tauri/src/store.rs"],
  postedAt: 1000,
  touchedAt: 1000,
  stale: false,
  ...over,
});

const notice = (over: Record<string, unknown> = {}) => normalize(row(over)) as Notice;

describe("normalize", () => {
  test("takes a row as Rust writes it", () => {
    const n = notice();
    expect(n.subject).toBe("reworking the store");
    expect(n.paths).toEqual(["src-tauri/src/store.rs"]);
    expect(n.stale).toBe(false);
  });

  /* The bargain `normalizeAsk` strikes, one table over: what arrives is data a
     model composed and a build older than it may be reading. Refusing to draw a
     row is a board that silently shows less than is on it, which is the one
     failure this feature cannot have. */
  test("degrades a row it does not fully understand rather than dropping it", () => {
    const n = normalize({ id: "n2", subject: "hm", extra: 7 })!;
    expect(n.body).toBe("");
    expect(n.paths).toEqual([]);
    expect(n.scope).toBe("project");
    expect(n.from).toBeNull();
    expect(n.stale).toBe(false);
  });

  test("drops only what could not be drawn or taken down", () => {
    /* No id: nothing to unpost with. No subject: a blank line on the board. */
    expect(normalize(row({ id: "" }))).toBeNull();
    expect(normalize(row({ subject: "" }))).toBeNull();
    expect(normalize(null)).toBeNull();
    expect(normalize("a notice")).toBeNull();
  });

  test("a path list with rubbish in it keeps the strings", () => {
    expect(notice({ paths: ["a.ts", 7, null, "b.ts"] }).paths).toEqual(["a.ts", "b.ts"]);
    expect(notice({ paths: "not a list" }).paths).toEqual([]);
  });

  test("a whole board survives one bad row", () => {
    const all = normalizeAll([row(), { nonsense: true }, row({ id: "n3" })]);
    expect(all).toHaveLength(2);
    expect(normalizeAll("nope")).toEqual([]);
  });
});

describe("the reading", () => {
  /* Stale last is the only rule with an argument behind it: an old notice is
     the one least likely to still be true, so it must not lead — and it must
     not be hidden either, because a long refactor is a real thing. */
  test("puts what is current first and the old at the foot, newest first in each", () => {
    const list = [
      notice({ id: "old-stale", postedAt: 10, stale: true }),
      notice({ id: "new", postedAt: 90 }),
      notice({ id: "mid", postedAt: 50 }),
      notice({ id: "new-stale", postedAt: 80, stale: true }),
    ];
    expect(reading(list).map((n) => n.id)).toEqual([
      "new",
      "mid",
      "new-stale",
      "old-stale",
    ]);
  });

  test("keeps every notice — the order is a reading, not a filter", () => {
    const list = [notice({ id: "a", stale: true }), notice({ id: "b" })];
    expect(reading(list)).toHaveLength(2);
    expect(isEmpty([])).toBe(true);
    expect(isEmpty(list)).toBe(false);
  });
});

describe("what a row says", () => {
  test("ages read as the rest of the wall's do", () => {
    const n = notice({ postedAt: 0 });
    expect(since(n, 0)).toBe("just now");
    expect(since(n, 5 * 60_000)).toBe("5m");
    expect(since(n, 3 * 3_600_000)).toBe("3h");
    expect(since(n, 50 * 3_600_000)).toBe("2d");
    /* A clock that has not caught up yet is not a notice from the future. */
    expect(since(notice({ postedAt: 900 }), 0)).toBe("just now");
  });

  test("the files line is clipped, because a row is one line", () => {
    expect(covering(notice({ paths: [] }))).toBe("");
    expect(covering(notice({ paths: ["a.ts", "b.ts"] }))).toBe("a.ts, b.ts");
    expect(covering(notice({ paths: ["a", "b", "c", "d", "e"] }))).toBe("a, b, c +2");
  });

  test("an author is named in the words on the card, and falls back to a handle", () => {
    const names = new Map([["aaaaaaaa-1111-4111-8111-111111111111", "store schema"]]);
    expect(author(notice(), names)).toBe("store schema");
    /* A card closed since — the sweep in Rust should have taken the row with
       it, and this is the moment before the next read catches up. */
    expect(author(notice(), new Map())).toBe("aaaaaaaa");
    /* And one you posted yourself, which has no card behind it at all. */
    expect(author(notice({ from: null }), names)).toBe("you");
  });
});
