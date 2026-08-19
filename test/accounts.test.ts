import { describe, expect, test } from "bun:test";
import {
  availableAt,
  blockersFor,
  capFor,
  choose,
  ordered,
  sayBlocked,
  standingOf,
  swapNote,
  type Account,
  type Allowance,
} from "../src/lib/accounts";
import type { Window } from "../src/lib/limits";

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 7, 19, 12, 0, 0);

function win(over: Partial<Window> = {}): Window {
  return {
    kind: "session",
    group: "session",
    used: 0,
    severity: "normal",
    resetsAt: null,
    scope: null,
    active: false,
    ...over,
  };
}

function acct(label: string, over: Partial<Account> = {}): Account {
  return { label, rank: 0, enabled: true, caps: {}, hasToken: true, ...over };
}

/** An account with nothing spent on it. */
function fresh(at = T0): Allowance {
  return {
    ok: true,
    at,
    windows: [
      win({ kind: "session", used: 5, resetsAt: at + 2 * HOUR, active: true }),
      win({ kind: "weekly_all", group: "weekly", used: 10, resetsAt: at + 72 * HOUR }),
    ],
  };
}

function spent(sessionPct: number, weeklyPct = 10, at = T0): Allowance {
  return {
    ok: true,
    at,
    windows: [
      win({ kind: "session", used: sessionPct, resetsAt: at + 2 * HOUR, active: true }),
      win({ kind: "weekly_all", group: "weekly", used: weeklyPct, resetsAt: at + 72 * HOUR }),
    ],
  };
}

describe("caps", () => {
  test("no cap set leaves the server's ceiling", () => {
    expect(capFor(acct("a"), "session", false)).toBe(100);
  });

  test("a cap set is the ceiling", () => {
    expect(capFor(acct("a", { caps: { session: 80 } }), "session", false)).toBe(80);
  });

  test("a cap only applies to the window it names", () => {
    const a = acct("a", { caps: { session: 80 } });
    expect(capFor(a, "weekly_all", false)).toBe(100);
  });

  /* A slider dragged to the end must not quietly come to mean "and past the
     real limit too". */
  test("a cap above 100 is not a cap", () => {
    expect(capFor(acct("a", { caps: { session: 150 } }), "session", false)).toBe(100);
  });

  test("a cap of zero is honoured, not read as unset", () => {
    expect(capFor(acct("a", { caps: { session: 0 } }), "session", false)).toBe(0);
  });

  test("a bypass lifts your ceiling to the server's", () => {
    expect(capFor(acct("a", { caps: { session: 80 } }), "session", true)).toBe(100);
  });
});

describe("what blocks an account", () => {
  test("nothing, on a fresh account", () => {
    expect(blockersFor(acct("a"), fresh().ok ? (fresh() as any).windows : [], false)).toEqual([]);
  });

  test("your cap blocks, and is marked as yours", () => {
    const a = acct("a", { caps: { session: 80 } });
    const b = blockersFor(a, (spent(85) as any).windows, false);
    expect(b).toHaveLength(1);
    expect(b[0]!.by).toBe("you");
    expect(b[0]!.window.kind).toBe("session");
  });

  test("a cap blocks at exactly the cap, not one point past it", () => {
    const a = acct("a", { caps: { session: 80 } });
    expect(blockersFor(a, (spent(80) as any).windows, false)).toHaveLength(1);
    expect(blockersFor(a, (spent(79.9) as any).windows, false)).toHaveLength(0);
  });

  test("a spent window blocks with no cap set at all, and is marked the server's", () => {
    const b = blockersFor(acct("a"), (spent(100) as any).windows, false);
    expect(b).toHaveLength(1);
    expect(b[0]!.by).toBe("server");
  });

  /* The server's word is taken below 100 because it knows things this does
     not — an org restriction, a spend limit, a refusal already issued. */
  test("a rejection wins below 100", () => {
    const w = [win({ kind: "session", used: 12, severity: "rejected" })];
    const b = blockersFor(acct("a"), w, false);
    expect(b).toHaveLength(1);
    expect(b[0]!.by).toBe("server");
  });

  test("a bypass clears your caps", () => {
    const a = acct("a", { caps: { session: 80 } });
    expect(blockersFor(a, (spent(85) as any).windows, true)).toHaveLength(0);
  });

  /* The load-bearing one. Nothing may promise work through a real refusal. */
  test("a bypass does not clear the server's ceiling", () => {
    const a = acct("a", { caps: { session: 80 } });
    const b = blockersFor(a, (spent(100) as any).windows, true);
    expect(b).toHaveLength(1);
    expect(b[0]!.by).toBe("server");
  });

  test("a bypass does not clear a rejection either", () => {
    const w = [win({ used: 3, severity: "exceeded" })];
    expect(blockersFor(acct("a"), w, true)).toHaveLength(1);
  });

  test("caps on two windows both block independently", () => {
    const a = acct("a", { caps: { session: 80, weekly_all: 50 } });
    const b = blockersFor(a, (spent(85, 60) as any).windows, false);
    expect(b).toHaveLength(2);
  });
});

describe("when an account comes back", () => {
  test("the latest blocker, since work needs every window clear", () => {
    const a = acct("a", { caps: { session: 80, weekly_all: 50 } });
    const b = blockersFor(a, (spent(85, 60) as any).windows, false);
    expect(availableAt(b)).toBe(T0 + 72 * HOUR);
  });

  test("unknown when any blocker names no reset", () => {
    const b = blockersFor(acct("a"), [win({ used: 100, resetsAt: null })], false);
    expect(availableAt(b)).toBeNull();
  });

  test("null for nothing blocking, which is not the same as unknown", () => {
    expect(availableAt([])).toBeNull();
  });
});

describe("standing", () => {
  test("ready when under every ceiling", () => {
    expect(standingOf(acct("a"), fresh(), false).state).toBe("ready");
  });

  test("switched off is unusable rather than blocked", () => {
    const s = standingOf(acct("a", { enabled: false }), fresh(), false);
    expect(s.state).toBe("unusable");
  });

  test("no token stored is unusable, and says what to do", () => {
    const s = standingOf(acct("a", { hasToken: false }), fresh(), false);
    expect(s.state).toBe("unusable");
    if (s.state === "unusable") expect(s.why).toContain("sign in");
  });

  /* A fault is not the same as an account being full, and the two must never
     collapse into each other — one is waited out, the other is fixed. */
  test("an unread allowance is unusable, not ready", () => {
    expect(standingOf(acct("a"), undefined, false).state).toBe("unusable");
  });

  test("a faulted reading carries the fault through", () => {
    const s = standingOf(acct("a"), { ok: false, fault: "offline" }, false);
    expect(s.state).toBe("unusable");
    if (s.state === "unusable") expect(s.why).toBe("offline");
  });
});

describe("the waterfall", () => {
  const one = acct("one", { rank: 0, caps: { session: 80 } });
  const two = acct("two", { rank: 1, caps: { weekly_all: 50 } });
  const three = acct("three", { rank: 2 });

  test("rank order, not registry order", () => {
    expect(ordered([three, one, two]).map((a) => a.label)).toEqual(["one", "two", "three"]);
  });

  test("the first account gets the work while it is under its cap", () => {
    const c = choose([one, two, three], {
      one: fresh(),
      two: fresh(),
      three: fresh(),
    });
    expect(c).toEqual({ kind: "use", label: "one", swapFrom: null });
  });

  /* The core of what was asked for: consume one fully, then move on. Not
     "spread the load" — account one at 85% is past *your* cap, and two is
     nearly empty, and a headroom policy would have been using two all along. */
  test("falls to the second only once the first is past its cap", () => {
    const c = choose([one, two, three], {
      one: spent(85),
      two: fresh(),
      three: fresh(),
    });
    expect(c).toEqual({ kind: "use", label: "two", swapFrom: null });
  });

  test("and to the third once the second is past its own, different cap", () => {
    const c = choose([one, two, three], {
      one: spent(85),
      two: spent(10, 55),
      three: fresh(),
    });
    expect(c).toEqual({ kind: "use", label: "three", swapFrom: null });
  });

  test("an account with no token is stepped over, not waited for", () => {
    const c = choose([acct("one", { rank: 0, hasToken: false }), two], {
      two: fresh(),
    });
    expect(c).toEqual({ kind: "use", label: "two", swapFrom: null });
  });

  test("a switched-off account is stepped over", () => {
    const c = choose([acct("one", { rank: 0, enabled: false }), two], {
      one: fresh(),
      two: fresh(),
    });
    expect(c).toEqual({ kind: "use", label: "two", swapFrom: null });
  });
});

describe("sticking to an account", () => {
  const one = acct("one", { rank: 0, caps: { session: 80 } });
  const two = acct("two", { rank: 1 });

  /* A card swaps when it must, not when it could. Account one has come back
     and outranks two, but this card is mid-conversation on two and moving it
     would re-read its whole context uncached for no gain. */
  test("a running card stays put even when a better-ranked account frees up", () => {
    const c = choose([one, two], { one: fresh(), two: fresh() }, { stickTo: "two" });
    expect(c).toEqual({ kind: "use", label: "two", swapFrom: null });
  });

  test("but new work still goes to the lowest available account", () => {
    const c = choose([one, two], { one: fresh(), two: fresh() }, { stickTo: null });
    expect(c.kind === "use" && c.label).toBe("one");
  });

  test("a card sticks only to an account it is still allowed on", () => {
    const c = choose([one, two], { one: fresh(), two: spent(100) }, { stickTo: "two" });
    expect(c).toEqual({ kind: "use", label: "one", swapFrom: "two" });
  });

  test("swapFrom is set only when the account actually changes", () => {
    const c = choose([one, two], { one: fresh(), two: fresh() }, { stickTo: "one" });
    expect(c.kind === "use" && c.swapFrom).toBeNull();
  });
});

describe("when nothing is available", () => {
  const one = acct("one", { rank: 0, caps: { session: 80 } });
  const two = acct("two", { rank: 1, caps: { session: 80 } });

  test("holds, rather than failing", () => {
    const c = choose([one, two], { one: spent(85), two: spent(90) });
    expect(c.kind).toBe("hold");
  });

  /* The earliest door to open — the opposite of the rule within one account,
     and right for the same reason: there, work needs every window clear; here
     it needs any one account. */
  test("holds until the first account comes back, not the last", () => {
    const c = choose([one, two], {
      one: { ok: true, at: T0, windows: [win({ used: 90, resetsAt: T0 + 3 * HOUR })] },
      two: { ok: true, at: T0, windows: [win({ used: 90, resetsAt: T0 + 1 * HOUR })] },
    });
    expect(c.kind === "hold" && c.until).toBe(T0 + 1 * HOUR);
  });

  test("an account with an unknown return does not make the wall's unknown", () => {
    const c = choose([one, two], {
      one: { ok: true, at: T0, windows: [win({ used: 100, resetsAt: null })] },
      two: { ok: true, at: T0, windows: [win({ used: 100, resetsAt: T0 + HOUR })] },
    });
    expect(c.kind === "hold" && c.until).toBe(T0 + HOUR);
  });

  test("unknown only when no blocked account names a reset", () => {
    const c = choose([one], {
      one: { ok: true, at: T0, windows: [win({ used: 100, resetsAt: null })] },
    });
    expect(c.kind === "hold" && c.until).toBeNull();
  });

  /* A hold is a wait; "none" is a thing to go and fix. They must not be the
     same answer. */
  test("nothing usable is 'none', not a hold that never ends", () => {
    const c = choose([acct("one", { hasToken: false })], {});
    expect(c.kind).toBe("none");
  });

  test("an empty registry says so", () => {
    const c = choose([], {});
    expect(c).toEqual({ kind: "none", why: "no accounts are set up" });
  });

  test("one shared reason is said rather than generalised away", () => {
    const c = choose(
      [acct("one", { rank: 0, hasToken: false }), acct("two", { rank: 1, hasToken: false })],
      {},
    );
    expect(c.kind === "none" && c.why).toContain("sign in");
  });

  test("a bypass still holds when the accounts are genuinely spent", () => {
    const c = choose([one, two], { one: spent(100), two: spent(100) }, { bypass: true });
    expect(c.kind).toBe("hold");
  });

  test("but a bypass gets through when only your caps were in the way", () => {
    const c = choose([one, two], { one: spent(85), two: spent(90) }, { bypass: true });
    expect(c).toEqual({ kind: "use", label: "one", swapFrom: null });
  });
});

describe("wording", () => {
  test("your cap and the account being spent read differently", () => {
    const yours = blockersFor(acct("a", { caps: { session: 80 } }), (spent(85) as any).windows, false);
    const theirs = blockersFor(acct("a"), (spent(100) as any).windows, false);
    expect(sayBlocked(yours)).toContain("your cap");
    expect(sayBlocked(theirs)).toContain("spent");
  });

  test("the fullest blocker speaks for the set", () => {
    const a = acct("a", { caps: { session: 80, weekly_all: 50 } });
    const b = blockersFor(a, (spent(99, 55) as any).windows, false);
    expect(sayBlocked(b)).toContain("5 hours");
  });

  test("nothing blocking says nothing", () => {
    expect(sayBlocked([])).toBe("");
  });

  /* The cost is named because it is the part with a cost, and the note is
     written at all because an app spawning with --dangerously-skip-permissions
     owes you a record of what it did on its own. */
  test("a swap note names both accounts and the re-read", () => {
    const note = swapNote("one", "two", "at your cap on the 5 hours");
    expect(note).toContain("one");
    expect(note).toContain("two");
    expect(note).toContain("uncached");
  });
});
