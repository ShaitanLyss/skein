---
paths:
  - "src-tauri/src/spawn.rs"
---

# A card putting a card on the wall

This wall's thesis is that concurrent conversations are the unit of work, and for its whole
life only *you* could start one. An agent that had decomposed a job into four independent
pieces had two moves and neither was a card: do them one after another in its own context, or
spawn subagents that live inside its turn, report through it and vanish. A subagent cannot be
looked at, talked to, sent a message, or left running while you go and read something else.

`spawn` is the tool, and it is the most consequential one on this server. Almost all of the
file is the bounds.

### What it deliberately cannot do

A project card spawns with `--dangerously-skip-permissions`. A tool that let an agent choose
*where* a new one of those stands **by writing a path** is a tool that lets a model pick a
directory and be handed the machine in it — through whatever the agent happens to have been
reading all turn.

- **The child stands on the wall.** Where the parent stands by default, or in one of the
  wall's own territories, *named*. Never a path the caller composed: `project` is resolved by
  `standing` against `store::projects`, and a needle matching nothing is refused with the list
  of what would have matched. So the bound that cannot be argued around is no longer "the
  parent's cwd" but **the user's own declaration of where they work here** — a territory is in
  that table because they opened it and stays until they forget it (`forget_row`), so the set
  of reachable directories is one they curated rather than one a model composed. A
  subdirectory of a territory is not a territory, and a test says so.

  It was the parent's `cwd` and nothing else for the tool's first life, on the reading that
  the capability a spawned card has must be exactly the capability the spawning card already
  had. What that reading missed is that the wall is not one repository: a card in `atelier`
  that has worked out what `nova` and `caravan` each need could describe the work and then
  wait to be asked, which is the whole gesture the wall exists to remove. And the escalation
  it was guarding against is thinner than it looks — every project card on the wall already
  holds a shell with no permission prompt, so a directory the *user* put on the wall is not a
  reach the model has gained. A path it invented would be.

### Naming a territory

- **By name as `list` reports it, or by root path.** Path first, since `root_path` is unique;
  name second, folded for case, and both folded for separators — a model reading a path back
  out of `list` should not depend on which slash it chose.
- **Two territories can share a name and neither is picked.** Only the root path is unique, so
  `C:\dev\nova` and `D:\archive\nova` are both `nova`; guessing the first would open a card
  with the machine in its hands in the wrong repository, so it is `Ambiguous` and the refusal
  carries both paths.
- **Naming your own project is the default said out loud** — `Standing::Here`, which keeps the
  parent's `cwd` rather than the project root. That is what lets a card in a worktree open one
  beside it instead of one in the main tree.
- **Skein's own directories are not on offer.** Chat cards need an address and get a folder
  beside the database, which `#openIn` makes an ordinary `project` row of (`chat.md`) — a row
  in the table that nobody declared. `is_skeins_own` drops it, in `spawn.rs` rather than in the
  query, because what disqualifies it is where the database lives and SQL cannot see that.
- **Resolved before the id is minted**, so a misnamed project costs nothing against the hourly
  bound: an agent correcting a name is not an agent fanning out.
- **The receipt for a card in another territory is worded differently**, and not for
  decoration. "It has the brief and nothing else of yours" costs something real there — the
  child cannot read the file the parent was looking at, so whatever it needed from here was in
  the brief or is gone. And it is outside the caller's project, so the default `list` scope
  will not show it; being told that saves a round of looking for a card standing exactly where
  it was asked to.
- **A chat card may not spawn.** It reaches nothing on this machine on purpose (`chat.md`),
  and a chat card opening a project card would be a line from the open web to a shell — the
  hole `relay.rs` refuses `send` and `list` to close, one layer further up. Decided by asking
  the store what kind of card the caller is, never by trusting the caller, which is
  `spawn_conversation`'s own rule.
- **One generation.** A card an agent opened may not open one of its own, and this is the
  guard that matters. It is `relay.md`'s reasoning exactly: **the branching is the problem
  rather than the depth**, so a hop counter is the wrong instrument — every spawn is a first
  one. Four children each spawning four is sixteen agents on one prompt, then sixty-four, and
  a depth limit set at six would let all of it through.

### And what it cannot help doing

It costs money and attention without asking. So does `send`, so does a broadcast, and the
answer is the same: bound it, make it visible, and say what it cost.

- **Four live children per parent, six spawns an hour.** Two bounds because they answer
  different failures: the first is about how much is running at once, the second catches a
  spawn that was asked for and never drew — an agent whose spawn silently failed and which is
  therefore asking again is precisely the loop the rate is for. Both refusals carry their
  reasoning, per `MAX_HOPS`: an agent told only "no" tries a different phrasing.
- **Every spawned card is a card.** On the wall, with a title, in `list`, named by the perf
  meter, closed by the same gesture as any other. Nothing about it is hidden, and that is the
  whole difference between this and a subagent — a fan-out you can see is one you can stop.
- **The description tells the agent to say so.** `Tell them you are opening a card, and why`,
  and a test asserts that sentence is there. This is the one tool on the server that spends
  the user's money on a turn the user did not ask for, and a quiet one would be the wall
  growing cards nobody accounted for.
- **The brief is the whole of what the child gets** — not the parent's context, not what the
  user said, not what has already been ruled out. The `prompt` field says so in those words,
  because a one-line prompt spends an entire card rediscovering what the parent already knew.

### Rust decides; the wall opens

`Skein.#openIn` is the one correct way a card comes into being: ensure the project, write the
row *before* the spawn so `spawn_conversation` can ask the store what kind of card it is,
resolve the account off the waterfall, mint the `Conversation`, load its history. Reproducing
any of that in Rust would be a second birth path, and the one that drifts is the one nobody
is looking at.

So `spawn.rs` checks the guards, mints the id, records the parentage and emits; `#openIn`
gained one optional argument and `Skein.openSpawned` is the door.

**And that is why a card in another project cost the front end nothing.** `spawn:asked`
already carries a `cwd` and `#openIn` already calls `ensure_project` on it — which finds the
existing territory rather than making a second one, since `root_path` is what a project is
identified by. A card opened in `nova` from a card in `atelier` therefore travels the same
line as `new conversation here` does in `nova`. Deciding *where* in Rust and opening it on the
wall is what makes that true; had the wall been the thing choosing, this would have been a
second door.

- **Minting the id in Rust is what makes the receipt useful.** The agent is handed the child's
  handle in the same tool call, so it can `send` to it or `recall` it without a round of
  `list` and a guess about which card is new. That is the only reason `#openIn` takes an id at
  all, and the comment there says so.
- **The brief goes in through `send`**, so it is echoed into the child's transcript exactly as
  a typed prompt is. What the parent asked for should be *readable* there rather than inferred
  from what the card does next.
- **A given title is not `named_by_hand`.** It is a label to tell cards apart until the card
  names itself from its first turn, and `read_ai_title` must be free to replace it — see
  `naming.md`.

### `spawned` is a table, not a column

`conversation.spawned_by` would have been the obvious shape and could not work. The row for a
card is written by the *front end*, and `spawn.rs` has to know the answer **before** the card
is opened, since that is when the guards are checked — so there is no row to stamp. Recording
the intent instead makes the question answerable at the only moment it is asked, and leaves
nothing to race. `store::migrate_v20` has the rest of it, including why nothing sweeps the
table: the value of a lineage is answering "was this opened by an agent" months later, and one
that evaporated when the parent closed would answer that wrongly and confidently.
