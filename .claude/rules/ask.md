---
paths:
  - "src-tauri/src/ask.rs"
  - "src/lib/asking.ts"
  - "src/lib/Ask.svelte"
  - "src/lib/Gallery.svelte"
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

**And then it died at five minutes anyway, because there are two watchdogs and the variable
moves one.** Reported 2026-08-19 and read straight out of the 2.1.232 binary rather than
probed, since six minutes of parking per attempt is a slow way to ask: every `tools/call`
arms a hard deadline — the one `MCP_TOOL_TIMEOUT` sets — *and* an idle deadline that fires
when a call has gone that long with neither a response nor a progress notification. The idle
default is chosen by transport: 1800s for `stdio`, **300s for `http`**, which is what this
server is. It is polled on a 30s interval, so the question was abandoned at the first tick
past five minutes with `"sent no response or progress for 300s; aborting"` — on a card whose
own clock had another five minutes left to run, which is exactly what it looked like from
the outside and looked nothing like a second timeout.

A progress notification resets it and there is nothing here to send one down: this server
answers POSTs and never opens an SSE stream, which is most of why it is as small as it is.
So the fix is the per-server `timeout` field the CLI's own message names, and `ask::mcp_config`
is now the one place the `--mcp-config` is built so the number cannot be set in one of the two
places and not the other. It raises **both** deadlines — the idle one is
`max(transport default, timeout)` clamped to the hard one — which is why one number covers it.
The env var is kept as well; it costs nothing and is what an older build reads.

The general shape, and it is the third time this file has learned it: **a deadline you have
moved is not the only deadline.** Something that stops early after you fixed it stopping
early is usually a second clock, not the first one misbehaving.

- **The client is told to wait a minute longer than we do**, deliberately. Whichever side
  gives up first writes what the model reads, and ours is the sentence worth having — it
  says how long it waited and what to do next, where the client's says only that something
  timed out. `ANSWER_TIMEOUT` stays the real deadline.
- **The heartbeats are not a way out.** The CLI streams `tool_progress` events every 30s for
  a call in flight, but they do not extend either of its deadlines — the abort landed on the
  same tick as the 60s heartbeat, and what the idle watchdog wants is a notification coming
  the *other* way, from the server, which needs an SSE stream this one does not open.
- **Both numbers come from `client_timeout_ms`.** The env var and the config field are one
  value written twice, and a test in `ask.rs` asserts the config carries it — the failure it
  guards is silent, since a card with only the hard deadline raised looks completely correct
  for four and a half minutes.
- **The abort is visible to the server and is currently ignored.** tiny_http's parked thread
  does not notice the dropped connection, so past its own timeout the card would go on
  showing a question the agent has abandoned. With the env set, ours fires first and the
  question is always closed by something.

Consequence for `classify.ts`: the `asked` ending is currently unreachable via tools, so
amber means *has been waiting too long* — urgency decays with neglect against a single
one-second `clock` rune shared by all cards.

#### A tool the agent can see, under a name it can call

Two failures, found together on 2026-08-19 from one symptom — agents barely touching the
billboard — and they compound: the reasoning was withheld, and the pointer to it was wrong.

**Withheld.** Tool search is on by default in the CLI and is *not* threshold-gated when
`ENABLE_TOOL_SEARCH` is unset (read out of 2.1.235; unset and `auto` are different modes and
only `auto` weighs the definitions against 10% of the context window). So every MCP tool
arrives at a card as a bare name behind a `ToolSearch` step with its schema withheld — which
costs this server more than most, because everything that makes the billboard work is *in*
the descriptions: that reading it is free where a `send` costs the other agent a turn, that a
notice wants `paths`, that `unpost` is the half nobody else can do for you. `mcp_config` sets
**`alwaysLoad`**, which exempts the whole server whatever `ENABLE_TOOL_SEARCH` says and does
not count toward `auto`'s threshold either, so skein does not compete for budget with
whatever else the machine has configured. ~9KB of schema per spawn, and the CLI's own
documentation names this case: a small number of tools wanted on every turn.

**Wrong.** The `--append-system-prompt` said `ask_user`, `board`, `post`, `list`, `send` —
and not one of those is a name a card can call, since the CLI prefixes every MCP tool with
its server (`mcp__skein__board`). The one paragraph guaranteed to be in front of every agent
spent its length naming five identifiers that resolve to nothing. Nothing errored: the tools
were there and described, and the card was pointed at names for them that were not. An agent
that never calls a tool it cannot find looks exactly like one choosing not to, which is why
this survived as long as it did — and why `supervisor.rs` now asks `ask::dispatch` what is
advertised rather than keeping a list, so a renamed tool breaks a test instead of stranding a
sentence.

The two are coupled in one direction worth knowing before touching either:
`supervisor::append_prompt` is *short because of* `alwaysLoad`. The descriptions carry the
reasoning, so the paragraph need not, and re-stating it there would be the same words paid
for twice in the copy that can drift out of step with the schema. **Take `alwaysLoad` off and
that paragraph becomes the whole of what a card knows about the board**, at which point it
has to grow back. Both comments say so, from both ends.

The general shape, and it is a different one from this file's other lesson: **a capability an
agent cannot see is indistinguishable from one it declined to use.** Neither half of this
produced an error, a log line, or a failed call — only a wall whose billboard stayed empty.

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

#### Designs that are looked at rather than described

Claude Code in a terminal can only ever *describe* a layout, so an agent with three of them
to offer writes three paragraphs and you choose by imagining. Every one of those paragraphs
is a worse version of the thing itself, and the choice is being made from memory. There is a
webview here. So an option can carry a `preview` — plain `html`, optional `css`, optional
`js` — and Skein draws it (`Gallery.svelte`).

This is the one question this app is straightforwardly better placed to ask than the CLI is,
and it changes nothing about the parking: the reply is still the option's label, composed by
`composeAnswer` exactly as before. A preview is about *seeing*, never about answering.

- **The gallery is its own surface, not part of the dock.** `.ask` is
  `max-height: min(52vh, 30rem)` and grows upward into the wall; three mockups in it is the
  studio gone, which is the same argument that made the questions be asked one at a time.
  But it is also the opposite job. Questions are stepped through because a decision read
  alone is decided alone — *options within one question* are already all shown at once, and
  comparison is the entire reason a design preview is worth having. So the panels are laid
  out side by side, full size, over everything.
- **It hangs off an option for a comparison and off the question for an approval.** One
  design and a yes/no is not two previews; duplicating the same mockup onto both buttons
  would say it was two things. `panelsOf` flattens the two into the one list the gallery
  draws, and a question's own preview chooses nothing (`label: null`).
- **The frame is contained by two things and only one of them is guaranteed.** The `sandbox`
  attribute is spec: `allow-scripts` with deliberately **no** `allow-same-origin` puts the
  document on an opaque origin — no parent DOM, no `window.__TAURI__` through
  `window.parent`, no storage, no navigation, no modals. Those two are not independent
  permissions and adding the second hands the frame this document's origin back. The other
  half is a `<meta>` CSP inside the document (`previewDoc`), which is what closes network
  egress, since `tauri.conf.json` has `"csp": null` and nothing else would. **That half is
  reasoned about rather than probed** — a meta CSP applies to its own document by spec and
  srcdoc inherits its parent's, but nobody has run `tools/probe-*.ts` against WebView2 to
  watch a `fetch` fail. It is good enough for designs and is not yet evidence for anything
  else.
- **The threat this defends against is not a hostile agent.** A project card already spawns
  with `--dangerously-skip-permissions` and can delete the repo; that was decided at spawn
  and no iframe attribute revisits it. What the sandbox is actually for is the **chat** card,
  which spawns `--tools WebSearch,WebFetch` with no bypass and can reach nothing on this
  machine — and which is precisely the card most likely to be handed a design copied out of a
  web search. A running script there would be the first executable surface that card kind has
  ever had.
- **So scripts are gated by what kind of card asked, never by the payload** — the same rule
  `spawn_conversation` follows when it reads `kind_of` off the store rather than taking a
  capability as an argument. `Ask.svelte` passes `scripts={conv.kind !== "chat"}`, and the
  gate is the CSP's `script-src` rather than dropping the `js` field, so a `<script>` typed
  into `html` instead is refused by the same line. A chat card says so on the panel rather
  than silently rendering a design that looks broken.
- **The risk no sandbox closes is that a spin takes the window.** A srcdoc frame on an opaque
  origin shares the renderer with its parent, so `while(true){}` in a mockup freezes the wall,
  every transcript and the dock — and nothing can kill it, because the thread that would is
  the one that is blocked. The mitigation is that hover, focus and transition are all pure
  CSS, so **every preview renders static first** even on a card that is allowed scripts, and
  running one costs a deliberate click per panel with the cost written on the button. That is
  the whole of the defence and it is honest about being partial.
- **A fixed composing viewport, scaled down** (`PREVIEW_VIEWPORT`, 1280×800). A frame cannot
  report the height it wants and asking it would mean a `postMessage` channel back out of the
  sandbox — a hole in the only wall this stands on, opened for a layout convenience. It is
  also what makes three designs comparable: same size composed, same size judged, which is
  `CARD_BOX`'s bargain one surface over.
- **The app's own tokens are injected**, read off the live `:root` rules at mount rather than
  listed in the component, so a token added to `tokens.css` reaches previews with nobody
  remembering this file. A design composed in Skein's palette is being judged on the decision
  rather than on whether the agent guessed the greys.
- **Choosing from the gallery answers the question.** Reading the designs is how the decision
  gets made; closing the gallery and then hunting for the matching button in the dock would be
  answering it twice. It goes through `give`, so the single-question send comes with it.
- **Escape is captured on the window.** While the gallery is open it is the innermost thing
  there is, and `App.svelte`'s ladder is a bubble-phase listener that would otherwise stop the
  focused card's turn. The menu and the import panel are named in that ladder by hand; a
  capture listener needs nothing to know about it.
- **The schema's `preview` description is doing real work.** The model has spent its whole
  life describing layouts in prose to a terminal and will keep doing it beside an empty field,
  so `ask.rs` says what the frame can and cannot reach (no network, no imports, no
  frameworks), that the tokens are already defined, and what size to compose at. `preview` is
  required nowhere, for the same reason neither question form is: almost every ask is a
  sentence and some buttons, and a mandatory field would refuse all of them at the client.

`snapshot.cards[].pendingAsk.previews` is a count per question, for the reason the stepper's
fields are reported: a question whose three options carry three mockups and one whose options
carry none are the same question, the same card and the same tier from outside.

#### What the transcript keeps of it

The question lived in the dock, was answered there, and went — so the panel carried the tool
call and then, some seconds later, an agent acting on a decision recorded nowhere. Reading a
card back, *yours* was the half of that exchange missing. So the reply is kept in the
transcript under the call that asked, as a line kind of its own (`answer`).

- **It is not a `you` line.** That register is a prompt, and the rails list every one of them
  as a place in the conversation to travel back to; an answer to a question you were asked is
  not one. It is drawn small and set under the call — the footnote to the tool line above,
  not a new thing said — and achromatic, because the amber was the card *waiting* and it is
  not waiting any more.
- **Both folds go through `answerNote`**, which is why it is in `asking.ts` rather than at
  either call site. Live it takes what `answerAsk` sent; off disk `foldTranscript` takes the
  `tool_result` the CLI recorded against the call, and the two produce the same line — the
  seam `history.ts` exists to avoid. The `Answering each in turn:` preamble is dropped: it is
  addressed to the model, and the numbered pairs under it are the whole of what you decided.
- **This is the one tool result history draws**, and it is the exception for the reason the
  rule exists: every other one is machinery, and this is the only thing a *person* said that
  arrives on the wire as a tool result. A result carries no tool *name*, only the id of the
  call it answers, so the fold remembers which `tool_use` ids were `SKEIN_ASK_TOOL`.
- **What `ask.rs` sends when nobody answers is not something you said.** The ten-minute
  timeout and the dismissal are Skein's own sentences, and read off disk they are a
  `tool_result` like any other — drawn as an answer they put those words in your mouth,
  exactly the `isStopNote` hazard one layer over. `answerNote` returns them as `meta`, and
  the live path writes the same note off `ask:closed`'s `answered: false`, so a question that
  expired says so on the page instead of simply vanishing.
- **`SKEIN_ASK_TOOL` is in `classify.ts` and deliberately not in `ASK_TOOLS`** — that set
  decides the `asked` ending, which is for a turn that *stopped* on a question, and this one
  resumes in place the moment you reply. A card whose question you answered would settle
  amber and stay there. Naming it there does mean the call finally reads `asked you a
  question` rather than the raw `mcp__skein__ask_user` it drew for its whole life.

`snapshot.cards[].pendingAsk` keeps `question` and `options` under their old names, meaning
the question *currently* being asked, and adds `step`, `count`, `headers`, `answers`,
`dropped` and `complete` — a call parked on three decisions with two answered otherwise looks
from outside exactly like one parked on three with none. The `answer` op fills in the current
question and steps on (`answers` for several at once, `at` to answer or revise any nominated
one, `rest: true` to leave the remainder to the agent). It reports `sent: false` until the
sheet is complete, then `reviewing: true` until `send: true` — mirroring the panel, because an
op that sent straight through would be testing a path no hand can take.

