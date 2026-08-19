---
paths:
  - "src/lib/repair.ts"
  - "src-tauri/src/repair/mod.rs"
  - "src-tauri/src/repair/text.rs"
  - "test/repair.test.ts"
---

# Mending a conversation a tool call made unsendable

### The failure this exists for

A tool that reads a binary file as text puts characters into the transcript that the API will
not take. The whole conversation goes back over the wire every turn, so **one bad tool result
breaks every request after it, permanently**. From the wall it looks like a card failing
intermittently. It is not — it is failing identically, forever, and the only thing that
changes between attempts is that the conversation is slightly longer.

Found 2026-08-19 in `~/.claude/projects/C--Users-lyss-delprat-workbench/97d45f01-…jsonl`. The
agent ran

```
grep -aoE "(Paste|paste)[^"]{0,70}" claude.exe
```

to learn how the CLI words its login prompt — `-a` is *treat this binary as text* — and the
result carried **1,222 NUL characters and 100 undecodable bytes**. Three sends, three
`400 … unexpected end of data`, `HEAL_BUDGET` spent on retries that could not have worked,
and then a card that said the conversation was probably too large. It was 700 KB. Size had
nothing to do with it.

**What the file does *not* contain is the part worth knowing**, because it is what a repair
written from the obvious theory would look for and fail to find. The transcript is valid
UTF-8 and holds no raw NUL: the CLI sanitises at capture, so the undecodable bytes are
already U+FFFD on disk and the NULs are written as JSON escapes. Every byte-level check
passes. The poison is in the *characters the conversation holds*, one layer up — which is why
`repair_text` parses each record and walks the decoded strings rather than scanning the file.

### The two causes behind one error

`wasMalformedRequest` in `classify.ts` cannot tell them apart, and that is not a defect in it
— the API says the same thing either way:

- **the wire** — a body cut short in transit. Clears on a retry. This is the failure the heal
  in `turns.md` was written for, and its budget of two is calibrated to it.
- **the conversation** — characters the session cannot express. Never clears. Every retry is
  an identical failure that costs a whole conversation upload.

So the repair runs **on the first heal attempt only**, before the re-send, and its answer is
what says which failure this was. One file read decides it. `repairWorthTrying` gates it to
`malformed`: an overload is somebody else's weather and there is nothing in this conversation
to mend — running a repair on one would rewrite a session to fix a queue somewhere else.

### What it does, and what it says

The bad characters come out and **a note goes in where they were**, in the session file, in
the agent's own history:

> *[skein removed 11,340 characters of binary output from this tool result — 1,112 NUL
> characters and 100 bytes that would not decode… The command was: … Re-run it in a way that
> cannot emit binary…]*

That placement is the whole design. An agent that finds its `grep` output silently missing
runs it again the same way; one that reads why does not. Telling the *user* and leaving the
agent to discover a hole would have been half a feature.

Two rules inside the repair, and they pull in opposite directions on purpose:

- **A tool result is replaced whole.** Binary output is not partially trustworthy, and the
  note names the length and the command, so the agent can decide whether to re-run it.
- **Prose is stripped, not replaced.** An assistant message or a prompt that picked up one
  stray character keeps its text and loses the character. Destroying a paragraph to remove a
  byte from it would be a worse repair than the damage.
- **One control character condemns a string; U+FFFD needs three** (`FFFD_TOLERANCE`). There is
  no honest way for a NUL to be in a conversation — nothing types one and nothing means one.
  A replacement character has a legitimate use: a message *about* encodings contains one. This
  rewrites another program's file, so the doubt goes to leaving text alone.
- **A line that will not parse is not rewritten.** A record this cannot read is one it must
  not touch.

Verified against the real transcript, not only against fixtures: 288 records in, 288 out,
every one still valid JSON, 1,222 NULs and 100 undecodable characters gone.

### A repair to the file is invisible to a live process

This is the half that was missing when the feature first shipped, and it is the trap anyone
touching it will fall into again. `claude -p` is **long-lived** on this wall and holds the
conversation in memory: it builds every request from that, not from the transcript. So
rewriting the file underneath a running card changes nothing at all, and the re-send that
follows fails identically to the send that triggered the repair.

Observed 2026-08-19, which is how it was caught: a session repaired at 13:39, spoken to at
13:46, answered `400 … char 400492` — from a process that had been up since 11:28, while the
file on disk was verifiably clean and so were the five records the failed send appended.

So `#recycle` kills the child after a repair and leaves the card dormant. The send that
follows wakes it, `spawn_conversation` finds the transcript and resumes from it, and *that*
read is what finally picks the repair up. `retiring` goes up before the kill or our own exit
code lands on the card as a crash — the same ordering `clear` needs.

`#awaitDormant` sits between the kill and the wake because `close_conversation` returns when
the kill has been *asked for*, while the card learns it happened from `conv:exit` an event
later. Waking in the gap spawns a second process against a card that exit is about to mark
dormant, leaving the wall with a live child it believes is asleep — and the next send
spawning a third.

**The general shape, which is not about repairs at all: mending state on disk does nothing
for a process that already loaded it.**

### Keeping the original

`repair_session` writes `<session>.jsonl.skein-bak` before it touches anything, stages the
repair beside the file and renames it over — so a crash mid-write leaves the session either
untouched or repaired and never half of each.

**The backup is not discarded when the repair succeeds, because "succeeds" is not observable
then.** A repair that broke the session shows up as the *next* turn failing, and by then the
only copy of what the conversation used to be would be gone. `REPAIR_SETTLE_TURNS` is 2:
two turns of the agent working normally is the evidence. Two rather than one because the turn
straight after a repair is the one most likely to be short — an agent reading the note and
saying "understood" is not proof the conversation still holds together.

An error does not reset the count to zero, it just does not count. A card can break for its
own unrelated reasons a week later, and a backup kept forever on the strength of that is
exactly what the sweep then has to clean up.

`sweep_repair_backups` runs at launch for the exits that never reach the countdown — Skein
killed, the card cleared, the wall torn down mid-count — and drops anything older than
`SWEEP_AFTER`. Not awaited and its answer is not read: it is housekeeping in somebody else's
directory and a launch must not turn on whether it worked. Same argument as the job objects
in `supervisor.rs`: **"Skein cleans up after itself" is worth only what runs when Skein does
not get to finish.**

Clearing a card drops all of it. The backup belongs to a session the card no longer has, so
nothing can ever settle it — and the discard would then be aimed at the *new* session id,
which has no backup and never will.

### A line that names a cause must have checked one

The give-up note used to end *"the conversation may be too large to send"*. It was a guess
wearing the clothes of a finding, and it pointed the reader at trimming a conversation whose
size was irrelevant. It now says what happened and stops; `sayRepair` and `sayNothingToRepair`
are the lines allowed to name a cause, because they are the ones that looked.

A clean conversation is a real finding and the card states it — *"nothing corrupt in this
conversation — so the break was on the wire, not in it"*. That is a different claim from the
old one and the card has earned it.

The same correction, one layer over: `endingFor` preferred `api_error_status` over
`result`, so `lastError`, the transcript's error line and the card's activity all read `400`
while the sentence explaining it sat above in the transcript **because the CLI had printed
it** — Skein's own account of a failure was the least informative thing on the card. The
message comes first now; the status stays as the fallback, since `rate_limit_error` with
nothing said still beats "unknown error".

### Where the code is, and why it is split

`repair/text.rs` is pure — what counts as unsendable and what stands in its place — and
`repair/mod.rs` owns the file, the backup and the commands. That split is not tidiness. On a
machine with no MSVC toolchain `cargo test` cannot run at all (`build.md`, the `0xC0000139`
note), and a scratch crate that pulls in `text.rs` with `#[path]` is the only way those
assertions get run there. `include!` does not work for it: inner doc comments cannot come from
a macro expansion.

`src/lib/repair.ts` is the front end's half — when to reach for a repair, what the card says,
how long the original is kept — and is pure and directly tested like the rest of `src/lib`.

**`sayCommand` drops `cd … &&` before it truncates**, which is the one piece of cleverness
here and it was earned by a failing test. Taking sixty characters off the front of the real
command produced ``Bash cd /c/Users/lyss.delprat/.local/bin && echo "=== oauth…`` — sixty
characters naming a directory and never reaching the `grep` that broke the session. The front
of a shell line identifies it only after the navigation is gone.
