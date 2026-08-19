---
paths:
  - "src/lib/classify.ts"
  - "src/lib/conversation.svelte.ts"
  - "src-tauri/src/supervisor.rs"
---

# How a turn starts, stops, and outlives itself

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

### Work that outlives a turn

Every other state on this wall is a fold over one turn: it opens on the first event and
closes on the `result`. Background work breaks that, and it was the one thing on the wire the
fold had no concept of at all — so a card running `uv run pytest tests/ -n 6` across twelve
processes said `at rest` and started warming on the neglect clock. That reading was not a
bug in `urgencyFor`; the turn really had finished. The card simply had no way to say that its
*work* had not.

A `Bash` carrying `run_in_background`, an `Agent` (which backgrounds by default in this
build) and a `Monitor` all return **immediately**. The tool result is a receipt, not an
answer, and the three are worded differently — read out of this machine's 496 transcripts on
2026-08-14:

```text
Command running in background with ID: btuqox9zy. Output is being written to: …
Monitor started (task bc4v3btv8, timeout 1800000ms). You will be notified on each event.
Async agent launched successfully. (This tool result is internal metadata — never quote …)
```

Completion arrives much later as a `<task-notification>` block carrying `task-id`,
`tool-use-id`, `status` and a `summary`. `classify.ts` owns all of it (`backgroundKind`,
`jobLabel`, `startedJob`, `parseTaskNotification`, `taskNumberOf`); `Conversation.jobs` is
the fold.

- **`busy` is a second question, not a widening of `working`.** `working` still means exactly
  what it meant — a turn is open — and rousing, delivery and the interrupt all still want
  that. What changed is that the *colour* was reading `working` to answer a broader question:
  is this card busy. An agent that backgrounded a thirteen-minute run and said "I'll commit
  once the suite is green" has ended its turn and not its work, and it will be woken by the
  notification rather than by you.
- **A job is keyed on the tool_use id**, which is the only identity the call, the receipt and
  the notification all share — the same bargain `Seat` makes. The agent receipt's `agentId`
  is deliberately never extracted: it instructs in the same breath that it not be repeated,
  and it is not needed.
- **The call registers the job and the receipt confirms it.** `Agent` can be told to run
  inline and only its receipt says which it did, so a job starts `starting` and is either
  promoted to `running` or dropped. Registering from the call is what puts it on the card a
  round trip early rather than late.
- **A broken turn outranks a running job.** `tier` reads `working`, then `error`, then
  `busy`. Rust is the fault colour and a background job painting celadon over a turn that
  errored would be the one case where the wall says "fine" about a card that is not.
- **The notification is `meta`, and missing it put XML in your mouth.** It is a bare string on
  a `user` record with no `isMeta` to sort it out by — exactly `isStopNote`'s shape, and
  exactly its failure: **both** folds pushed the raw `<task-notification>` block as a `you`
  line and then opened a turn on it. `history.ts` needs the guard too, or a restart changes
  what a card said.
- **No turn is begun on a notification.** The agent usually is woken by it and the first event
  of that turn opens it through the arms that already do so; opening one here would strand the
  card `working` for good on the occasions when nothing responds.
- **The neglect clock starts when the last job lands**, not back when the turn ended —
  otherwise a card whose job ran twenty minutes blooms amber the instant it finishes, for a
  wait nobody was subject to.
- **Jobs are not persisted, and `markExited` clears them.** Skein only ever learns a job
  finished by being *told*, down the stream that just closed — so a job it did not watch start
  is one it could never watch end, and a count nothing can decrement would leave the card
  permanently celadon. It is said out loud rather than dropped silently, because the work may
  well still be running: these are grandchildren of `claude`, not of Skein.
- **A completed job with a non-zero exit code is a failed one.** The code rides in the summary
  rather than in a field of its own, and a background test run that came back red must not
  read as done.
- **A backgrounded subagent holds a seat *and* a job, and only the notification closes the
  seat.** `#closeSeat` fires on a `tool_result`, which for a background agent is the launch
  receipt rather than an answer — so closing on it would collapse the seat the instant it was
  taken and write that receipt's own "internal metadata, never quote this" text into the
  verdict the wall then draws. This only became reachable once seats started being created at
  all; see below.

### Told, and not stirring

The line above says an agent "will be woken by the notification rather than by you", and it is
right. Counting *batches* over the 64 transcripts on this machine that carry a
`<task-notification>` (`tools/probe-wake.ts`, 2026-08-19):

```text
skein-spawned   53 batches   woken 48 (91%)   prompt first 2   silent 3
terminal       124 batches   woken 120 (97%)  prompt first 1   silent 3
```

Median wake delay ten seconds. **The ordinary path works and needs no help**, which is worth
stating plainly because the first attempt at this measurement said otherwise and was wrong in
two ways that any future probe over transcripts will meet:

- **Notifications arrive in batches.** Three jobs landing together write three `user` records
  in the same second, so "did an assistant record immediately follow this one" answers NO for
  every notification but the last of its batch, by construction.
- **Bookkeeping sits between everything.** `ai-title`, `mode`, `last-prompt`,
  `file-history-snapshot` and `attachment` are interleaved freely and break the same test
  again.

Together those turned a ~3% failure rate into a reported ~50%. A related dead end: the queue
records (`queue-operation`, `enqueue`/`dequeue`/`remove`) show a notification enqueued 506
times and dequeued **zero**, which looks conclusive and means nothing — the CLI evidently
delivers them by some path that writes no `dequeue`, and the only sound test is whether a turn
followed.

What is actually left is one case, and every silent notification on the Skein side is it:

```text
"3 background shell command task(s) from the previous session"
"10 background shell command task(s) from the previous session"
```

That is the CLI reconciling tasks it found orphaned at startup. A process died holding them;
`--resume` restores the conversation but not the task table, so the new process can only
report them stopped with no exit code. **That notification wakes nobody, three times out of
three** — and it is the one Skein generates constantly, because a desktop app gets closed
where a terminal session runs for days. The work behind it has usually finished and written
its output (11 of 15, in the case this was found from), so what is lost is the news rather
than the work, and the card sits reading `at rest` on top of a completed job.

So this is a narrow fix for a narrow case, and the wall's own reading was the wrong half of it:

- **`unwoken` is a third question, the way `busy` was a second one.** `working` means a turn is
  open and `busy` means work is running; this means *told, and not stirring*. It has to be
  separate from neglect, because `#settleJob` already restarts the neglect clock when a job
  lands — so such a card does warm to amber eventually, but on the clean-finish clock and
  indistinguishably from a card that finished a turn and went quiet. Those two want opposite
  things from you: one wants reading, the other wants a word, any word.
- **`stalled` sits below `busy` in the tier and above `urgencyFor`.** A card with other work
  still running is honestly working, not waiting. But left to `urgencyFor` this reads as
  ordinary neglect and takes five minutes to say anything, about a state known in seconds.
- **The nudge is a prompt because a prompt is what the case needs.** `NUDGE_TEXT` is nearly
  empty on purpose: the notification is already in the conversation, and what the agent wants
  is a turn in which to act on it, not Skein's paraphrase of a summary line.
- **The budget is per generation of work, not per turn**, and the obvious place to clear it is
  wrong. A nudge is a prompt, a prompt opens a turn, so clearing `nudgeAttempts` in
  `#beginTurn` would have it reset by its own spending every time — an allowance of two that
  can never reach two, and no bound at all on a card that keeps stalling. `#job` clears it
  instead: a card that starts new work has demonstrably been picked up.
- **Escape cancels a pending nudge, and clears the stall with it.** The same early branch
  `#heal` needed and for the same reason — a card about to act on its own is exactly what
  Escape means "don't" at. Dropping only the timer would leave the card amber, asking for the
  thing you had just refused.
- **A dead card is not nudged.** `markExited` clears the stall along with the jobs: there is no
  process to look at anything, and the amber would be asking for a gesture that does nothing.

`WAKE_GRACE_S` is twelve seconds, which is just past the median wake delay of ten — long
enough that a card taking the ordinary path is never accused, short enough that the reading
still concerns the job you are waiting on.

**What this does not fix** is the loss itself. Jobs are not persisted (see above), so a
restart still costs the card everything it knew about work in flight; the nudge only ensures
somebody reads the CLI's report of it. Persisting the job — the `Output is being written to:`
path in the receipt, which `startedJob` currently discards — is what would let a roused card
go and look.

#### The plan, and the tool names that were never arriving

`classify.ts` knew two names that this machine has **never once emitted**, and the cost was
paid twice over.

- **`Task` is not the subagent tool; `Agent` is.** 0 uses against 192, all time. Both
  `describeTool`'s case and `conversation.svelte.ts`'s seat creation keyed on `Task` alone, so
  the entire seat machinery was dead from the day it shipped — the only seats that ever
  appeared were minted by the forwarded-message fallback, which has no persona to give them
  and so called every one of them `seat`. Both names are matched now; the old one costs a line.
- **`TodoWrite` is not the plan; `TaskCreate`/`TaskUpdate` are.** 0 uses against 359. Every
  plan update fell through `default:` and printed the bare string `TaskUpdate` on the card.
- **The plan is folded, because `TaskUpdate` carries no words.** It has an id and a status,
  and the subject lives back on the `TaskCreate` whose receipt (`Task #1 created successfully:
  …`) assigned the number. `Conversation.plan` holds the pairing so the activity line can read
  `activeForm` — the gerund the model writes for exactly this purpose — instead of a verb.

The card wears a small hollow ring at its foot for background work, achromatic and drawn at
every density: at `field` the activity line is gone, and a busy card must not read as merely
quiet. It carries a count only past one. `snapshot.cards[]` reports `busy`, `jobs` and `plan`
beside `working` for the reason `aside` is reported beside `tier` — a card mid-turn and a card
holding a background job both read `work`, which is the intended effect and therefore the
thing a test cannot otherwise see.

### Turns a card may try again by itself

Two failures, and only two. Both share the property that licenses a retry: the request did not
get a turn out of a model, so re-sending repeats nothing.

- **`malformed`** — 400, "The request body is not valid JSON: unexpected end of data: line 1
  column 429454". The conversation was serialised and the body arrived truncated. Both halves
  of the detection are load-bearing: a bare 400 is the API refusing the *content* of a request
  (a parameter out of range, a model that does not exist), which is deterministic, and
  retrying one of those is a loop that ends when the allowance does.
- **`overloaded`** — 529. One signal is enough here, because "overloaded" is not a word the API
  uses for anything else.

**429 is deliberately not on this list.** A rate limit is not weather — it is the account's own
allowance, the horizon already reports it (`usage.md`), and it clears at a time that is *known*
rather than guessed at. Retrying into one is asking the same question of a door with its
opening hour written on it.

Every other failure has to be assumed to have done something. A project card spawns with
`--dangerously-skip-permissions`, so "send the last thing again" is the most dangerous reflex
this app could be given; it is affordable only where the thing being repeated demonstrably had
no effect. Note what that argument does *not* claim: a turn is many requests, and the ones
before the failing one may well have written files. Re-sending is still right, because the
retry resumes the same session and the agent reads back what it already did rather than
starting over blind. What must not happen is a repeat of a request that *itself* had an effect.

**`faultText` is the gate, and it is the one piece here that is easy to leave out.**
`result.result` on a turn that *succeeded* is the agent's own final message — so without it, a
card that answered a question about a 529 by quoting one reads as having hit one, and Skein
re-sends your prompt on the strength of the agent talking about the weather. In this repository
that is not hypothetical. Both callers happen to sit behind `ending === "error"` already, so it
is belt to that braces; it exists because the next caller will not know to stand there.

The two ladders differ because the two failures do. A truncation waits 1s then 4s, and that
wait is for **you** — a card that fails and re-sends inside the same tick reads as a card that
did nothing, and the note would be gone before it could be read. An overload starts at **15s**
and runs 15s → 45s → 2m → 5m, because by the time a 529 reaches a `result` the CLI has already
spent its own internal backoff on it; a card asking again a second later is asking a question
that was just asked several times and answered the same way.

**The overloaded arm is jittered and the truncated one is not**, and the asymmetry is the
point: an overload is the one failure that arrives at *every card at once*. Twenty cards all
waiting exactly fifteen seconds and re-sending a whole conversation in the same tick is a
thundering herd aimed at a service that has just said it is over capacity. Spreading them over
a quarter of the window is the same instinct as `ROUSE_GAP_MS`. A truncation is one card's
transport; two cards hitting it together is a coincidence, not a cause. The roll happens once,
in `#heal`, so the note names the wait the timer actually holds — a card that says "in 15s" and
goes at 19 is an instrument lying about itself.

**A `malformed` failure has two causes and the heal can only fix one of them**, which is what
`repair.md` is about. A body cut short in transit clears on a retry; characters the
*conversation* cannot express never do, and every attempt is an identical failure costing a
whole upload. `wasMalformedRequest` cannot tell them apart — the API says the same thing
either way — so the first heal attempt looks at the session file before re-sending, and what
it finds is the answer. Found 2026-08-19: a `grep -a` over `claude.exe` had put 1,222 NUL
characters in one tool result, the budget went on retries that could not have worked, and the
card then blamed a size that was never the problem.

`HEAL_BUDGET` is per kind and **per turn, not per card**: any turn ending some other way resets
it, so a card that healed this morning starts the afternoon with its full allowance.

Three separations make it safe, and each was a way of getting it wrong:

- **Only what this window sent.** `#lastSent` is set in `echo` and nowhere else. A `user` event
  with no line waiting for it is a terminal appending to the same session, and re-sending
  *that* would be Skein putting words into a conversation it is not holding.
- **The card decides, Skein does.** `Conversation.pendingHeal` is a field and not a callback,
  because the card must be able to come to rest holding one: the wall's tick, the ledger and
  the persistence all run off the same `result`, and a re-send fired from inside `ingest` would
  land in the middle of them. `conversation.svelte.ts` also never talks to Rust.
- **The failed attempt is still a turn.** `#heal` runs *after* `#persistConv`, so the broken
  turn lands in the ledger like any other. A retry that swallowed it would make the day's
  figure understate what the wall spent.

It is never silent. The error line is pushed before a heal is considered, `healNote` says which
failure, which attempt out of how many, and how long the card will be quiet — a card that has
gone still for five minutes should not need the reader to guess whether it is thinking or
waiting — and `healGaveUpNote` accounts for the rust when the budget is spent. That last line
is written only where the *budget* is what stopped it: a card with nothing to re-send has not
given up on anything, and saying it had would describe a decision nobody made.

**Escape cancels a heal, and that check sits ahead of `stop`'s `working` guard.** A card waiting
to try again is not working — that is the whole state — so without the early branch the one
card on the wall visibly about to act on its own was the one card Escape could not stop. The
scheduled timer is dropped on `detach`, `clear` and `close` for the same reason `Listeners`
exists: in dev, `detach` runs on every file save, and a surviving timer is a prompt re-sent by
an instance whose wall is already gone.
