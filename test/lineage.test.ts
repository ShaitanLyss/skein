import { describe, expect, test } from "bun:test";
import {
  BASE,
  BASE_MIN,
  CHARGE_SPAN,
  GROW_MS,
  SPREAD_DEG,
  TIP,
  bearing,
  bearingGap,
  chargeAt,
  clusters,
  familiesOf,
  halfWidthAt,
  halfWidths,
  limbsFor,
  outline,
  RETREAT_MS,
  reachOf,
  reeled,
  fading,
  withdrawing,
  type Departing,
  spine,
  stirring,
  type Kid,
  type Kin,
} from "../src/lib/lineage";
import type { Box, Pt } from "../src/lib/flow";

const CARD = { w: 240, h: 150 };

/** A card box centred where it is said to be, which is how these read. */
function at(x: number, y: number): Box {
  return { x: x - CARD.w / 2, y: y - CARD.h / 2, w: CARD.w, h: CARD.h };
}

function kid(id: string, x: number, y: number, born?: number): Kid {
  return { id, box: at(x, y), born };
}

const PARENT = at(0, 0);

function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

describe("which children share a trunk", () => {
  test("two cards the same way out is one trunk", () => {
    const groups = clusters(PARENT, [kid("a", 900, -120), kid("b", 900, 140)]);
    expect(groups.length).toBe(1);
    expect(groups[0].map((k) => k.id).sort()).toEqual(["a", "b"]);
  });

  /* The case `spawn`'s `project` argument created: a card in `atelier` opening
     one in `nova` to the east and one in `caravan` to the west. A mean direction
     over those two is meaningless, and a limb drawn along it doubles back
     through the card it came from. */
  test("opposite directions are two trunks, not one mean", () => {
    const groups = clusters(PARENT, [kid("east", 900, 0), kid("west", -900, 0)]);
    expect(groups.length).toBe(2);
    expect(groups.map((g) => g[0].id).sort()).toEqual(["east", "west"]);
  });

  /* The seam of the sort falls at due west, so a fan sitting across it comes
     back as two groups at opposite ends of the list. Nothing but the wrap join
     puts them together, and without it a pair of neighbours would be drawn as
     two trunks leaving the same edge a few degrees apart. */
  test("a fan across due west is still one trunk", () => {
    const groups = clusters(PARENT, [kid("up", -900, -60), kid("down", -900, 60)]);
    expect(groups.length).toBe(1);
  });

  test("no children is no trunks, and one is one", () => {
    expect(clusters(PARENT, [])).toEqual([]);
    expect(clusters(PARENT, [kid("only", 400, 400)]).length).toBe(1);
  });

  /* Wrapping is the whole reason `bearingGap` is a function: a naive subtraction
     puts two cards ten degrees apart at three hundred and fifty. */
  test("the gap between bearings takes the short way round", () => {
    const nearly = Math.PI - 0.05;
    expect(Math.abs(bearingGap(nearly, -nearly))).toBeCloseTo(0.1, 6);
    expect(Math.abs(bearingGap(0, 0.3))).toBeCloseTo(0.3, 6);
  });

  test("bearing is measured with y down, the frame the wall is in", () => {
    expect(bearing({ x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(0, 6);
    expect(bearing({ x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(Math.PI / 2, 6);
  });

  /* Stated as a test because the constant is arguable and the reading it buys is
     not: two cards a right angle apart are still "the same way out". */
  test("the spread is wider than a right angle is not", () => {
    expect(SPREAD_DEG).toBeGreaterThan(60);
    expect(SPREAD_DEG).toBeLessThan(90);
  });
});

describe("the trunk and the fork", () => {
  const opts = { scale: 1, now: 0 };

  test("every limb of a cluster leaves the card from one point", () => {
    const limbs = limbsFor(PARENT, [kid("a", 900, -120), kid("b", 900, 140)], opts);
    expect(limbs.length).toBe(2);
    expect(limbs[0].spine[0]).toEqual(limbs[1].spine[0]);
    /* And along one tangent, which is what makes the trunk: the first control
       point is the shared fork. Coinciding until they separate is the whole of
       how the fork is emergent rather than computed. */
    expect(limbs[0].spine[1]).toEqual(limbs[1].spine[1]);
  });

  test("two trunks share nothing", () => {
    const limbs = limbsFor(PARENT, [kid("east", 900, 0), kid("west", -900, 0)], opts);
    expect(limbs[0].spine[0]).not.toEqual(limbs[1].spine[0]);
  });

  test("a limb starts on the parent's rim and ends on the child's", () => {
    const [limb] = limbsFor(PARENT, [kid("a", 900, 0)], opts);
    const [from, , , to] = limb.spine;
    /* The rim, not the centre: a root that started in the middle of the card
       would be drawn under its own title, which is the one thing on it you might
       be reading. `rimPoint`'s gap puts it a few pixels clear. */
    expect(from.x).toBeGreaterThanOrEqual(CARD.w / 2);
    expect(from.x).toBeLessThan(CARD.w / 2 + 12);
    expect(to.x).toBeLessThanOrEqual(900 - CARD.w / 2);
  });

  test("the fork is inside the distance to the nearest child", () => {
    const limbs = limbsFor(PARENT, [kid("near", 500, 0), kid("far", 1800, 90)], opts);
    const [from, fork] = limbs[0].spine;
    const nearest = Math.min(...limbs.map((l) => dist(l.spine[0], l.spine[3])));
    /* Past the nearest child the branch would leave the trunk after it had
       already arrived. */
    expect(dist(from, fork)).toBeLessThan(nearest);
  });

  test("a lone child does not bow: its own direction is the mean", () => {
    const [limb] = limbsFor(PARENT, [kid("a", 900, 300)], opts);
    const [from, fork, into, to] = limb.spine;
    /* Every control point on the straight line means no bow at all, which is
       what `side` being zero has to give. */
    const cross = (p: Pt) =>
      (to.x - from.x) * (p.y - from.y) - (to.y - from.y) * (p.x - from.x);
    expect(Math.abs(cross(fork)) / dist(from, to)).toBeLessThan(0.5);
    expect(Math.abs(cross(into)) / dist(from, to)).toBeLessThan(0.5);
  });

  test("a fan splays apart rather than every limb bowing the same way", () => {
    const limbs = limbsFor(PARENT, [kid("up", 900, -300), kid("down", 900, 300)], opts);
    const from = limbs[0].spine[0];
    const dir = { x: limbs[0].spine[1].x - from.x, y: limbs[0].spine[1].y - from.y };
    /* Signed by which side of the trunk each child is on, so the two bows have
       opposite signs. Signing by the perpendicular of `a → b` — which is what a
       relay strand does — would bow both the same way and draw them on top of
       each other. */
    const side = (p: Pt) => Math.sign(dir.x * (p.y - from.y) - dir.y * (p.x - from.x));
    expect(side(limbs[0].spine[2])).toBe(-side(limbs[1].spine[2]));
  });

  test("the order is stable, so the fill is the same shape twice", () => {
    const kids = [kid("a", 900, 140), kid("b", 900, -120), kid("c", -900, 0)];
    const once = limbsFor(PARENT, kids, opts).map((l) => l.child);
    const twice = limbsFor(PARENT, [...kids].reverse(), opts).map((l) => l.child);
    expect(twice).toEqual(once);
  });
});

describe("how thick a root is", () => {
  test("more children is a thicker trunk, so the fork reads", () => {
    expect(halfWidths(1, 3).base).toBeGreaterThan(halfWidths(1, 1).base);
    /* The tip is the child's end and belongs to one child however many there
       are. */
    expect(halfWidths(1, 3).tip).toBe(halfWidths(1, 1).tip);
  });

  /* The deliberate departure from `flow.ts`, which keeps a strand's width at
     every zoom because it is light crossing a room. A root is a thing on the
     ground beside the cards. */
  test("width follows the zoom but never to nothing, and never past 1:1", () => {
    expect(halfWidths(0.01).base).toBe(BASE_MIN);
    expect(halfWidths(0.5).base).toBeLessThan(BASE);
    expect(halfWidths(4).base).toBe(BASE);
  });

  test("the taper is monotonic, which is what makes direction readable", () => {
    const ws = [0, 0.25, 0.5, 0.75, 1].map((p) => halfWidthAt(p, 6, 1));
    for (let i = 1; i < ws.length; i += 1) expect(ws[i]).toBeLessThan(ws[i - 1]);
    expect(halfWidthAt(0, 6, 1)).toBeCloseTo(6, 6);
    expect(halfWidthAt(1, 6, 1)).toBeCloseTo(1, 6);
  });

  test("the tip is never zero", () => {
    expect(TIP).toBeGreaterThan(0);
    expect(halfWidths(0.001).tip).toBeGreaterThan(0);
  });
});

describe("growing out", () => {
  test("a root restored from the database is drawn whole", () => {
    /* Twenty cards sprouting at launch as though each had just been opened is
       the thing this answers. */
    expect(reachOf(null, 10_000)).toBe(1);
    expect(reachOf(undefined, 10_000)).toBe(1);
  });

  test("a root born this session grows, and stops when it is done", () => {
    const born = 1_000;
    expect(reachOf(born, born)).toBe(0);
    expect(reachOf(born, born + GROW_MS / 2)).toBeGreaterThan(0);
    expect(reachOf(born, born + GROW_MS / 2)).toBeLessThan(1);
    expect(reachOf(born, born + GROW_MS)).toBe(1);
    expect(reachOf(born, born + GROW_MS * 10)).toBe(1);
  });

  test("reduced motion gets the finished root, not no root", () => {
    expect(reachOf(1_000, 1_000, true)).toBe(1);
  });

  test("a limb with no reach yet has no outline to fill", () => {
    const [limb] = limbsFor(PARENT, [kid("a", 900, 0, 5_000)], { scale: 1, now: 5_000 });
    expect(limb.reach).toBe(0);
    expect(outline(limb)).toEqual([]);
  });

  /* Growth is a root *extending*, not one being revealed: the profile is read
     against what exists, so a half-grown root is a complete short root. Its far
     end is therefore already thin. */
  test("a growing root is tapered along its whole length", () => {
    const born = 0;
    const [limb] = limbsFor(PARENT, [kid("a", 1200, 0, born)], {
      scale: 1,
      now: born + GROW_MS / 3,
    });
    const ring = outline(limb, 8);
    expect(ring.length).toBe(18);
    const width = (i: number) => dist(ring[i], ring[ring.length - 1 - i]);
    expect(width(0)).toBeGreaterThan(width(8));
    /* And it reaches only as far as it has grown. */
    const far = Math.max(...ring.map((p) => p.x));
    const whole = limbsFor(PARENT, [kid("a", 1200, 0)], { scale: 1, now: 0 })[0];
    expect(far).toBeLessThan(Math.max(...outline(whole, 8).map((p) => p.x)));
  });
});

describe("the charge", () => {
  test("it runs from the parent towards the child", () => {
    const early = chargeAt(200)!;
    const later = chargeAt(900)!;
    expect(early.head).toBeLessThan(later.head);
  });

  /* It shortens into the card rather than stopping dead at the rim — the same
     landing `flow.pulseAt` draws, because light absorbed reads as arriving where
     a dot deleted reads as a bug. */
  test("it lands by shortening into the child", () => {
    const at = chargeAt(2_390)!;
    expect(at.head).toBe(1);
    expect(at.tail).toBeGreaterThan(1 - CHARGE_SPAN);
    expect(at.tail).toBeLessThan(1);
  });

  test("it never runs past either end", () => {
    for (let age = 0; age < 12_000; age += 37) {
      const at = chargeAt(age);
      if (!at) continue;
      expect(at.tail).toBeGreaterThanOrEqual(0);
      expect(at.head).toBeLessThanOrEqual(1);
      expect(at.head).toBeGreaterThan(at.tail);
    }
  });

  test("it repeats", () => {
    expect(chargeAt(100)).toEqual(chargeAt(2_500));
  });
});

describe("what is worth a frame at all", () => {
  const one: Kin[] = [{ parent: "p", child: "c" }];

  test("a wall of finished roots runs no frames", () => {
    expect(stirring(one, new Set(), 10_000)).toBe(false);
    expect(stirring([], new Set(["c"]), 10_000)).toBe(false);
  });

  test("a working child is a frame, and only while it is working", () => {
    expect(stirring(one, new Set(["c"]), 10_000)).toBe(true);
    /* The *parent* working is not: the charge says which child is doing the
       work, not that the family is busy. */
    expect(stirring(one, new Set(["p"]), 10_000)).toBe(false);
  });

  test("a root still growing is a frame until it has grown", () => {
    const born: Kin[] = [{ parent: "p", child: "c", born: 1_000 }];
    expect(stirring(born, new Set(), 1_100)).toBe(true);
    expect(stirring(born, new Set(), 1_000 + GROW_MS)).toBe(false);
  });
});

describe("which pairs are drawn at all", () => {
  const boxes = new Map<string, Box>([
    ["p", PARENT],
    ["a", at(900, -120)],
    ["b", at(900, 140)],
  ]);

  test("a family is grouped under its parent", () => {
    const kin: Kin[] = [
      { parent: "p", child: "a" },
      { parent: "p", child: "b" },
    ];
    const families = familiesOf(kin, boxes);
    expect(families.length).toBe(1);
    expect(families[0].kids.map((k) => k.id)).toEqual(["a", "b"]);
  });

  /* The table is never swept, on purpose — the value of a lineage is answering
     "was this opened by an agent" months later. So a row whose parent has been
     closed is ordinary, and a card with no parent on the wall is a card rather
     than half a root. */
  test("a pair with an end off the wall is not half a root", () => {
    expect(familiesOf([{ parent: "gone", child: "a" }], boxes)).toEqual([]);
    expect(familiesOf([{ parent: "p", child: "gone" }], boxes)).toEqual([]);
  });

  test("`born` survives the grouping, or nothing would ever grow", () => {
    const [family] = familiesOf([{ parent: "p", child: "a", born: 7 }], boxes);
    expect(family.kids[0].born).toBe(7);
  });
});

describe("going home", () => {
  const opts = { scale: 1, now: 0 };
  const parked: Departing = {
    limb: limbsFor(PARENT, [kid("gone", 1200, 0)], opts)[0],
    parent: "p",
    anchor: { x: 0, y: 0 },
    at: 0,
  };

  test("it withdraws towards the parent and then stops existing", () => {
    const far = (u: number) => {
      const home = withdrawing(parked, u * RETREAT_MS, null);
      return home ? Math.max(...outline(home.limb).map((p) => p.x)) : -1;
    };
    /* Monotonic: at no point does a root going home come back out. */
    const steps = [0.05, 0.25, 0.5, 0.75, 0.95].map(far);
    for (let i = 1; i < steps.length; i += 1) expect(steps[i]).toBeLessThan(steps[i - 1]);
    /* And it is gone rather than left as a stub at the rim. */
    expect(withdrawing(parked, RETREAT_MS, null)).toBeNull();
    expect(withdrawing(parked, RETREAT_MS * 3, null)).toBeNull();
  });

  test("it fades, and late enough to be watched withdrawing", () => {
    const a = (u: number) => withdrawing(parked, u * RETREAT_MS, null)!.alpha;
    expect(a(0)).toBeCloseTo(1, 6);
    /* Held: half way home it is still plainly there. An even fade spends half
       the animation on a root too faint to see moving, which is the only thing
       there is to watch. */
    expect(a(0.5)).toBeGreaterThan(0.8);
    expect(a(0.9)).toBeLessThan(0.3);
    for (const u of [0.1, 0.3, 0.5, 0.7, 0.9]) expect(a(u)).toBeGreaterThan(a(u + 0.05));
  });

  test("it stays a whole tapered root while it shrinks", () => {
    const home = withdrawing(parked, RETREAT_MS * 0.5, null)!;
    const ring = outline(home.limb, 8);
    const width = (i: number) => dist(ring[i], ring[ring.length - 1 - i]);
    /* The mirror of growth: the profile is read against what is left, so what
       withdraws is a shorter complete root rather than a clipped long one. */
    expect(width(0)).toBeGreaterThan(width(8));
  });

  /* The whole reason a retreat is anchored to a card rather than to the glass:
     the wall can be panned or the parent dragged while a root is going home, and
     half a second glued to the screen is a root pointing at nothing. */
  test("it is carried by the card it is going back to", () => {
    const moved = { ...PARENT, x: PARENT.x + 300, y: PARENT.y - 120 };
    const still = withdrawing(parked, RETREAT_MS * 0.4, null)!;
    const carried = withdrawing(parked, RETREAT_MS * 0.4, moved)!;
    expect(carried.limb.spine[0].x - still.limb.spine[0].x).toBeCloseTo(300, 6);
    expect(carried.limb.spine[0].y - still.limb.spine[0].y).toBeCloseTo(-120, 6);
    /* Every point by the same amount — it is a translation, not a redrawing. */
    expect(carried.limb.spine[3].x - still.limb.spine[3].x).toBeCloseTo(300, 6);
  });

  test("a parent that has gone too leaves the frozen coordinates alone", () => {
    const orphaned = withdrawing(parked, RETREAT_MS * 0.4, null)!;
    expect(orphaned.limb.spine[0]).toEqual(parked.limb.spine[0]);
  });

  /* A card can be closed while its root is still on its way out. It should go
     back from wherever it had got to, not snap out to full length first. */
  test("a root that never finished growing retreats from where it was", () => {
    const half: Departing = { ...parked, limb: { ...parked.limb, reach: 0.4 } };
    const home = withdrawing(half, RETREAT_MS * 0.2, null)!;
    expect(home.limb.reach).toBeLessThan(0.4);
    expect(home.limb.reach).toBeGreaterThan(0);
  });

  test("the reel is slow, quick, slow rather than a yank", () => {
    expect(reeled(0)).toBe(0);
    expect(reeled(1)).toBe(1);
    expect(reeled(0.5)).toBeCloseTo(0.5, 6);
    /* Symmetric, and gentler than linear at both ends — which is what makes it
       read as letting go and then going home. */
    expect(reeled(0.1)).toBeLessThan(0.1);
    expect(reeled(0.9)).toBeGreaterThan(0.9);
    /* Clamped, so a clock that jumped cannot put a root inside out. */
    expect(reeled(-2)).toBe(0);
    expect(reeled(5)).toBe(1);
    expect(fading(-2)).toBe(1);
    expect(fading(5)).toBe(0);
  });
});

describe("the spine a charge runs along", () => {
  test("it is the centreline, and it stops where the root does", () => {
    const born = 0;
    const [limb] = limbsFor(PARENT, [kid("a", 1200, 0, born)], {
      scale: 1,
      now: born + GROW_MS / 2,
    });
    const pts = spine(limb, 0, 1, 6);
    expect(pts.length).toBe(7);
    expect(pts[0]).toEqual(limb.spine[0]);
    /* Not the child's rim: half a root is half a spine, so a charge cannot run
       further than the thing carrying it. */
    expect(dist(pts[pts.length - 1], limb.spine[3])).toBeGreaterThan(1);
  });
});
