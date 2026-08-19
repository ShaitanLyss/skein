---
paths:
  - "src/lib/accounts.ts"
  - "src/lib/waterfall.svelte.ts"
  - "src/lib/Accounts.svelte"
  - "src-tauri/src/accounts.rs"
  - "src-tauri/src/claude.rs"
---

# More than one subscription, in an order

One account runs out at four in the afternoon and twenty cards stop. That is the
whole problem. Skein already knows what is left of an allowance
(`.claude/rules/usage.md`) and already spawns every card itself
(`supervisor.rs`), so it is the only thing on this machine positioned to spend a
second subscription without anybody noticing the first one ended.

This is the subsystem that does it: a registry of accounts in a fixed order, a
ceiling you set per account, a swap that costs a card nothing it had already
read, and a wall that stops rather than fails when there is genuinely nothing
left.

### The credential is not ours to hold

`CLAUDE_CODE_OAUTH_TOKEN` is read by the CLI ahead of
`~/.claude/.credentials.json` and does not write to it. Probed 2026-08-19
against claude 2.1.235: with the variable set `claude auth status` answers
`authMethod: "oauth_token"`, with it unset `authMethod: "claude.ai"`, and the
credentials file is byte-identical afterwards either way. Three consequences,
and the design rests on all three:

- **A swap is per-process.** The variable is set on the child at spawn, so two
  cards can be on two accounts at the same moment. Nothing here edits a file
  that Claude Code is also reading, which is the race `limits.rs` refuses to
  enter for the same reason — the loser of a credential race is signed out.
- **The config directory stays shared.** `CLAUDE_CONFIG_DIR` would isolate the
  accounts properly and is the wrong tool: it splits the session transcripts
  three ways, and a session started on one account could then never be resumed
  on another. That resume is the entire swap mechanism. So: one config dir,
  three tokens.
- **A token does not announce whose it is.** Under token auth `auth status`
  omits `email`, `orgName` and `subscriptionType` — probed the same day. So the
  **label is the only name an account has**, it is yours to give, and nothing
  here can verify that the label on a token matches the subscription behind it.

The tokens themselves live in `~/.claude/tokens/<label>.tok`, DPAPI-wrapped,
written by the `cc-add` PowerShell helper. **Skein stores no token anywhere** —
not in its database, not in a snapshot, not in a log. The database holds the
label, the rank and the caps; `accounts.rs` goes to the store for the secret at
the moment it builds a `Command` and lets it go again. This is `limits.rs`'s
standing rule extended rather than a new one, and it buys a real property:
deleting Skein's database costs you no credentials, and a Skein bug cannot leak
one it never had.

DPAPI means the blob decrypts only under this Windows user on this machine. The
format is PowerShell's own — `ConvertFrom-SecureString` with no `-Key` — which
is a raw DPAPI blob, hex-encoded, over the UTF-16LE bytes of the token. Probed
2026-08-19: 524 hex characters for a 35-character token, opening with the v1
magic and the provider GUID `df9d8cd0-1501-11d1-8c7a-00c04fc297eb`.

### The order is an order, not a preference

Accounts have a **rank**, and the rule is strictly waterfall: the lowest-ranked
account that is allowed to work gets the work. Not the one with the most
headroom. Those two policies differ in exactly the way that matters — spreading
by headroom keeps three accounts at 40% and leaves you with three
part-exhausted subscriptions and no clean one, where a waterfall keeps the
second and third untouched until the first is genuinely spent. A reserve is only
a reserve if something guards it.

**A card swaps when it must, not when it could.** The waterfall picks the
account for a card that is *starting* something — a new card, a dormant one
waking, a held one released. A card already mid-conversation on account two
stays there while account two is still allowed, even once account one has come
back. This is not a softening of the ordering: new work still always falls to
the lowest available account, so the consumption order is unchanged. It exists
because a swap has a cost, below, and paying it to move a conversation back to
an account it will only have to leave again is paying it twice for nothing.

### What a swap costs

A swap is `close_conversation`, then `open_conversation` on the same session id
with a different token in the environment — which comes back up `--resume`,
because the transcript is on disk in a config directory both accounts share.
The card keeps its context, its scrollback and everything it had read.

What it does not keep is the **prompt cache, which is per-account**. The first
turn after a swap re-reads the whole conversation uncached at full price. On a
card fifty turns deep that is the expensive kind of invisible, and it is why
the stickiness rule above exists, why the swap happens at a turn boundary
wherever possible, and why the transcript says so out loud when it happens. It
is also an argument, when the wall is busy, for letting a shallow card take the
swap and a deep one take the wait — which this does not currently automate, and
should not until somebody has watched it happen for a week.

### Two ceilings, and only one of them is yours

Every window the account is measured against (`limits.ts::Window` — `session`,
`weekly_all`, the scoped ones) can carry a **cap**: a percentage past which
Skein will not start new work on that account. Caps are per account and per
window kind, so "account one, never past 80% of the five-hour" and "account two,
never past 50% of the week" are both sayable, which is what they are for.

That is *your* ceiling, and it is the only one that is negotiable. The other is
the server's: a window at 100%, or wearing a `severity` of `rejected` or
`exceeded`, is an account that will refuse work whatever anybody here thinks.
The two are kept apart all the way to the face, because they mean opposite
things to the person reading it — one is a decision you made and can unmake, the
other is a fact you can only wait out. `blockedBy` returns which.

Caps clamp to 100 and default to none. A cap *above* 100 is not a cap, and is
read as none rather than honoured, so a slider dragged to the end cannot
accidentally mean "and past the real limit too".

### The bypass is per card, and it only moves your own ceiling

A card can be told to ignore the caps. It then measures every account against
the server's ceiling alone, in the same waterfall order. This is the escape
hatch for the afternoon when the thing you are doing matters more than the
reserve you were keeping, and it is per conversation rather than global because
that is the granularity the decision actually has.

**A bypass cannot cross the server's ceiling**, because nothing can. A bypassed
card with every account genuinely spent is held exactly like an unbypassed one.
Anything else would be a promise this app is in no position to keep.

A card that is bypassing says so on its face for as long as it is. The rule is
`healNote`'s: Skein spawns with `--dangerously-skip-permissions`, and the one
thing an app like that owes you is that nothing it does on its own is invisible
afterwards. A card quietly spending a reserve you set aside is precisely that.

### Being held, and coming back

When no account is allowed to work, a send is **held** rather than failed. The
prompt is kept, the card says what it is waiting for and until when, and the
moment an account frees up it goes. Nothing is lost and nothing is silently
dropped.

`heldUntil` is the *earliest* moment any account comes back — the first door to
open, not the last — and it comes from the `resetsAt` of whichever windows are
doing the blocking. A window blocking with no named reset (a scoped window
nobody has touched genuinely reports none) makes the answer unknown rather than
infinite: the hold stands and the next allowance poll is what releases it. So a
hold has two ways out, a timer and a poll, and needs neither to be reliable.

Escape on a held card drops the hold and the prompt with it, which is the same
gesture and the same meaning it already has on a card waiting to heal
(`skein.svelte.ts::stop`). A card waiting on your account's clock is a card
about to act on its own, and Escape aimed at one means don't.

### The reactive half, and what is not probed about it

The proactive path above reads the allowance and decides before it sends. It
cannot be sufficient on its own: the poll is at best a minute old (`FLOOR_MS`),
a five-hour window can cross a cap inside that minute, and other machines may be
spending the same account. So a turn that comes back rate-limited swaps and
re-sends, through the existing heal machinery, as `HealKind: "limited"`.

Unlike the other two heal kinds this one does **not** wait — waiting is what the
other accounts are for. It marks the account spent on the server's word (which
outranks our last poll, being newer and being the actual refusal), picks the
next in the waterfall, and re-sends there. Where no account is left it becomes a
hold, which is the honest end of the ladder: the heal budget is not what bounds
this, the accounts are.

**`wasRateLimited` is written from the API's documented shape and has not been
probed against a real refusal**, which is the one thing in this file not
established by observation — a limit has to be hit to see it, and the hit is
the thing being avoided. It matches on `429` together with limit wording, in the
two-signal style `wasMalformedRequest` uses and for the same reason: a bare
`429` from some tool the agent ran is not this, and a card that swapped account
on the strength of an agent quoting a rate-limit error would be the exact bug
`faultText`'s gate was written to stop. When somebody does hit one, the wording
belongs in this paragraph and the predicate belongs beside it.

### Finding Claude Code before installing it

Every card is a `claude` child, so "claude is not on PATH" stops the whole wall
— and it is the failure most likely to be a lie. A per-user install that never
got a PATH entry, a GUI app launched from Explorer with a different environment
than the shell that installed it, a package manager's own bin directory: all
three look identical to `Command::new("claude")`, and none of them means the CLI
is absent. So `claude.rs` looks in every known home before it will admit to
missing, and `supervisor.rs` spawns the **path it found** rather than the bare
name — which is the fix for the off-PATH case on its own.

**`%LOCALAPPDATA%\AnthropicClaude\claude.exe` is the desktop app and is not the
CLI.** Probed 2026-08-19 on this machine: it answers `--version` with
`1.21459.3` where the CLI answers `2.1.235 (Claude Code)`. A discovery routine
trusting the filename would have spawned it for every card on the wall. So a
candidate is Claude Code only when it *says* it is — `verify` requires the words
`Claude Code` in the version string, and a bare version number is never enough,
because the wrong binary has one of those too. That directory is deliberately
absent from the search list as well, so a not-found message cannot send somebody
to reinstall the wrong product.

Installing is `https://claude.ai/install.ps1` (the Windows sibling of the
`install.sh` the CLI carries a reference to; both strings are in the binary).
**Nothing calls it automatically.** `find` coming up empty is a question to put
to somebody, not a licence to execute a script off the network — an app that
downloads and runs one because a lookup failed is an app that does it on a
typo'd PATH.

### Signing in, and why it takes a window

`claude setup-token` is the only supported way to mint a long-lived token, and
it is an interactive TUI. Probed 2026-08-19: run with pipes for stdio it emits
nothing at all and never exits — it wants a terminal, and there is no
`--print`-shaped arm to ask for instead.

The obvious answer is a PTY, and it is closed here: **ConPTY is broken on this
machine**, which `servers.md` and `shell.md` both record at length — every
`openpty`-spawned child dies at `0xC0000142` having emitted only ConPTY's own
`ESC[6n`. `shell.rs` is pipes for exactly this reason and the same reason
applies one module over.

The other obvious answer — Skein implementing the OAuth flow itself — is worse
than it looks. It means pinning a `client_id` that is not ours against
undocumented endpoints, and it breaks silently whenever any of that moves. A
sign-in is the last thing that should be reverse-engineered.

So the flow is orchestrated rather than embedded: Skein opens a real terminal
running `claude setup-token`, the browser round trip happens there, and a
wrapper writes the resulting token straight into `~/.claude/tokens/<label>.tok`
DPAPI-wrapped — so **the token never passes through Skein**. The paste happens
in that terminal rather than in a field on the wall, which is what keeps the
secret out of a webview entirely; Skein supplies the label, watches the store
for the file, and picks it up. Rust reads that store and never writes it, so
there is exactly one place a credential is handled on the way in. A window appears, which is the honest cost of an
interactive TUI on a machine whose PTY layer does not work; everything else
about the gesture stays in the app.

### Where the pieces are

`accounts.ts` is pure and answers every question of *meaning* — is this account
allowed, which one is next, when does the wall come back, what is any of it
called. All of it is tested (`test/accounts.test.ts`), which is the same split
`limits.ts` draws against `limits.rs` and for the same reason: the policy is the
part that will be argued about, and an argument is worth having against tests.

`accounts.rs` holds the facts and the secret handling: the registry in SQLite,
the DPAPI read, and the one function that puts a token into a `Command`'s
environment. `waterfall.svelte.ts` is the reader the wall watches, on the
`ledger.svelte.ts` pattern — named for what the subsystem does rather than for
the module it serves, because `accounts.svelte.ts` does not survive contact with
Windows: `./accounts.svelte` resolves to the component `Accounts.svelte` on a
case-insensitive filesystem and `svelte-check` refuses two files differing only
in casing. That is the `usage.svelte.ts` trap `ledger.svelte.ts` is named
around, one degree worse — not an ambiguity resolved the wrong way but one that
cannot be resolved at all. `skein.svelte.ts` does the swapping and the holding,
because sending is a Rust call and a `Conversation` never makes one.
