import { describe, expect, test } from "bun:test";
import {
  availableAt,
  blockersFor,
  capFor,
  choose,
  ordered,
  sayBlocked,
  sayUnmeasured,
  several,
  standingOf,
  swapNote,
  usable,
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
  return { label, rank: 0, enabled: true, caps: {}, signedIn: true, ...over };
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

  test("not being signed in is unusable, and says what to do", () => {
    const s = standingOf(acct("a", { signedIn: false }), fresh(), false);
    expect(s.state).toBe("unusable");
    if (s.state === "unusable") expect(s.why).toContain("sign in");
  });

  /* The regression this suite exists for. An account whose allowance cannot be
     read is an account that has not been *measured* — it is not an account that
     cannot be *used*, and conflating the two took the whole feature down for
     every account, because the credential Skein's own sign-in minted was
     refused by the allowance endpoint and `ok` was false forever. Every send
     met "no account available" for an account that ran turns perfectly well.
     See `standingOf`. */
  test("an unread allowance is ready but unmeasured, not unusable", () => {
    const s = standingOf(acct("a"), undefined, false);
    expect(s.state).toBe("ready");
    if (s.state === "ready") expect(s.unmeasured).toContain("has not been read");
  });

  test("a faulted reading is ready, and carries the fault as the reason", () => {
    const s = standingOf(acct("a"), { ok: false, fault: "offline" }, false);
    expect(s.state).toBe("ready");
    if (s.state === "ready") expect(s.unmeasured).toBe("offline");
  });

  /* And the other half of it: an account that *was* measured and is full is
     still blocked. Softening the unread case must not soften this one, or a
     spent account would go on being sent work. */
  test("a measured account that is full is still blocked", () => {
    const s = standingOf(acct("a"), spent(100), false);
    expect(s.state).toBe("blocked");
  });

  /* A cap cannot be applied to a reading nobody has, which is the cost of the
     softening above and is stated as a test so it cannot be lost by accident:
     an account with a cap of 0 — "never start work here" — is still ready while
     unmeasured. It is guarded instead by the server's own refusal, which is
     what `markSpent` and the reactive swap are for. */
  test("an unmeasured account is ready even with a cap that would block it", () => {
    const s = standingOf(acct("a", { caps: { session: 0 } }), undefined, false);
    expect(s.state).toBe("ready");
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
    const c = choose([acct("one", { rank: 0, signedIn: false }), two], {
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
    const c = choose([acct("one", { signedIn: false })], {});
    expect(c.kind).toBe("none");
  });

  test("an empty registry says so", () => {
    const c = choose([], {});
    expect(c).toEqual({ kind: "none", why: "no accounts are set up" });
  });

  test("one shared reason is said rather than generalised away", () => {
    const c = choose(
      [acct("one", { rank: 0, signedIn: false }), acct("two", { rank: 1, signedIn: false })],
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

  /* An unmeasured account says the consequence rather than only the cause: the
     reason it could not be read is already a sentence from Rust, and what a
     person needs off the face is that a ceiling they set is not in force. */
  test("an unmeasured account names the caps, not just the reason", () => {
    const said = sayUnmeasured("its allowance has not been read yet");
    expect(said).toContain("caps");
    expect(said).toContain("has not been read");
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

describe("whether there is a choice to be made at all", () => {
  /* Everything the feature draws on the wall hangs off this — the account
     beside a card's project name, and the account knob on the usage widget.
     With one account all of it is a word that never varies. */

  test("one signed-in account is not a choice", () => {
    expect(several([acct("one")])).toBe(false);
  });

  test("two are", () => {
    expect(several([acct("one"), acct("two")])).toBe(true);
  });

  test("none is not", () => {
    expect(several([])).toBe(false);
  });

  /* Counted over what could actually take work, so registering a second
     account you have not signed into yet does not switch the wall into a mode
     it cannot use. */
  test("a registered account with no token does not make a choice", () => {
    expect(several([acct("one"), acct("two", { signedIn: false })])).toBe(false);
  });

  test("nor does a switched-off one", () => {
    expect(several([acct("one"), acct("two", { enabled: false })])).toBe(false);
  });

  test("usable is what it is counted over", () => {
    const list = [
      acct("one"),
      acct("two", { signedIn: false }),
      acct("three", { enabled: false }),
      acct("four"),
    ];
    expect(usable(list).map((a) => a.label)).toEqual(["one", "four"]);
    expect(several(list)).toBe(true);
  });
});
