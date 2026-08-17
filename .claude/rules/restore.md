---
paths:
  - "src/lib/rousing.ts"
  - "src/lib/skein.svelte.ts"
  - "src/lib/history.ts"
  - "src-tauri/src/sessions.rs"
  - "src-tauri/src/supervisor.rs"
  - "src/lib/Import.svelte"
---

# Lazy restore, rousing, setting aside, and adopting sessions

### Lazy restore, and rousing the wall

On launch the wall is painted entirely from SQLite — every card in its pinned position,
title, and the context fraction it reached — with **zero** `claude` processes spawned and
nothing awaited, which is what makes the first frame cost a query however many cards are on
it. A card is `dormant` until it has a process, and `Skein.wake()` spawns with `--resume`
(or `--session-id` when there is no transcript to resume). Dev server groups start eagerly —
they are the slow thing and nothing about them is speculative.

**Which of those two it is, is asked of the disk** — `spawn_conversation` looks for
`~/.claude/projects/<slug>/<session>.jsonl` and decides there. It used to be told, by
`resume: conv.everSpoke`, and `everSpoke` is `last_ending IS NOT NULL`, which answers *did a
turn ever finish*. Those are different facts and a card killed part-way through its first
turn has the second without the first: it came back wanting `--session-id` against an id the
CLI already knew, and the child died at once with `Error: Session ID <id> is already in use.`
on stderr and **nothing on stdout** — no `result`, so the card had only a stderr line and an
exit code 1 to show for it. Rousing is what turned that from a click you could avoid into
every launch, since interrupted cards are woken first and being interrupted is exactly how a
first turn ends up unfinished. Probed 2026-08-14 against claude 2.1.232 with
`tools/probe-resume.ts`: a spawn that is never spoken to writes **no file at all**, so the
file existing means something was said and can be resumed, and the check needs no second
condition. It fixes the other direction too — a row claiming an ending whose transcript has
since been deleted now starts fresh rather than dying on `No conversation found with session
ID`. The front end no longer passes the flag: one question with a file for an answer must not
have a second, staler answer travelling beside it.

Because of this, anything a dormant card must display has to be persisted in
`store.rs::update_conversation` as turns settle.

**Laziness is about the paint, not about the processes.** Behind the painted wall two passes
run and neither is awaited: `#fillHistory` reads the transcripts, and `#rouse`
(`rousing.ts`, pure: the order, the pacing, the words) gives every dormant card its process
back and asks any card that was mid-turn when the app closed to pick that turn up. Waiting
for a click bought nothing — a wall you have to touch card by card before it can do
anything, and a card left half-way through editing a repo sitting there saying `interrupted`
until somebody noticed.

- **Only an interrupted card is *prompted*.** Waking is cheap and reversible: a `claude -p`
  with nothing on its stdin is a process and no tokens. A prompt is neither — it spends money
  and starts an agent editing a repo with `--dangerously-skip-permissions` — so it is
  reserved for the cards that demonstrably lost a turn, which is what `interrupted` records
  (`Supervisor::shutdown` → `mark_interrupted`, only what was actually mid-turn).
- **Rousing broke the definition of `interrupted` on its way in**, and the whole wall was
  resumed at every launch for it — cards at rest included, each one a resume prompt spending
  money to go and read `git status` about a turn that had ended cleanly hours before.
  `shutdown` returned every id it killed, which was a fair reading of "was running" back when
  only a card you had spoken to had a process. This pass hands one to *every* dormant card, so
  after it shipped, quitting flagged everything on the wall. The supervisor now tracks the
  actual question on the `Conv` — `turn_mark` in the reader thread, speech opens a turn and
  `result` closes it, and `send_prompt` sets it on the write so a prompt still on the wire at
  quit counts as lost. It is deliberately the *only* wire vocabulary in Rust: the question is
  asked at `ExitRequested`, where there is no round trip to the webview left to make. Schema
  v10 clears what the old rule wrote, because a stored `1` from before it cannot be told from
  a real one. The general shape is worth carrying: **anything that makes the wall do more on
  its own has to be re-checked against every flag that meant "you did this"** — `interrupted`
  and `aside` are both readings of intent, and rousing is the app acting without any.
- **You outrank the queue.** Each card is re-checked when its turn comes up rather than when
  the order was taken: one you have already woken is skipped, and one that is already working
  is not sent anything. So speaking to a card during the launch cannot land a resume prompt
  on top of what you just said.
- **Interrupted cards go first**, then the wall's own order, `ROUSE_GAP_MS` apart. Sequential
  with a gap for the reason `broadcast` gives — thirty spawns in one tick is a thundering
  herd on a machine that is also painting a wall and starting dev servers.
- **The flag has to clear, or the same lost turn is resumed at every launch.** Nothing used
  to unset `interrupted`; it was written at shutdown and read once. `#deliver` now clears it
  on any successful send — yours or the queue's, it makes no difference, since either way the
  lost turn has been answered for. That is the one column `update_conversation` ever *un*sets,
  which is why it is passed explicitly rather than by a rule (every other column is COALESCEd
  so an absent argument leaves it alone).
- **A prompt nobody typed arrives introduced.** The resumed card gets a `meta` line
  (`RESUME_NOTE`, via `Conversation.note`) above the `you` line, or the panel is quietly
  putting words in your mouth — the same honesty `echo`'s pending mark is spending its
  complexity on.
- **That note broke `trimOverlap`, which is worth knowing before writing another one.** The
  overlap guard anchored on `live[0]`, and Skein's own meta lines are in no transcript, so a
  roused card matched nothing and kept the file's copy of the prompt directly above the live
  one. It anchors on the first non-`meta` line now. The race is real rather than theoretical:
  the sends happen while `#fillHistory` is still working along the wall.
- **The prompt spends its length on looking first.** An interrupted turn died somewhere
  unknown — a file half-written, a command that may or may not have run — and the agent's own
  last message is the *least* reliable account of it, having been cut off before it could
  report. So `resumePrompt` sends it to `git status` and the tree, and says to stop and ask
  rather than guess: a guess at half-finished work is worse than a question, because it looks
  finished. Hand-wrapped, like `conflictPrompt`, since the panel renders GFM breaks.
- **A loop cannot be unsubscribed**, so `detach` sets a flag the queue checks each time
  round. This is the `Listeners` hazard in a shape `Listeners` cannot fix: editing a
  front-end file constructs a second Skein while the first one's queue is still walking the
  wall, and left running it would spawn against ids the live Skein is also spawning against
  and send a second copy of every resume prompt.
- **A card you set aside is left where you put it**, interrupted or not — see below. That is
  the strongest of the things the flag means: rousing spawns a process per dormant card and
  prompts the ones that lost a turn, and a card put by for later is precisely one you have
  said you are not carrying on with.
- **`SKEIN_NO_WAKE=1` turns the whole pass off** (`supervisor::wake_quiet`, sharing
  `servers::quiet`'s vocabulary), leaving the wall exactly as lazy as it was before. Two
  reasons it must exist: a second Skein against the same store would otherwise resume every
  session in the workspace a second time, appending to transcripts the first instance is
  holding — the same pairing `SKEIN_NO_SERVERS` exists for — and there has to be a way to
  open the wall and look at it without spending money. Advisory in the same way: every card
  still wakes the moment it is spoken to.

The control surface has a `rouse` op driving that same pass, and `snapshot` reports
`wakeQuiet` and `rousing` — a wall left dormant on purpose and one whose every wake failed
look identical from outside, and a card that is dormant *yet* is not one that is staying
that way.

### Setting a card aside

Amber on this wall means *nobody has been back to this in a while* — urgency here is
neglect, and neglect is measured by a clock (`urgencyFor`). That is fair about a card you
forgot and false about one you parked: half-finished work you mean to return to, a session
held open for the context in it, a thread waiting on somebody else. Left alone those cards
warm on the same clock as everything else, join `waiting`, and take their turn in the Ctrl+Tab
cycle — at which point the cycle has stopped being a list of things that want you, which is
the only thing it was for. Rousing made it acute: with every card given its process back at
launch, everything on the wall is eventually overdue.

So a card can be **set aside** — right-click, `set it aside` / `pick it back up`. Nothing
stops, nothing closes, nothing on disk moves; it keeps its process if it has one, its
transcript, its place and its context. What it stops doing is counting.

- **It goes into `urgencyFor`, not into the places that read a tier.** `waiting` in
  `App.svelte`, the dock's count, `attention.items` and the card's own colour are four
  readings of one question, and the comment above `URGENCY` claims that question is answered
  in exactly one place. Filtering the cycle instead would leave a card out of Ctrl+Tab while
  still blooming amber on the wall — the wall arguing with itself.
- **It silences decay, not events.** The check sits *after* the `error` and `asked` arms:
  those are things that happened rather than time passing, and a card that broke in the middle
  of the turn you walked away from still has to be able to say so. In practice a card set
  aside has nothing running, so those arms only ever concern the one you set aside mid-turn.
- **Speaking to it picks it back up** (`Skein.#deliver`, on a *delivered* prompt — a send that
  never left has changed nothing). There is no second gesture to remember, and the alternative
  is an agent working away on a card that has opted out of saying it has finished. The dock
  says so on the target line while it is still true.
- **Persisted, because both of the things it protects against happen at launch** — the waiting
  cycle is the same cycle tomorrow, and the rousing queue would otherwise hand back exactly
  the sessions you had put down. Schema v6, one column, and it rides on `update_conversation`
  rather than getting a command of its own: it is only ever written by the gesture that sets
  or unsets it, so it always arrives carrying the value it means and the COALESCE never has to
  express "back to the default" (which is the whole reason `clear_conversation` is separate).
  Written through immediately rather than at the next settling turn — a card set aside is very
  often one that will never take another turn, and `update_conversation` otherwise only runs
  off a `result`.
- **Drawn as a mute and a mark, never a colour.** The label reads `set aside` with no age
  beside it — the age is the reading being withdrawn, and a card put by for a fortnight is not
  four hundred hours overdue. The mark is a small bar at the opposite corner from the pin,
  achromatic, and it is the only thing that says so at `field` density, where there is no room
  for a label and a card set aside and a card genuinely resting are both muted. Opaque like
  `.pin`, or the ambience comes through it.
- **One menu item with two labels**, the shape `unpin` already has: it is one state with two
  sides and only one of them is ever available. Not marked danger — a prompt undoes it.

The control surface has an `aside` op (defaulting to true, returning the tier, since a card
that went aside without going `rest` has not actually been set aside), and `snapshot.cards[]`
carries `aside` beside `tier` — the two cards it distinguishes both read `rest`, which is the
intended effect and therefore the thing a test cannot otherwise see.

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

