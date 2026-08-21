<script lang="ts">
  /* The roots, painted.
   *
   * One canvas in screen space, behind the whole wall, and a frame loop that
   * only exists while something is growing or charged. Everything it draws is
   * worked out in `lineage.ts`; nothing here decides anything you could assert.
   *
   * Five things about it are deliberate:
   *
   * - **Behind the cards, and that is the feature.** A sibling of `Backdrop`
   *   inside `.surface` and *before* `.pan` in the document, so it draws over
   *   the ambience and under the territories, the images and the cards. The
   *   relay strand is the mirror of this one layer up: above the cards is
   *   traffic, below them is structure. It also means a root arriving at a card
   *   passes under it rather than across its title.
   *
   * - **Screen space, canvas-space widths.** Endpoints come from `cardBoxes`,
   *   which is already in screen pixels for `Flow`; the widths are scaled by
   *   `studio.scale` and clamped, because a root is a thing on the ground beside
   *   the cards rather than light crossing a room. See the note over `BASE`.
   *
   * - **One fill for all of it.** Every limb of every family goes into a single
   *   `Path2D` and is filled once, so the coincident trunk of a fork unions
   *   instead of stacking its alpha into a dark seam. This is the only reason
   *   the fork can be emergent rather than computed.
   *
   * - **Endpoints are read fresh.** A card dragged takes its root with it, and
   *   so does a pan and a zoom — the root is between two *cards*. Static frames
   *   are redrawn from a reactive read of the boxes; only motion of our own
   *   costs a loop.
   *
   * - **Colour is status, so the root has none.** `--edge`, the tone the wall's
   *   own furniture is in. The one moving light is celadon and means the child
   *   is working — see the module note in `lineage.ts` for why that is the only
   *   honest way to have it.
   */

  import { hexRgb, rgba, type Rgb } from "./ambience";
  import type { Box } from "./flow";
  import {
    CHARGE_ALPHA,
    CHARGE_MS,
    FILL_ALPHA,
    HALO_ALPHA,
    SHEEN_ALPHA,
    chargeAt,
    familiesOf,
    limbsFor,
    outline,
    spine,
    stirring,
    type Kin,
    type Limb,
  } from "./lineage";

  let {
    kin,
    boxes,
    scale,
    charged,
  }: {
    /** Every recorded parentage the wall knows. Pairs whose ends are not both
     *  on the wall are dropped by `familiesOf`, so this needs no filtering. */
    kin: readonly Kin[];
    /** Every card's box in screen pixels, by id — `Canvas`'s `cardBoxes`, the
     *  same map `Flow` is given. */
    boxes: ReadonlyMap<string, Box>;
    /** The wall's zoom, which the widths follow. */
    scale: number;
    /** Which children are working this second. The only thing that moves. */
    charged: ReadonlySet<string>;
  } = $props();

  /* One clock, and it is the wall clock rather than `performance.now()`.
     `born` is stamped by `Skein` off `Date.now()`, because it mirrors a row Rust
     wrote with a unix timestamp — and two clocks in one animation is a root
     whose growth is measured against an epoch it never started from, which
     leaves `reachOf` clamped at zero and nothing drawn at all. */
  let el = $state<HTMLCanvasElement | undefined>();
  let w = 0;
  let h = 0;
  let root: Rgb = [51, 44, 41];
  let sheen: Rgb = [97, 88, 80];
  let work: Rgb = [127, 184, 164];
  /* Read once at mount, per `Flow`: a preference changing mid-growth should not
     change how a root already on the wall behaves. */
  let still = false;

  function measure() {
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const dpr = window.devicePixelRatio || 1;
    w = parent.clientWidth;
    h = parent.clientHeight;
    el.width = Math.max(1, Math.round(w * dpr));
    el.height = Math.max(1, Math.round(h * dpr));
    const ctx = el.getContext("2d");
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function readTheme() {
    if (!el) return;
    const cs = getComputedStyle(el);
    /* The wall's own furniture tone and the faintest ink on it. Read rather
       than hardcoded: the theme lives in tokens.css and only there, so a
       derived theme moves the roots with everything else. */
    root = hexRgb(cs.getPropertyValue("--edge"), root);
    sheen = hexRgb(cs.getPropertyValue("--paper-faint"), sheen);
    work = hexRgb(cs.getPropertyValue("--st-work"), work);
  }

  /** Everything to draw, this frame. Pure but for the clock. */
  function shape(now: number): Limb[] {
    const out: Limb[] = [];
    for (const family of familiesOf(kin, boxes)) {
      out.push(...limbsFor(family.parent, family.kids, { scale, now, still }));
    }
    return out;
  }

  function trace(ctx: CanvasRenderingContext2D, limbs: readonly Limb[], now: number) {
    ctx.clearRect(0, 0, w, h);
    if (limbs.length === 0) return;

    /* One path, one fill — the union is what makes a trunk out of limbs that
       merely coincide. `nonzero` rather than `evenodd`: overlapping subpaths
       have to add up, not cancel out. */
    const body = new Path2D();
    for (const limb of limbs) {
      const ring = outline(limb);
      if (ring.length === 0) continue;
      body.moveTo(ring[0].x, ring[0].y);
      for (let i = 1; i < ring.length; i += 1) body.lineTo(ring[i].x, ring[i].y);
      body.closePath();
    }
    ctx.fillStyle = rgba(root, FILL_ALPHA);
    ctx.fill(body, "nonzero");

    /* The sheen, on the parent half only, which is where the root is thick
       enough to have a top. Drawn per limb rather than into one path because it
       is a stroke and strokes do not union. */
    ctx.lineCap = "round";
    ctx.strokeStyle = rgba(sheen, SHEEN_ALPHA);
    for (const limb of limbs) {
      if (limb.reach <= 0.05) continue;
      const pts = spine(limb, 0, 0.55, 10);
      ctx.lineWidth = Math.max(0.7, limb.base * 0.34);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }

    /* The charge. Only on a root whose child is working, only once it has
       finished growing — a card's first turn opens while its root is still on
       its way out, and a charge running a root that is not there yet is light
       arriving before the thing it travelled along. */
    for (const limb of limbs) {
      if (!charged.has(limb.child) || limb.reach < 1) continue;
      /* Held rather than absent under `prefers-reduced-motion`, per `Flow`: what
         a charge says is that this child is working, and none of that is in the
         movement. A wall that answers the preference by drawing nothing has
         answered a different question. */
      const at = chargeAt(still ? CHARGE_MS * 0.42 : now);
      if (!at) continue;
      const pts = spine(limb, at.tail, at.head, 12);
      const width = Math.max(1.2, limb.base * 0.5);
      /* Halo first, wide and soft, then the core over it. Two strokes rather
         than a shadow: `shadowBlur` on a path this long is measurably slower
         and this loop runs while an agent is streaming. */
      ctx.strokeStyle = rgba(work, HALO_ALPHA);
      ctx.lineWidth = width * 3.4;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
      ctx.strokeStyle = rgba(work, still ? CHARGE_ALPHA * 0.6 : CHARGE_ALPHA);
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
  }

  $effect(() => {
    const parent = el?.parentElement;
    if (!parent) return;
    still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    measure();
    readTheme();
    const ro = new ResizeObserver(() => {
      measure();
      paint(Date.now());
    });
    ro.observe(parent);
    return () => ro.disconnect();
  });

  function paint(now: number) {
    const ctx = el?.getContext("2d");
    if (!ctx) return shape(now);
    const limbs = shape(now);
    trace(ctx, limbs, now);
    return limbs;
  }

  /* The wall moved, or the parentage changed, or a child started working: one
     frame, off a reactive read. This is what makes a static root free — the
     roots are not animated, they are simply *there*, and there is redrawn only
     when there is a different answer. */
  $effect(() => {
    void kin;
    void boxes;
    void scale;
    void charged;
    if (!el) return;
    paint(Date.now());
  });

  /* And the loop, only while something is actually moving. `stirring` is the
     whole of the decision; `Backdrop`'s rule and `Flow`'s — an idle wall runs no
     frames, and a permanent mark must not mean permanent motion.

     It reads `kin` and `charged` and deliberately *not* the boxes, so a pan does
     not tear this down and rebuild it sixty times a second. See `stirring`. */
  $effect(() => {
    if (!el || still) return;
    if (!stirring(kin, charged, Date.now())) return;
    let raf = 0;
    const step = () => {
      const now = Date.now();
      paint(now);
      /* Re-asked every frame rather than once, because both reasons to be here
         end on their own: growth finishes, and a card stops working. The effect
         above is what *starts* a loop; this is what stops one. */
      if (stirring(kin, charged, now)) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  });
</script>

<canvas class="lineage" bind:this={el}></canvas>

<style>
  /* Behind everything on the wall and in front of the weather.
     `Backdrop`'s canvas is the layer under this one and `.pan` — the whole
     transformed wall, territories and cards and all — is the layer over it, by
     document order rather than by a z-index anybody has to keep winning. A card
     is opaque (`ambience.md`), so a root reaching one goes under it.

     Pinned to 100% of `.surface` rather than measured from itself, per
     `measure()`: a canvas sized from its own box cannot grow. */
  .lineage {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }
</style>
