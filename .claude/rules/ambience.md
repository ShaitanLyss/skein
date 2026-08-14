---
paths:
  - "src/lib/ambience.ts"
  - "src/lib/ambience.svelte.ts"
  - "src/lib/Backdrop.svelte"
  - "src/lib/Effects.svelte"
---

# The wall's ambience

### The wall's ambience

What the ground does when nobody is asking it anything: a stack of effects you
layer, adjust while you watch them, and keep as profiles. `ambience.ts` is pure
and holds the whole vocabulary — the effect catalogue, the parameter specs, the
geometry of a brush flourish, the envelope that draws it and fades it, how the
wind varies, where a leaf is a moment later, which rings of a ripple are alive,
where somebody's next footprint lands. `Backdrop.svelte` owns one canvas and a
frame loop that only calls into it; `Effects.svelte` is the panel and builds every
control off a `ParamSpec`, so a new knob is one line in the catalogue and a new
effect is one entry plus one arm in the draw switch.

- **Screen space, not canvas space.** Panning does not drag the weather along.
  This is the light in the room rather than something pinned up, and it means an
  effect never has to answer where to spawn on a surface with no edges. The canvas
  lives inside `.surface` (not in `App`) so it covers the wall exactly and never
  the transcript you are reading, and carries no `z-index`: `.layer` follows it in
  the DOM, so everything on the wall — a back-band reference image included —
  draws over it.
- **The loop stops when nothing is drawing.** `living()` decides, and it is the
  *only* thing the start/stop effect reads. Nothing on this wall polls, and a
  `requestAnimationFrame` clearing a canvas sixty times a second to show an empty
  profile is a poll.
- **Nothing on the wall may be transparent, or the weather comes through it.**
  Since the backdrop is behind everything, whatever stands on the wall is the only
  thing occluding it — so this constraint lives in `Card.svelte`, not here. A
  dormant card was `background: transparent` on purpose ("drawn hollow, because the
  light is what's missing") and a leaf drifted straight through the middle of one;
  it is now filled with `--ink`, which is what you would have seen anyway. A
  conversation is not something the weather gets to cross. Seat bubbles, territory
  chips and the acts row were already opaque; the transcript is outside `.surface`
  entirely.
- **A parameter change must not restart anything.** The frame reads the profile
  untracked, so dragging `size` shapes the next flourish and leaves the ones
  already on the wall alone. Runtime state is keyed by layer id — which is why
  duplicating a profile re-mints them, or two profiles would share a flock.
- **Never measure a canvas against itself.** A canvas is a replaced element, so
  `width: auto` resolves to its *attribute* size and `inset: 0` is ignored:
  measuring `clientWidth` and writing it back as `el.width` multiplied the size by
  the device pixel ratio on every observed resize, and the ResizeObserver fired on
  each one. It reached 22 million pixels across before anything looked wrong. The
  element is pinned at `100%` and the box is measured off the *parent*.
- **Colour is still status.** Every layer draws in one tone mixed between `--well`
  and `--paper`, both read off the document, and `ink` is a lightness rather than a
  hue. The panel's own controls are the same: the layer-order buttons say "back"
  and "front" because `↑` falls through to Segoe UI Emoji and renders *blue*.
- **The footprint names are the cards on the wall** (stubbed with `outline.ts`'s
  own `stub`, since a title is a sentence). Nothing is invented: a made-up name
  would be flavour text on a working surface, and an empty wall gets unnamed
  prints.
- **Persistence**: `ambience_profile`, schema v4. The layer stack is one JSON
  column — every effect has its own knobs and they change as the effects do, so a
  normalised schema would mean a migration per slider, to describe data only ever
  read and written whole. Rust never parses it; `normalizeProfile` does, on every
  read, which is what makes a renamed knob or a deleted effect degrade to
  something drawable instead of a NaN inside a frame loop. `active` is at most one
  row, set in a transaction — two rows marked active would leave the front end
  picking by row order, which is a wall that changes when nothing did. Which
  profile is showing belongs here rather than in localStorage: unlike the
  viewport, it is a thing you *made*. Having none showing is a real state, so no
  empty profile is shipped.

