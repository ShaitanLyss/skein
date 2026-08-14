---
paths:
  - "src-tauri/src/ask.rs"
  - "src/lib/asking.ts"
  - "src/lib/Ask.svelte"
---

# The ask_user MCP server, and several questions in one call

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

#### Several questions in one call

The tool began as one question with a flat list of options, which is the right shape for
most asks and the wrong one for the ask that matters. An agent about to build something
rarely has one decision outstanding; it has two or three, on independent axes. With one
question to put them in it *fuses* them, and the options it then writes are a
cross-product:

```text
two widgets, and yes to attention
two widgets, but keep it silent
one widget with three variants (attention: yes)
three widgets (attention: yes)
```

Four of the eight combinations, presented as though they were the whole set — so "three
widgets, keep it silent" was not merely awkward to pick, it was **not there**. That is
worse than a long question: it is a list that looks complete and is not. The length is a
symptom of the same fusing, since every option then has to spell out both halves, which is
what turns four choices into four paragraphs.

So a call carries `questions[]` and the panel walks you through them one at a time.

- **The parking is one request and therefore one reply**, however many questions it asked.
  That is not a limitation to design around later — it is the whole feature (`ask.rs`'s
  parked `tools/call`), so nothing is sent until the last question is answered and
  `composeAnswer` puts the sheet back together. Everything else about the panel follows
  from it: `answerAsk` takes no text in the normal path, the stepper's "back" is free, and
  a half-answered ask is a card still legitimately `ask`.
- **One question composes to the bare answer and nothing else.** Several compose to a
  numbered list carrying each question's `header`. Load-bearing: the bare form is what every
  ask sent before this, and a single question suddenly arriving numbered and headed would
  change the reply's shape for every agent already written against the tool. Skipped
  questions are sent as `no preference — your call` rather than omitted, because a gap in a
  numbered list invites the model to re-align the rest onto the wrong questions.
- **Asked one at a time, not laid out at once.** Two reasons, and the second is the one that
  matters: the panel lives in the dock and grows *upward* into the wall, so three questions
  with four options each is a dock that has eaten the studio — and a decision read on its own
  is answered on its own, where decisions shown together get read together, which is the very
  habit that made the agent fuse them in the first place. `.ask` also carries a `max-height`
  and `overflow-y` as the floor under that.
- **Rust reads nothing out of the arguments.** `AskOpened` carries the tool call's `args`
  whole and `asking.ts::normalizeAsk` owns the vocabulary — the same bargain
  `widget.config_json` and `ambience_profile.layers_json` strike, and it has already paid:
  `questions` was added without the struct changing. Normalizing degrades rather than
  refuses (a missing field, a string where an array belongs, a call with neither form), for
  one reason: the payload is whatever a model composed, and a card parked with nothing on
  screen to unpark it with is the one outcome that cannot be allowed.
- **Neither form may be `required` in the schema**, or a call using the other one is refused
  by the client before it reaches us — and a refused ask is an agent that stops asking. The
  guidance lives in the description instead, which is also where the model is told *not* to
  fuse decisions and why.
- **The step is derived from the sheet, never held** (`stepAt` = the first unanswered).
  Going back to revise an earlier answer and giving it again lands on the next open question
  rather than stranding a cursor on one already answered. `at` only ever *shows* an answered
  question and is cleared the moment one is given.
- **A sheet with several questions ends at a review, not at a send.** This is the whole point
  of asking them together: reading the third is often what changes your mind about the first,
  and sending on the last answer put that revision one gesture out of reach — you could go
  back freely right up until the moment it stopped being possible. So the answered sheet is
  drawn as pairs, every one a way back into its question, and the send is its own act. One
  question still sends on the click: there is nothing to step to and nothing to review, and
  making a single decision cost two gestures would be a worse panel than the one this
  replaced.
- **There is no order to enforce, and enforcing one was a bug.** Any question is reachable at
  any time, answered or not — the spine, `←`/`→`, and the op's `at`. An earlier cut walled off
  everything past the first unanswered question, on the belief that a sheet filled out of order
  composed a reply the agent would read against the wrong decisions. It does not:
  `composeAnswer` keys each answer to its own question by *index* and always emits them in the
  order they were asked, so the reply is byte-identical however the sheet was filled (this is a
  test, not a claim). What the rule actually cost was the ability to look ahead at what else is
  being asked before deciding where to start — and since the questions in one call are usually
  independent, which is the entire reason they arrive together, that is the normal case rather
  than an edge one.
- **The answers live on the ask, not in `Ask.svelte`.** The dock draws whichever card is
  blocked, so the component survives the card changing under it — held locally, switching to
  another blocked card and back would throw away everything already answered. The same fact
  is why `at` is reset on `askId`: a "back" from the last card's sheet would otherwise point
  into a different set of questions.
- **The question is rendered, not printed.** It used to be a bare `{ask.question}` while the
  transcript six inches away rendered the same prose properly, so an agent's backticks and
  hashes arrived as themselves. `Markdown.svelte` is renderable outside the panel (`--read`
  defaults to 1) so this costs an import, with `nav={false}` — a question in the dock is not a
  place in the transcript for the rails to travel to.
- **`MAX_QUESTIONS` is 5, and the overflow is said out loud.** An agent that asked six things
  and got five answers will act on the sixth regardless; silence there reads as "all of it was
  asked".
- **The peek is named by headers, never by a truncated body** (`askHeadline`). That line is
  `white-space: nowrap` with an ellipsis, so a question body put there is a cut-off paragraph
  naming nothing — and a call carrying several would name only the first.

`snapshot.cards[].pendingAsk` keeps `question` and `options` under their old names, meaning
the question *currently* being asked, and adds `step`, `count`, `headers`, `answers`,
`dropped` and `complete` — a call parked on three decisions with two answered otherwise looks
from outside exactly like one parked on three with none. The `answer` op fills in the current
question and steps on (`answers` for several at once, `at` to answer or revise any nominated
one, `rest: true` to leave the remainder to the agent). It reports `sent: false` until the
sheet is complete, then `reviewing: true` until `send: true` — mirroring the panel, because an
op that sent straight through would be testing a path no hand can take.

