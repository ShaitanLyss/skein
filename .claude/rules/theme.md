---
paths:
  - "src/lib/theme.ts"
  - "src/lib/theme.svelte.ts"
  - "src/lib/Themes.svelte"
  - "src/lib/tokens.css"
  - "test/theme.test.ts"
---

# Themes: how the reading is set, and how to get back

The transcript panel does not read as well as it should, and most of the reasons are
judgement calls rather than defects — whether the agent's prose or your own prompts belong
at the top of the ink ramp, whether a fence is set small beside a serif, whether
hyphenation reads as a printed page or as a screen. None of those has one right answer, and
arguing them in the tree means the losing answer is gone.

So they are **knobs**, and a theme is a set of values for them. The feature exists to be
experimented with, which is the whole of its shape: switching is live, there is no preview
mode and no apply button, and `paper` is always at the head of the ring.

## A theme is a diff against `tokens.css`, never a second stylesheet

This is the load-bearing decision and everything else follows from it.

`tokens.css` stays the ground truth and no theme touches it. A theme is a map of CSS custom
properties written onto `document.documentElement` with `setProperty`, and taken off again
with `removeProperty`. The reason is **reverting has to be exact**. A theme that swapped one
stylesheet for another could only promise to *look like* the original; one that removes the
properties it set leaves the cascade resolving against `tokens.css` and nothing else, which
is byte-for-byte the app with no theme code in it.

Hence `REST` — `paper` — whose override map is deliberately empty. Its emptiness is the
guarantee, `test/theme.test.ts` asserts it first, and anything added to that map destroys
the one name that means "untouched". It is a *default you can choose* rather than the
absence of a choice, which is why it is in the ring rather than being a "clear" button.

Two consequences that are easy to get wrong:

- **`paint` visits every knob, not only the ones the incoming theme names.** A knob the new
  theme is silent about is *removed*. Setting only what it names would leave the outgoing
  theme's values behind on every knob the two did not share, and the wall would drift a
  little further from any of its themes with each switch — which is exactly what this
  arrangement exists to make impossible.
- **The base value lives in `tokens.css`, not in a theme.** `paper` removes the property, so
  if nothing declared it the cascade would land on each rule's `var()` fallback instead.
  That still draws, but it puts the base value in as many places as there are rules using
  it, which is how two of them drift apart.

## It is not a palette switcher and must not become one

Skein is a single warm ink studio wall on purpose and **colour on it means status**. A theme
changes how the *reading* is set — its ink, its size, its air, its rag. `KNOBS` is a closed
list, no `--st-*` is in it, and a test asserts that, so no theme can make a failed card a
different kind of failed depending on how somebody likes to read.

`resolve` filters against `KNOBS` for the same reason the rest of the front end normalizes
anything opaque it reads back: this is data that outlives the build that wrote it, and once
custom themes exist it is data a person typed.

## A knob is a contract between two files, and nothing in either half can see the other

**This is the bug that shipped, and it is the reason for the ugliest test in the suite.**

The first version of this feature was complete on the theme side and inert on the drawing
side. `theme.ts` had eleven knobs, `BUILTINS` set them, `paint` wrote them onto the root
element, and `getComputedStyle` reported them back faithfully. Two of them — `--tx-size` and
`--tx-leading` — were actually read by a rule. The other nine were read by nothing at all.

So `readable` and `prose` differed from `paper` by a size and a leading, and were otherwise
identical to it and to each other. Every test passed. The catalogue was right, the storage
was right, the chain arithmetic was tested to three decimal places, and the panel drew the
same thing whatever you picked.

The failure is silent in both directions: nothing in `theme.ts` can tell whether a property
it sets is ever consumed, and nothing in `Transcript.svelte` can tell that a knob exists it
has not wired. So `test/theme.test.ts` **reads the stylesheets as text**. It is not elegant.
It asserts three things, and each one is a way this contract has broken or could:

- every knob is declared in `tokens.css` (so `paper` is exact — see above);
- some rule somewhere says `var(--knob` (so the knob is not inert);
- no rule says a bare `var(--knob)` with no fallback, because a bare `var()` resolving to
  nothing makes the declaration invalid at computed-value time — for `font-size` that is an
  inherited size and for `color` it is black on a dark wall.

**Adding a knob means four edits**: `KNOBS`, a default in `tokens.css`, `KNOB_INFO` +
`KNOB_GROUPS` so the editor has words for it, and a rule that actually draws with it. Miss
any of them and the suite says which.

The general shape, which is worth having past this file: **a feature whose halves cannot
observe each other needs a test that stands outside both.** A test written from inside
either half will pass on a feature that does nothing.

## The knobs, and why each one is arguable

Contrast figures are against `--well` (#0f0d0c), computed from the tokens rather than
eyeballed:

| token | contrast | used for |
| :--- | :--- | :--- |
| `--paper` | 15.4:1 | prompts, headings, bold |
| `--paper-dim` | 8.3:1 | the agent's prose |
| `--paper-mute` | 4.9:1 | tool lines, fold caps |
| `--paper-faint` | **2.8:1** | marks, rules — and, once, text |

- **`--paper-note`** is the split of that fourth row. `--paper-faint` is *correct* for the
  em-dash bullet, `li::marker`, the `▸` on a tool line and a link's underline; marks and
  rules can sit at 2.8:1. Glyphs cannot — it is below AA at any size — and it was carrying
  the seam label at 10.2px, the meta-bar at 10.9px and the meta line at 12.2px. Those are
  readouts you *glance* at, which is the case where low contrast hurts most, because a
  glance has no time to resolve. Splitting the token rather than raising it is what lets the
  text half be argued about without disturbing the ninety-odd places drawing a mark.
- **`--tx-prose` / `--tx-you`** are the ramp inversion. A prompt was `--paper` and the
  agent's prose — the thing you are here to read, at length — was `--paper-dim`, so the
  brightest thing on the page was the half you wrote and already know. The argument for it
  is real: the prompt is the landmark you scan for. But it is already over-marked, with a
  2px rule, its own margin and a rail devoted to listing it. Neither answer is a defect —
  8.3:1 is fine by any standard — which is precisely why it is a theme and not a fix.
- **`--tx-code`** was 0.78em of a 13.8px line: 10.7px, smaller than the tool lines above it
  and the smallest thing in the panel bar the seam, for the densest and most literal thing
  in an answer. 0.78 is the standard mono-beside-serif correction and it assumes the serif
  is at a comfortable size; at 13.8px there is not a fifth of it to give away. 0.86em is
  level with inline code, which the fence was already disagreeing with by a pixel.
- **`--tx-round` / `--tx-round-rule`** are the structural one, at two strengths. Two
  paragraphs inside one answer sat 7.6px apart and a prompt sat 9.6px from the answer above
  it — two pixels between "next paragraph" and "a whole new thing was said". Proximity is
  the strongest grouping signal there is and it was saying nothing, which is why finding a
  round wanted the rail; and the rail wants a hand on the mouse at exactly the moment you
  are scrolling. The left rule was always the landmark and only wanted room to act as one,
  so air is the first answer and a rule is the second — see `column` below.
- **`--tx-wrap` / `--tx-head-wrap` / `--tx-hyphens`** are the rag. At ~53 characters
  one-word last lines are constant; `pretty` is cheap (Chromium reflows only the last few
  lines) and has no aesthetic cost, and `balance` stops a two-line heading breaking 90/10.
  Hyphenation is separated from both because it is the one people feel immediately and in
  both directions, so no theme should turn it on by asking for something else.
- **`--tx-leading`**: 1.55 is right for a serif dark-on-light. Light-on-dark blooms — the
  glyphs optically thicken and the counters close up — so it usually wants 1.6–1.65.
- **`--tx-size`** is what the wall is *set* in, and is deliberately not `--read`, which is
  ctrl+wheel. Two multipliers answering different questions: how large you want this hour's
  reading, and how the studio is set. Keeping them apart means changing theme does not throw
  away a size you had wheeled to.

## The five built-ins

- **`paper`** — as it always was. Empty, and its emptiness is the revert guarantee.
- **`readable`** — the changes that are close to being simply correct: notes lifted from
  2.8:1 to a text contrast, a fence level with inline code, a touch more leading, air above
  a prompt, and the two free wrap improvements.
- **`prose`** — `readable`, plus the ramp inversion and hyphenation. The two decisions that
  are taste rather than defect, kept behind their own name.
- **`temper`** — `prose`, with the reading held one step back down the ramp.
  `prose` fixes muted prose by giving it the top of the ramp, and that costs
  something the complaint did not ask to spend: `strong`, `.h` and `.link` are
  all `--paper` too, so prose at `--paper` is prose at exactly the brightness of
  every emphasis inside it. Bold is then carried by weight and face alone, with
  no brightness step. Against `--well`, with the second figure being how much
  brighter bold still is than the prose around it — `--paper-dim` 8.3:1 / 1.85,
  40% toward paper 10.8:1 / 1.42, **60% 12.2:1 / 1.26 (here)**, `--paper`
  15.4:1 / 1.00. It is **one knob** different from `prose` deliberately, and
  sits beside it in the ring, because the ring order is the order you compare
  in and a two-variable comparison answers nothing. The value is a `color-mix`
  along the ramp rather than a literal, since it is a *position* on a ramp
  `tokens.css` already declares and a literal would stay put if the ends were
  retuned.
- **`column`** — `prose`, plus a hairline above each prompt and nearly double the air.
  `readable`'s whitespace is right while you are reading *forwards*; it stops being enough
  when you are hunting back through forty rounds for where something was decided, because
  whitespace is a difference you have to measure against the paragraph spacing beside it and
  a rule is one you see without reading. It uses `--edge`, the shade the seam and the
  meta-bar already draw, because a round boundary is the same kind of event as the boundary
  between restored scrollback and the live stream and should not invent a second weight of
  rule to say so. Against the left rule already there it closes into a bracket.

`prose` is also the demonstration of `from`: it used to repeat every one of `readable`'s
knobs with a test asserting the two stayed in step by hand, and now it says what it actually
is. `column` stands on it in turn, three deep.

## Deriving, and the two words for it

`extend` keeps the link — the new theme holds only what you changed and follows its base
when the base is edited. `copy` cuts it — the base's resolved chain is inlined and `from` is
null. Both were asked for and they fail differently: an extend you thought was a copy
changes under you, and a copy you thought was an extend quietly stops tracking a base you
are still editing. Hence a word rather than a boolean.

Resolution walks the chain root-first and a child's knobs win. Two ways it stops early and
they are different failures — a `from` naming nothing is a **broken link** (the child still
resolves on its own overrides, because a theme you cannot select is worse than one that lost
a layer) and a `from` revisiting the chain is a **cycle**. Neither throws: this runs on every
switch and at start-up, and a store that has gone strange must not stop the app drawing.

**Editing a knob on a built-in derives an extending child first** rather than refusing.
Refusing would be honest if there were anywhere to explain it, but this is a control being
used — the answer to "you cannot edit `readable`" is always "then make one from it", and
doing that costs nothing recoverable while a dead control costs the gesture.

## Where the themes you wrote live, and why it is the wrong place

localStorage, which is the wrong home: the rest of the app puts authored work in SQLite and
keeps localStorage for what is per-machine and disposable — the viewport, the panel's width,
the reading scale. A theme you wrote is not disposable.

It is there because this machine has no MSVC toolchain, so a schema rung and the commands to
reach it could be written but not compiled or tested, and untested Rust in a tree somebody
else is working in is a worse trade than a storage seam that has to move later. See
`.claude/rules/build.md`.

**`readCustoms` and `writeCustoms` are the only two functions in the front end that know
where a theme lives.** When the toolchain is there, those two become invokes and nothing
else in `theme.svelte.ts` or above it moves. `exportThemes` / `importThemes` are the
mitigation in the meantime — your themes can leave the machine as text, which is what makes
the wrong home survivable. Import **renames rather than overwrites** on a collision, because
the themes already here are the ones you have been using and the paste is the guess; a
rename costs a moment's confusion and an overwrite costs work with no way back.

*Which ink is on* is a different question and localStorage is the right answer for it —
that is per-machine and disposable, exactly like the panel width beside it.

## `ink` is a module singleton, and both of those words are load-bearing

It is constructed at import, and `main.ts` imports it **before `mount`** — that is the
earliest point that exists, and later (in `App.svelte`'s setup, say) means the app paints
the base theme and re-themes itself a frame afterwards, which is a flash on every launch.
After `tokens.css`, since the properties override what that file declares.

A singleton rather than something the studio owns because the peek is a second window with
its own document and its own root component; a holder owned by `App.svelte` would leave the
notification surface permanently untheming itself. Both roots load the same bundle, so both
get it by importing.

**It holds no subscription and no timer**, which is what makes a singleton safe here where
`Skein`, `Attention` and `Control` all need releasing (see the `Listeners` note in
CLAUDE.md). If anything is ever added to it that listens, that stops being true and it needs
a place in `Listeners` like the rest.

Two windows do mean two copies of the state and they do not hear about each other: theme the
wall and the peek keeps the ink it started with. Left alone deliberately — the peek is
short-lived and re-reads storage every time it appears, so the divergence cannot outlive one
notification, and a `storage` listener would cost the class the property above.

## The panel

`Themes.svelte` is a thin hand on `ink` and holds no theme state of its own — only the three
half-typed things (a name being entered, a value mid-edit, the word the export button says
back). Everything it computes about a theme it asks `theme.ts`, where it can be tested.

- **Ctrl+Shift+T cycles without opening it**, which is the gesture that matters: the point
  of the feature is comparison, and a picker costs two gestures per look and puts a menu
  over the thing you are trying to see. Free to take — the webview has no tab strip to
  reopen anything into.
- **A knob this theme sets is distinguished from one it inherits** by the label's weight
  rather than a badge; "what did I actually change" is the first thing the panel is asked
  and a column of badges is a column of furniture.
- **Clearing a knob is a delete, not a write of the default** — on an extending theme that
  means "fall back to the base", which is the point of extending.
- **Delete arms in place rather than calling `confirm()`.** Partly taste: an OS dialog over
  a panel about how the wall is set is the chrome this app has spent the most effort not
  having. But mostly correctness — **Tauri patches `window.confirm` to return a Promise, and
  a Promise is always truthy**, so `if (confirm(…))` is a delete that never asks. Arming has
  neither problem and says more, since the dependents can be named in the button's own
  words. `ink.children` is asked first: `resolve` degrades a broken link to "no base", which
  is the right behaviour and a bad surprise.
