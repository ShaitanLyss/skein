---
paths:
  - "src/lib/widgets.ts"
  - "src/lib/widgets.svelte.ts"
  - "src/lib/WidgetNode.svelte"
  - "src/lib/Clock.svelte"
  - "src/lib/clock.ts"
  - "src/lib/Perf.svelte"
  - "src/lib/perf.ts"
  - "src/lib/meter.svelte.ts"
  - "src-tauri/src/perf.rs"
  - "src/lib/serverlog.ts"
  - "src/lib/ServerLog.svelte"
---

# Widgets, the clock, and the performance meter

### Widgets

Instruments you hang on the wall: a clock, a reading of what this studio's processes are
costing, a reading of what Claude Code has spent. To the wall a widget is the same kind of thing as a reference image — hand-placed,
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

- **A widget is opaque unless you say otherwise.** The ambience is drawn behind everything on
  the wall, so an instrument you can see the weather through is not an instrument — the same
  constraint, and the same fix, as the dormant card a leaf drifted through. That is the
  default and the reason for it; the `frame` knob below is the way to spend it deliberately.
- **The press is a click until it has travelled.** A widget can hold buttons (a performance
  row goes to the card it names), and capturing the pointer on `pointerdown` retargets the
  eventual `click` to the wrapper and silently swallows every one of them. Same 4px slop, same
  bug, as `Canvas.cardDown`.

##### How much of a frame it wears

Every widget wore a solid outline and a solid fill, which is right for an instrument and wrong
for furniture: a clock is a thing in the room, and a panel drawn over the wall reads as
something the app is telling you rather than something you hung up. So the frame is a knob —
`frame` in `COMMON`, three values, `framed` (the wall as it was), `plate` (a fill, no outline),
`bare` (neither).

- **`COMMON` is joined on by `paramsOf`, never written into a spec.** It is the one place the
  shared knobs meet a widget's own, and therefore the definition of a widget's vocabulary: the
  menu, `defaultConfig` and `normalizeWidget` all ask it rather than reading `spec.params`, or
  a shared knob would be offered without being persisted — or persisted without being
  reachable, which is the failure the catalogue's "a parameter with no way to reach it does not
  exist" rule already names. A new kind of instrument gets the frame by existing, the way
  `widgetOffers` already gives it a way onto the wall.
- **One choice, not two toggles**, because the fourth state a pair would allow is the only one
  nobody wants: an outline with the wall showing through it is a hole cut in the wall rather
  than an instrument. The three values are an ordered retreat and each step takes one layer
  off, so that state cannot be written.
- **`bare` is the deliberate exception to "nothing on the wall may be transparent."** That rule
  exists because a leaf drifting through a dormant card reads as broken — the card did not ask
  for it. A clock you *set* bare is the opposite: the weather behind it is the reading you
  chose, and is what makes it furniture rather than a panel. The rule stands as the default,
  which is the whole reason this is a knob and not a restyle.
- **The fill lives on the wrapper and nowhere else.** Every face used to paint its own
  `var(--ink)` — the same colour twice, harmless until it wasn't: `bare` would have shown the
  wall through the frame and then had the reading paint it straight back over. The faces now
  paint no background at all and `WidgetNode` is the only thing that fills. The buttons inside
  a timer and a pomodoro keep theirs, which is right — a control is not a reading.
- **Selection puts the edge back, and only selection.** That rule has to be read *after* the
  `data-frame` ones: at equal specificity only source order settles it. Hover used to reveal
  the edge too, on the argument that a widget you cannot find the corner of is one you cannot
  drag — but every widget is draggable anywhere, so the only thing that edge reported was where
  the pointer was, and a wall of instruments lighting up one after another as you cross it is
  the app narrating your mouse. The grips have always been selection-only, so now the edge and
  the handles agree about what picking a thing up means: the frame you chose is what the widget
  wears until it is selected.
- **It goes onto the node as `data-frame` and the styling hangs off that**, one enum in the DOM
  rather than a pair of booleans. `frameOf` is total, so the attribute always names a frame the
  CSS has a rule for. Nothing was added to `snapshot` for it: `widgets[].config` already
  carries the value, and the `dom` op returns `data` and computed styles, so the knob and the
  rule it reached are both visible from outside — which is the pairing `panel.reading` and
  `panel.linePx` exist to make.
- **A pomodoro's menu had to be told.** Its cadence items are built by hand (the cycle is one
  per studio), and that arm read every `cfg:` id as cadence-or-nothing — so the one kind whose
  menu is partly written out here was the one kind that silently dropped its frame. `optionsOf`
  is now asked for a pomodoro too, and the `cfg:` handler falls through to it.

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

#### Listing what a card holds, and ending one of them

A count was never enough on its own. A row said `4` and there was no way to ask which four,
and no way to end any of them — the one number on the wall with nothing behind it. Now the row
unfolds (`perf.ts::members`, keyed on the row's own key so the two cannot drift) and a card's
right-click carries `processes…` for the same list with room to read it (`Processes.svelte`).

- **The list comes from the card's job, not from walking parents.** `ancestry` climbs until it
  recognises somebody, which goes blind the moment an *intermediate* process exits — and that
  is exactly the shape of a leak, so the instrument was blind precisely where it needed to
  see. `jobs::Job::pids` asks the kernel instead: membership is set at assignment, inherited
  by everything spawned after, and survives anything in between dying. `Supervisor::owned_pids`
  is that per card, consulted only where ancestry came back empty-handed so `own` still means
  what it meant.
- **Job membership is also the only proof of ownership there is**, which is why `kill_process`
  refuses any pid outside one. A parentless `bun.exe` is unattributable by inspection; the rule
  that a `claude.exe` Skein did not spawn is somebody's terminal cuts harder for killing than
  for labelling, because mislabelling costs a wrong word on a widget.
- **Ending one is `taskkill /T`.** Ending a process and orphaning its children is the bug the
  whole of this came out of.
- **Orphans sort above cost**, which is the one place the list disagrees with the rows and does
  so deliberately. Rows rank by what is eating the machine, because that is what a meter is
  for. A list you opened, you opened to find the thing that should not be there — and that
  thing is reliably *cheap*: every leaked process measured on this machine sat at 0%. Ranking
  by cost files them last.
- **A mute and a mark, never a colour.** An orphan is not a failure; rust would say the card
  had broken when what happened is a process lost the thing above it. Same reading `set aside`
  already settles.

#### The server log

A dev server group's own output, on the wall it is being written for. The panel already has
every group's log behind a `log` button; what the widget adds is that you did not have to ask —
the recompile, the port binding, the stack trace, on the wall beside the card whose agent caused
it. `serverlog.ts` is pure and holds all of it: which group a widget is about, what a filter
hides, and what to say about a server that is saying nothing.

- **No holder, and that is the point of it.** `Meter`, `Ledger`, `DevOps` and `Board` each exist
  because their widget has to go and *ask* somebody — a process table, a transcript, an API, the
  billboard — and one asker must serve however many faces are up. This one asks nothing:
  `servers.rs` already pipes every group's stdout and stderr up as `server:log` for the panel's
  sake, and `GroupRuntime` already keeps them. A log widget is a second reading of live state, so
  inventing a `Servers` holder for it would have been a sampler with nothing to sample.
- **It reads a crash as down, because `running` does not.** That flag is what the *wall* asked
  for — set on start, cleared on stop — so a server that exited on its own (a port already bound,
  a config that will not parse) comes back `running: true` with an `exited` health. A start button
  that appeared only for a group nobody had started would have been missing from exactly the case
  you are looking at the log to understand. `standing` is where that is decided, and it is the one
  thing in here with a test per branch.
- **A start button, and deliberately nothing else.** Stop and remove belong in the panel, spelled
  out, next to the × that deletes the group. This is furniture on a wall you drag things around
  on, and a stop under the pointer where a reading used to be is a server killed by a mis-drag.
  It is also why the widget does not reuse the territory chip's `onserver`, which *toggles*: a
  crashed group is `running: true`, so the toggle would have stopped a server the face had just
  said had stopped. `onserverstart` starts, and `start_group` releases any old tree of its own
  before it binds a port, so that one verb is the restart too.
- **It does not scroll, and the wheel is why.** `Canvas` preventDefaults every wheel on the
  surface to zoom the wall, so *nothing* standing on the wall can be scrolled with one — a pane
  that overflowed would hide its newest lines behind a scrollbar nothing could move. So
  `linesFor` draws what the height fits, anchored to the tail, which is the same "the box you
  drag it to is the setting" rule `rowsFor` follows and here it is load-bearing rather than
  tasteful. Reaching further back is the panel's job, and the panel scrolls. It is *not* `rowsFor`:
  that is shared by three faces which are lists of the same one-line rows at the same size, and a
  log is monospace and denser, so sharing it would have made the arithmetic wrong about its own
  CSS — which is the one thing it is for.
- **Which group is a knob, because a widget belongs to no project.** Unlike a territory chip this
  cannot be answered by where it is standing. `whichever is running` leads and is the default,
  because it is the setting that stays right when groups are added and deleted long after the
  widget was hung up — and nothing is hidden by it, since the face names its subject in the
  header either way. The rest of the options are resolved at menu time off the wall (`Source`,
  now `"accounts" | "groups"`), and a wall with one group is not offered the knob at all: following
  it and naming it are the same answer.
- **Two absences, said differently.** A wall with no groups is a widget with nothing to point at
  yet. A widget naming a group that has been *deleted* is the one thing that must not be papered
  over by quietly showing the next group's output — the lines would be somebody else's and
  nothing on the face would say so. `subjectOf` returns which, and the face says which.
- **The colour is the server's own.** The one place on this wall where colour is not ours to
  reserve for status: `ansi.ts` renders what the program printed, which the pipes keep by
  *asking* (`force_colour`) rather than by being a terminal. What Skein adds is achromatic — the
  source label is tinted toward rust when a line came down stderr, and the line itself is left
  alone, because half of everything logs to stderr perfectly calmly and a rust-coloured line
  would be Skein overruling it.
- **And it is the first reader `ServerLog.stderr` has ever had.** The field only became true when
  the pseudo-terminal came off and each pipe got its own reader; under the merged one it was
  hardcoded `false` for every line ever emitted. The panel still ignores it. See
  `.claude/rules/servers.md`.

#### The sweep

`perf.rs::sweep`, started by `spawn_reaper`, ends anything in a card's job whose parent has gone away, once a
minute. Two tests, neither a guess: the job says it is ours, a dead parent says nobody is
waiting on it.

- **It has no idea of "hung", deliberately, because one cannot be had honestly.** Every leaked
  process on this machine sat at 0% CPU — and so does an idle dev server, an MCP server parked
  on stdin, and a `Monitor` that `turns.md` says may legitimately run half an hour. `REAP_MIN_AGE`
  is not a hang threshold; it is a race guard, because a process is briefly parentless while a
  spawn is still being handed over.
- **This is the second deliberate exception to "nothing polls", and wants the same
  justification as the first.** The meter polls because no process emits an event when it
  starts using the CPU; this polls because none emits one when its parent dies. Orphaning is a
  thing that *stops* happening to a process — there is nothing to subscribe to.
- **Started in `setup`, not with the meter.** The meter exists only while a widget is on the
  wall, and a guarantee that holds while you are looking at it is not one.
- **The honest caveat**: a backgrounded tool call whose shell has exited while the work goes on
  is indistinguishable from a leak by these two tests, and killing one means a
  `<task-notification>` that never arrives and a card left holding a job it cannot decrement.
  The window is narrow — Claude Code keeps the shell up to collect output — and was accepted
  deliberately in exchange for a wall that does not silt up.

The control surface has `widget.add`, `widget.set`, `widget.update`, `widget.remove` and
`widget.select`, and `snapshot` reports `widgets` and `meter`. `meter.sampling` is reported
apart from the widget count for the reason ambience reports `drawing` apart from `canvas`: a
meter on the wall with a dead sampler and one with a live sampler look identical from outside.

