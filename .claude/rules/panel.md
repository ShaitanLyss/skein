---
paths:
  - "src/lib/Transcript.svelte"
  - "src/lib/Markdown.svelte"
  - "src/lib/Inlines.svelte"
  - "src/lib/Rail.svelte"
  - "src/lib/markdown.ts"
  - "src/lib/transcript.ts"
  - "src/lib/outline.ts"
  - "src/lib/copy.ts"
---

# The transcript panel: markdown, folding, size, rails, keys

### Markdown in the panel

The agent speaks markdown and the panel used to print it: hashes, asterisks, pipes and
fences, in one pre-wrap block. `markdown.ts` is a pure parser (blocks and inlines, tested
directly) and `Markdown.svelte` / `Inlines.svelte` walk the tree into elements. It is a
*parser*, not a renderer — nothing produces a string of HTML, so there is no `{@html}` on
the path and no escaping to get wrong; the text is whatever an agent wrote.

Five things it is worth knowing:

- **Only `text` lines fold.** `you` is what you typed, shown character for character; a
  tool call, an error and a meta note are already terse and already monospaced.
- **The streaming line is parsed on every delta**, so every *prefix* of an answer has to
  parse into something showable — an unclosed fence is a code block that says so (a dashed
  edge) rather than a paragraph of literal backticks that becomes a code block later. The
  caret travels down the tree to the last thing written, or a half-written list blinks a
  line below itself.
- **Single newlines survive** (GFM's `breaks`, not CommonMark's collapse): an agent's own
  line breaks in prose carry meaning in a transcript.
- **A link is a `<button>`, never an `<a href>`.** This window is undecorated, with no
  address bar and no way back, so following a real href is a one-way trip out of the app.
  The click routes out to `Skein.openLink` → `open.rs`, which shells out through
  `rundll32 url.dll,FileProtocolHandler` — not `cmd /c start`, whose shell reads `&` and
  `^` in a url an agent wrote. The scheme is checked on both sides.
- **Copying gives back the markdown, not the drawing of it** (`copy.ts`, the panel's
  `oncopy`, and the context menu's `copy` — both routes, or there would be two clipboards).
  Rendering marks as elements means the browser's own copy strips every one of them: a
  numbered list arrives unnumbered, a bold label unbolded, a fence as loose lines. But an
  answer copied out of here is nearly always on its way somewhere that reads markdown, so
  the selection's cloned fragment is walked back into source. It is put back together from
  what is *drawn* rather than sliced out of the line's text because a selection is a DOM
  range and only the DOM knows where one starts — so a partial selection gives a partial
  document, and a clone that has lost its list has no marker to write. `toMarkdown` is pure
  and takes `Bit`s (the little of a node it needs), which is what lets it be tested with no
  browser; `bitsOf` is the ten lines that turn a real fragment into them. The panel's own
  furniture — the fence's copy button and language tag, the caret, the seam over restored
  scrollback — is drawn but never copied.

No syntax highlighting, deliberately: colour on this wall is status, and a keyword is not a
status.

### Folding the machinery away

A round is mostly machinery: an agent reads six files, edits four and runs the suite twice, and
drawn one line each those calls *are* the column — what you asked and what came of it end up a
screen apart with twenty lines of bookkeeping between them. So a run of consecutive tool calls
folds into one cap you can open, each independently. `transcript.ts` is pure (`blocksOf`,
`foldCount`, `foldSummary`, tested in `test/transcript.test.ts`) and `Transcript.svelte` draws
what it returns; the two columns — history and live — are folded once each and share one key
namespace, hence the `tag`.

- **Only tool calls fold, and two is the minimum.** A run is broken by anything that is not a
  tool line, so an error, a meta note and speech cannot end up inside a fold — which is what
  makes folding safe rather than merely tidy. A lone call folded would trade a line of
  transcript for a line of chrome and hide the more useful of the two.
- **Nothing navigable is ever inside a fold** — a tool line carries no `data-nav` — so the rails
  list the same places whatever is open. Opening one does change every offset they measured,
  which is why `toggle` calls `refresh(0)`.
- **A group is keyed by its first line's words, not its position.** The live fold is capped at
  `MAX_LINES` and sliced off the *front*, which shifts every index down and would silently move
  an opened group onto a different run. A group's first line does not change as the group grows,
  so the key lasts exactly as long as the group; identical runs are told apart by a count of
  those before them.
- **Folded, the cap carries the run's *last* call**, so a group at the foot of a live turn reads
  as a status line and the panel stays current without being opened; once the turn settles the
  same words say where the work got to.
- **The live edge is its own line at the foot of the column** (`.line.doing`, `conv.doing`).
  A tool call reaches `lines` only when its block closes, so between your prompt landing and the
  first thing written there was nothing on the page at all — and with the calls folded the page
  can sit still for a minute at a time. It is suppressed while text streams: `activity` is
  "responding" then, and the words arriving above it are the better account.

### The compaction, which is a wait and then a wall of text

Both halves of it were drawn wrong, and in opposite directions: the wait showed nothing and
the result showed everything. See `.claude/rules/commands.md` for what the wire actually
carries — probed, and less than it looks: on a manual `/compact`, two status events and
nothing else. **The boundary and the summary reach `history.ts`, not `ingest`.**

- **`doing` is `activity` plus the one wait that has to count itself.** Everywhere else the
  word is enough because something under it is moving — deltas arrive, calls land, the plan
  advances. A compaction has none of that: the wire says `compacting` and then says nothing
  for up to three minutes, which is indistinguishable from a card that has hung. So
  `compactingSince` is held and `doing` appends `spanOf` it, off the same one-second `clock`
  every card already reads for neglect — no second timer. Both readers go through `doing`
  (the card's label and the panel's live edge) rather than one of them appending the count,
  or the wall and the panel would disagree about how long you had been waiting. It is cleared
  by the closing status, by `result` and by `markExited`, because a count nothing can stop
  ticks on a dead card for the rest of the session.
- **The ring is the last thing to hear about a compaction and the first thing you look at.**
  Occupancy is the last `assistant` message's usage and a compaction produces no assistant
  message, so a card that went into `/compact` at 98% is still drawn at 98% — rust and
  apparently no better off — until the next turn answers. `compact_boundary` carries
  `post_tokens` and `ingest` reads it, but **the probe never saw one on a manual `/compact`**:
  that path writes the boundary to the session file only. The arm is kept because a *reactive*
  compaction is a different shape — it happens mid-turn, the CLI has to tell the consumer the
  conversation was rebuilt underneath it, and `qEf` has a `compact_boundary` case producing
  exactly the wire form `compactStat` reads. That is inference from the binary and not probed;
  filling a real context to the auto threshold costs hundreds of thousands of tokens. Until
  somebody does, **a manual compaction's ring corrects on the next turn and not before** — say
  so rather than assuming the arm fires.
- **The summary is its own line kind, folded, and kept whole.** It arrives as a `user`
  message — the CLI handing the model everything it must not forget — and pushed as a `you`
  line it was 16k–25k characters you appear to have typed, with the round you were reading
  shoved off the top of the panel. It is not the agent's either. `summary` is neither, drawn
  as a fold of exactly *one* thing: the deliberate opposite of `MIN_FOLD`, whose reasoning is
  about not trading a line of transcript for a line of chrome, where this trades twenty
  thousand characters for it. History used to clip it to 240 characters, which lost the
  discontinuity more politely rather than not at all; what a card used to know is worth being
  able to read, and a clip is not readable.
- **The cap is the boundary's two token counts**, which arrive one event *before* the words
  they label — so both folds hold a note and hang it on the summary that follows
  (`#compacted`, `compacted`). `history.ts` pushes it as a bare `meta` line if no summary ever
  comes, which is exactly the old behaviour for the one case that still needs it.
- **Live it is matched on the preamble, not on a flag** — and, like the boundary, this is the
  reactive path's arm rather than the manual one's. `isCompactSummary` is written to the
  session file and dropped on the way to stdout (`qEf`'s `user` case names `isSynthetic` and
  nothing else), and `isSynthetic` is equally true of every note Claude Code injects. The
  preamble is one fixed string in the binary, the same manual or automatic, identical on the
  wire and on disk, so `classify.ts::isCompactSummary` is one question both folds can ask of
  the same words. Same bargain as `isStopNote` and `parseTaskNotification`, at a hundred times
  the size. No turn is opened on it: the compaction's own turn is already open.

- **A local command writes four `user` records and marks one of them, and that cost the
  transcript more than the summary did.** From the probe's own session file:

  ```text
  isMeta:true   <local-command-caveat>Caveat: The messages below were…
  (unmarked)    <command-name>/compact</command-name>
                <command-message>compact</command-message>
                <command-args></command-args>
  (unmarked)    <local-command-stdout>Compacted </local-command-stdout>
  ```

  Only the caveat is sorted out by `isMeta`. The other two were pushed as `you` lines — a
  block of XML you appear to have typed — and because `<command-message>` holds the bare name,
  **a compacted card read as though somebody had said the word "compact" into it**. 61
  `<command-name>` blocks and 21 `<local-command-stdout>` blocks across this machine's
  transcripts, every one drawn that way. `localCommand` folds them to `meta`: the name with
  its arguments (`/model sonnet`), and whatever the command printed back. Not dropped —
  running a command is a real thing that happened and the transcript is the record of it.
  It returns `null` for "not a local command" and an empty `text` for "one with nothing to
  draw", and conflating those two puts the quietest commands straight back into your mouth.
- **Markdown is parsed only when the fold is open.** A summary is written as headed sections
  and numbered lists, and parsing twenty thousand characters of it on every delta of a live
  turn — folded away where nobody can see it — would be the panel's most expensive line by
  some distance.
- **Nothing inside it is navigable**, the same rule the tool folds keep. A summary's own two
  dozen headings would bury every real place in the conversation the `contents` rail lists.
- **A failed compaction says so.** `status:null` carries `compact_result` and, when it went
  wrong, `compact_error`; success needs nothing said, because the ring falling and the cap
  have already said it. Silence on a failure is a card that spent three minutes and a fold
  that did not happen, looking exactly like one that succeeded.

### How wide the panel is

**A column you set, never one that sizes itself.** `panelWidth` in `layout.ts` decides it —
undragged, the third of the window it always was (300–460); dragged, what you dragged it to,
and the only thing that overrules you is `WALL_MIN`, so there is always a wall left to have
the conversation on. The width lives on `Studio` beside the viewport and goes to
localStorage for the same reason: it is how this window is divided, per-machine and
disposable, not something you made. The handle is `.side`'s own left border widened to seven
pixels (`.grip` in `App.svelte`), hanging three pixels out over the wall — clear of the
rails, and the wall under it still pans everywhere the cursor is not on it.

It sized itself once, by accident, and that is the thing not to reintroduce. `.detail` was a
flex item with no `min-width: 0`, and a flex item will not shrink below its *min-content*
width: prose has none to speak of (`overflow-wrap: anywhere` on `.line` gives a paragraph a
min-content of one character), but a code fence is `white-space: pre` and a table's headers
are `nowrap`, so their min-content became a floor — clamped by `.line`'s `max-width: 78ch`,
which at 0.86rem is around 537px against a column that never exceeds ~420. So any answer
containing a fence widened the whole panel past `.side` and off the right edge of the
window, and the `overflow-x: auto` that is on `.code` and `.table-scroll` never got its
chance, because the box around them grew instead of the box scrolling. Wide content scrolls
inside itself. Nothing in the panel may decide the panel's width — re-measuring the
paragraph somebody is halfway through reading is the same kind of wrong as reshuffling the
wall when a card opens.

**The grip does not `preventDefault` on pointerdown**, which suppresses the compatibility
mouse events and with them `dblclick` — so the double-click reset could not fire at all.
`user-select: none` on the grip refuses the selection that the default would otherwise have
started, at the source. Probed 2026-08-13 through the control surface.

### How big the reading is

The panel's other dimension, set with **ctrl+wheel over the panel**, and ctrl+0 puts it back
to 100%. Independent of the width on purpose: a narrow column of large type is an ordinary
way to read, and so is a wide one of small, so neither is derived from the other. Same shape
as the width otherwise — `readingScale` / `nudgeReading` in `layout.ts` are pure and tested,
`Studio.readScale` holds it beside the viewport in localStorage (per-machine, disposable, not
a thing you made), and the gesture in `Transcript.svelte` is routed back out to `App.svelte`,
because how this window is set up to be read from is not the panel's to keep.

- **It is one multiplier, `--read`, and everything else is already relative to it.** The
  transcript is proportional to itself — a heading, a fence, a table and the caret are all
  `em` off `.line`, and `78ch` means seventy-eight characters at whatever size those
  characters are — so scaling `.line` scales the column and nothing inside it changes shape.
  What `--read` is written into by hand is the handful of sizes and spacings that are *not*
  `em`: the other `.line` kinds, the seam, the line gap, and the list indents and cell
  padding in `Markdown.svelte`. `calc(Xrem * var(--read, 1))` rather than an inherited `em`
  chain, so each rule keeps the number it always had and a new rule cannot opt out by being
  nested one level deeper than expected. The default of 1 is what keeps `Markdown.svelte`
  renderable outside the panel.
- **The instrument is not the reading.** The readout chip (`text 115%`) is deliberately not
  scaled by `--read`, and it goes after 900ms — a size left on the panel would be furniture.
- **The wheel is the other way round from the wall's.** On the wall a bare wheel zooms,
  because the densities *are* the navigation there; in the panel a bare wheel can only mean
  scrolling, so the size costs a modifier. They never overlap — the panel is outside
  `.surface`, and neither listener sees the other's events. Both are registered by hand for
  the same reason: non-passive, or `preventDefault` is not available.
- **Resizing moves the reader.** Every mark's offset changes, so the panel recollects a frame
  later (mid-effect it is still drawn at the old size), and the scroll position is restored as
  a *fraction* of the column taken before the change — at double the size, the same pixel
  offset means something entirely different. A panel that was following the tail outranks
  that anchor.
- The effect that does this depends on `read` alone. `scroller` and `following` are read
  untracked: either would re-run it on every scroll, and re-running it means recollecting the
  whole panel and flashing a readout for a size that did not change. It also skips its first
  run, or focusing a card would announce the panel's own size on every click.

Chromium's ctrl+wheel and ctrl+0 are free to be taken because Tauri 2 leaves
`zoomHotkeysEnabled` false and `tauri.conf.json` does not set it. `snapshot.panel` reports
both halves — `reading`, the multiplier the studio holds, and `linePx`, what a line is
actually drawn at — because a `--read` that reached no rule would leave the first moving and
the second still. The `wheel` op takes `target=panel` to drive the real listener.

### The rails beside the transcript

Two floating lists hang off the panel's left edge, over the wall, and they list different
things. `you said` is the whole conversation — every prompt you have sent, from the top.
`contents` is **one** answer — how the round being read came out: its opening words, its
headings, the start of each of its list items. A table of contents for a dozen answers at
once is not a table of contents; it is the transcript again in a narrower column.

**"Its headings" mostly means its bold paragraph openings.** An agent writes `##` far less
often than it writes `**1. The impact pipeline.** The largest unbuilt system left…` — six
sections and not one heading or list marker in the message. A rail that listed only `#` and
`-` had nothing to say about answers written that way, which is most of them: it showed the
opening line and stopped. So a paragraph that *opens* in bold is a heading with its label run
in, marked `data-nav="lead"` and named by the bold alone (`runIn` in `markdown.ts`, the label
carried on the element as `data-lead`, the whole paragraph kept for the tooltip). Two rules
keep it from listing prose: the bold has to open the paragraph — bold mid-sentence is
emphasis and no section begins there — and it has to be short, or a first sentence written in
bold for weight becomes a rail entry that is the paragraph again. Run-in labels are collected
for top-level paragraphs only (`nav={false}` down every recursion in `Markdown.svelte`):
inside a list item the line is already a mark and would be listed twice, one line apart.

Same three needs either way — a list of places, one lit, and a click that goes there — so
they are one component (`Rail.svelte`) over one pure module (`outline.ts`: `stub`, `nest`,
`readingAt`), and only what is collected differs.

The marks are read off the panel's **own DOM** rather than parsed out of the markdown a
second time. Everything navigable carries `data-nav` — `"you"` on the line, `"msg"` on an
agent message, `"h"` on a heading, `"li"` on a list item and `"lead"` on a paragraph that
opens with a bold label, all in `Markdown.svelte` — so one
`querySelectorAll` finds the lot in document order, the labels cannot drift from what is
drawn, and the element's `offsetTop` — which is what a click needs anyway — comes free. That
offset is measured against `.lines`, which is `position: relative` for exactly this reason.

- **A container is labelled by what it carries before its first nested mark** (`startText`).
  Everything past that belongs to the mark below, and taking it twice prints the same words
  one line apart. So a message opening with a heading has no entry of its own, and a list
  item holding a nested list is labelled by its own line.
- **`rank` is not an indent.** A heading's 1–6 and a list item's nesting are what the tag
  knows alone; the indent is carried along the run by `nest`, each heading setting the floor
  for the list items after it — the same `rank`-1 list sits deeper under an `h3` than under
  an `h1`. A run-in label sits *on* the floor and a list written under it hangs off it, but
  it never moves the floor: `nest` keeps `floor` and `base` apart for exactly this, or a run
  of bold paragraphs would step one indent further right with each one until the answer ran
  off the edge of the column. `nest` also returns `null` for the marks to drop, *after* using them: an empty
  `msg` shows nothing but is still the boundary that stops the next answer's list from
  inheriting the last one's indent.
- **`contents` is scoped to the round, and lists that round's last message** (`conclusionAt`).
  A round is not a message: an agent says a line, calls four tools, says another line, calls
  three more, and *then* explains what it did — so one thing you asked for is a dozen `msg`
  marks, eleven of which are "right, now the store". Scoping to the message being read meant
  scrolling back through a round you had just watched replaced its contents with those eleven
  in turn. Mid-round the last message is as far as the agent has got, which is the best
  available answer to "what did this come to"; once it settles it is the summing-up. Marks are
  still collected for every message — which round you are in, and what it came to, both fall
  out of the same `headAt` that lights an entry, so neither is a thing to track. The
  consequence is that `contentsAt` is legitimately `-1` inside a round's working part: the
  rail lists where the round is going while you read how it got there. The cap counts *rounds*
  (`contents · 2/5`) when there is more than one, or a scoped rail reads as a rail that lost
  half its headings; rounds that answered nothing yet are not counted, since the rail cannot
  show them.
- **A collect walks every mark in the panel**, so a live turn's deltas are throttled
  (`refresh`, 160ms) while structure changes are immediate. Only ever shortening the wait is
  what keeps that from starving.

- **Offsets are measured, never cached.** The column above a mark grows all through a turn,
  so a top recorded when the mark was collected is wrong a second later. `measure()` runs on
  scroll and on the frame after any content change.
- **`readingAt` returns `-1` above the first mark**, and the *last* mark whenever the view is
  parked at the bottom — a final section shorter than the viewport never reaches the top edge,
  so without that rule scrolling all the way down leaves the rail pointing well above what
  fills the screen.
- **A carried view is not a scrolled view**, and conflating the two made clicking a rail
  entry do nothing at all. `following` is a dependency of the follow-the-tail effect, and a
  smooth scroll emits its first event with the panel barely moved — so a panel parked at the
  tail (where every panel starts) read as still following, the effect re-ran, and the view
  was dragged straight back down before it had gone anywhere. `jump` now holds `carrying`
  until `SETTLE_MS` after the last scroll event and `settle` takes the reading then. For the
  same reason the follow's `requestAnimationFrame` asks whether it is still following when it
  fires, not only when it was scheduled: a click during a live turn lands between the two.
- **A view held is a view being read, and nobody reads an unfocused window.** Letting go of
  the tail is how you read what has just gone past, so it must survive a live turn — but it
  must not survive being away. Turn to an editor while the agent works and it writes another
  round underneath the place you were holding, so coming back lands you mid-round on stale
  news with the newest thing said off the bottom of the panel. `watching` (the studio's own
  focus, passed down from `attention.focused` rather than subscribed to twice) re-arms
  `following` whenever anything arrives while the window is blurred, and the existing follow
  does the scrolling — a second path to the bottom would be a second thing to keep in step
  with the frame it waits. It is gated on something *arriving*, not on the blur: away for two
  seconds with nothing said, the place you were holding is still yours. The other two ways to
  stop watching need nothing — focusing another card already re-arms on `conv.id`, and `read`
  unmounts the panel outright.

  **This shipped not wired up, and did nothing for two months.** `watching` has a default of
  `true` — so that `Markdown.svelte`'s panel is renderable with no studio around it — and
  `App.svelte` mounted `<Transcript>` without the prop, so `if (!watching)` was unreachable
  and the whole re-arm was dead. The symptom is not "the view stayed where I left it", which
  is what a dead re-arm sounds like; it is **"the scroll is near the start of the
  conversation"**, because a held pixel offset that was three quarters of the way down a
  short column is a tenth of the way down the long one an agent spent ten minutes writing.
  Two things follow for any prop like this: a default that makes a component work standalone
  also makes a missing prop silent, and a behaviour whose whole point is that it fires while
  nobody is looking is a behaviour nobody will notice the absence of.

  The follow effect reads `watching` too, and that is the other half of it: Chromium suspends
  `requestAnimationFrame` for a minimised or occluded window, so the re-arm can set
  `following` all it likes and the frame it waits for arrives only on the restore. Re-running
  the follow when focus comes back re-pins the tail; if the tail was genuinely let go of, the
  `following` guard returns and nothing moves.
- **The click scrolls by rect, not by `offsetTop`** (`measure` still uses `offsetTop`, since
  it reads every mark on every scroll and the panel is positioned for it). One click can
  afford `getBoundingClientRect` and gets the right answer whatever the panel grows in the
  way.
- **`.rails` is `pointer-events: none`; each rail takes it back.** The gaps around them are
  wall, and the wall pans.
- **The marks go the moment the card does**, before the next collect lands — they point at
  elements no longer in the document, so left up they would list the previous answer and
  measure it at an offset of zero.

### Reading it from the keyboard

Until now the only ways down the panel were the wheel and the rails, both of which want a
hand on the mouse — at exactly the moment the other hand has finished typing the prompt.
**Ctrl+↑/↓ moves the reading three lines, Ctrl+PageUp/PageDown a screen less two lines of
overlap.** `stepBy` and `landing` in `outline.ts` are the arithmetic, pure and tested;
`Transcript.step` does it; the keys are `App.svelte`'s, in `onGlobalKey`.

- **It does not check `isTyping`, and that is the whole point.** Everything else on the wall
  that reaches past a field checks it first. Here the moment you most want to scroll an
  answer is the moment you have just pressed Enter, with the caret still in the draft, so a
  binding that worked everywhere except in the field would fail exactly where it is for.
  Ctrl is what buys the right to fire inside a field: bare arrows stay the caret's, bare page
  keys stay the field's, and ctrl+arrow is not a text gesture Chromium binds in a textarea,
  so nothing is taken away. The palette's own arrows are narrowed to bare ones for the same
  reason — a palette open over the draft is no reason to stop answering a question asked of
  the other half of the window.

  The rule it is an exception to: **a bare key that means something to a field belongs to the
  field.** Tab, Delete and a bare printable character were all guarded with `isTyping`;
  `Home` was not, so fitting the wall fired with the caret in the draft — and since the
  branch calls `preventDefault`, the key was swallowed rather than merely doubled up and the
  caret did not move at all.
- **Measured in lines, never in pixels.** The transcript is scaled by `--read`, so a step of
  sixty pixels is three lines at 100% and one at 300% — the same key moving a different
  amount of reading depending on how large you had set the reading. `lineHeight` measures a
  real `.line` rather than recomputing the `calc`, or a step would disagree with the text it
  moves and leave a sliver of the previous line at the top of every page.
- **Instant, unlike `jump` and `toTail`.** Those are one deliberate leap to a place you
  named, where seeing yourself travel is what tells you where you went. A step is the reading
  advancing, and a held key would spend the press fighting the animation it started a frame
  earlier. It calls `stopGlide` for the reason the wheel does.
- **`following` is not touched.** An instant write to `scrollTop` fires a real scroll event,
  so `onScroll` takes the reading exactly as it does for the wheel — stepping up off the tail
  lets go of a live turn, stepping back down onto it takes it up again, and there is no
  second path to the bottom to keep in step with the frame the follow waits for. This is why
  `landing` clamps rather than letting the browser do it: the last press of a run down has to
  land *on* the tail.
- **Aimed at the focused card alone**, like Escape's stop — the panel only ever shows one
  conversation, and a gathering has no reading to move. With no panel open the binding is
  undefined and the keys are somebody else's.

`snapshot.panel` reports `scrollTop` and `scrollMax`. Both, because either alone is
unreadable from outside: a `scrollTop` of 0 is the top of a long transcript and also every
position of one that does not fill its panel, where the keys are correctly a no-op.

