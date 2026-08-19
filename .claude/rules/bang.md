---
paths:
  - "src/lib/bang.ts"
  - "src/lib/bang.svelte.ts"
  - "src/lib/Dock.svelte"
  - "src/lib/field.svelte.ts"
  - "src-tauri/src/bang.rs"
  - "test/bang.test.ts"
---

# `!` — a shell line where a prompt goes

### The gesture, and the one thing it cannot copy

Type `!` in the dock and the field becomes a shell line: the command runs in the focused
card's directory and what it printed lands in that card's transcript. Lifted from the CLI's
bash mode, and the gesture is the same — a line you want *run* rather than answered, typed
where you were already typing instead of somewhere else.

**What cannot be copied is the mechanism.** Claude Code puts the output into the model's
context as `<local-command-stdout>`, so the agent has seen your `git status` by the time you
next speak. There is no route to that over `claude --print`: nothing on stdin injects context
without opening a turn. Pretending otherwise would be the worst of the options — a card that
looks as though the agent knows something it does not.

So the one gesture becomes two, and the second one is honest about costing a turn:

- **Enter runs it.** The transcript keeps the record; the agent is told nothing. Free, and
  nothing is spent.
- **Ctrl+Enter runs it and then says it**, as an ordinary prompt built by `handover` — the
  command, the directory, a fenced block of what it printed, and the exit code. That is a
  turn, and it is charged like one.

Ctrl is doing the same work it does everywhere in this dock: widening what the key reaches.
It cannot mean "more cards" here — see below — so it means the other thing a run can reach.
The expensive gesture still costs the modifier, which is the rule the broadcast established.

- **The exit code is always stated, including zero.** A command that printed nothing at all
  is exactly the case where the code is the whole of the news, and "it worked" is not
  something to make the agent infer from an empty block.
- **Truncation is said in words.** `capOutput` keeps the last 400 lines and reports how many
  it dropped; `handover` writes that count into the prompt. Silent truncation is the failure
  mode — an agent reasoning confidently about output it was never shown.
- **The CLI's own wrapper is not borrowed.** `<local-command-stdout>` is the binary's marker
  for output *it* injected, and putting it in a prompt would be this window claiming to be
  the thing that wrote it. What actually happened is that you ran a command and are now
  telling the agent about it, so it says so.

### One card, and why the gathering is not consulted

A `!` line runs in one directory. Broadcasting one across a gathering would run it once per
card in what is very often the same tree — the exact hazard the broadcast warning exists for,
except that here there is no version of it anybody would want.

So `bangCard` is the focused card, falling back to the first of a marquee selection, and
**the bar names the directory** rather than the dock's usual claim about reach. That is not
decoration: with five cards gathered the target line says "5 cards", and for a run that would
be a lie. The bar replacing it is what keeps the dock from disagreeing with itself — the same
failure `/rename` had to avoid from the other direction.

### pwsh, not bash

The name is the CLI's and the shell is this machine's: `bang.rs` uses `shell.rs`'s own ladder,
so a `!` line runs in `pwsh`, then `powershell`, exactly as the Alt+I console does. `!ls -la`
is `Get-ChildItem`, and `!` is not bash mode however much the character says so.

That was a decision rather than an oversight — Git Bash is installed here and was the other
candidate. One shell dialect in the app is worth more than the familiarity of the character:
a second one would be a second marker protocol, a second quoting rule for the completer, and
two ways for a `cd` to behave. The console panel and the dock answer the same way, which is
the property worth having.

### A run is a process per command — the opposite call from the console

`shell.rs` keeps one long-lived shell you go on talking to, and needs a marker because a shell
that outlives its commands cannot otherwise say when one finished. This needs none: a run is
spawned, told one thing, and has its **stdin closed**, which is what `-Command -` reads as
"that is everything". The process ending *is* the end of the command and its exit status *is*
the status.

That also settles what `cd` means. Each `!` is its own process starting at the card's
directory, so `!cd ..` changes nothing that outlives the line — which is the honest reading of
a gesture whose whole shape is one command at a time. Anything you want to persist belongs in
the console, which is what it is for.

- **The run is registered before its pipes are pumped**, and getting that backwards was a
  real bug for about a minute: `!true` prints nothing and exits at once, so both streams can
  close — and `finish_if_last` run — before the insert had happened. It found no entry,
  concluded by elimination that the run had been stopped, and reported a clean command as
  stopped. The general shape is the one `set_mid_turn` learned: **bookkeeping that something
  is in flight must be written before the flight can end.**
- **The exit is claimed by whichever stream closes last**, counted down through an
  `AtomicUsize` rather than joined — a detached thread parked on a `join` is one the shutdown
  path would have to know about.
- **The child is reaped outside the map's lock.** The entry is removed first and waited on
  afterwards, so a run that is slow to die does not hold the mutex `bang_stop` needs to kill
  it.
- **A stop is not a failure, and the code says so by being absent.** Killing a process on
  Windows gives it an exit code like any other, so a stopped run arrives wearing every mark
  of a failed one. `code: None` is the distinction, and it is the same trap `wasStopped`
  disarms for a turn: a card must not read rust for something you did on purpose. The stop
  leaves the entry in the map on purpose, so the pipes closing remain the one path that
  reports an ending — a stop that emitted its own `bang:done` would race the one already
  coming and draw the run twice.
- **The tree goes down through the job object**, dropped by `bang_stop`. `child.kill()` alone
  reaches only the `pwsh` at the top; a `!bun run test` is a shell holding a bun holding a
  compiler, exactly as the console's children are.
- **Escape stops it**, and it is the first thing Escape reaches — before a turn, because a
  card can be doing both at once and the run is the one you started most recently.

### Completion is the shell's own, which is the whole point

`TabExpansion2` is the function PSReadLine calls, and asking it means the dock offers exactly
what your terminal would. Probed 2026-08-18 against PowerShell 7 over pipes:

```text
'Get-Chi'            n=1  1919ms   ← the command cache, built once
'Get-Chi' (again)    n=1     3ms
'ls src/l'           n=1     7ms   ReplacementIndex=3 Length=5   .\src\lib
'Get-ChildItem -Pa'  n=1     1ms   ReplacementIndex=14 Length=3  -Path
'cat src/lib/sh'     n=2     -     ReplacementIndex=4 Length=10  two files
'git sta'            n=0    98ms   ← nothing
```

- **The spans are the payload.** PowerShell says *what it would replace* as well as what
  with, so nothing on this side has to work out how much of `src/li` a path completion eats
  or that `-Pa` is three characters of a parameter name. `applyCompletion` takes the span and
  splices; it clamps rather than trusting, because a keystroke can land while a request is in
  flight and a stale span would otherwise slice at an index the line has not got.
- **`git sta` completes to nothing, and that is not a bug to fix here.** Native executables
  complete their own subcommands through `Register-ArgumentCompleter`, which lives in a
  profile. There is no profile on this machine (`Test-Path $PROFILE` is false — it points into
  OneDrive), so there are none. The completer loads the profile anyway, for exactly this
  reason: a machine whose profile registers them gets them free, and one whose does not pays
  0.6s of startup once.
- **The completer is a second long-lived shell, and never runs your code.** The obvious
  economy — reuse the console's session — is wrong: that shell is busy running your build,
  and completion queued behind a ten-minute `cargo build` is completion that does not exist.
  A process per keystroke is wrong the other way, at 1.9s for the first command-name request.
  So: one shell, started lazily, warmed with a throwaway request (number 0, which nobody is
  waiting for) so the cache is built before your first Tab.
- **Replies are correlated by request number**, `\u{1}skcomp\u{1}<n>\u{1}<json>`. A different
  word from the console's marker on purpose: the two protocols must not be able to answer
  each other, and `read_reply` is tested against the console's own marker to prove it.
- **The completer's mutex is released before the wait.** Holding it across the reply would
  make completion serial with itself — the next request could not be written until this one
  had been answered.
- **A quote cannot end the string it is inside.** The request is built out of PowerShell
  single-quoted literals, which interpret nothing but a doubled quote, so `ps_quote` doubles
  it and strips newlines. One request is one line, and a pasted two-line command would
  otherwise be read as two statements with the second one unquoted.
- **Nothing to complete is an empty offering, not an error.** The request carries its own
  `catch` writing `null`, which arrives for ordinary reasons — a half-typed string the parser
  will not take, a directory that has gone. None of those is worth raising into the UI.
- **Off Windows there is no `TabExpansion2` and nothing is faked.** A home-grown path
  completer would answer differently from the shell about to run the line, which is worse than
  answering nothing.

### The keys, and where they part company with the palette

Tab asks, and only Tab — never as you type. That is what makes the whole path simple: no
debounce, no racing requests, no popup appearing under a caret that has moved on. It is also
what the CLI does.

- **One match is applied rather than offered.** A popup with one row in it is a keystroke
  asked for nothing.
- **With the popup up, Enter completes rather than runs.** This is the one place that
  deliberately contradicts the command palette, where Enter runs what is lit. There the
  palette is for choosing *what to do*; here it is for choosing *what to type*, and a
  half-written path is the one moment you certainly did not mean to run anything. Escape, then
  Enter, is how you run it. Tab agrees at that row, as it does everywhere.
- **Typing closes the offering**, because the span the shell answered with no longer
  describes the line. `applyCompletion`'s clamp is the backstop; this is the fix.
- **Up and Down walk this card's own history**, which they can take here in a way they cannot
  in an ordinary draft: a shell line is one line, so there is no caret to move vertically.
  The ring is `shell.ts`'s `remember`/`recall` rather than a second copy — the immediate-repeat
  guard and the clamping are exactly what this wants, and the histories differ only in what
  they are keyed by. Per card, the same call `shell.md` makes about the console's.
- **Escape leaves the shell line and keeps the text.** A prompt beginning with `!` is a
  perfectly ordinary thing to say to an agent, and that is the way to say it — the palette's
  dismissal exactly, including that it does not outlive the draft. It has to stop propagating,
  or the window's handler blurs the field on the same press and takes two steps at once.

### The highlight, and the colour rule it bends

The field holds two things in one box: a textarea whose text is transparent, and the coloured
copy of it underneath. So **`tokens` must concatenate back to exactly what went in** —
whitespace and all — because one dropped space puts every colour on the line over the wrong
character. `test/bang.test.ts` asserts that round trip on every case it has, and it is the
reason whitespace comes back as `plain` tokens rather than being skipped.

- **A rough PowerShell, on purpose.** It is a reading aid: the cost of getting a token wrong
  is a word the wrong colour, and the cost of a parser faithful enough never to is a parser.
  Words are classified once they are whole rather than character by character, which is what
  keeps `src-tauri/src/bang.rs` one token — `\`, `/`, `.`, `:` and `-` all live inside paths.
- **`#` is a comment only at the front of a word**, which is PowerShell's own rule and is why
  `cat a#b.txt` is a file rather than a command and a remark.
- **Colour here is not status, which is the standing rule bent once.** The exemption is
  `ansi.ts`'s, already taken and for the same reason: a terminal register reads by hue, and
  these are the same warm-neutral takes on the standard 16 that the console panel renders
  output with. Amber is deliberately absent — it means "wants you" on this wall, and nothing
  in a line you are typing does.

### In the transcript

One `shell` line per run, written into as the output arrives, folded on its own like a
compaction's summary and for the same reason: what a `cargo build` prints is not a line.

- **It is the only fold on this wall that starts open.** Every other one hides machinery you
  did not ask for; a run is the thing you asked for, and a `git status` you have to click to
  read is one you would rather have typed somewhere else. Hence `shut` beside `open` in
  `Transcript.svelte` — "have you touched this one" is a different question for runs than for
  calls, so it gets its own answer.
- **The failure mark goes on the command, not in its output**, the same call
  `Console.svelte` makes: which line failed is a question you ask having scrolled past a
  screenful of what it printed, so the answer wants to be at the top of that screen.
- **The cap is written whole by `runCap`** when the run is drawn, so the component draws a
  string without knowing what a command, a line count or an exit code is.
- **stdout and stderr go into one column in the order they arrived.** The console colours the
  two apart; here the whole run is one transcript line, and what the shell wrote in order is
  what you would have seen in a terminal.
- **Not persisted, and it is a real limit rather than an oversight.** `history` is read back
  out of the session file `claude` itself writes, and a command Skein ran is in nobody's
  session file. So a run is on the wall for as long as the card is, and a restored card comes
  back without it. Persisting it would want a table and a migration rung; the record that
  survives today is the one you handed over, which is in the conversation proper.

### Where things live

The usual three-way split, and the same one `shell.md` describes. `bang.rs` is the processes
and the one piece of shell dialect; `bang.ts` is pure and tested (`test/bang.test.ts`) — what
a draft means, the tokenizer, the span arithmetic, the cap and the handover; `bang.svelte.ts`
owns the runs and the completion state; `field.svelte.ts` has which mode the field is in, and
`Dock.svelte` the two rows above it.

The keys are the one part still in `App.svelte`, in `onDraftKey`, and that is deliberate: a
`!` line borrows Escape and Tab from the same ladder the palette and the wall borrow them
from, and the order between them is the whole point. Split across two files, neither half
could be read against the other.

`Bang` holds subscriptions and a batch timer, so `App.svelte`'s `onDestroy` releases it with
the rest — output is batched to a frame rather than drawn line by line, because a build emits
thousands a second and a `$state` write per line puts Svelte's scheduler in front of the
reader thread. The same call `Shell` makes, and the same number.

It is given a way to find a card and a way to say something to one rather than the whole of
`Skein`, the same injection `devops.roots` and `widgets.others` use — so nothing in
`bang.svelte.ts` can reach the wall.
