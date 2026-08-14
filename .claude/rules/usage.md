---
paths:
  - "src/lib/usage.ts"
  - "src/lib/ledger.svelte.ts"
  - "src/lib/Usage.svelte"
  - "src-tauri/src/usage.rs"
  - "tools/probe-usage.ts"
---

# What it has cost

#### What it has cost

The other meter, and the one that reads a clock rather than a machine: what Claude Code has
spent against the two windows its limits actually run on — a five-hour one and a week.
`usage.rs` reads, `usage.ts` decides, `Usage.svelte` draws, `ledger.svelte.ts` holds the one
reader behind however many of these are up (named for the class, since `usage.svelte.ts`
beside the pure `usage.ts` is one import specifier with two answers — the same trap
`meter.svelte.ts` and `cycle.svelte.ts` are named around).

- **It reads the transcripts, not Skein's own `turn` table**, and that is the whole design
  rather than a shortcut. The limits are per *account* and count every turn taken on this
  machine, terminal sessions included — and Skein's cards and a terminal's write to the same
  `~/.claude/projects/<slug>/*.jsonl` files, so one read covers both. The `turn` table knows
  only what this wall did, which is the wrong denominator for "am I about to be cut off", and
  carries zeros for in/out on every row written before `migrate_v7`. There is deliberately no
  `scope` knob like the process meter's: scoping to the studio would answer a different
  question with the same numerals, and `skein.spend` and the burn horizon already answer that
  one.
- **One API response is several records, all carrying the same `usage`.** A turn with a
  thinking block and a text block writes *two* `assistant` lines, and both repeat
  `message.usage` verbatim — the same numbers, not halves. Summed naively a reasoning turn
  counts two to five times over, so a line is folded in once per `message.id` + `requestId`,
  which is the pair identifying one request. Probed 2026-08-14 against claude 2.1.229's own
  transcripts, where the two blocks of one message differ in `uuid` alone. Measured over this
  machine's past eight days: **46% of all `assistant` records are duplicates** — 19,169 records
  for 10,323 requests — so without the dedup every figure here would read about 1.85x high.
- **Nothing may match on a bare field name**, because `usage.iterations[]` repeats
  `input_tokens` and friends per iteration. The record is parsed and read by path. The cheap
  gate before the parse is `"type":"assistant"`, which is most of what a pass costs — prompts,
  tool calls and Claude Code's own bookkeeping records carry no usage at all.
- **Cache writes are two prices and the file says which.**
  `cache_creation.ephemeral_5m_input_tokens` is 1.25x input and `…_1h_…` is 2x — a factor of
  1.6 between two numbers it would be easy to add together, which is the split `migrate_v7`
  had to make one level up. A record with no breakdown is charged at the cheaper rate rather
  than dropped: under-reporting is a smaller lie than losing the tokens.
- **`rateFor` guesses by tier rather than returning nothing.** A model released after the build
  shipped would otherwise price at zero, and a ledger silently reading zero for the model you
  are actually using is the one failure this widget must not have. Tiers have held their rate
  across every release so far, so guessing by tier is a much smaller error. A model matching no
  tier is counted as `unpriced` and said out loud on the face.
- **All five kinds of token are priced, and cache is most of the bill.** Input at the model's
  rate, output at its output rate, a cache read at 0.1x input, a five-minute cache write at
  1.25x and an hour one at 2x. Measured over this machine's past seven days on 2026-08-14:
  cache is **89% of the spend** — $852 of cache reads and $270 of hour-TTL writes against $132
  of output and $1.12 of input. A cost reading that ignored cache would not be slightly low, it
  would be out by a factor of nine. `tools/probe-usage.ts` prints that split, and it is the
  thing to re-run if the number ever looks wrong.
- **Cost is the default measure, and not for tidiness.** It is the only reading that weights
  those five against each other. The same seven days are 1.7B cache-read tokens against 5.3M of
  output, so a raw token total is 99.7% cache reads and says almost nothing about how hard the
  wall has been worked — which is why `tokens` is still offered but labelled `tokens processed`
  rather than anything about a limit.
- **The two windows are not the same kind of thing.** The five-hour one is a *block*: it opens
  on the hour the first turn after a lull landed in and closes five hours later, which is why
  it has a reset worth printing. The weekly one is *rolling* — seven days back from now —
  because the real weekly window resets on a schedule tied to the account and nothing on this
  machine knows it. Inventing one would put a countdown on the wall wrong by up to a week. So
  the week says `past 7 days` and offers no reset, and `blocks()` needs no gap rule: a turn
  five hours after the last one is necessarily outside whatever block that one was in.
- **No percentage of an allowance is drawn anywhere.** No limit is knowable from here —
  `rateLimits` appears in the transcripts only on error records and is `null` on every one of
  them, and `stats-cache.json` is daily, stale, and maintained by nobody. So a bar is drawn
  against the wall's own recent history instead: the block against the busiest *other* block of
  the past week, the week against the week before. Each says what it is measured against, and
  the measure reaches the reference too — otherwise a bar in tokens would be drawn against a
  peak in dollars.
- **What it cannot know is another machine.** Turns taken elsewhere count against the same
  limits and leave nothing here to read. That is the reason this reports what has been spent
  rather than what is left.
- **A subagent's turns are in a different directory, and two levels is the wrong walk.** Every
  Task-tool agent gets its own transcript at `<slug>/<session>/subagents/agent-*.jsonl`, one
  level below the session that spawned it — 194 files out of 507 on this machine, 2026-08-14.
  They spend real tokens against the same limits, and the first cut of this widget missed all
  of them: the walk stopped at the session file, and the reading it produced still looked like a
  perfectly plausible number. Adding the recursion moved the eight-day cost from $1.8k to $2.0k
  and the five-minute cache writes from *zero* to 8.5M — so it was also hiding one of the two
  cache-write TTLs entirely. Recursing costs nothing where the two overlap, and they barely
  do: measured across every transcript on this machine, 24,158 unique requests appear in session
  files and 4,386 in subagent files, with **2** in both — and dedup is by request rather than by
  file, so those two are still counted once. `tools/probe-usage.ts` is what found the missing
  directory, and is the thing to re-run if these numbers ever look small.
- **Reading is incremental, and asked for.** Rust holds a byte offset per transcript, so the
  first pass reads whatever a week of work amounts to (~208 MB across 108 files here on
  2026-08-14) and every pass after it reads only what was appended. A file never opened whose
  mtime predates the window is skipped without being opened at all, which is what keeps that
  first pass to the week rather than to every session ever recorded — 476 MB across 507 files
  on this machine, 399 of them skipped. A partial last line is left unconsumed: the offset
  advances only over bytes that ended in a newline, or a write still in flight would be lost for
  good. And none of it happens until a widget attaches, the rule the process sampler already has.
- **Polling is the same deliberate exception the sampler is.** A turn taken in a terminal emits
  no event this app can hear — it appends to a file — and counting those turns is the whole
  point of reading files rather than the `turn` table. Twenty seconds, which moves a five-hour
  reading by a third of a percent.
- **The countdown runs on the wall's own one-second tick** (`clock` in
  `conversation.svelte.ts`), and `left()` changes about once a minute rather than ticking —
  the argument `Rest.svelte`'s `said` makes. A countdown you can watch is one you do watch.
- **`money` compares before it rounds.** Rounding first is what turns $999,999 into `$1000k`,
  six characters in a row of tabular numerals that must not reflow as the number grows.

The control surface has a `usage` op (`read: true` forces a reading rather than waiting out the
beat — the same `#tick` the timer drives, and it obeys the same rule of reading nothing while
nobody is watching), and `snapshot.ledger` reports both windows at *both* measures, plus
`watchers`, `ready`, `resting` and `unpriced`. Both measures because which one a widget happens
to be drawing is a property of that widget: a test that had to turn the `measure` knob to read
the other number would be testing the menu. `watchers` is apart from the widget count for the
reason `meter.sampling` is — a usage widget with a stopped reader goes on drawing whatever it
last saw and looks identical from outside.

