---
paths:
  - "src-tauri/src/spawn.rs"
  - "src/lib/lineage.ts"
  - "src/lib/Lineage.svelte"
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

## The root a spawned card stands on

For its whole first life the table had no reader: `spawned_by` was a command nothing called,
and a card an agent had opened looked exactly like one you opened yourself. `lineage.ts` and
`Lineage.svelte` draw it, and the reason it is drawn as a *root* is an argument with
`relay.md` that this feature wins.

**A standing line is honest here and nowhere else.** `flow.ts` refuses to draw a message as a
wire, because "a line between two cards says they are connected, which is a claim about the
wall that is not true — nothing connects two cards, and a message is an event rather than a
relationship". Parentage is the exception that argument implies: it *is* a relationship, it is
a row written before the child exists and kept after both cards are closed, so a mark that
stays says something true. Nothing about `flow.md`'s rule is weakened — it is the reason this
one is allowed.

**So the two are deliberately not the same drawing, and the difference is the layer.** A relay
strand is light in the air: braided, celadon, transient, above the cards. A root is in the
ground: opaque, achromatic, permanent, below them — the canvas is a sibling of `Backdrop`
inside `.surface` and *before* `.pan`, so it draws over the weather and under the territories,
the images and the cards. **Above a card is traffic; below it is structure.** That reading cost
no prose in the UI and no legend: it is the document order. It also means a root reaching a
card passes under it rather than across its title, with no rim arithmetic to get right.

- **Colour is status, so the root has none** — `--edge`, the tone the wall's own furniture is
  in, read off the document so a derived theme moves it. Parentage is as true of a card that
  finished yesterday as of one streaming now, so it cannot be a status colour, and
  `tokens.css` forbids a decorative one. The moving light everybody reaches for first — an
  arc, a spark, electricity — is available only by making it *mean* something, and there is
  exactly one thing it can honestly mean: a charge runs a root only while that child is
  working, in `--st-work`. `Canvas` derives that set from the same `tier` the card's own colour
  comes from, so the two can never disagree about what working means.
- **One trunk, forking, and the fork is emergent.** Four children in four territories is four
  strands across the wall, which is spaghetti; so children are clustered by bearing
  (`clusters`), one cluster is one trunk, and every limb of a cluster shares its first control
  point. They therefore leave along one tangent and separate smoothly, and *no trunk geometry
  is computed anywhere*. Every limb goes into one `Path2D` filled once, so the coincident part
  unions instead of stacking alpha into a seam — which is the only reason that trick works,
  and why the base widens with the number of children: a fat trunk splitting into thin
  branches is the whole reading.
- **Two territories, two trunks.** A mean direction over a child east and a child west is
  meaningless and a limb drawn along it doubles back through the card it came from. The wrap
  join in `clusters` is the other half: the sort's seam falls at due west, so a fan sitting
  across it arrives as two groups at opposite ends of the list.
- **Direction needs no arrowhead** — the taper is monotonic, thick where the work came from and
  a hair where it arrived. A relay strand answers the same question with the sign of its bow;
  neither wall ever draws an arrow.
- **Widths follow the zoom, where a strand's do not.** The one place this and `flow.ts`
  disagree, and each is right about its own thing: a strand keeps its width at every zoom
  because it is light crossing a room, and a root is a thing lying on the ground beside the
  cards — at `field` density a fixed 6px trunk against a 60px card reads as a cable somebody
  left out. Clamped at both ends, because at no zoom may the structure thin to nothing.
- **A new root grows out; a restored one is simply there.** `born` is stamped by `Skein` when
  `spawn:asked` arrives — the moment it happened — and is absent for every pair read back at
  launch, or the wall would sprout twenty roots as though each card had just been opened. The
  width profile is read against the grown length, so a half-grown root is a complete short
  root: a thing extending rather than a thing being revealed.
- **One clock, and it is `Date.now()`.** `born` mirrors a unix timestamp Rust wrote, so
  measuring growth against `performance.now()` is an epoch the root never started from —
  `reachOf` clamps to zero and nothing is drawn at all.
- **An idle wall runs no frames**, per `Backdrop` and `Flow`. A root that is neither growing
  nor charged is a static shape, repainted from a reactive read when the wall moves and not
  from a clock. `stirring` decides, and it asks the *rows* rather than the limbs on purpose:
  limbs are computed from the card boxes, so an effect that read them would tear the loop down
  and rebuild it on every frame of a pan — the exact hazard `flow.md` names about tracking a
  list instead of a boolean. What that costs is one idle loop for a working child whose parent
  has been closed, which is the better side of the trade.
- **A pair with an end off the wall is not half a root.** `familiesOf` drops it, and
  `store::lineage` asks the narrower question one layer earlier so the wall is never handed
  rows it will only throw away. The rows themselves stay, per the table's own note.
- **Read once, then only appended to.** A spawn *emits*, so the wall learns a new root from
  `spawn:asked` rather than by asking again; `Lineage.svelte` has no poll in it and
  `spawn::lineage` is called exactly once per launch.
