---
paths:
  - "src-tauri/src/shell.rs"
  - "src/lib/shell.ts"
  - "src/lib/shell.svelte.ts"
  - "src/lib/Console.svelte"
---

# The floating shell

### The floating shell (Alt+I)

One long-lived `pwsh` in the middle of the window, over the wall rather than instead of it.
Lifted straight from nvim's floating terminal, and the two things that make that gesture worth
having are both about *not* being modal: the panel is summoned and dismissed with one key from
anywhere at all, and dismissing it does not end what is running inside it.

- **The panel and the session are two facts.** Alt+I toggles the panel; the process outlives
  it, keeps its directory, and keeps its scrollback. A build you started keeps building while
  you go back and read what an agent said about it. Only `close` — or the app exiting — ends
  it. `snapshot.shell` reports `open` and `live` separately for exactly this reason, since from
  outside a panel that is shut and a shell that is gone look identical.
- **Alt+I fires while you are typing**, which no other binding on this wall does. It can
  afford to: Alt+letter is not a text gesture Chromium binds in a field, and there is no menu
  bar to collide with (`decorations: false`). Everything else in `onGlobalKey` is skipped
  outright while the panel is up — including the two branches that deliberately reach past a
  field, ctrl+arrow's scroll and ctrl+0's reading size, which would otherwise fire from inside
  a console into a transcript nobody is looking at.

### Pipes, not a PTY — the opposite call from dev servers

`servers.rs` runs its children under a real pseudo-terminal, and the rule beside it says that
is where a PTY earns its weight. This does not, and the reason is written down in `servers.md`:
**ConPTY is broken on this machine.** Every `openpty`-spawned child dies at `0xC0000142`
(STATUS_DLL_INIT_FAILED) having emitted only ConPTY's own `ESC[6n`. A dev server that will not
start is a chip that reads `exited`; a *terminal* that will not start is the whole feature. So
this is `std::process` with three pipes, and the panel is honest about being line-oriented
rather than pretending to be a terminal emulator.

What that costs, and what it does not:

- **No TUI.** Anything that paints by moving a cursor — `vim`, `htop`, a full-screen installer
  — has nowhere to paint. Line-oriented output, which is essentially everything you actually
  type at a shell, comes through exactly as it does for dev servers, `pump_lines` and all.
- **Colour survives.** Probed 2026-08-17 against PowerShell 7 with `-Command -` over pipes:
  output streamed line by line as it happened, and SGR sequences came through intact
  (`Get-Location` emitted `ESC[32;1m`). `ansi.ts` renders them, the same parser the servers
  panel uses. `FORCE_COLOR` and `CLICOLOR_FORCE` are set for the toolchains that check.
- **There is no ctrl+C to send.** `GenerateConsoleCtrlEvent` needs a console the child shares,
  and a GUI app's children have none. So the gesture is `stop`, and it says what it does: kill
  the tree, open a fresh shell in the same directory. Naming it "interrupt" would have been a
  button that sometimes did nothing to a process that had hung. The tree goes down through a
  Windows job object with `KILL_ON_JOB_CLOSE`, the same one `servers.rs` uses and for the same
  reason — a shell spawns builds which spawn compilers.
- **`GIT_TERMINAL_PROMPT=0`**, as everywhere else that shells out. This one is foreground only
  in the sense that you typed it: there is still no terminal for Git Credential Manager to ask
  a question in, so an expired token has to fail fast rather than hang forever behind a prompt
  nobody can see.

### The marker

`-Command -` prints **no prompt and no echo** — which is what makes it usable as a stream, and
what means Skein has to draw the prompt itself and therefore has to be *told* where the shell
is. So after every command a second line goes in, whose whole job is to be recognised on the
way back out:

```
$__skein_ok = $?; Write-Output ([char]1 + 'skein' + [char]1 + …$PWD.Path)
```

`shell.rs` recognises it, turns it into a `shell:done { ok, cwd }`, and never emits it as
output. Four things about it are load-bearing:

- **The PowerShell stays in `shell.rs`, next to the argv it belongs with.** The front end never
  learns that a marker exists — it receives an event. A protocol split across the two sides
  would be one more thing to keep in step across a shell dialect.
- **`$?` is captured into a variable before anything else is evaluated**, because building the
  string would be that next thing and would clobber it. It is `$?` rather than `$LASTEXITCODE`
  because it is the one that means "the thing I just typed worked" for a cmdlet and a native
  exe alike.
- **The marker is searched for, not matched at the start.** A command that ends without a
  newline (`Write-Host -NoNewline`) leaves its last word on the front of our line, and that
  word is output. It is emitted as output and the rest read as the marker.
- **`cd` is a thing you type**, and so is a script that changes directory forty times without
  saying so. Nothing here parses what was typed; the prompt is whatever the shell last said
  `$PWD` was.

`[char]1` rather than a `` `u{1} `` escape, because Windows PowerShell 5.1 has not got the
escape and is the fallback rung of the ladder.

### Which shell, and what it costs to be yours

`pwsh`, then `powershell`, and the panel says which it got — the two differ in enough places
(encoding, `$PSStyle`, half the cmdlets) that claiming the wrong one would be lying about what
it runs. The spawn is the probe: a failed `spawn` falls through to the next rung, which is
cheaper and more honest than walking `PATH` for a name that may be a Store alias stub.

**The profile is loaded on purpose**, and it is why the panel has a `starting` state at all.
Probed 2026-08-17: this profile takes about 4s against 0.5s for `-NoProfile`, and prints a line
of its own on the way. That is a real wait, and it buys the aliases and functions that make it
*your* shell rather than a box that happens to run commands. The first marker is what says the
wait is over, so readiness needed no second mechanism.

Two things are primed before anything you type, and neither is shown: UTF-8 output, because
5.1 otherwise hands a redirected stdout the OEM code page and every box-drawing character
arrives as mojibake; and `$ProgressPreference = 'SilentlyContinue'`, because PowerShell renders
progress by steering a cursor we have not got and over a pipe that is a screenful of escapes
per web request.

### Attaching to a shell that is already running is the normal case

Not an error, and not a reason to spawn a second one. Toggling the panel shut leaves the
session live, and in dev **every front-end edit** rebuilds `App.svelte` and with it the object
that was holding it. `open_shell` answers a live id with a fresh marker instead of a spawn, and
reports `started: false` — so the reattach path and the first-open path look identical from the
front end, and the note that says `pwsh in <directory>` is only printed when there is a
directory we actually chose. An attached shell claims no `cwd` at all until its marker lands,
because it may have been `cd`'d anywhere since.

### Where things live

The usual three-way split. `shell.rs` is primitives and the one piece of shell dialect;
`shell.ts` is pure and tested (`test/shell.test.ts`) — the scrollback cap, the history ring,
and `promptPath`; `shell.svelte.ts` owns the session and its subscriptions; `Console.svelte`
draws it.

- **The component is `Console` and the class is `Shell`** because `shell.svelte.ts` and
  `Shell.svelte` are one file to a case-insensitive filesystem and TypeScript says so. The same
  split `cycle.svelte.ts` and `Pomodoro.svelte` already have.
- **`Shell` holds subscriptions and a batch timer**, so `App.svelte`'s `onDestroy` releases it
  with the rest — `snapshot.listeners.shell` is 3 and must not climb across an edit. Lines are
  batched to a frame rather than pushed one at a time: a build emits thousands per second, and
  a `$state` write per line puts Svelte's scheduler in front of the reader thread.
- **`promptPath` cuts from the front**, which is why it exists rather than a
  `text-overflow: ellipsis` — that cuts the other end, and every prompt in this repo would read
  `C:\Users\flori\Documents\…`. It keeps four segments rather than three because the drive
  spends one of them.
- **The failure mark goes on the command, not in its output.** Which line failed is a question
  you ask having scrolled past a screenful of what it printed, so the answer wants to be at the
  top of that screen. Rust for the caret, and nothing else — colour is status here as
  everywhere.
- **The panel is opaque and has no scrim.** Opaque because the backdrop draws behind everything
  and a leaf drifting through a console is the same bug a dormant card once had; no scrim
  because the reason to open a shell beside a card is usually the card, and the wall behind
  stays readable *and* clickable.

The control surface has a `shell` op (`show`, `hide`, `send`, `stop`, `close`, `clear`) driving
the panel's own functions, and `key` grew an `alt` flag so `wall.test.ts` can press the real
binding rather than call `show` and prove nothing about the key.
