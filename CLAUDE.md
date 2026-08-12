# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Skein is a Tauri 2 desktop app (Windows-first) that puts every concurrent Claude Code
conversation on one zoomable studio wall. Each card is a long-lived
`claude --print --output-format stream-json` child process; there is no terminal emulator
anywhere on the path. The front end folds the structured event stream into its own design.

The README is the unmodified Tauri template and is wrong on one point: this uses plain
**Svelte 5 + Vite**, not SvelteKit.

## Commands

```powershell
bun run tauri dev        # the app (starts vite on :1420 itself via beforeDevCommand)
bun run dev              # vite alone — the wall will fault, since every read is an invoke
bun run check            # svelte-check + tsc over src/**
bun run build            # vite build → dist/
bun run tauri build      # bundle

bun run test             # the pure suites: ansi, classify, layout, specs, history, menu,
                         # markdown, actions, outline, ambience
bun test test/classify.test.ts                                        # one file
bun test test/classify.test.ts -t "urgency"                            # one describe/test
bun run test:live        # spawns the real `claude` binary, real API turns, minutes
bun run test:wall        # drives a RUNNING app over the control surface (see below)

cd src-tauri && cargo test    # unit tests in store.rs, ask.rs, control.rs, supervisor.rs,
                              # servers.rs, sessions.rs, project.rs
```

`bun run test` deliberately excludes `test/live.test.ts` and `test/wall.test.ts` — one costs
money, the other needs a live app. Both are real tests, not scaffolding; run them when
touching the classifier or the wall.

## Architecture

### The event pipeline

```
claude -p (child, NDJSON stdio)
  → supervisor.rs reader threads → app.emit("conv:event" | "conv:stderr" | "conv:exit")
  → skein.svelte.ts #wire() routes by conversation id
  → Conversation.ingest(ev) folds it into $state
  → $derived tier/ctx/idleSeconds paint the card
```

Nothing polls, and nothing is drawn optimistically. Your own prompt appears in the
transcript only when `--replay-user-messages` echoes it back, so the UI never shows a
message the agent did not receive.

`src/lib/skein.svelte.ts` is the only place that talks to Rust. `src/lib/conversation.svelte.ts`
owns per-card state and is the only place that reads the raw event shapes.

### Lazy restore

On launch the wall is painted entirely from SQLite — every card in its pinned position,
title, and the context fraction it reached — with **zero** `claude` processes spawned. A card
is `dormant` until you speak to it, then `Skein.wake()` spawns with `--resume` (or
`--session-id` if it never completed a turn, since there is no transcript to resume). Dev
server groups, by contrast, start eagerly on load — they are the slow thing and nothing
about them is speculative.

Because of this, anything a dormant card must display has to be persisted in
`store.rs::update_conversation` as turns settle.

### Scrollback, and adopting sessions Skein did not start

`--resume` hands the model its history but replays **nothing** onto the stream. Probed
against 2.1.228: resuming a two-turn session with `--output-format stream-json` emitted
`system/init`, the new prompt and the new answer, and no historical messages — the model
answered from context it had, and stdout never carried it. The TUI's scrollback is not a
stream feature either; it reads `~/.claude/projects/<slug>/<session>.jsonl` and renders it
locally. So Skein reads the same file: `supervisor.rs::read_transcript` (tail-capped, 8 MB)
hands it to `history.ts`, which folds it into the same `Line`s the live stream produces. That
is what stops a restored card from being blank.

Reading happens as the wall loads, four files at a time, and is not awaited — the wall is
painted and correct without it. This does **not** compromise lazy restore, which is about
*processes*: a transcript read spawns nothing, so there is no reason to make a click pay for
it. Every path that puts a card on the wall starts one (`load`, `open`, `importSession`), and
`loadHistory` is idempotent, so opening the panel is then a no-op. One consequence: waking a
card while its file is still being read can leave the new turn in both places, so
`trimOverlap` cuts history at the first line the wire also carried.

The transcript's vocabulary is *not* the wire's, which is the whole difficulty —
`attachment`, `last-prompt`, `ai-title`, `mode`, `file-history-snapshot` and friends
outnumber speech, `isMeta` records are context Claude Code injected rather than anything
anybody said, and a prompt is a bare string from the TUI but a text block from the SDK.
`history.ts` records the counts it was written against.

Adoption (`sessions.rs`, the `adopt` chip) is the same file read the other way round: a
session recorded by the CLI becomes a card by writing a row that **points** at it. Nothing
is copied and nothing moves — waking that card runs `--resume` against the same file and
appends to it, so the session stays resumable from a terminal afterwards, Skein's turns
included. Two things hold it together:

- `import_conversation` sets `last_ending = 'ok'`, because `restore` reads NULL as "never
  spoke" and would wake the card with `--session-id` — a collision on an id that already
  has a transcript. It means no more than "there is something to resume".
- A transcript never carries the window tier (`[1m]` reaches the wire only on
  `system/init`), so an imported ring is inferred by `windowForObserved`: occupancy above
  200k can only mean the wider window, and inference only ever widens. `#adoptModel`
  replaces the guess with the fact the moment the card wakes.

### Markdown in the panel

The agent speaks markdown and the panel used to print it: hashes, asterisks, pipes and
fences, in one pre-wrap block. `markdown.ts` is a pure parser (blocks and inlines, tested
directly) and `Markdown.svelte` / `Inlines.svelte` walk the tree into elements. It is a
*parser*, not a renderer — nothing produces a string of HTML, so there is no `{@html}` on
the path and no escaping to get wrong; the text is whatever an agent wrote.

Four things it is worth knowing:

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

No syntax highlighting, deliberately: colour on this wall is status, and a keyword is not a
status.

### The rails beside the transcript

Two floating lists hang off the panel's left edge, over the wall, and they list different
things. `you said` is the whole conversation — every prompt you have sent, from the top.
`contents` is **one** answer, the one being read: its opening words, its headings, the start
of each of its list items. A table of contents for a dozen answers at once is not a table of
contents; it is the transcript again in a narrower column.

Same three needs either way — a list of places, one lit, and a click that goes there — so
they are one component (`Rail.svelte`) over one pure module (`outline.ts`: `stub`, `nest`,
`readingAt`), and only what is collected differs.

The marks are read off the panel's **own DOM** rather than parsed out of the markdown a
second time. Everything navigable carries `data-nav` — `"you"` on the line, `"msg"` on an
agent message, `"h"` on a heading and `"li"` on a list item in `Markdown.svelte` — so one
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
  an `h1`. `nest` also returns `null` for the marks to drop, *after* using them: an empty
  `msg` shows nothing but is still the boundary that stops the next answer's list from
  inheriting the last one's indent.
- **Marks are collected for every answer, and `contents` then shows one.** Which one is not
  a fourth thing to track: `headAt` is measured across *all* of them, and the answer on show
  is simply the one holding that mark (`answer` / `contentsAt`). So the lit entry is always
  one of the entries listed, scrolling from one answer into the next swaps the rail, and
  clicking never lands outside what you were looking at. The cap counts (`contents · 2/5`)
  when there is more than one, or a scoped rail reads as a rail that lost half its headings.
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
- **The click scrolls by rect, not by `offsetTop`** (`measure` still uses `offsetTop`, since
  it reads every mark on every scroll and the panel is positioned for it). One click can
  afford `getBoundingClientRect` and gets the right answer whatever the panel grows in the
  way.
- **`.rails` is `pointer-events: none`; each rail takes it back.** The gaps around them are
  wall, and the wall pans.
- **The marks go the moment the card does**, before the next collect lands — they point at
  elements no longer in the document, so left up they would list the previous answer and
  measure it at an offset of zero.

### Purity boundary

Files named `*.svelte.ts` contain runes and only run in the app. Plain `.ts` files in
`src/lib` (`classify.ts`, `layout.ts`, `ansi.ts`, `specs.ts`, `markdown.ts`, `ambience.ts`) are pure and have direct Bun
tests — keep them that way, and put new testable logic there rather than inside a component.
Adding a test file means adding it to the `test` script, which names its files explicitly.

`classify.ts` holds essentially all Claude-specific knowledge: tool names, model ids, event
vocabulary, the tier/ending taxonomy. If a second agent backend ever matters, that is the
file that grows an interface.

### Things that were got wrong once and are load-bearing

- **Context occupancy comes from the last `assistant` message's `usage`**, never from
  `result.usage` — the latter sums every iteration of a turn and pegs the ring.
- **Model ids arrive in two forms.** `system/init` gives the configured id with its window
  tier (`claude-opus-5[1m]`); every `assistant` message gives the bare API name. A
  per-message id must never be allowed to narrow the window — see `sameModel` / `#adoptModel`.
- **`thinking_delta` outnumbers `text_delta` ~8:1** on reasoning models, so a turn must be
  marked working on thinking deltas too or cards look frozen.
- **A freshly spawned conversation is not dormant** even though `system/init` has not
  arrived — claude emits init only after the first message lands.
- **Closing the studio must exit the app.** `peek` is a second window created at startup
  and only ever hidden, and the run loop exits when *all* windows close — so closing `main`
  left a live process with no window, ports still bound and `claude` children still editing
  repos, because `RunEvent::ExitRequested` never fired. `lib.rs` now exits explicitly on the
  main window's `CloseRequested`; everything in the exit handler depends on that.
- **Shutdown marks what was running**, not every row with `closed_at IS NULL` — that also
  matches dormant cards restored from previous sessions, so a clean quit used to bring the
  whole wall back claiming each card's last turn was interrupted. `Supervisor::shutdown`
  returns the ids it killed and only those are flagged.
- **The transcript directory slug folds every non-alphanumeric character**, not only the
  separators: `C:\atelier\skein\.scratch\wall` → `C--atelier-skein--scratch-wall`, and one
  emoji becomes *two* dashes because the replacement runs per UTF-16 code unit. Getting the
  dot wrong meant `read_ai_title` looked at a path that did not exist and reported its
  normal, silent "no transcript yet", so every card under a dotted directory stayed
  untitled. Note the encoding is lossy, so nothing may decode it: anything enumerating
  sessions reads `cwd` out of the records instead, which all of them carry.
- **Migrations**: `store.rs` has a `SCHEMA_VERSION` and numbered steps. `CREATE TABLE IF NOT
  EXISTS` is not a migration; every schema change gets a new `if version < N` arm with
  `ALTER`s.
- **Tauri arg names**: `invoke` converts camelCase to the command's snake_case parameters.
  A misspelled key is silently dropped into `None` rather than erroring — this is how
  `lastTier` vs `last_ending` left the column NULL for every turn ever taken, and cost every
  restored card its `--resume`. Schema v2 backfills what was recoverable.

### The `ask_user` MCP server (`src-tauri/src/ask.rs`)

`AskUserQuestion` and `ExitPlanMode` do not exist in headless mode, so Skein hosts its own
tool over a loopback HTTP MCP endpoint and injects it into every spawn via `--mcp-config`.
The URL carries the conversation id (`/mcp/<id>`), so a call arrives already addressed to a
card with no correlation logic. A `tools/call` **parks the HTTP request** until the UI
answers (10 min timeout), which is what makes the agent genuinely stopped rather than idle,
and what lets the turn resume in place. One thread per request, or one waiting card would
stall every other card's MCP traffic.

Consequence for `classify.ts`: the `asked` ending is currently unreachable via tools, so
amber means *has been waiting too long* — urgency decays with neglect against a single
one-second `clock` rune shared by all cards.

### The control surface (`src-tauri/src/control.rs` + `src/lib/control.svelte.ts`)

Off unless `SKEIN_CONTROL=1` (or a pinned port number). It binds loopback, writes
`%APPDATA%/dev.skein.studio/control.json` with a fresh token, and lights a chip in the title
bar. `POST /op` with `X-Skein-Token` runs one op in the studio and returns its answer.

```powershell
$env:SKEIN_CONTROL="1"; bun run tauri dev     # terminal 1
bun tools/ctl.ts health                        # terminal 2
bun tools/ctl.ts ops                           # the full vocabulary
bun tools/ctl.ts snapshot cards
bun tools/ctl.ts send card=skein text="hello"
bun run test:wall
```

Two rules make a green run mean something, and both are easy to break:

1. **Ops drive the app's own seams.** Injecting an event goes out as a real `conv:event` and
   comes back through Rust to the same listener the supervisor talks to; a dropped file goes
   out as a real `tauri://drag-drop`. Never add an op that reaches into component internals
   or builds a parallel path.
2. **Synthetic vs real pointer.** `click` dispatches a synthetic event and proves only that
   handlers are connected. `real.click` / `real.drag` move the actual Win32 cursor, and are
   the only thing that can see Chromium retargeting a real click after `setPointerCapture`.
   They need a **second** opt-in, `SKEIN_CONTROL_INPUT=1` — `SKEIN_CONTROL` alone must never
   arm the mouse.

There is no `eval` op, on purpose. Editing any front-end file hot-reloads `App.svelte` and
constructs a second `Control`; a generation counter on `window` (not module scope) keeps the
superseded one silent — this once caused a single `open` op to spawn two agents.

The same hazard applies to anything holding a Tauri subscription. `Skein`, `Attention` and
`Control` are plain classes with no lifecycle, so **`App.svelte`'s `onDestroy` releases them**
via `Listeners` (`src/lib/listeners.ts`). Skip that and a superseded `Skein` keeps ingesting
events *and writing rows* — one `result` became one `turn` row per generation. `snapshot`
reports `listeners.skein` / `listeners.attention` / `listeners.actions` so a leak is visible
from outside: they must not climb across an edit (7, 3 and 2 today). Module-level timers need the same care — see the
`clock` interval's `window` handle in `conversation.svelte.ts`.

`test/wall.test.ts` only ever creates conversations under `.scratch/`, and closes them in
`afterAll`. Keep it that way, so running it cannot disturb real work on the wall.

### Dev servers (`src-tauri/src/servers.rs`)

Groups of commands per project, run under a real PTY (`portable-pty`) so vite/cargo/tsc keep
their colour and progress rendering — parsed by `src/lib/ansi.ts`. `pump_lines` splits output
on **both** `\r` and `\n` for that reason: a progress line redraws with a bare `\r`, and
`BufReader::lines()` would hold a whole build back and then dump it flat, which is the piped
behaviour the PTY exists to avoid. Each group lives in a
Windows **job object** with `KILL_ON_JOB_CLOSE`, because `pnpm dev` spawns node spawns
esbuild and killing the parent leaves orphans holding ports.

**ConPTY is broken on this machine and so, therefore, is this.** Probed 2026-08-12 on Windows
11 26200 against portable-pty 0.9.0 (the newest published) with
`src-tauri/examples/pty-probe.rs`: every `openpty`-spawned child dies with `0xC0000142`
(STATUS_DLL_INIT_FAILED) having emitted only ConPTY's own `ESC[6n`, while the same command
through `std::process::Command` runs fine — including `git.exe` with no shell at all, so it is
not the argv. Project actions took the pipe route instead (below); dev servers have not, since
the PTY is the whole point of them. Re-run the probe to find out whether that is still true.

### Project actions (`src/lib/actions.ts`, `actions.svelte.ts`, `src-tauri/src/{project,actions}.rs`)

The verbs a project has all day — build it, test it, open its editor, ship it, push it — as a
row of chips along the **bottom** edge of its territory. Deliberately not up beside the dev
servers: an Unreal project offers six of them, and that row is already the project's name, its
servers and two ways to start a conversation. Identity and address at the top, work at the
foot, each with the full width. The row lives inside the region's own `REGION_PAD`, which is
why it needs no layout constants of its own and is the same size at `wall` and at `open`.

The split is the same one `classify.ts` draws for Claude:

- **`project.rs` answers in facts and never in verbs.** What a project *is* — its scripts, its
  package manager, its `.uproject` and the engine that `EngineAssociation` resolves to — is
  probed once, when the territory appears. What it is *doing* — is its editor up, is the
  branch ahead — is a poll, every 8s.
- **`actions.ts` is pure** and holds all the toolchain knowledge: UBT's argv, what Live Coding
  prints when it succeeds, how to read `[3/12]` and `@progress` and the cook's counters. It is
  tested directly (`test/actions.test.ts`).
- **`actions.rs` is primitives only**: spawn argv, tail a file, PUT a console command, focus a
  window, close a window, is-this-pid-alive. It decides nothing.
- **`actions.svelte.ts` orchestrates**, because half of these are sequences — a cycle is close,
  then build, then relaunch — and a sequence with a UI attached belongs in the front end.

Things that are load-bearing:

- **Steps carry argv, never a shell string.** Everything runs through `cmd /C call …`, and cmd
  does not read the `\"` escaping a Windows command line is quoted with — so
  `C:\Program Files\Epic Games\UE_5.8\…`, which is where every engine is installed, would
  arrive at UBT in pieces. The `call` earns its place too: cmd strips the first and last quote
  of its own tail when that tail *begins* with one, so a command whose first token is a quoted
  path loses it. A bare word in front means there is nothing to strip.
- **Pipes, not a PTY** — see the note under dev servers. `pump_lines` is shared, and it splits
  on `\r` as well as `\n` whatever it is reading, so a redraw still arrives as a line. Both
  streams are pumped: cargo and UBT do much of their talking on stderr.
- **The log keeps its colour; everything that *reads* a line gets it stripped.** A `[1/4]`
  behind an SGR sequence matches nothing, and a note carrying raw escapes puts literal
  `ESC[43m` in a tooltip and on the fault bar.
- **pnpm is the default** when a repo says nothing — `packageManager` first, then the lockfile,
  then pnpm. npm is what gets typed by habit rather than chosen. Only npm needs `--` to forward
  arguments through a script, which is the whole of the dialect difference that matters.
- **Is the editor open** is asked the cheap way first: a top-level window of class
  `UnrealWindow` whose title carries the project name, one `EnumWindows`. Only when that finds
  nothing does it fall back to the authoritative answer — the process command line, which on
  Windows means a PowerShell/WMI spawn — cached 15s. It has to be *this* project's editor:
  another project's `UnrealEditor.exe` must never receive our compile and test triggers, and
  the Remote Control port (30010) is shared by all of them.
- **`git status` is asked with `-uno --no-optional-locks`.** The untracked scan is essentially
  the whole cost of status on an Unreal project — `Saved/`, `Intermediate/`, `DerivedDataCache/`
  — and answers a question the push chip never asks; the lock flag stops a poll colliding with
  a commit being made in a terminal.
- **Closing the editor is WM_CLOSE, never a kill.** The editor has to get to put up its "save
  your changes?" prompt. A cycle that threw away an afternoon of level edits gets used once.
- **The editor is launched detached and outside any job object** — the one spawn in the app
  that deliberately outlives Skein. Closing the wall must not take unsaved level work with it.

Unreal's shape here is lifted from a working nvim setup (`~/AppData/Local/nvim/lua/unreal.lua`),
which had already paid for the two facts that make it non-obvious: UBT *refuses* an external
build of the editor target while the editor holds the Live Coding mutex, so `build` means a
console command sent to the editor when one is open and a `Build.bat` when one is not; and a
headless test run spends ~30s booting a second editor, so with one already open the tests run
inside it. Neither of those has an exit code to read — the Remote Control call returns the
moment the editor accepts it, and the answer turns up in `Saved/Logs/<Name>.log` seconds later
— which is why `tail_log` exists and why the marker vocabulary is pure and tested.

The control surface has `action`, `action.cancel` and `action.poll`, and `snapshot` reports
each project's facts, status, chips and runs. `snapshot.listeners.actions` is 2, and must not
climb across an edit.

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

Cards are placed on a fixed pitch (`SLOT_W`/`SLOT_H`) that does not change with zoom, so
**every density's card must fit its slot** — `CARD_BOX` in `layout.ts` records the size each
one draws at, and `layout.test.ts` asserts the invariant. It did not always hold: `open` drew
a 288-wide card on a 248 pitch, covering exactly the strip where the neighbour's context ring
sits. `open` therefore grows downwards only. Changing a `[data-lod]` size in `Card.svelte`
means updating `CARD_BOX` to match.

`.layer` — the translated, scaled box the wall is drawn into — is `inset: 0`, so at rest it
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

The wheel zooms at the cursor and shift+wheel pans — deliberately not Figma's convention
(which this was first), because the densities are the navigation here and panning has the
whole ground to drag. ctrl+wheel still zooms.

Placements live in SQLite next to the conversations they key on; only the *viewport* (pan,
zoom) goes to localStorage — see the note in `studio.svelte.ts` about not having two sources
of truth. Semantic zoom has three densities via `lodFor`: `field`, `wall`, `open`.

Reference images (`images.svelte.ts`, `reference_image` table) are deliberately not tied to a
project, are always hand-placed with their own size and rotation, and are *copied* into
`$APPDATA/references/` — which is also the only path the asset protocol scope allows. They
arrive either by being dropped in from another window or from `pin up an image…` on the
wall's own menu, which places them under the cursor.

**One stacking order for the whole wall**, in `layout.ts`: `Z_CARD` / `Z_CHIP` are set inline
from there rather than in CSS, and images stack in two bands around them — `nextBackZ` for a
reference that should sit behind the work, `nextFrontZ` for one brought to the front. It was
not one order before: cards were pinned at 1000 and chips at 1001 in CSS while an image's
z-index was its own small `z`, so the front-most image on the wall still drew behind every
card and every `+`, and `bringToFront` could only reorder images among themselves.

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

### The right-click

Chromium's own menu never appears — an undecorated window whose header *is* its title bar
has no business offering "Reload" and "Save image as…". `main.ts` suppresses it for both
roots, which also means the whole answer is Skein's to give.

`menu.ts` is pure and owns *what* a target offers; `ContextMenu.svelte` only turns ids into
calls. Offering nothing is a real answer, not a failure: right-clicking prose with no
selection opens no menu rather than an empty box, so the pure function returns `[]` and the
component is never mounted. Conditional items are swept for orphaned separators, because a
menu that opens on a horizontal rule reads as a missing item.

Two consequences elsewhere. `.region` lost its `pointer-events: none` so a territory can
answer for itself — safe only because `isGround` now decides by what a press is *not* on,
so a press there still pans. And the card menu is where the session id finally leaves the
UI (`copy resume command`); before it, nothing on the wall would tell you what `--resume`
takes.

### Windows and window chrome

`decorations: false`, so `App.svelte`'s header **is** the title bar (`data-tauri-drag-region`,
plus `WindowControls.svelte`). A second Tauri window (`peek`, `index.html?peek=1`) is the
notification surface — `main.ts` picks the root component off the query string —
deliberately a Skein-designed window rather than an OS toast. `attention.svelte.ts` escalates
taskbar flash → peek → optional chime.

Real-input, job objects, and the `to_screen` arithmetic are `#[cfg(windows)]`; non-Windows
arms return errors rather than silently no-oping.

## Conventions

- Comments here explain *why*, often citing a probe against a specific `claude` version or a
  bug that shipped. When you change behaviour that a comment justifies, update the
  justification — and if you probed something, say what you probed and what it returned.
- `tools/probe-context.ts` is the pattern for answering "what does the CLI actually do":
  spawn with Skein's exact argv, isolate one variable per variant.
- Design tokens in `src/lib/tokens.css`, single warm-ink theme on purpose. Chrome is
  achromatic and **colour is reserved for status** — celadon working, amber asking, rust
  failed. Don't introduce decorative colour.
- Prose in the UI is lowercase, quiet, and sentence-shaped ("dormant — will wake on send").
- All conversations spawn with `--dangerously-skip-permissions`, so a broadcast is the most
  destructive gesture in the app; that is why it costs a modifier (Ctrl+Enter) and warns when
  targets share a working tree.
