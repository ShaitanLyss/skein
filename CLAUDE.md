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
                         # markdown, actions, outline, ambience, transcript, commands
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

### Building without MSVC

`bun run tauri build` wants the MSVC toolchain, and Visual Studio Build Tools wants a local
administrator. Where there isn't one, `tools/build-gnu.ps1` builds the same two installers
against `x86_64-pc-windows-gnu` with Cygwin's mingw-w64 cross gcc — both of which install
per-user.

```powershell
pwsh tools/build-gnu.ps1              # release + msi + nsis
pwsh tools/build-gnu.ps1 -NoBundle    # just the exe
```

Probed 2026-08-13 (GCC 13.4.0, rustc 1.95.0, binutils 2.46): the whole tree compiles and
links on gnu — bundled sqlite, wry, webview2-com, portable-pty — the exe opens its windows,
and WiX and NSIS produce what they produce under MSVC. Four things bite:

- **The failure without MSVC does not mention MSVC.** rustc runs bare `link.exe`, which
  resolves to GNU coreutils' `link` from Git Bash or Cygwin, and every build script dies
  with `link: extra operand`. That is a *missing* MSVC linker, not a broken one.
- **Cygwin's `windres` cannot read a Windows path.** It drives `gcc -E` through a shell
  command string, so cargo's backslashed `OUT_DIR` arrives at the preprocessor with the
  separators eaten (`C:\a\b` → `C:ab`) and `tauri-build` panics compiling `resource.rc`.
  Forward slashes compile the identical file. `tools/windres-shim.c` is a `windres` that
  rewrites its arguments and delegates; the script builds it into `.build-tools/` and puts
  that in front of PATH **for the build only** — installed under the real PATH it would
  shadow the genuine `windres` for everything else on the machine. It has to be intercepted
  by name, since `embed-resource` 3.0.11 spawns the bare `windres` on non-msvc targets and
  reads no `$RC` override on that path.
- **The gnu exe needs `WebView2Loader.dll` beside it, and the bundler doesn't know.**
  `webview2-com-sys` hardcodes `target_env = "msvc"` → `WebView2LoaderStatic`, anything else
  → `#[link(name = "WebView2Loader.dll")]`; there is no feature to choose. The build drops a
  copy into `target/release`, so the app runs *from the build directory* and looks fine,
  and the installer then produces something that dies on launch with "WebView2Loader.dll was
  not found". `build-gnu.ps1` ships it as a bundle resource through a `--config` overlay —
  not in `tauri.conf.json`, where it would be a missing resource under MSVC. `objdump -p`
  on the exe is the check: it must name no non-system DLL but that one.
- **The `cc` crate builds the C dependencies for Cygwin, not for mingw**, because this
  toolchain's *host* is `x86_64-pc-windows-gnu` — so `cc` sees host == target, decides the
  build is native, and spawns the bare name `gcc`, which on this PATH is Cygwin's own.
  rustc links with `x86_64-w64-mingw32-gcc` already, so only the C dependencies are
  affected and the failure lands at link time in the linker's voice, naming nothing that
  points at the cause — `liblibsqlite3_sys-*.rlib(sqlite3.o)` carrying undefined references
  to `cygwin_conv_path` and `__errno`. Probed 2026-08-13 against libsqlite3-sys 0.30.1 with
  Cygwin's GCC 13.4.0. `build-gnu.ps1` pins `CC_x86_64_pc_windows_gnu` (and `CXX_`/`AR_`)
  to the cross compiler. Note the target triple is spelled with **underscores** in those
  variable names, and a misspelled one is simply not read — the same silent-fallback shape
  as the Tauri arg-name bug further down.

- **`cargo test` does not run on the gnu toolchain here**, so the Rust suites need MSVC and
  the pure Bun suites are what a no-MSVC machine can actually check. Probed 2026-08-13: the
  crate *compiles* clean for `x86_64-pc-windows-gnu` and `cargo test --lib` links, but the
  harness exe dies at load with `0xC0000139` (STATUS_ENTRYPOINT_NOT_FOUND) — before any test
  runs, so a failure here says nothing about the code. Plain `cargo test` does not even get
  that far: the debug **cdylib** overruns mingw ld's export table (`export ordinal too large`),
  which the release build never hits. `--lib` skips it.

- **`bun run tauri dev` cannot work on gnu either**, for that same reason — `tauri dev` builds
  the cdylib, and the debug cdylib dies at `export ordinal too large: 104203` after compiling
  all 405 crates. Probed 2026-08-13; `build-gnu.ps1 -Dev` exists and documents the failure
  rather than working. So on a machine with no MSVC there is **no hot-reload loop**, and
  looking at the running app means:

  ```powershell
  pwsh tools/build-gnu.ps1 -NoBundle
  $env:SKEIN_CONTROL="1"; $env:SKEIN_NO_SERVERS="1"; ./src-tauri/target/release/skein.exe
  ```

  With the dependency tree warm that relinks only the final crate, so a front-end change costs
  a relink rather than a build — but a release build embeds `dist/`, so every front-end edit
  needs one. `SKEIN_NO_SERVERS` matters because this exe reads the *real* store: without it a
  second instance beside an installed one races the first for every port in the workspace and
  both walls end up showing `exited`. And `bun run test:wall` is the thing to reach for rather
  than driving the real wall by hand.

  It cannot be linked statically on this target, which is worth writing down so nobody
  spends the afternoon again. `WebView2LoaderStatic.lib` is MSVC C++: after discounting the
  52 symbols the archive defines itself, what stays undefined includes MSVC-mangled
  `operator new`/`delete` (`??2@YAPEAX_KAEBUnothrow_t@std@@@Z` and friends), `std::nothrow`,
  `_Init_thread_header`/`_footer`/`_epoch`, `__security_cookie`/`__security_check_cookie`
  and `__guard_dispatch_icall_fptr`. mingw's libstdc++ mangles Itanium-style (`_Znwm`), so
  none of it resolves, and CFG's dispatch pointer is synthesized by MSVC's linker. `zig cc`
  does not help: `-target x86_64-windows-gnu` is the same ABI, and `-target
  x86_64-windows-msvc` fails `WindowsSdkNotFound`, since zig locates an MSVC install rather
  than shipping one. Note also that static would not make Skein self-contained — the loader
  is a 160 KB shim whose whole job is to `LoadLibrary` the WebView2 *runtime* installed on
  the machine.

## Architecture

### The event pipeline

```
claude -p (child, NDJSON stdio)
  → supervisor.rs reader threads → app.emit("conv:event" | "conv:stderr" | "conv:exit")
  → skein.svelte.ts #wire() routes by conversation id
  → Conversation.ingest(ev) folds it into $state
  → $derived tier/ctx/idleSeconds paint the card
```

Nothing polls, and nothing the *agent* said is drawn before it says it — every card state
above is a fold over events that arrived.

Your own prompt is the one exception, and it is drawn the moment you send it
(`Conversation.echo`). It was once the other way round: only `--replay-user-messages`
echoing the prompt back put it in the transcript, on the argument that the UI should never
show a message the agent had not received. That argument was right about honesty and wrong
about where to spend it — waking a dormant card spawns a process and resumes a session
first, so the transcript swallowed what you had typed for a second or more with the draft
already cleared. The honesty is kept by *marking* the line instead: `state: "pending"` until
the echo claims it (`#claimEcho`, matched on trimmed text), `state: "failed"` if the send
never left (`echoFailed`), absent once the process has demonstrably got it — an `assistant`
message or a `result` settles anything still pending, since answering us is proof of receipt,
and so does the process going away, which is a prompt it took and died holding rather than
one that never went.
So the panel still distinguishes what the agent has from what is on its way; it no longer
does it by showing nothing. A `user` event with no pending line waiting for it is a prompt
this window did not send — a terminal appending to the same session — and is pushed as
before.

`src/lib/skein.svelte.ts` is the only place that talks to Rust. `src/lib/conversation.svelte.ts`
owns per-card state and is the only place that reads the raw event shapes.

### Stopping a turn

The stdin that carries prompts carries a second kind of message: a `control_request`. The
CLI accepts a small set of subtypes on it — `interrupt`, `set_model`,
`set_permission_mode`, `set_max_thinking_tokens`, `set_color`, `mcp_toggle`,
`message_rated` — and `interrupt` is the same one the Agent SDK's `query.interrupt()`
sends. `supervisor.rs::interrupt_conversation` writes one line; that is the whole
mechanism.

Probed against claude 2.1.229 with `tools/probe-interrupt.ts`, which spawns with Skein's
exact argv. Within 20ms of the write:

```text
control_response  subtype success, {still_queued: [], cancelled: []}
assistant         the half-written answer, as far as it had got
user              "[Request interrupted by user]"
result            is_error true, subtype error_during_execution,
                  terminal_reason "aborted_streaming"
```

and the child then answered the next prompt normally. **This is not `close_conversation`
with a nicer name** — the process, the session and the context all survive, and what the
agent had already written is kept, because the CLI emits the partial message before it
emits the aborted result. Three things follow:

- **`terminal_reason` is the only honest signal.** A stopped turn arrives wearing every
  mark of a failed one, so `wasStopped` is consulted *before* the error test in
  `endingFor`; without it a card goes rust for something you did on purpose. Prefix-matched
  on `aborted` — `aborted_streaming` mid-answer, `aborted_tools` with a tool call in
  flight, and room for a third.
- **`stopped` is an `Ending`, and it warms on the clean-finish clock.** Nothing went
  wrong and nobody is waiting on an answer, so it is not `fail` and not `ask` — but a card
  you stopped is exactly as easy to walk away from as one that finished. It also clears any
  `pendingAsk`: a question cannot outlive the turn it was asked in (the parked thread in
  `ask.rs` times out on its own).
- **The `[Request interrupted by user]` note is the CLI talking, not you.** It arrives as a
  `user` message on the wire *and* as a plain `user` record in the session file with no
  `isMeta` to sort it out by, so both folds have to know it on sight (`isStopNote`) or the
  same stop is a meta line live and a sentence you appear to have typed after a restart.
  Two wordings on this machine, hence matching by shape.

`cancel_queued` is deliberately not asked for, though the CLI advertises it
(`interrupt_cancel_queued_v1`). Stopping means stopping what is *running*; a prompt already
written to stdin behind it is one you sent and are owed an answer to, and the transcript is
marking it unacknowledged until it lands.

The gesture is Escape, which is what the same hands do in Claude Code, and a `stop` button
in the dock beside the target readout. Escape reaching it first is the existing ladder
rather than an exception to it — a running turn is the innermost thing there is — and it
takes only the step it has, so with nothing working Escape lets go exactly as before and a
second press after a stop does the letting go. Both aim at the **focused card alone**,
never at the gathering: a stop is cheap and undoable, but firing one at everything a wide
marquee happened to catch is not a gesture anybody means. The button's square is drawn in
CSS, not typed — `■` falls through to Segoe UI Emoji here and comes out blue, the same trap
the ambience panel's layer-order buttons avoid.

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

### Slash commands, and clearing a card

The dock reads `/`-prefixed drafts as commands. `commands.ts` is pure and owns the
vocabulary and what a half-typed draft matches; `App.svelte` holds the palette's state and
one arm per command — the same split as `menu.ts` and `ContextMenu.svelte`. Adding a command
is one entry in `COMMANDS` and one arm in `runCommand`.

- **Skein reads only its own names, and this is a safety property rather than a
  simplification.** `claude` has slash commands of its own — the built-ins and everything in
  `.claude/commands/` — and they work in `--print` mode, so a prompt beginning with a slash
  is ordinary traffic. `/commit` is the project's command and has to reach the agent unread.
  An unknown name therefore matches nothing, opens no palette, and is sent as the prompt it
  is; swallowing it would silently break every custom command anybody has written, and the
  failure would look like the agent ignoring them.
- **The palette is for choosing, so it closes at the first space.** Left open while
  arguments are typed it would sit there claiming a choice is still to be made. Enter runs
  the lit entry (`/cle` + Enter clears, as in the CLI), Tab completes without running, Escape
  dismisses and *keeps the text* — a draft starting with a slash is a perfectly ordinary
  thing to say to an agent, and that is the way to say it.
- **A command reaches as far as a prompt does and costs the same modifier.** Clearing five
  gathered cards at once must not be easier than talking to them.

`/clear` is the first one, also on a card's right-click menu. There is no way to ask a
running `claude -p` to forget its context — the CLI's own `/clear` is a TUI gesture and never
reaches the stream — so the honest equivalent is to end the process and point the card at a
fresh session id.

- **The card and the session it holds are different things, and only now do they differ.**
  `conversation.id` is *the card* — its placement, its turns, its file touches all key on it
  and must survive — while `sessionId` is what `--session-id` / `--resume` take and what
  names the transcript on disk. They were the same value everywhere until clearing, which is
  why `Skein` used `c.id` for `read_transcript`, `read_ai_title` and `copy resume command`;
  all three are `c.sessionId` now, and getting one wrong means reading a file that is not
  this card's.
- **No migration.** `agent_session_id` has been in the schema since v1, is written by
  `record_conversation` and `import_row`, and is already returned by `load_studio` — it had
  simply never had a reason to differ from `id` and so was read by nobody.
- **`clear_conversation` is its own command rather than more parameters on
  `update_conversation`**, whose every column is COALESCEd so an absent argument leaves the
  old value alone. Clearing needs the opposite for three of them, and `last_ending` back to
  NULL is the whole point: the front end reads NULL as "never spoke", which is what makes the
  next spawn use `--session-id` rather than `--resume` against a transcript that does not
  exist yet.
- **`retiring` is set before the kill.** Killing a child on Windows gives it a non-zero exit
  code and `markExited` reads one of those as a crash, so clearing raced its own teardown and
  stamped "process exited with code 1" and a rust ending onto the fresh session that had just
  replaced it. The flag is cleared by whichever exit arrives, so the ordering does not matter;
  it is only set when there is a child to kill, or a later genuine crash would go unreported.
  `close` does not need it — that card leaves the wall.
- **Nothing is destroyed, which is why it is not a danger item.** The old transcript stays
  where Claude Code wrote it, so `adopt a recorded session…` puts it back on the wall as its
  own card. That makes `importable()` filter by `sessionId` rather than `id`: keyed on `id` a
  cleared card's own fresh session would be offered for adoption while it is standing there,
  and the session it was cleared away from would not be.
- **Offered only when there is something to clear** (`everSpoke || working`), not when there
  are lines on screen — a cleared card still carries its own "cleared" note, which would leave
  the item offered forever on a card with nothing left to clear. `working` earns its place:
  abandoning a first turn that is going wrong is exactly when this is wanted.

The control surface has a `clear` op, and `snapshot` carries each card's `sessionId` (the
only way to see from outside that a clear repointed it) and the palette's current `commands`.

### What a card is called

A title arrives in three stages: a card is opened with none, the first prompt cuts one out of
what you said, and once a turn lands Claude Code's own generated title replaces it
(`#adoptAiTitle`). The first stage used to be drawn as the literal word `untitled` — which is
the *sentinel's spelling*, not a label, and it said less about the card than any other state
on the wall at exactly the moment the card is asking to be given something to do.

`naming.ts` is pure and owns the whole vocabulary. The sentinel is unchanged and still means
what it meant (`store.rs`'s column default, the test in `#deliver` that decides whether the
first prompt gets to name the card); only what is *drawn* moved.

- **An unnamed card wears the draft you are typing at it.** Nothing is invented — it is the
  name it is about to have, shown a few seconds early, which is the same argument
  `Conversation.echo` makes for drawing a prompt before it has been delivered. With nothing
  typed it says `a new thread`, deliberately not "nothing said yet": the open density already
  says that about the transcript, and a card with two lines telling you the same absence twice
  has one thing to say.
- **`titleFromPrompt` is shared between the preview and the commit**, or the preview lies. A
  draft drawn in full and then stored as forty-one characters and an ellipsis is a card that
  renames itself the instant you press Enter.
- **Provisional is marked by slope, not colour** (`.title.provisional`, italic). Colour on this
  wall is status and "you have not named this" is not a status — and it has to be the slope,
  because an unnamed card is always dormant and the dormant rule already mutes every title.
- **App decides reach, `naming.ts` decides wording.** The draft goes to `Canvas` as text plus
  the target ids, so a keystroke touches only the cards it is aimed at; a card outside the
  gathering correctly shows the new-thread line, since it is not the one about to be named. App
  also withholds the draft while the palette is lit — `/clear` is about to be *run* rather than
  sent, and a card briefly calling itself `/clear` would be describing a prompt it never gets.
- **Three answers to "what is this card called", because the question differs.** `cardName` for
  the card face. `displayName` for the footprints and the process meter, which fall back to the
  project: read at a distance or out of context there is no room to explain an absence, and
  whereabouts is the more useful fact. `nameBesideProject` for the dock's target line, the peek
  and the ask panel, which print the project themselves and so fall back to nothing — falling
  back to the project there would say it twice.

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
- **The live edge is its own line at the foot of the column** (`.line.doing`, `conv.activity`).
  A tool call reaches `lines` only when its block closes, so between your prompt landing and the
  first thing written there was nothing on the page at all — and with the calls folded the page
  can sit still for a minute at a time. It is suppressed while text streams: `activity` is
  "responding" then, and the words arriving above it are the better account.

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
`src/lib` (`classify.ts`, `layout.ts`, `ansi.ts`, `specs.ts`, `markdown.ts`, `ambience.ts`,
`transcript.ts`, `commands.ts`) are pure and have direct Bun
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

**Parking is worth nothing unless the client is still listening**, and by default it is not.
Probed 2026-08-14 against claude 2.1.232 with `tools/probe-ask.ts`, which parks a call and
answers it late: the CLI **aborts the HTTP request at 60.02s** and hands the model
`is_error: true, "The operation timed out."`. So the whole feature failed exactly where it
was meant to work — the question was drawn, an option was clicked well inside the ten
minutes, and the answer went to a request nobody was reading while the agent had already
given up and moved on. It looked like a lost answer and was a lost *listener*.
`supervisor.rs` therefore spawns with `MCP_TOOL_TIMEOUT` set from
`ask::client_timeout_ms()`; the same probe with it set parked 90s, was never aborted, and
resumed the turn in place.

- **The client is told to wait a minute longer than we do**, deliberately. Whichever side
  gives up first writes what the model reads, and ours is the sentence worth having — it
  says how long it waited and what to do next, where the client's says only that something
  timed out. `ANSWER_TIMEOUT` stays the real deadline.
- **The heartbeats are not a way out.** The CLI streams `tool_progress` events every 30s for
  a call in flight, but they do not extend its own deadline — the abort landed on the same
  tick as the 60s heartbeat. There is nothing a well-behaved server can send instead.
- **The abort is visible to the server and is currently ignored.** tiny_http's parked thread
  does not notice the dropped connection, so past its own timeout the card would go on
  showing a question the agent has abandoned. With the env set, ours fires first and the
  question is always closed by something.

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

**`SKEIN_NO_SERVERS=1` suppresses the eager start**, and only that: groups are still listed
and still start when clicked (`servers::servers_quiet` → `Skein.serversQuiet`). It is
advisory rather than enforced in `start_group`, because the flag means "don't start these for
me" and a chip that refused a click would be worse than a port conflict. Its reason for
existing is a second Skein against the same store — a build under test beside the installed
one — which otherwise races the first for every port in the workspace and leaves both walls
reading `exited`. The Servers panel says so at the top when it is set: a wall of groups that
are down for a reason must not look like a wall of groups that failed, since the chips read
`idle` either way. `snapshot.serversQuiet` reports it.

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
- **`pull` and `push` are drawn only when there is something to do**, which makes their
  *presence* the news: a pull chip on a territory means somebody pushed to that remote, legible
  from across the wall without reading a label. They are last in the row because they come and
  go, so what moves under the cursor is only ever each other.
- **The fetch is a second, much slower clock, and the only thing here that leaves the
  machine.** `behind` comes off the same `--porcelain=v2 --branch` header `ahead` does
  (`# branch.ab +2 -5`, parsed and thrown away for as long as only push existed), so it is
  local and free — but it measures against the remote-tracking ref, which is only as current as
  the last fetch. So `project.rs::fetch_projects` runs `git fetch` per repo, at `FETCH_MS`
  (5 min) rather than `POLL_MS` (8s), and is **fire-and-forget**: it has no verdict worth
  drawing, and what it changes is read by the status poll already running, so a colleague's push
  becomes a pull chip within one tick of the fetch landing and nothing ever waits on the
  network. Deliberately not a `Run` — a fetch in the runs list every five minutes buries the
  builds you pressed.
- **A background fetch must never ask a question.** `GIT_TERMINAL_PROMPT=0` and
  `-c credential.interactive=false`, or a repo whose credentials have expired pops Git
  Credential Manager's window over the wall from a poll nobody asked for — or blocks forever on
  a prompt there is no terminal to answer. Both turn it into a fast failure, which is right:
  being unable to fetch is not worth interrupting anybody about. `FETCHING` holds a root for the
  life of its fetch so a dead remote cannot stack a thread per tick, and `#fetched` is stamped
  *before* the call for the same reason on the other side — a hang must not put its repo back at
  the front of the queue forever.
- **A conflicted repo tears its own territory.** Conflicts are not a verb the project offers,
  so they are not an `Action`: they are something that happened to it and has not finished, and
  the wall draws that as a state. The region's boundary is already a dashed line — a stitch —
  so `.region.torn` draws a second dashed rectangle 4px outside the first. The two are 8px
  different in each dimension, so their dashes fall out of step along every edge and the pair
  reads as one seam that has split. No SVG and no animation. It is the one project-level state
  drawn at **every** density, `field` included: colour is status here and rust is the fault
  colour, so a wall zoomed right out still shows which project is torn without showing a word.
  Deliberately not a fill — cards stand inside a territory and the backdrop draws behind
  everything, so a wash would sit between the two and tint work that is perfectly fine.
- **The badge is at the foot, opposite the verbs**, right-aligned off the region's own edge so
  a long acts row cannot shove it and so it needs nothing from that row's existence — a bare
  git repo with no build and nothing to push still tears. Clicking it opens a *new card* rather
  than broadcasting: the cards already in that territory are mid-thought on something else, and
  a conflict is its own piece of work with its own transcript worth keeping.
- **`ours` and `theirs` are backwards in a rebase**, and that single fact is most of why
  `conflictPrompt` is worth having. Git replays your commits onto the other branch, so the
  *other* branch is what is being built on and gets called "ours" while your own work arrives
  as "theirs". An agent not told which operation it is standing in takes the wrong side with
  complete confidence. `git_operation` answers it by checking `rebase-merge`/`rebase-apply`
  **before** `MERGE_HEAD` — git's own order in `wt-status.c`, because a rebase that stops on a
  conflict can have `MERGE_HEAD` too — and asks only while `conflicts > 0`, since it costs a
  second spawn. It goes through `git rev-parse --git-dir` rather than joining `.git` by hand,
  because in a worktree that is a *file* pointing elsewhere and worktrees are how half the
  cards on this wall are opened.
- **The prompt spends its length on method, not mechanics.** Anything can delete a marker; the
  ask is what each side was *for*, which a person does by remembering and an agent has to do by
  reading. So it says where to find each side's intent, that the answer is usually neither side
  verbatim, and — the important one — to **stop and ask** where the two genuinely cannot both
  be true, rather than pick. A conflict resolved by coin toss is worse than one left standing,
  because it looks finished. It never lists the conflicted paths itself (the list from
  `project.rs` is capped at 8 and would quietly lie about a forty-file conflict — the agent is
  standing in the repo and can run `--diff-filter=U`), and it stops before `git commit` and
  before any `--continue`: every card here spawns with `--dangerously-skip-permissions`, and a
  merge is exactly the thing to read before it becomes history.
- **`pull` is `--ff-only`.** This wall is full of agents editing these repos with
  `--dangerously-skip-permissions`, and a chip that can stop halfway through a merge is a chip
  that eventually does, leaving a conflicted tree for whatever is mid-turn in it. A refusal is a
  message; a conflict is an afternoon. Reconciling a divergence is a decision, and decisions
  belong in a terminal — the chip says "diverged" and stops.
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

The control surface has `action`, `action.cancel`, `action.poll`, `action.fetch` and
`action.resolve` (which spawns a real agent and sends it a real prompt), and `snapshot` reports
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
arrive either by being dropped in from another window or from `pin up an image…` on the
wall's own menu, which places them under the cursor.

**One stacking order for the whole wall**, in `layout.ts`: `Z_CARD` / `Z_CHIP` are set inline
from there rather than in CSS, and images stack in two bands around them — `nextBackZ` for a
reference that should sit behind the work, `nextFrontZ` for one brought to the front. It was
not one order before: cards were pinned at 1000 and chips at 1001 in CSS while an image's
z-index was its own small `z`, so the front-most image on the wall still drew behind every
card and every `+`, and `bringToFront` could only reorder images among themselves. Widgets
(below) share those bands, which is why `Board` and `Widgets` are each handed the other's
`z`s (`others`) — computed apart, "bring to front" would only mean "in front of the other
clocks".

### Widgets

Instruments you hang on the wall: a clock, a reading of what this studio's processes are
costing. To the wall a widget is the same kind of thing as a reference image — hand-placed,
freely sized, belonging to no project, never in the auto-layout — so `widgets.svelte.ts` is
`images.svelte.ts` with a kind and a config where the path was, and `WidgetNode.svelte` is
`ImageNode.svelte` minus rotation (a photo pinned at an angle is a photo; a clock at an angle
is a clock you cannot read).

`widgets.ts` is pure and is the *whole* vocabulary: the catalogue, each kind's parameters,
its default size and its floor. A new knob is one line, a new variant is one entry in a
`choice`, a new kind is one spec plus one arm in `WidgetNode`'s switch — and Rust never hears
about any of it, because `widget.config_json` is one opaque column for the same reason
`ambience_profile.layers_json` is (schema v5). `normalizeWidget` is the other half of that
bargain and runs on every read: a retired variant, a renamed knob or a config that will not
parse degrades to something drawable, and a *kind* nothing can draw is left off the wall
rather than guessed at — that is a widget from a newer build, and drawing it as a clock would
be worse than an empty patch of wall.

Everything a widget can be told is on its own right-click, not in a panel: the native menu is
suppressed, so `menu.ts` is the whole answer. Two groups — the variant, which is what you are
looking at, and then everything else (`optionsOf`, built off the catalogue, so a knob added
there is reachable by hand the same day; a parameter with no way to reach it is a parameter
that does not exist). The one in force is *marked* — `on` on the `MenuItem`, a dot drawn in
CSS by `ContextMenu.svelte`, because a `✓` falls through to Segoe UI Emoji here and comes out
blue, and "analog (showing)" repeated five times is a paragraph. What can be hung up comes off
the catalogue too (`widgetOffers` in `App.svelte`), so a new kind appears on the ground and
territory menus by existing.

**No numbers among the knobs.** A menu is a poor slider, and the one number these widgets
wanted was better answered by the box you drag: how many rows a meter shows is `rowsFor(h)`.
A setting that could disagree with the height would be a widget arguing with itself.

Two things carry over from elsewhere and are load-bearing:

- **A widget is opaque.** The ambience is drawn behind everything on the wall, so an
  instrument you can see the weather through is not an instrument — the same constraint, and
  the same fix, as the dormant card a leaf drifted through.
- **The press is a click until it has travelled.** A widget can hold buttons (a performance
  row goes to the card it names), and capturing the pointer on `pointerdown` retargets the
  eventual `click` to the wrapper and silently swallows every one of them. Same 4px slop, same
  bug, as `Canvas.cardDown`.

#### The clock

`clock.ts` is pure and holds the arithmetic — hand angles, ring fractions, the digital split,
the words, the face geometry. Five variants, and they are genuinely different readings rather
than skins: `analog` is read by angle, `digital` by numeral, `words` by sentence, `artistic`
as a brush sweep round the hour, `abstract` as three rings and no numerals at all.

- **It runs on the wall's existing one-second tick** (`clock` in `conversation.svelte.ts`).
  A second timer for the most obviously timed thing in the app would be a second wake-up per
  second on a machine that is otherwise idle. Nothing sweeps, for the same reason: with a
  once-a-second reading a swept hand sits between positions for most of every second, which
  reads as broken rather than smooth. `handAngles` takes a `sweep` flag anyway, because the
  *minute* hand carrying its seconds is not optional — an hour hand at `hour * 30` is a clock
  that is wrong 59 minutes in 60.
- **The words are every minute, not the nearest five.** A clock that says "half past three"
  at 15:32 is a clock you check against another clock.
- **Type is sized off the widget's own box** (`cqw`/`cqh` against `container-type: size` on
  the node), so a clock dragged large is a large clock rather than a small one in a large
  frame.

#### The performance widget

A task manager whose rows are *things on this wall*. That is the whole argument for it living
in here: six cards are six identical `claude.exe` in anybody else's process list, and the one
eating a core is the one you want to go and look at — so clicking a row reveals the card.

The split is the one `project.rs` draws. `perf.rs` answers in facts — pid, name, cost, and the
*role* it plays here as an opaque reference — and `App.svelte`'s `nameFor` turns
`conversation: <uuid>` into a card's title, because the title is front-end knowledge.
`Supervisor`, `Servers` and `Runs` each expose `pids()`; a `claude.exe` this studio did not
spawn is somebody's terminal and must never be labelled as one of our cards.

- **Descendants inherit their ancestor's role** (`ancestry`, bounded at 16 hops because pids
  are reused and a stale parent map can close a loop). A dev server is `pnpm` spawning node
  spawning esbuild, and a build fans out to cl.exe by the dozen; only the first of each is in
  any of our maps, and a meter that showed the rest as strangers would understate the thing by
  most of its cost. `perf.ts::fold` then makes each tree one line — strangers fold by
  executable, the way a browser's dozen windows do.
- **Sampling is the one deliberate exception to "nothing polls"**, because no process emits an
  event when it starts using the CPU. It is bounded at both ends: the `Meter` (`meter.svelte.ts`
  — named for the class, since `perf.svelte.ts` beside `Perf.svelte` is the *same file* on this
  filesystem) is one sampler for however many widgets are up, and when the last detaches it
  stops and `release_performance` drops Rust's process table. One sample serves both scopes —
  the machine's is a superset — which is also why `Sample` carries the scope it was taken at:
  a studio-scoped widget must not inherit a machine-scoped sample's leftovers.
- **In development the studio's own row reads low.** WebView2 keeps one browser process per
  user-data folder, so a second Skein against the same `%APPDATA%` has no webview children of
  its own — they are all under the instance that started first. Probed 2026-08-13 with two up.
- **Every number goes through one formatter.** A row printing 0.2% under a header printing 0%
  is a meter arguing with itself.

The control surface has `widget.add`, `widget.set`, `widget.update`, `widget.remove` and
`widget.select`, and `snapshot` reports `widgets` and `meter`. `meter.sampling` is reported
apart from the widget count for the reason ambience reports `drawing` apart from `canvas`: a
meter on the wall with a dead sampler and one with a live sampler look identical from outside.

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
