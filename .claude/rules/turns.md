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

