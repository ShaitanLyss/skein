<script lang="ts">
  /* One instrument on the wall: the frame, the two gestures it answers, and
   * whichever face its kind draws.
   *
   * The same shape `ImageNode` has, minus rotation — a reference photo pinned
   * at an angle is a reference photo, and a clock at an angle is a clock you
   * cannot read. Everything else is deliberately identical, because to the wall
   * these are the same kind of thing: hand-placed, freely sized, belonging to no
   * project. */

  import type { Meter } from "./meter.svelte";
  import { specFor, type Widget } from "./widgets";
  import Clock from "./Clock.svelte";
  import Perf from "./Perf.svelte";

  let {
    widget,
    selected,
    scale,
    meter,
    naming,
    toCanvas,
    onselect,
    onupdate,
    onremove,
    onreveal,
  }: {
    widget: Widget;
    selected: boolean;
    /** Canvas zoom, so the handles stay a constant size on screen. */
    scale: number;
    meter: Meter;
    naming: (role: string, reference: string | null) => string | null;
    toCanvas: (clientX: number, clientY: number) => { x: number; y: number };
    onselect: () => void;
    onupdate: (patch: Partial<Widget>) => void;
    onremove: () => void;
    onreveal?: (role: string, reference: string) => void;
  } = $props();

  const spec = $derived(specFor(widget.kind));
  const hs = $derived(11 / scale);

  type Gesture = {
    kind: "move" | "size";
    ox: number;
    oy: number;
    w0: number;
    h0: number;
    px: number;
    py: number;
    /** Screen pixels, for the slop — canvas units shrink with the zoom. */
    sx: number;
    sy: number;
    moved: boolean;
  };

  /** The same 4px a card drag uses, and for a sharper reason here: a widget can
   *  hold buttons, and capturing the pointer on `pointerdown` retargets the
   *  eventual `click` to this wrapper — which silently swallows every one of
   *  them. So a press is a click until it has travelled far enough to be a
   *  drag, and only then is the pointer captured. */
  const SLOP = 4;

  let gesture: Gesture | null = null;

  function begin(e: PointerEvent, kind: Gesture["kind"]) {
    if (e.button !== 0) return;
    e.stopPropagation();
    onselect();
    const p = toCanvas(e.clientX, e.clientY);
    gesture = {
      kind,
      ox: widget.x,
      oy: widget.y,
      w0: widget.w,
      h0: widget.h,
      px: p.x,
      py: p.y,
      sx: e.clientX,
      sy: e.clientY,
      /* A resize grip is unambiguous — nothing else is under it, and it is
         small enough that requiring travel would make it feel stuck. */
      moved: kind === "size",
    };
    if (kind === "size") (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function move(e: PointerEvent) {
    if (!gesture) return;
    if (!gesture.moved) {
      if (Math.hypot(e.clientX - gesture.sx, e.clientY - gesture.sy) < SLOP) return;
      gesture.moved = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    e.stopPropagation();
    const p = toCanvas(e.clientX, e.clientY);

    if (gesture.kind === "move") {
      onupdate({
        x: gesture.ox + (p.x - gesture.px),
        y: gesture.oy + (p.y - gesture.py),
      });
      return;
    }
    /* Free aspect, unlike an image: a clock stays square inside whatever box it
       is given, and a process list genuinely wants to be wider than it is tall.
       The floor is the widget's own, from the catalogue — below it the face
       stops saying anything and the handles start overlapping each other. */
    const min = spec?.min ?? { w: 60, h: 48 };
    onupdate({
      w: Math.max(min.w, gesture.w0 + (p.x - gesture.px)),
      h: Math.max(min.h, gesture.h0 + (p.y - gesture.py)),
    });
  }

  function end(e: PointerEvent) {
    if (!gesture) return;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    gesture = null;
  }
</script>

<div
  class="widget"
  data-widget={widget.id}
  data-kind={widget.kind}
  class:selected
  style:left="{widget.x}px"
  style:top="{widget.y}px"
  style:width="{widget.w}px"
  style:height="{widget.h}px"
  style:z-index={widget.z}
  onpointerdown={(e) => begin(e, "move")}
  onpointermove={move}
  onpointerup={end}
  onpointercancel={end}
  role="presentation"
>
  <div class="face">
    {#if widget.kind === "clock"}
      <Clock {widget} />
    {:else if widget.kind === "performance"}
      <Perf {widget} {meter} {naming} {onreveal} />
    {/if}
  </div>

  {#if selected}
    <button
      class="grip size"
      style:width="{hs}px"
      style:height="{hs}px"
      style:right="{-hs / 2}px"
      style:bottom="{-hs / 2}px"
      onpointerdown={(e) => begin(e, "size")}
      onpointermove={move}
      onpointerup={end}
      aria-label="Resize"
    ></button>

    <button
      class="grip shut"
      style:width="{hs}px"
      style:height="{hs}px"
      style:right="{-hs / 2}px"
      style:top="{-hs / 2}px"
      onpointerdown={(e) => e.stopPropagation()}
      onclick={onremove}
      aria-label="Take it down"
    ></button>
  {/if}
</div>

<style>
  .widget {
    position: absolute;
    cursor: grab;
    /* The faces size their type against this box — `cqw`/`cqh` in Clock and
       Perf — so a clock dragged large is a large clock rather than a small one
       in a large frame. */
    container-type: size;
    border: 1px solid var(--edge);
    border-radius: 3px;
    /* Opaque: the ambience is drawn behind everything on the wall, and an
       instrument you can see the weather through is not an instrument. */
    background: var(--ink);
    overflow: hidden;
    transition: border-color 0.15s ease;
  }
  .widget:active {
    cursor: grabbing;
  }
  .widget:hover {
    border-color: var(--rule);
  }
  .widget.selected {
    border-color: var(--paper-faint);
  }

  .face {
    width: 100%;
    height: 100%;
    /* Presses on the face carry the widget: everything inside is a reading, and
       the one thing that is not — a row you can click through to — takes its
       own press back. */
    user-select: none;
  }

  .grip {
    position: absolute;
    padding: 0;
    border: 1px solid var(--ink);
    background: var(--paper-dim);
    border-radius: 2px;
    cursor: nwse-resize;
    z-index: 2;
  }
  .grip:hover {
    background: var(--paper);
  }
  .grip.shut {
    border-radius: 50%;
    cursor: pointer;
    background: var(--st-fail);
  }
  .grip.shut:hover {
    background: color-mix(in srgb, var(--st-fail) 70%, var(--paper));
  }
</style>
