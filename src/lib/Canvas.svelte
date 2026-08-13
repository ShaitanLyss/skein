<script lang="ts">
  import type { Conversation } from "./conversation.svelte";
  import {
    Studio,
    layout,
    wallOrder,
    CARD_BOX,
    Z_CARD,
    Z_CHIP,
    type Territory,
  } from "./studio.svelte";
  import type { Board } from "./images.svelte";
  import type { Widgets } from "./widgets.svelte";
  import type { Meter } from "./meter.svelte";
  import type { Profile } from "./ambience";
  import { stub } from "./outline";
  import Backdrop from "./Backdrop.svelte";
  import Card from "./Card.svelte";
  import Seats from "./Seats.svelte";
  import ImageNode from "./ImageNode.svelte";
  import WidgetNode from "./WidgetNode.svelte";

  let {
    convs,
    projects,
    studio,
    board,
    widgets,
    meter,
    naming,
    onreveal,
    ambience,
    focusedId,
    chipsFor,
    actionsFor,
    onaction,
    onfocus,
    ondeselect,
    onclose,
    onpin,
    onplace,
    onserver,
    onadd,
  }: {
    convs: Conversation[];
    /** Every project the studio knows, so a territory outlives its last card. */
    projects: Territory[];
    studio: Studio;
    board: Board;
    /** The instruments hung on the wall — a clock, a performance meter. */
    widgets: Widgets;
    /** The one process sampler behind however many meters are up. */
    meter: Meter;
    /** What a performance row's role and reference are called up here. */
    naming: (role: string, reference: string | null) => string | null;
    /** Go and look at whatever a widget row points at. */
    onreveal?: (role: string, reference: string) => void;
    /** What the wall does when nobody is asking it anything, or null for a bare
     *  one. Drawn inside the surface rather than in App, so it covers exactly
     *  the wall and never the transcript you are reading. */
    ambience: Profile | null;
    focusedId: string | null;
    /** Dev-server groups belonging to the project that owns a directory. */
    chipsFor?: (cwd: string) => { id: string; label: string; state: string; running: boolean }[];
    /** What the project itself can be asked to do — build, test, ship, push. */
    actionsFor?: (cwd: string) => {
      id: string;
      label: string;
      title: string;
      state: string;
      pct: number | null;
      quiet: boolean;
      idle: boolean;
    }[];
    onaction?: (cwd: string, id: string) => void;
    onfocus: (id: string) => void;
    /** Let go of everything: a click on bare ground. The focus lives in App
     *  beside the panel it opens, so the canvas can only report the gesture. */
    ondeselect?: () => void;
    onclose: (conv: Conversation) => void;
    onpin?: (id: string, x: number, y: number) => void;
    /** A territory was carried somewhere. `null` gives it back to the grid. */
    onplace?: (cwd: string, x: number | null, y: number | null) => void;
    onserver?: (groupId: string) => void;
    /** New conversation in an existing project. `worktree` branches it. */
    onadd?: (cwd: string, worktree?: string) => void;
  } = $props();

  /** Which territory is showing its "name a worktree" input. */
  let branching = $state<string | null>(null);
  let branchName = $state("");

  let surface: HTMLDivElement | undefined = $state();

  /** Screen point → canvas point. Everything that manipulates a node needs
   *  this, because the layer is translated and scaled under them. */
  export function toCanvas(clientX: number, clientY: number) {
    const r = surface?.getBoundingClientRect();
    return {
      x: ((clientX - (r?.left ?? 0)) - studio.x) / studio.scale,
      y: ((clientY - (r?.top ?? 0)) - studio.y) / studio.scale,
    };
  }

  /* While a territory is being carried, where it is comes from the gesture
     rather than from the row that will be written on release. */
  let carried = $state<{ cwd: string; x: number; y: number } | null>(null);
  const territories = $derived.by(() => {
    const c = carried;
    if (!c) return projects;
    return projects.map((p) =>
      p.root_path === c.cwd ? { ...p, x: c.x, y: c.y } : p,
    );
  });

  const model = $derived(layout(convs, studio.placements, territories));

  /** Who is wandering about, for the footprints effect: the cards on the wall,
   *  by whatever they are called. An untitled card gives its project's name
   *  instead — "untitled" crossing the wall says nothing about anything.
   *
   *  Stubbed, with the rails' own function: a card's title is a sentence
   *  ("Review remaining implementation tasks from design") and a name floating
   *  over a pair of footprints has room for about three words. */
  const wanderers = $derived(
    convs.map((c) =>
      stub(c.title && c.title !== "untitled" ? c.title : c.project, 22),
    ),
  );

  /* ── panning the ground ─────────────────────────────────── */
  /* $state because the template reads it for the grab/grabbing cursor. */
  let pan = $state<{ sx: number; sy: number; ox: number; oy: number } | null>(
    null,
  );

  /** Shift-drag on bare ground gathers cards; plain drag pans. */
  let marquee = $state<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null,
  );

  const marqueeBox = $derived(
    marquee
      ? {
          x: Math.min(marquee.x0, marquee.x1),
          y: Math.min(marquee.y0, marquee.y1),
          w: Math.abs(marquee.x1 - marquee.x0),
          h: Math.abs(marquee.y1 - marquee.y0),
        }
      : null,
  );

  /** Is this press on the ground rather than on something that lives on it?
   *
   *  This used to be `e.target === surface`, which looks equivalent and is not.
   *  `.layer` is an absolutely positioned box the size of the viewport, so a
   *  press anywhere inside it lands on the layer and never on the surface —
   *  and panning simply did nothing over that whole area. It went unnoticed
   *  because the layer is transformed: after any pan there is a margin of bare
   *  surface where dragging still worked, so the wall felt draggable in some
   *  places and inert in others, the inert part being wherever the projects
   *  were. Cards, images and controls still handle their own presses. */
  function isGround(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el?.closest) return false;
    return !el.closest(
      "[data-conv], [data-image], [data-widget], [data-region], button, input, textarea, a",
    );
  }

  /* A press on the ground, whichever button made it. The right button pans as
     readily as the left, and a pan that happened must not also leave a menu
     behind when the button comes up — the gesture was "move the wall", not
     "ask the wall something". Chromium fires `contextmenu` on release on
     Windows, so by the time it arrives this knows which one it was. */
  let ground: { button: number; sx: number; sy: number; moved: boolean } | null =
    null;
  let swallowMenu = false;

  function groundMenu(e: MouseEvent) {
    if (!swallowMenu) return;
    swallowMenu = false;
    /* Stopped as well as prevented: the studio's own handler is on an ancestor
       and would open Skein's menu even with the native one suppressed. */
    e.preventDefault();
    e.stopPropagation();
  }

  function groundDown(e: PointerEvent) {
    if (!isGround(e.target)) return;
    ground = { button: e.button, sx: e.clientX, sy: e.clientY, moved: false };
    surface?.setPointerCapture(e.pointerId);

    if (e.shiftKey) {
      const p = toCanvas(e.clientX, e.clientY);
      marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      return;
    }
    pan = { sx: e.clientX, sy: e.clientY, ox: studio.x, oy: studio.y };
  }

  function groundMove(e: PointerEvent) {
    if (ground && !ground.moved) {
      const far =
        Math.hypot(e.clientX - ground.sx, e.clientY - ground.sy) >= DRAG_SLOP;
      /* The same slop a card drag uses, so a right-click with an unsteady hand
         still opens a menu. */
      if (far) ground.moved = true;
    }
    if (marquee) {
      const p = toCanvas(e.clientX, e.clientY);
      marquee = { ...marquee, x1: p.x, y1: p.y };
      return;
    }
    if (!pan) return;
    studio.x = pan.ox + (e.clientX - pan.sx);
    studio.y = pan.oy + (e.clientY - pan.sy);
  }

  function groundUp(e: PointerEvent) {
    if (marqueeBox) {
      const b = marqueeBox;
      /* Anything the rectangle touches, not only what it fully contains —
         a lasso you have to draw perfectly is a lasso you stop using. The card's
         size is whatever the current density draws, not the wall's. */
      const card = CARD_BOX[studio.lod];
      const hit = model.laid
        .filter(
          (n) =>
            n.x < b.x + b.w &&
            n.x + card.w > b.x &&
            n.y < b.y + b.h &&
            n.y + card.h > b.y,
        )
        .map((n) => n.conv.id);
      studio.selected = [...new Set([...studio.selected, ...hit])];
    }
    /* A click on bare ground lets go of everything — the card, the gathering
       and any reference image. On the *release*, and only if the press never
       moved: it used to happen on pointerdown, which meant dragging the wall to
       look at something dropped the gathering you had assembled on the way. A
       pan is how you read this wall, not how you change your mind about it.
       Shift is the additive gesture, so a marquee never clears either. */
    if (ground && !ground.moved && !marquee && ground.button === 0) {
      studio.clearSelection();
      board.selected = null;
      widgets.selected = null;
      ondeselect?.();
    }
    if (ground?.moved && ground.button === 2) swallowMenu = true;
    ground = null;
    marquee = null;
    pan = null;
    if (surface?.hasPointerCapture(e.pointerId)) {
      surface.releasePointerCapture(e.pointerId);
    }
  }

  /* ── dragging a card pins it ────────────────────────────── */
  const DRAG_SLOP = 4;
  let drag: {
    id: string;
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    moved: boolean;
  } | null = null;
  let suppressClick = false;

  function cardDown(e: PointerEvent, id: string, x: number, y: number) {
    if (e.button !== 0) return;
    /* Record the gesture, but do NOT capture the pointer yet. Capturing on
       pointerdown retargets the eventual `click` to this wrapper, which silently
       swallows every button inside the card — close included. */
    drag = { id, sx: e.clientX, sy: e.clientY, ox: x, oy: y, moved: false };
  }

  function cardMove(e: PointerEvent) {
    if (!drag) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < DRAG_SLOP) return;
      drag.moved = true;
      /* Only now is it a drag rather than a click, so capturing is safe. */
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    /* Screen delta → canvas delta. Without dividing by scale a card would
       outrun the cursor when zoomed out and lag it when zoomed in. */
    studio.pin(drag.id, drag.ox + dx / studio.scale, drag.oy + dy / studio.scale);
  }

  function cardUp(e: PointerEvent) {
    if (!drag) return;
    if (drag.moved) {
      suppressClick = true;
      /* Commit the pin only once, on release — not on every pointermove. */
      const p = studio.placements[drag.id];
      if (p) onpin?.(drag.id, p.x, p.y);
    }
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    drag = null;
  }
  /* ── dragging a territory carries the project ───────────── *
   *
   * The handle is the territory's own name, not the territory: `.region` fills
   * most of the wall, and a press anywhere inside one has to keep panning —
   * that whole area being inert is the bug `isGround` exists to have fixed.
   *
   * Everything standing in the territory comes along. Flowing cards do that by
   * arithmetic, since their positions are slots measured off the region's
   * origin; pinned cards are absolute canvas coordinates and have to be carried
   * by hand, or a territory would tear in two the moment it moved. */
  let terr: {
    cwd: string;
    sx: number;
    sy: number;
    ox: number;
    oy: number;
    /** Pinned members and where they started, so every frame is computed from
     *  the origin rather than accumulated — as `ox`/`oy` are for a card. */
    pins: { id: string; x: number; y: number }[];
    moved: boolean;
  } | null = null;

  function terrDown(e: PointerEvent, r: { cwd: string; x: number; y: number }) {
    if (e.button !== 0) return;
    const pins: { id: string; x: number; y: number }[] = [];
    for (const c of convs) {
      if (c.cwd !== r.cwd) continue;
      const p = studio.placements[c.id];
      if (p?.pinned) pins.push({ id: c.id, x: p.x, y: p.y });
    }
    terr = { cwd: r.cwd, sx: e.clientX, sy: e.clientY, ox: r.x, oy: r.y, pins, moved: false };
  }

  function terrMove(e: PointerEvent) {
    if (!terr) return;
    const dx = e.clientX - terr.sx;
    const dy = e.clientY - terr.sy;
    if (!terr.moved) {
      if (Math.hypot(dx, dy) < DRAG_SLOP) return;
      terr.moved = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    /* Screen delta → canvas delta, or the territory outruns the cursor when
       zoomed out and lags it when zoomed in. */
    const x = terr.ox + dx / studio.scale;
    const y = terr.oy + dy / studio.scale;
    carried = { cwd: terr.cwd, x, y };
    for (const p of terr.pins) {
      studio.pin(p.id, p.x + (x - terr.ox), p.y + (y - terr.oy));
    }
  }

  function terrUp(e: PointerEvent) {
    if (!terr) return;
    if (terr.moved && carried) {
      /* Committed once, on release: the project's row, and every card that came
         with it. From here the rows are the position again. */
      onplace?.(terr.cwd, carried.x, carried.y);
      for (const p of terr.pins) {
        const at = studio.placements[p.id];
        if (at) onpin?.(p.id, at.x, at.y);
      }
      carried = null;
    }
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    terr = null;
  }

  /* A drag must not also read as a click that focuses the card. */
  function nodeClickCapture(e: MouseEvent) {
    if (suppressClick) {
      e.stopPropagation();
      e.preventDefault();
      suppressClick = false;
    }
  }

  /* ── zoom ───────────────────────────────────────────────── *
   * The wheel zooms at the cursor; shift+wheel pans. This is deliberately not
   * Figma's convention (wheel pans, ctrl+wheel zooms), which is what this was
   * first: on a wall whose densities *are* the navigation, zoom is the gesture
   * you make constantly and panning is the one you make by dragging the ground.
   * ctrl+wheel still zooms, so the older habit costs nothing.
   *
   * Registered by hand because the listener must be non-passive to
   * preventDefault. */
  $effect(() => {
    const el = surface;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.shiftKey) {
        /* Only one axis is ever non-zero — Windows reports shift+wheel on
           deltaX, a trackpad on deltaY — so both are applied unconditionally. */
        studio.x -= e.deltaX;
        studio.y -= e.deltaY;
      } else {
        studio.zoomAt(
          e.clientX - r.left,
          e.clientY - r.top,
          Math.exp(-e.deltaY * 0.0016),
        );
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  /* Persist viewport and pins, debounced — a pan fires this every frame. */
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    void studio.x;
    void studio.y;
    void studio.scale;
    void studio.placements;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => studio.save(), 300);
  });

  /** Open a territory's worktree field, as its `+ branch` chip does. Exposed so
   *  the context menu can reach the same input rather than growing a second way
   *  to name a branch. */
  export function startBranch(cwd: string) {
    branching = cwd;
    branchName = "";
  }

  /** The cards in the order they read off the wall, for Tab and shift+Tab.
   *
   *  Asked of the canvas rather than worked out again in App, because the order
   *  has to be the order of the wall actually on screen — the same layout pass,
   *  carried territory included. */
  export function order(): Conversation[] {
    return wallOrder(model.laid);
  }

  /** Pan the least that brings a card fully into view; leave the zoom alone.
   *
   *  Tab can reach a card that is off screen, and a selection you cannot see is
   *  worse than none: the ring moves, the dock retargets, and nothing you are
   *  looking at changes. The density stays put because it is a deliberate choice
   *  — this shows you the card, it does not decide how you are reading the wall. */
  export function reveal(id: string) {
    const n = model.laid.find((l) => l.conv.id === id);
    if (!n || !surface) return;
    const box = CARD_BOX[studio.lod];
    const pad = 24; /* a card flush against the edge reads as cut off */
    const x0 = studio.x + n.x * studio.scale;
    const y0 = studio.y + n.y * studio.scale;
    const x1 = x0 + box.w * studio.scale;
    const y1 = y0 + box.h * studio.scale;
    const right = surface.clientWidth - pad;
    const bottom = surface.clientHeight - pad;
    /* Top-left wins where a card is taller or wider than the viewport, which is
       what `open` on a short window is: better to see its head than its foot. */
    const dx = x0 < pad ? pad - x0 : x1 > right ? right - x1 : 0;
    const dy = y0 < pad ? pad - y0 : y1 > bottom ? bottom - y1 : 0;
    if (!dx && !dy) return;
    studio.x += dx;
    studio.y += dy;
    /* The debounced save above is watching x/y, so nothing to persist by hand. */
  }

  export function fitAll() {
    if (!surface) return;
    /* References and instruments are part of the wall, so framing "everything"
       has to include them — otherwise Home hides the board you just pinned up,
       or the clock you just hung. */
    const boxes = [
      ...model.regions,
      ...[...board.images, ...widgets.items].map((n) => ({
        project: "",
        cwd: n.id,
        x: n.x,
        y: n.y,
        w: n.w,
        h: n.h,
      })),
    ];
    studio.fit(boxes, surface.clientWidth, surface.clientHeight);
  }
</script>

<div
  class="surface"
  bind:this={surface}
  onpointerdown={groundDown}
  onpointermove={groundMove}
  onpointerup={groundUp}
  onpointercancel={groundUp}
  oncontextmenu={groundMenu}
  class:panning={!!pan}
  role="presentation"
>
  <!-- Behind everything, and outside `.layer`: ambience is drawn in screen space
       so panning the wall does not drag the weather along with it. The names are
       the cards standing on the wall — the footprints effect borrows them rather
       than inventing anybody. -->
  <Backdrop profile={ambience} names={wanderers} />

  <div
    class="layer"
    style:transform="translate({studio.x}px, {studio.y}px) scale({studio.scale})"
  >
    {#each model.regions as r (r.cwd)}
      <div
        class="region"
        data-name={r.project}
        data-cwd={r.cwd}
        style:left="{r.x}px"
        style:top="{r.y}px"
        style:width="{r.w}px"
        style:height="{r.h}px"
      ></div>

      <!-- The name is also the handle. A project is a place on the wall, and
           where that place is should be yours to decide — so it is grabbed by
           the one part of a territory that is a thing rather than an area. -->
      <div
        class="name"
        data-region={r.cwd}
        data-cwd={r.cwd}
        style:left="{r.x + 11}px"
        style:top="{r.y + 8}px"
        style:z-index={Z_CHIP}
        title="{r.project} — drag to move it, and everything in it"
        onpointerdown={(e) => terrDown(e, r)}
        onpointermove={terrMove}
        onpointerup={terrUp}
        onpointercancel={terrUp}
        role="presentation"
      >
        {r.project}
      </div>

      <!-- Dev servers belong to the territory, not to a panel somewhere else:
           "is the backend up" is a property of the project you're looking at. -->
      {#if studio.lod !== "field"}
        {@const chips = chipsFor?.(r.cwd) ?? []}
        <div
          class="chips"
          style:left="{r.x + r.w - 8}px"
          style:top="{r.y + 7}px"
          style:z-index={Z_CHIP}
        >
          {#each chips as c (c.id)}
            <button
              class="chip"
              data-state={c.state}
              title={c.running ? "Running — click to stop" : "Click to start"}
              onclick={() => onserver?.(c.id)}
            >
              <i></i>{c.label}
            </button>
          {/each}

          <!-- Adding another conversation to a project you already have should
               cost one click and no typing. -->
          {#if branching === r.cwd}
            <span class="branch">
              <!-- Focused on appearance: the input is opened by a click on a
                   chip, so without this the very next thing you do — type the
                   branch name — goes to whatever had focus before, and the field
                   you are looking at stays empty. -->
              <input
                bind:value={branchName}
                placeholder="branch name"
                spellcheck="false"
                {@attach (el) => el.focus()}
                onblur={() => (branching = null)}
                onkeydown={(e) => {
                  if (e.key === "Enter" && branchName.trim()) {
                    onadd?.(r.cwd, branchName.trim());
                    branching = null;
                    branchName = "";
                  } else if (e.key === "Escape") {
                    branching = null;
                    branchName = "";
                  }
                }}
              />
            </span>
          {:else}
            <button
              class="chip add"
              title="New conversation in {r.project}"
              onclick={() => onadd?.(r.cwd)}>+</button
            >
            <button
              class="chip add"
              title="New conversation in its own git worktree"
              onclick={() => {
                branching = r.cwd;
                branchName = "";
              }}>+ branch</button
            >
          {/if}
        </div>

        <!-- What the project itself can be asked to do, along its bottom edge.
             Deliberately not up beside the servers: an Unreal territory offers
             six verbs, and the top row is already the project's name, its dev
             servers and two ways to start a conversation. Splitting them puts
             identity and address at the top and the work at the foot, and gives
             each row the whole width of the territory.

             It sits inside the region's own bottom padding — `REGION_PAD` below
             the last row of slots — which is why nothing here changes with the
             density: the row is the same size at `wall` and at `open`, and both
             have room for it. -->
        {@const acts = actionsFor?.(r.cwd) ?? []}
        {#if acts.length}
          <div
            class="acts"
            data-cwd={r.cwd}
            style:left="{r.x + 11}px"
            style:top="{r.y + r.h - 21}px"
            style:z-index={Z_CHIP}
          >
            {#each acts as a (a.id)}
              <button
                class="chip act"
                data-run={a.state}
                class:quiet={a.quiet}
                disabled={a.idle}
                style:--p="{a.pct ?? 0}%"
                title={a.title}
                onclick={() => onaction?.(r.cwd, a.id)}
              >
                <i></i>{a.label}{#if a.pct !== null}<em>{a.pct}%</em>{/if}
              </button>
            {/each}
          </div>
        {/if}
      {/if}
    {/each}

    <!-- References sit beneath the cards. The wall is a working surface first
         and a mood board second; a photo should never cover live work. -->
    {#each board.images as img (img.id)}
      <ImageNode
        {img}
        src={board.src(img)}
        selected={board.selected === img.id}
        scale={studio.scale}
        {toCanvas}
        onselect={() => {
          board.selected = img.id;
          board.bringToFront(img.id);
        }}
        onupdate={(patch) => board.update(img.id, patch)}
        onremove={() => board.remove(img.id)}
      />
    {/each}

    <!-- Instruments. They stack in the same two bands a reference image does —
         behind the work by default, in front of everything when you say so —
         because to the wall they are the same kind of thing. -->
    {#each widgets.items as w (w.id)}
      <WidgetNode
        widget={w}
        selected={widgets.selected === w.id}
        scale={studio.scale}
        {meter}
        {naming}
        {toCanvas}
        {onreveal}
        onselect={() => {
          widgets.selected = w.id;
          /* One thing is held at a time: selecting a widget lets go of any
             reference image, or Delete would be aimed at whichever of them was
             picked first. */
          board.selected = null;
        }}
        onupdate={(patch) => widgets.update(w.id, patch)}
        onremove={() => void widgets.remove(w.id)}
      />
    {/each}

    {#if marqueeBox}
      <div
        class="marquee"
        style:left="{marqueeBox.x}px"
        style:top="{marqueeBox.y}px"
        style:width="{marqueeBox.w}px"
        style:height="{marqueeBox.h}px"
      ></div>
    {/if}

    {#each model.laid as n (n.conv.id)}
      <div
        class="node"
        data-conv={n.conv.id}
        style:left="{n.x}px"
        style:top="{n.y}px"
        style:z-index={Z_CARD}
        onpointerdown={(e) => cardDown(e, n.conv.id, n.x, n.y)}
        onpointermove={cardMove}
        onpointerup={cardUp}
        onpointercancel={cardUp}
        onclickcapture={nodeClickCapture}
        role="presentation"
      >
        {#if n.conv.seats.length}
          <Seats seats={n.conv.seats} scale={studio.scale} />
        {/if}
        <Card
          conv={n.conv}
          focused={n.conv.id === focusedId}
          selected={studio.isSelected(n.conv.id)}
          pinned={n.pinned}
          lod={studio.lod}
          onfocus={(e) => {
            /* Shift adds to the gathering; a plain click starts a new one. */
            if (e.shiftKey) studio.toggle(n.conv.id);
            else studio.selectOnly(n.conv.id);
            onfocus(n.conv.id);
          }}
          onclose={() => onclose(n.conv)}
        />
      </div>
    {/each}
  </div>
</div>

<style>
  .surface {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    cursor: grab;
    touch-action: none;
    /* On the wall a press-and-move is always a gesture — pan, marquee, or
       carrying a card — and never a text selection. Without this, dragging a
       card highlighted its title and activity line instead of moving it, and
       the highlight persisted after the drop. Reading and copying happen in the
       transcript panel, which is outside the canvas. */
    user-select: none;
  }
  /* Except where typing is the point: the territory's worktree field. */
  .surface input {
    user-select: text;
  }
  .surface.panning {
    cursor: grabbing;
  }

  .layer {
    position: absolute;
    inset: 0;
    transform-origin: 0 0;
    will-change: transform;
  }

  /* Territory. Faint on purpose — it is an address, not a container. */
  .region {
    position: absolute;
    border: 1px dashed var(--edge);
    border-radius: 6px;
    /* Was pointer-events: none, so presses would fall through to the surface.
       They fell through to `.layer` instead and did nothing — and now that
       `isGround` decides by what a press is *not* on, a territory can take its
       own events without swallowing a pan: right-clicking one is how you get a
       menu that knows which project you meant. */
  }
  /* The territory's name, and the handle that carries it. It was drawn with
     `.region::after` until the wall had to be arrangeable — a pseudo-element
     cannot be pressed, and making the whole region draggable would have taken
     the pan back off most of the wall. */
  .name {
    position: absolute;
    font-family: var(--util);
    font-size: 0.64rem;
    font-weight: 600;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--paper-faint);
    white-space: nowrap;
    cursor: grab;
    /* Room to aim at, without moving where the name reads from. */
    padding: 0.15rem 0.3rem;
    margin: -0.15rem -0.3rem;
    border-radius: 3px;
  }
  .name:hover {
    color: var(--paper-mute);
    background: var(--surface);
  }
  .name:active {
    cursor: grabbing;
  }

  /* z-index is set inline from Z_CHIP — see the stacking note in layout.ts. */
  .chips {
    position: absolute;
    transform: translateX(-100%);
    display: flex;
    gap: 0.28rem;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-family: var(--util);
    font-size: 0.62rem;
    color: var(--paper-mute);
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 999px;
    padding: 0.14rem 0.5rem 0.14rem 0.42rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .chip:hover {
    color: var(--paper);
    border-color: var(--rule);
  }
  .chip i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--paper-faint);
  }
  .chip[data-state="up"] i {
    background: var(--st-work);
  }
  .chip[data-state="starting"] i {
    background: var(--st-soft);
  }
  .chip[data-state="exited"] i {
    background: var(--st-fail);
  }
  .chip[data-state="exited"] {
    border-color: color-mix(in srgb, var(--st-fail) 45%, var(--edge));
  }
  .chip.add {
    color: var(--paper-faint);
    border-style: dashed;
  }
  .chip.add:hover {
    color: var(--paper);
    border-style: solid;
  }

  /* The project's own verbs, along the foot of its territory. Same chip, laid
     out from the left rather than the right, because this row grows with what
     a project is and the other grows with what you have started in it. */
  .acts {
    position: absolute;
    display: flex;
    gap: 0.28rem;
  }
  .act {
    /* A build's progress is drawn *in* the chip rather than beside it: a
       separate bar would need room the wall does not have, and the fill reads
       at a glance from across the room, which is the whole argument for the
       densities. `--p` is set inline from the run. */
    background:
      linear-gradient(
          to right,
          color-mix(in srgb, var(--st-work) 26%, transparent) var(--p, 0%),
          transparent var(--p, 0%)
        )
        var(--surface);
    /* Nothing about the chip may resize while a build runs, or the row shuffles
       under the cursor every few seconds. */
    transition: background 0.4s linear;
  }
  .act em {
    font-style: normal;
    font-variant-numeric: tabular-nums;
    color: var(--paper-faint);
    margin-left: 0.1rem;
  }
  /* Colour is status and nothing else: celadon working, rust failed. A run that
     finished cleanly leaves the faintest possible mark — enough to answer "did
     that build go through", not enough to draw the eye. */
  .act[data-run="running"] i {
    background: var(--st-work);
  }
  .act[data-run="ok"] i {
    background: color-mix(in srgb, var(--st-work) 55%, var(--paper-faint));
  }
  .act[data-run="failed"] i {
    background: var(--st-fail);
  }
  .act[data-run="failed"] {
    border-color: color-mix(in srgb, var(--st-fail) 45%, var(--edge));
    color: var(--paper);
  }
  /* Nothing to push, or nothing to do at all. Still drawn — a verb that comes
     and goes is a wall you have to re-read. */
  .act.quiet,
  .act:disabled {
    color: var(--paper-faint);
    opacity: 0.7;
  }
  .act:disabled {
    cursor: default;
  }
  .act.quiet:hover {
    opacity: 1;
  }

  .branch input {
    font-family: var(--mono);
    font-size: 0.62rem;
    background: var(--well);
    border: 1px solid var(--paper-faint);
    border-radius: 999px;
    color: var(--paper);
    padding: 0.14rem 0.55rem;
    width: 120px;
  }
  .branch input:focus {
    outline: none;
  }
  .branch input::placeholder {
    color: var(--paper-faint);
  }

  .marquee {
    position: absolute;
    border: 1px solid var(--paper-faint);
    background: color-mix(in srgb, var(--paper) 6%, transparent);
    border-radius: 2px;
    pointer-events: none;
    z-index: 999;
  }

  /* z-index is set inline from Z_CARD. A reference image sits below the cards
     by default and above everything once brought to the front — one order for
     the whole wall, described in layout.ts. */
  .node {
    position: absolute;
    cursor: grab;
  }
  .node:active {
    cursor: grabbing;
  }
</style>
