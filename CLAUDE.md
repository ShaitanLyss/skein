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

bun run test             # the pure suites: ansi, classify, layout, glass, specs, history, menu,
                         # markdown, actions, outline, ambience, transcript, compaction,
                         # commands, copy, widgets, naming, rousing, timing, asking, usage,
                         # azdo,
                         # shell
bun test test/classify.test.ts                                        # one file
bun test test/classify.test.ts -t "urgency"                            # one describe/test
bun run test:live        # spawns the real `claude` binary, real API turns, minutes
bun run test:wall        # drives a RUNNING app over the control surface

cd src-tauri && cargo test    # unit tests in store.rs, ask.rs, control.rs, supervisor.rs,
                              # servers.rs, shell.rs, sessions.rs, project.rs
```

`bun run test` deliberately excludes `test/live.test.ts` and `test/wall.test.ts` — one costs
money, the other needs a live app. Both are real tests, not scaffolding; run them when
touching the classifier or the wall.

**On a machine with no MSVC toolchain** neither `cargo test` nor `bun run tauri dev` runs at
all, and the failure names nothing that points at the cause. `.claude/rules/build.md` has the
whole of it — the four traps, and the `cargo check --lib` loop that *does* work there.

## Where the rest of it is

This file is what holds for every session. Everything below is one subsystem's reasoning, in
`.claude/rules/`, each scoped with `paths:` frontmatter so it loads when you open a file it
governs — and not otherwise. If you are about to work somewhere, read its rule first; the
prose there is why the code is shaped as it is, and most of it records a bug that shipped.

| rule | covers | fires on |
|---|---|---|
| `turns.md` | how a turn opens, how Escape stops one, and background work that outlives it (`busy` vs `working`, jobs, the plan) | `classify.ts`, `conversation.svelte.ts`, `supervisor.rs` |
| `restore.md` | painting the wall from SQLite, rousing dormant cards, setting one aside, scrollback and adopting sessions Skein did not start | `rousing.ts`, `skein.svelte.ts`, `history.ts`, `sessions.rs` |
| `panel.md` | the transcript: markdown parsing, folding tool calls, panel width, reading size, the two rails, keyboard scrolling | `Transcript.svelte`, `Markdown.svelte`, `markdown.ts`, `outline.ts`, `transcript.ts`, `copy.ts` |
| `layout.md` | territories, the flow, pinning, the two-box viewport, `CARD_BOX`, panning and the marquee | `layout.ts`, `Canvas.svelte`, `studio.svelte.ts`, `images.svelte.ts` |
| `widgets.md` | the widget catalogue and its knobs, the clock, the performance meter | `widgets.ts`, `WidgetNode.svelte`, `Clock.svelte`, `perf.ts` |
| `usage.md` | what Claude Code has cost — reading transcripts, the dedup, the five prices, and the day's figure the title bar and the horizon carry | `usage.ts`, `ledger.svelte.ts`, `usage.rs` |
| `timers.md` | timers, the pomodoro cycle, and why breaks are taken rather than offered | `timing.ts`, `cycle.svelte.ts`, `Rest.svelte` |
| `azdo.md` | pipelines and reviews, the auth ladder, and the TLS interception this network does | `azdo.ts`, `devops.svelte.ts`, `azdo.rs` |
| `actions.md` | the verbs a project has all day, Unreal's shape, conflicts and the fetch clock | `actions.ts`, `project.rs`, `actions.rs` |
| `ask.md` | the `ask_user` MCP server, parking a `tools/call`, and several questions in one call | `ask.rs`, `asking.ts`, `Ask.svelte` |
| `commands.md` | slash commands, why Skein reads only its own names, and clearing a card | `commands.ts` |
| `control.md` | the control surface and the two rules that make a green run mean something | `control.rs`, `control.svelte.ts`, `wall.test.ts` |
| `glass.md` | sticking a thing to a pane in screen space without moving where it is | `glass.ts` |
| `ambience.md` | what the ground does when nobody is asking it anything | `ambience.ts`, `Backdrop.svelte` |
| `servers.md` | dev server groups, the PTY, and why ConPTY is broken on this machine | `servers.rs`, `ansi.ts` |
| `shell.md` | the shell Alt+I floats over the wall, the marker that draws its prompt, and why this one is pipes | `shell.rs`, `shell.ts`, `shell.svelte.ts`, `Console.svelte` |
| `naming.md` | what a card is called, and the draft it wears before it is named | `naming.ts` |
| `menu.md` | the right-click, and why offering nothing is a real answer | `menu.ts` |
| `chat.md` | the card with no project, what `--tools` really does, and where a capability is decided | `supervisor.rs`, `store.rs`, `skein.svelte.ts` |
| `build.md` | building without MSVC — the four traps, and what a no-MSVC machine can check | `Cargo.toml`, `tools/*.ps1` |

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
does it by showing nothing. A `user` event with no line waiting for it is a prompt
this window did not send — a terminal appending to the same session — and is pushed as
before.

**Settling a line is not claiming it**, and conflating the two drew prompts twice. Send into a
card that is already working and the CLI *queues* the prompt behind the running turn — which
goes on speaking, and every message of it settled the line waiting below, so when the queued
prompt was finally taken up its replay found nothing pending to claim and pushed a second copy
of what you had typed. Being answered proves a prompt arrived; it does not say *which*. So the
two questions are two fields: `state` is what is drawn and `awaited` is whether the wire still
owes this line its echo. Speech clears the doubt and leaves the claim standing
(`#settleEchoes`); only the echo itself, a failed send, or the stream closing
(`#forgetEchoes`) closes the books.

`src/lib/skein.svelte.ts` is the only place that talks to Rust. `src/lib/conversation.svelte.ts`
owns per-card state and is the only place that reads the raw event shapes.

### Purity boundary

Files named `*.svelte.ts` contain runes and only run in the app. Plain `.ts` files in
`src/lib` (`classify.ts`, `layout.ts`, `ansi.ts`, `specs.ts`, `markdown.ts`, `ambience.ts`,
`transcript.ts`, `commands.ts`, `naming.ts`, `rousing.ts`, `timing.ts`, `asking.ts`,
`usage.ts`, `azdo.ts`, `glass.ts`, `shell.ts`) are pure
and have direct Bun tests — keep them that way, and put new testable logic there rather than
inside a component.
Adding a test file means adding it to the `test` script, which names its files explicitly.

`classify.ts` holds essentially all Claude-specific knowledge: tool names, model ids, event
vocabulary, the tier/ending taxonomy. If a second agent backend ever matters, that is the
file that grows an interface. The one exception is `usage.ts`'s price table, which is beside
the arithmetic that reads it rather than in `classify.ts` — a rate is knowledge about a
*bill*, not about a stream, and nothing in the event pipeline has ever needed one.

`azdo.ts` is the same arrangement one service over: the build status and vote vocabularies,
what a merge status means, how rows are ordered and what any of it is called. That is where a
second forge — GitHub checks, GitLab pipelines — would grow its interface, and it is
deliberately not in `classify.ts`, which is about an agent rather than about a repository host.

### Things that were got wrong once and are load-bearing

- **Context occupancy comes from the last `assistant` message's `usage`**, never from
  `result.usage` — the latter sums every iteration of a turn and pegs the ring. The one place
  that sum is the right number is a `turn` row, which wants the whole turn; see `store.rs`.
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
- **Shutdown marks what was mid-*turn***, and that has been got wrong twice in the same
  direction — each time by widening "interrupted" to something easier to ask, and each time
  the cost was the whole wall coming back claiming its last turn was cut off. First it was
  every row with `closed_at IS NULL`, which also matches dormant cards restored from previous
  sessions. Then it was every id `Supervisor::shutdown` killed — which was fine until rousing
  gave *every* dormant card a process at launch, at which point a clean quit flagged all of
  them and the next launch sent each a `resumePrompt`: money and an agent apiece, for turns
  that finished hours ago. A process is not a turn. `Conv::turn` is a flag the reader thread
  keeps (`turn_mark`: speech opens, `result` closes), `shutdown` returns only the ids holding
  it, and `store::mark_interrupted` still guards on `closed_at`. Schema v10 clears the flags
  written under the old rule, since nothing can tell them apart from real ones.
- **And then it under-fired, because a crash is not a shutdown.** Narrowing the rule was
  right and writing it *only* at `ExitRequested` was not: the column then meant "the app was
  asked to close while this was mid-turn", and the one exit that actually loses work asks
  nothing. Skein killed, and the wall came back with every card looking as though it had
  finished cleanly. So the mark is no longer computed at the end — `store::set_mid_turn`
  writes it at both boundaries of a turn as they happen (`send_prompt` and the reader thread,
  on a *transition* only, since `stream_event` arrives thousands of times a turn), and what
  survives a crash is a row that was already true. The clean path keeps `mark_interrupted` as
  a backstop, and the front end stopped clearing the flag after a send — that write now lands
  on a turn the same call has just opened, which is the under-firing bug in one line. The
  general shape: **a flag that says "something was lost" must be written when the thing
  starts, not when it is noticed** — code that runs at exit is exactly the code a crash skips.
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

### Rules that reach past the file they were written for

Each of these was learned in one place and then bit somewhere else. They are stated here
rather than only in the rule that owns them, because a rule loads when you open its files and
these apply when you open almost anything.

- **Nothing standing on the wall may be transparent.** The backdrop draws behind everything,
  so whatever stands on the wall is the only thing occluding it — a dormant card was
  `background: transparent` and a leaf drifted through the middle of one. The deliberate
  exception is a widget's `bare` frame, which is a reading you chose. See `ambience.md`.
- **Every density's card must fit its slot.** Cards sit on a fixed pitch that does not change
  with zoom; `CARD_BOX` in `layout.ts` records what each density draws at and
  `layout.test.ts` asserts it. Changing a `[data-lod]` size means updating `CARD_BOX`. See
  `layout.md`.
- **The press is a click until it has travelled.** Capturing the pointer on `pointerdown`
  retargets the eventual `click` and silently swallows every button inside the thing you
  captured on. Same 4px slop everywhere. Bit `Canvas.cardDown` and then `WidgetNode`.
- **Anything holding a Tauri subscription needs releasing.** `Skein`, `Attention` and
  `Control` are plain classes with no lifecycle, so `App.svelte`'s `onDestroy` releases them
  via `Listeners`. Skip it and a superseded instance keeps ingesting events *and writing
  rows* — one `result` became one `turn` row per generation. `snapshot.listeners.*` is how a
  leak is seen from outside; the counts must not climb across an edit. Module-level timers
  need the same care.
- **A background poll must never ask a question.** `GIT_TERMINAL_PROMPT=0` and
  `credential.interactive=false` on anything that shells out to git, or a repo whose
  credentials expired pops a credential window over the wall from a poll nobody asked for —
  or blocks forever on a prompt there is no terminal to answer. See `actions.md`, `azdo.md`.
- **Opaque JSON columns are read by the front end, never by Rust.** `widget.config_json`,
  `ambience_profile.layers_json`, `cycle.state_json` and the ask's arguments all strike the
  same bargain: a normalizer runs on every read and degrades to something drawable, so a
  renamed knob or a newer build's data costs no migration and cannot put a NaN inside a
  frame loop.

### Windows and window chrome

`decorations: false`, so `App.svelte`'s header **is** the title bar (`data-tauri-drag-region`,
plus `WindowControls.svelte`). A second Tauri window (`peek`, `index.html?peek=1`) is the
notification surface — `main.ts` picks the root component off the query string —
deliberately a Skein-designed window rather than an OS toast. `attention.svelte.ts` escalates
taskbar flash → peek → optional chime.

**`main` is created hidden** (`"visible": false`) and `window::settle` is the only thing that
shows it, which anything added to `setup` has to keep true — an early return that skips the
show is an app with no window and no gesture that asks for one. It is hidden because the size
in `tauri.conf.json` is *logical* pixels and therefore a wish: at 150% scaling a 1920×1080
panel is a 1280×720 desktop, the configured 820 is taller than it, and `center` split the
overflow so the title bar — which with `decorations: false` is the only way to move the
window — went off the top of the screen. `settle` clamps to the monitor's work area before
the window has been drawn once, because correcting a window already on screen is a jump you
watch. Where it was last is remembered in `window_frame`, in physical pixels, since that is
the unit monitors are described in and the one that survives a scale factor changing.

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
- **Project conversations** spawn with `--dangerously-skip-permissions`, so a broadcast is the
  most destructive gesture in the app; that is why it costs a modifier (Ctrl+Enter) and warns
  when targets share a working tree. **Chat conversations** (`conversation.kind`) spawn with
  `--tools WebSearch,WebFetch` and no bypass at all, so they can reach nothing on this
  machine. Which one a card is, is asked of the store inside `spawn_conversation` rather than
  passed in — `wake` would have had to remember, and the card it forgets is one that comes
  back from a rouse with the machine in its hands. See `.claude/rules/chat.md`.
- When a subsystem's reasoning grows past a paragraph or two, it belongs in its
  `.claude/rules/` file rather than here — this file is what every session pays for, and
  `/context` is where to check what that costs.

## Committing

**Finish a piece of work, commit it. Don't ask first.** A completed unit — a feature, a fix, a
refactor, a rule written down — is committed as soon as it stands up, without waiting to be
told. Work left sitting uncommitted in the tree is the failure mode this replaces: it is
invisible, it collects unrelated edits, and it puts the decision to keep it on someone who has
already said to keep it.

- **On the current branch, `main` included.** Branching first is not the default here; this is
  a solo repo with a linear history and the branch you are on is the branch you commit to. Say
  which branch it went to if it wasn't obvious.
- **Only when it stands up.** `bun run check` and `bun run test` before the commit, and they
  pass — a commit is a claim the tree builds. If something is genuinely half-done, that is not
  a completed unit; keep working or say plainly what is unfinished. Never commit around a
  known-red test to satisfy this rule.
- **One piece of work per commit**, in the house style: `skein: ` and then lowercase prose
  saying what changed and why, the body carrying the reasoning the way the log already does.
  `git add -A` is wrong when the tree holds something you did not write — stage what the work
  actually touched.
- **Pushing is still asked for.** A commit is local and cheap to amend or drop; a push is
  outward-facing and is not covered by this. Same for anything else that leaves the machine.
