---
paths:
  - "src-tauri/src/board.rs"
  - "src/lib/board.ts"
  - "src/lib/board.svelte.ts"
  - "src/lib/Billboard.svelte"
---

# The billboard

`send` is a message to somebody. A **notice** is a message to nobody in particular — "I am
reworking the transcript panel this afternoon, leave `markdown.ts` alone" — and the difference
that matters is what each costs. Reading the board is free and reaches the whole wall; a `send`
costs the recipient a turn and reaches one card. So an agent that wants to know who is working
nearby reads the board *first*, and sends only once it knows who to send to.

`send`'s own description says that, and so does the system prompt, because the reflex the
roster tools create is exactly the wrong one: an agent that has just been told it can message
its colleagues will message them to ask what they are doing. See `.claude/rules/relay.md` for
the other half of this.

Three tools — `board`, `post`, `unpost` — and there are three rather than two because **taking
a notice down has to be as obvious as putting one up**. A board nobody clears is a board nobody
believes, and the failure is quiet: every notice on it stays true-looking forever, so the first
thing an agent learns is that the board is out of date and can be skipped.

### Clearing, in descending order of how much it can be relied on

Only the first works without anybody remembering anything.

1. **A card that closes takes its notices with it.** `store::sweep_notices`, called when a card
   closes and again on every read as the backstop for a crash in between. The commonest stale
   notice by a long way is one from a card that finished and went away.
2. **Clearing a card clears its notices.** A reset card is not still doing what it said it was
   doing.
3. **Stale is marked, never removed.** Ninety minutes untouched and every reading says so — the
   agent's and yours, off the same number, because `board.rs` computes `stale` onto the row
   rather than letting each side recompute a threshold. A long refactor is a real thing, and
   deleting a true notice is worse than showing an old one.
4. **Your own notices come first on every read**, under a line saying they are yours to take
   down, and the receipt for posting one says the same.

**No foreign key does any of this, and reaching for one is the trap.** `ON DELETE CASCADE` on
`from_id` looks like it clears the board when a card goes and does nothing at all, because
closing a card sets `closed_at` and deletes no row. That is worse than having no constraint —
it reads as solved. See the note on `store.rs::migrate_v15`, which is the same shape
`set_mid_turn` learned one table over: bookkeeping that records how far something got must not
be left to a mechanism that never fires.

### The notice that comes to find you

A notice can carry `paths`, and then it does not wait to be read: any card that writes to a
file one of the globs covers is served it, **once**. That is the difference between a board
agents must remember to consult and one that reaches the agent who needed it.

- **It is a notice served, not a lock, and the wording is not modesty.** Skein sees the
  `tool_use` on the wire, which is the earliest it can know — but the CLI queues a prompt
  written mid-turn behind the running turn, so what the agent gets is "before you go further"
  rather than "before you touch". There is no gate to hold: a project card runs with
  `--dangerously-skip-permissions` and the edit is already happening when the event arrives.
  Reading the board first is still the cheap way to find this out; this is the backstop for
  when it did not happen.
- **Writes only.** Reading a file somebody else is rewriting is not a clash — it is how you
  find out. The call sits beside `record_file_touch` in `skein.svelte.ts`, which is the one
  place a write is folded out of the stream; the two are separate because they answer different
  questions, one a ledger of what happened and one a thing that reaches out.
- **Once per (notice, card), decided by `INSERT OR IGNORE`** rather than read-then-write. A card
  making three edits in one turn is exactly the card this fires on, and a check-then-set would
  serve it three times.
- **Editing a notice clears its served marks**, because new words are news again. Without it,
  the agent most in need of the correction is the one guaranteed not to get it.
- **Never your own**, and a failed delivery is still left marked served: a dormant card replayed
  the same notice at every wake for the rest of the day is worse than one missed, and the board
  is still there to be read.
- It arrives in the `RELAY_MARK` envelope with a third header form, so the transcript folds it
  exactly as a message and there is one recogniser rather than two. `relayCap` says "from the
  billboard". It draws a strand from the poster's card when there still is one — it is the same
  event on the wall, something leaving one card and arriving at another.

### The globs

Small and deliberately forgiving, because the two failures are not symmetric: a glob that
matches too little is a notice that never reaches the agent it was written for and **looks
exactly like the feature working**, where one that matches too much costs somebody a paragraph
they did not need.

So a pattern with no separator matches the *basename* — `*.rs` obviously means "any Rust file"
and not "one in the drive root" — and one with a separator matches the **tail** of the path,
anchored at a separator so `re.rs` cannot match `store.rs`. `*` stays inside a segment, `**`
crosses them, and everything is folded to forward slashes and lower case because Windows spells
one path two ways inside a single turn.

`glob` is iterative with one backtrack point rather than recursive. Nothing here is adversarial
today, but the naive recursion is exponential on a pattern like `**a**a**a**` and this runs on
every write every card makes.

### Caps

Four notices per card, **refused rather than rotated** — an agent whose oldest notice was
silently dropped would go on believing the wall had been told. 120 characters of subject, 1200
of body, 8 globs. Posting the same subject twice **replaces** rather than adding, which is what
keeps an agent that re-posts once a turn from papering the board with one sentence, and is also
how a notice says it is still true (`touched_at` moves, so `stale` resets).

A chat card has neither tool, the same gate `relay.rs` applies and decided the same way — by
asking the store, never the caller. It has no project to be coordinated about, and the board is
a list of this machine's directories handed to the one card that can reach an arbitrary URL.

### Consulting it yourself

A `billboard` widget, which is this app's own idiom for "when I desire to": you hang one up,
and that gesture *is* the asking — `Board` reads nothing at all until a widget attaches, the
bargain `Ledger` and `Meter` strike. Unlike those two it **does not poll**. They poll because a
turn taken in a terminal appends to a file and emits nothing; every write to this table goes
through `board.rs`, which emits `board:changed`, so there is an event for every change there is
and a timer would be polling for news that has already arrived.

- **You can take any notice down and put one up**, unlike the pipelines and reviews faces which
  are read-only on purpose. Taking one down is the gesture that keeps the board worth reading
  and is the one an agent may have forgotten. Putting one up is the only instruction on this
  wall that reaches every agent without costing any of them a turn.
- **A notice you post has no author**, so nothing sweeps it away and it is yours to remove. It
  goes to the whole wall, because a notice you write by hand is not standing in any one project
  — you are.
- **No scope knob.** A widget belongs to no project, so "this project" has no referent to
  resolve against; the scope split exists for the *agents*, who must not be shown another
  project's work. You want the wall. The knobs are the reading — a list you glance at, or notes
  opened out — and whether stale notices are hidden.
- **The only colour on the face is the stale mark**, in amber. An old notice is not broken and
  is not working; it is a question, which is what amber means everywhere else here.
- `normalize` degrades rather than refuses, the bargain `normalizeAsk` strikes: what arrives is
  a row a model composed and a build older than it may be reading, and a board that silently
  shows less than is on it is the one failure this feature cannot have. Only two fields are
  load-bearing — no id means nothing to take it down with, no subject means a blank line.

`snapshot.board` carries the notices and the **watcher count**, for `listeners`' reason: the
reader is idle until a widget attaches, so an empty board on a wall with nothing hung up is the
feature working rather than an empty board. The control surface has `board` (the tool's own
words, as a model reads them), `notices` (the rows the wall draws), `post`, `unpost` and
`touch` — the last so serve-on-first-contact can be exercised without an agent taking a turn to
edit a file. Both readings are exposed and not one, because the two are what must not drift:
the tool's says `STALE` in prose and the wall's says `stale: true`, off one number.
