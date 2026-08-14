---
paths:
  - "src/lib/layout.ts"
  - "src/lib/Canvas.svelte"
  - "src/lib/studio.svelte.ts"
  - "src/lib/images.svelte.ts"
  - "src/lib/ImageNode.svelte"
---

# Layout and the wall

### Layout and the wall

`layout.ts` is pure: cards auto-flow into their project's territory (grouped by `cwd`), and
dragging one pins it forever at canvas coordinates. Pinned cards never reflow; unpinned ones
flow around them.

**Territories flow onto a grid and can be carried.** They ran along a single line off the
origin at first — project 1 at x=0, project 2 beside it, forever rightwards — so six projects
made a wall three thousand units wide and five hundred tall, and the zoom that fitted it left
every card a smudge with the lower half of the screen unused. They now settle into
`TERRITORY_COLS` columns, `REGION_GAP` under what is above them, in the order
`territoryColumn` gives — and a territory dragged by its **name** (the handle;
`.region` itself must keep panning, which is what `isGround` exists to have fixed) stays where
it was put: `project.x/y`, schema v3, null meaning "not settled yet".

Two things about that are load-bearing:

- **The packing is against real heights**, so there is no air on the wall that nothing is
  standing in. The first cut reserved a fixed cell tall enough for eight cards, and a project
  holding one sat in four hundred units of nothing with the row below pushed miles down.
- **The order fills a growing square, not a row at a time** (`territoryColumn`): 1×1, then
  2×2, then 3×3 — the new right-hand column top to bottom, then the new bottom row left to
  right, so nine projects read `1 2 5 / 3 4 6 / 7 8 9`. Filling a row across first meant three
  projects made a wall three wide and one tall, fitted at a zoom that already cost the full
  width with two thirds of the screen empty. Only the *column* comes from the order; where a
  territory lands in it is still `settleY` against real heights, so a "row" is something you
  read off the wall rather than a pitch anything reserves. Past the last square the rows
  continue left to right — with the column count fixed there is nowhere further out to grow.
- **A settled position is written down** (`Skein.#settlePlaces`, after the cards are loaded and
  whenever a project first appears), which is the only reason packing against heights is safe.
  Left unsettled, a territory's position would depend on the project list *and* on how many
  cards each project happens to hold, so the wall would rearrange itself every time a
  conversation opened — and the cards pinned inside a territory that moved are absolute canvas
  coordinates, so they would be left standing where the territory used to be. Settling happens
  once per project, or when asked for; never on a paint.

Dense packing plus never repacking means a project that has grown a lot since it was placed can
reach into its neighbour. That is what `tidy the territories` on the wall's menu is for
(`Skein.tidyProjects`) — the whole wall laid out again around what is standing on it now — and
`settle it back in` on one territory's menu, offered only when it has actually been moved.
Neither ever happens by itself. The column count is a constant for the same reason: deriving it
from how many projects there are would move every territory the moment a folder was opened.

Carrying a territory carries its cards. Flowing ones follow by arithmetic, since their slots
are measured off the region's origin; pinned ones are translated by the same delta by hand and
re-saved on release, or the territory would tear in two the moment it moved.

**Territories come from the projects, not from the cards standing in them.** Deriving them
from grouped `cwd`s meant closing the last conversation in a project took the project off the
wall — and with it the `+` that starts the next one, though finishing everything and starting
again in the same place is ordinary. `layout` takes the project list and orders regions by
it (`created_at`), which is stable whatever opens and closes; a `cwd` with cards but no
project row still gets a territory, at the end.

The counterpart is `forget_project`, on an empty territory's menu: without it every folder
ever opened accumulates, and a wall you cannot tidy stops being a wall you read. It refuses
while anything is open there, and takes closed conversations, placements and server groups
with it by cascade — rows, not transcripts, which stay on disk and can be adopted back.
`test/wall.test.ts` forgets its `.scratch` projects in `afterAll` for the same reason it
closes its cards: without that, every run would leave a territory on the real wall.

"Around them" is load-bearing and was for a long time only a claim. The flow numbered its
own slots and ignored pinned cards entirely, so a card pinned *on* the grid — which is where
most end up, since dragging one a short way pins it about where it already sat — held its
position and left its slot claimable. Every conversation opened afterwards landed in that
same corner underneath it, and pinning a card also yanked its neighbour up into the slot it
had just vacated. `slotUnder` now reserves the slot a pinned card sits on, with half a slot
of tolerance because nothing dropped by hand lands on the pitch exactly; pinned cards
further out reserve nothing, since that wall really is free. Position is meant to be *memory*, so avoid anything that reshuffles the
wall when a conversation opens or closes.

The one reshuffle there is — closing a card moves every flowing card behind it up a slot —
is therefore **walked rather than jumped**: `animate:walk` on `.node`, over `settle` in
`layout.ts`. It is the same argument as position-is-memory rather than an exception to it,
since a card that arrives somewhere without travelling has to be found again. Three things
about it:

- **It is FLIP through Svelte's `animate:` directive, but not `svelte/animate`'s `flip`.**
  That one divides by the layer's zoom twice — its factor is
  `clientWidth / rect.width / currentCSSZoom`, and Chromium's client dimensions are already
  unzoomed while rects are not, so it comes out as 1/zoom². Probed 2026-08-14 against
  Chromium 151 (`tools/probe-zoom.html`, and one card closed out of a column of four): at
  `zoom: 0.5` a neighbour that moved one slot starts 232 units away instead of 116. `settle`
  divides by `studio.scale` once, the same bargain `toCanvas`, the drag deltas and `reveal`
  make.
- **The directive fires only when the keyed block is mutated**, which is exactly the reach
  wanted: closing and opening animate, and carrying a territory or dragging a card — which
  move cards without touching the list — stay glued to the cursor. There is nothing to
  suppress.
- **A pinned card is in the block and costs nothing.** It did not move, so `settle` gives it
  no distance and no duration; that is also why the duration is a function of distance rather
  than a constant.

Cards are placed on a fixed pitch (`SLOT_W`/`SLOT_H`) that does not change with zoom, so
**every density's card must fit its slot** — `CARD_BOX` in `layout.ts` records the size each
one draws at, and `layout.test.ts` asserts the invariant. It did not always hold: `open` drew
a 288-wide card on a 248 pitch, covering exactly the strip where the neighbour's context ring
sits. `open` therefore grows downwards only. Changing a `[data-lod]` size in `Card.svelte`
means updating `CARD_BOX` to match.

**The viewport is two boxes, and the split is what keeps the text sharp.** It was one,
carrying `translate(x, y) scale(s)`, and every card on the wall was soft at most zoom levels.
A `scale()` re-lays-out nothing: the subtree is laid out once at scale 1, rasterised at
whatever raster scale the compositor picked, and that bitmap is stretched. Chromium
re-rasterises when the displayed scale drifts far enough — but `will-change: transform` is a
promise the transform will keep changing, so it deliberately *pins* the raster scale instead
of re-rastering per frame. Sharp where the two happened to agree, smeared everywhere else,
occasionally snapping into focus a moment after the wheel stopped. It reads as a
machine-specific fault and is not: at 1.5× or 2× device pixel ratio the extra samples hide it,
so the same build looks fine on one monitor and poor on another.

So `.pan` translates and `.layer` zooms. A translation cannot change the raster scale, and
`zoom` is not a transform — it multiplies used lengths, so the subtree genuinely re-lays-out
and every glyph is rastered at the size it is shown at. Three things follow:

- **`will-change: transform` is worn only during a gesture** (`moved()`, released 180ms after
  the last movement). Holding it permanently is what pinned the raster scale, and it also
  costs subpixel antialiasing, since a promoted layer gets greyscale AA.
- **Nothing else had to change.** Everything on the wall is positioned in canvas units with
  `left`/`top`, which `zoom` scales; and `toCanvas`, the drag deltas and `reveal` all work off
  `studio.scale` rather than reading the DOM. `getBoundingClientRect` accounts for zoom, so
  the control surface's `dom` and `real.click` are unaffected too.
- **`zoom` re-lays-out, so card boxes are no longer exactly linear in the scale** — layout
  rounding moves them a fraction of a canvas unit between densities. Harmless against
  `CARD_BOX`, which has ~11 units of slack under `SLOT_H`, but it is why cards are all
  `white-space: nowrap`: text that wrapped would wrap *differently* at different zooms.

`-webkit-font-smoothing: antialiased` in `tokens.css` stays, deliberately. Removing it brings
back Windows subpixel AA, which puts colour fringes on every glyph — on this wall colour is
status, and greyscale AA at the correct raster size is sharp without it.

`.layer` is `inset: 0`, so at rest it
covers the surface exactly. "The ground" therefore cannot mean `e.target === surface`, which
was true *nowhere*: panning worked only in the margin the layer had been translated off, so
the wall felt draggable in some places and inert wherever the projects were. `isGround`
asks what the press is *not* on instead. For the same reason the surface sets
`user-select: none` — a press-and-move on the wall is always a gesture, and without it
dragging a card highlighted its title instead of carrying it. The transcript panel is
outside the canvas and stays selectable, because that is where you read and copy.

The right button pans as readily as the left, and a right-press that *moved* swallows the
`contextmenu` that Windows fires on release — the gesture was "move the wall", not "ask the
wall something". It uses the same 4px slop as a card drag, so an unsteady right-click still
opens a menu. Typing on the wall with a card in hand goes to the dock's field, carrying the
keystroke that started it across by hand: focus moves during that same keydown, and what
happens to that character is not something to leave to the browser. It is suppressed while a
menu is open, which is also why a `menu` op left open by a failing test makes the next
typing test look broken.

**Tab steps the focus along the wall**, shift+Tab back, from anywhere that is not a field —
in the wall's own reading order (`wallOrder` in `layout.ts`: territory by territory, top row
first), not open order, since a pinned card keeps its place in open order while sitting
anywhere. It lands on a card exactly as clicking it does — focus *and* the gathering, or the
dock would still aim a broadcast at whatever was picked before — and `Canvas.reveal` pans the
least that brings it into view, never zooming, because a selection you cannot see is worse
than none. Tab therefore no longer walks the browser's focus ring here, and the waiting cycle
that used to own the key (the dock's `N waiting` chip, urgency order) is Ctrl+Tab.

**Letting go is a click on bare ground, or Escape** — and it drops all three things that
being held consists of: the focus ring, the gathering, and the panel that the focus opens
(`ondeselect` in `App.svelte`, which the canvas can only *report* since the focus lives up
beside the panel). It used to drop one of them. `groundDown` cleared `studio.selected` and
nothing cleared `focusedId`, so clicking the wall left the card lit with its transcript open,
Escape did nothing anywhere, and there was no way back to a bare wall short of closing a
conversation. Two things about it:

- **On the release, and only if the press never moved.** Clearing on `pointerdown` meant
  dragging the wall to look at something dropped the gathering you had assembled on the way
  there — a pan is how this wall is read, not how you change your mind about it. Left button
  only (a right-press is on its way to a menu), and never during a shift-marquee, which is
  the additive gesture.
- **Escape backs out of one thing, innermost first**, and anything that closes on Escape owns
  the key while it is open — the context menu and the adopt panel both listen on the window
  themselves, so `onGlobalKey` only has to stay out of their way (it runs first, App having
  mounted before either). A field is a step of its own: Escape with the caret in the draft
  blurs it and keeps the card, or a prompt already written would be left aiming at nothing.

The control surface's `deselect` op calls the same function rather than clearing the two
halves itself, and `snapshot.dom.transcriptOpen` is how a test sees the third.

The wheel zooms at the cursor and shift+wheel pans — deliberately not Figma's convention
(which this was first), because the densities are the navigation here and panning has the
whole ground to drag. ctrl+wheel still zooms.

Placements live in SQLite next to the conversations they key on; only the *viewport* (pan,
zoom) goes to localStorage — see the note in `studio.svelte.ts` about not having two sources
of truth. Semantic zoom has three densities via `lodFor`: `field`, `wall`, `open`.

Reference images (`images.svelte.ts`, `reference_image` table) are deliberately not tied to a
project, are always hand-placed with their own size and rotation, and are *copied* into
`$APPDATA/references/` — which is also the only path the asset protocol scope allows. They
arrive either by being dropped in from another window, from `pin up an image…` on the
wall's own menu, or by being pasted — all three place them under the cursor.

**Paste is the only one of the three that does not start with a file**, which is the whole
reason it exists: a Windows screen capture leaves a bitmap on the clipboard and writes
nothing to disk, so there is no path for `import_image` to copy from and the wall could not
take the most common image anybody has to hand. `store.rs::paste_image` writes the bytes
into the same `references` directory and hands back a path, so everything downstream —
sizing, placement, the back band, the row — is `#place`, shared with a drop.

- **The bytes come off the `paste` event, not `navigator.clipboard.read()`.** The async
  clipboard API wants a permission the webview may prompt for or refuse; a paste is a
  gesture you already made and carries its own data. Chromium hands a clipboard bitmap over
  as a `File` in `clipboardData.files`, so a screenshot and a copied `.png` arrive by the
  same route. `clipboardData` is only valid during the event, so the files are read out
  synchronously before the first `await`.
- **They ride the IPC as a raw body** (`invoke("paste_image", arrayBuffer)` →
  `tauri::ipc::Request` → `InvokeBody::Raw`). A `Vec<u8>` command *argument* is serialised as
  a JSON array of numbers, which for a two-megabyte screenshot is around eight million
  characters of text.
- **The format is sniffed from the bytes** (`sniff_image`), never taken from the front end's
  `type` string. The extension it returns names the file, and the asset protocol serves a
  content type off that name, so a guess here would be served as a lie later. Anything
  unrecognised is refused rather than written — a clipboard also holds audio, html and
  shortcuts.
- **Position comes from the cursor, because ctrl+V has none of its own.** App tracks the last
  pointer position in a plain `let` rather than `$state` — a pointermove fires dozens of times
  a second and nothing is drawn from it. Off the wall (over the transcript, or never moved
  since launch) it falls back to `Canvas.center`, the middle of the *view*: the canvas is
  unbounded and its origin can be miles from anything you are looking at.
- **Text beside the image wins inside a field.** Copying from a web page puts both on the
  clipboard, and a paste into the draft you are writing means the words. Image-only in a field
  still pins, since there is nothing else it could mean — Skein's prompts are text on a child's
  stdin and there is nowhere for a picture to go.

The control surface has an `image.paste` op, which moves the cursor with a real pointermove
and then dispatches a real `paste` carrying the bytes in a `DataTransfer` — every seam except
the one thing nothing in a webview can reach, which is the OS clipboard itself. **So whether
WebView2 hands a screenshot over as a file at all is the one claim here no test makes**; it
takes a hand on ctrl+V, and it is the first thing to check if this ever appears to do nothing.

**One stacking order for the whole wall**, in `layout.ts`: `Z_CARD` / `Z_CHIP` are set inline
from there rather than in CSS, and images stack in two bands around them — `nextBackZ` for a
reference that should sit behind the work, `nextFrontZ` for one brought to the front. It was
not one order before: cards were pinned at 1000 and chips at 1001 in CSS while an image's
z-index was its own small `z`, so the front-most image on the wall still drew behind every
card and every `+`, and `bringToFront` could only reorder images among themselves. Widgets
(below) share those bands, which is why `Board` and `Widgets` are each handed the other's
`z`s (`others`) — computed apart, "bring to front" would only mean "in front of the other
clocks".

