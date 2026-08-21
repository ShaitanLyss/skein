---
paths:
  - "src-tauri/src/hooks.rs"
  - "src-tauri/src/main.rs"
---

# The hooks Skein hands its cards

One hook, and it exists to undo a bug in the tool it is handed to. This file is the
measurements behind it and the conditions under which it should be deleted — the *how* is in
`hooks.rs`, which is short.

### The failure this exists for

The Bash tool halves runs of backslashes in `command` before the shell ever sees them.
Measured 2026-08-21 against claude 2.1.233 on Windows, by comparing three points for one tool
call — what the API emitted (the transcript record), what a `PreToolUse` hook was handed, and
what arrived on disk:

```text
emitted  1  2  3  4  5  6
arrived  1  1  2  2  3  3        ceil(n/2)
```

**It is not the shell**, and that is the whole reason this went four months unfixed. Every
session that hit it wrote a correctly *quoted* heredoc — `<<'EOF'`, which does no backslash
processing whatsoever — and concluded the heredoc had eaten its escapes. The collapse also
hits single-quoted arguments and one-line commands, so bash never had the chance. Nor is it a
JSON or C unescape: `\n`, `\"`, `\$`, `` \` `` and a lone backslash all arrive intact, and a
JSON unescape would have turned the first into a newline.

There is one exception, and it is the whole reason `compensate` scans runs instead of calling
`.replace("\\\\", "\\")`: **a run immediately followed by `"` passes through whole.** That is
what made

```
awk '{ n=gsub(/\\/,"\\"); print n }' f
```

arrive as `gsub(/\/,"\\")` — the first pair halved, the second, sitting against a quote, not.
Runs of 1, 2, 3 and 4 before a `"` were each measured surviving intact; before `'`, before a
letter, and at end of line they halve. A single quote does not protect. So `"` is the whole of
the rule, and the transform is per-run rather than global.

### Why it was worth code rather than a habit

Because it is silent. The command succeeds, the file is written, and the damage surfaces
somewhere else entirely as a path with one backslash where two were meant.

The case that found it, from `C--atelier/15a03ed2` on 2026-08-11: an agent wrote
`new Database(process.env.APPDATA + "\\dev.skein.studio\\skein.db")` into a `<<'EOF'` heredoc,
which reached disk as `"\dev…"` and announced itself as `SQLITE_CANTOPEN`. It concluded
*"Heredoc ate the backslash escapes"* and used the Write tool instead. Three more did the same
between then and 2026-08-21 — `C--Users-flori-codes-nova/b9aeac10` ("avoiding the heredoc that
broke earlier"), `C--atelier-caravan/ba9d465d` twice, `C--atelier-caravan/0aa4f322` — and none
of them left a note, because from inside one session it reads as one flaky tool call rather
than as a rule.

Telling agents to avoid it was considered and rejected. The habit would have to be held by
every card, in every repository, forever, against a model's natural tendency to under-escape;
and it would cost context on every spawn to say so. A compensator is checkable and costs
nothing anybody has to remember.

### Where the compensator lives, and why there

**In this binary**, served by `skein.exe --bash-hook` as a stdin→stdout filter, and reached
through the `--settings` layer `supervisor` already passes each card.

- **In the binary rather than a script**, because a `PreToolUse` hook fires on *every* Bash
  call of every card, so its startup cost is a tax on the whole wall — this is ~5ms against
  ~50ms for a Python script and upwards of 200ms for PowerShell 5.1. And because a machine
  that has just downloaded Skein need not also have an interpreter, which is the entire point
  of the fix travelling with the app rather than living in one `~/.claude`.
- **Exec form** (`command` plus `args`), which spawns the executable with no shell in between.
  Not tidiness: the shell form would put an installation path through a shell parser, and a
  path holding a space, a `$` or a quote is precisely the class of bug this module exists to
  compensate for. `args` was verified present in 2.1.233 before being relied on — a build that
  ignored it would run this binary with no arguments, which is to say it would open a second
  Skein for every shell command a card ran.
- **Intercepted at the top of `main`**, before Tauri starts, so a hook invocation never opens
  the store, never creates a window and never joins the wall. Anything added to `main` above
  that check inherits it, once per Bash call, on a hot path.
- **`windows_subsystem = "windows"` does not get in the way.** With no console attached the
  standard handles are whatever the parent redirected, and for a hook that is always a pipe.
  Verified against a release build, not assumed — a GUI-subsystem binary whose `print!` went
  nowhere would fail open and leave the bug in place in exactly the configuration that ships,
  while every debug test passed.

### Cards only, and what that costs

The hook goes in Skein's own settings layer, so **nothing outside Skein is written**. The cost,
accepted deliberately: a `claude` run from a terminal on the same machine still eats
backslashes. Fixing that would mean Skein editing `~/.claude/settings.json`, and this is not an
app that writes to the user's global config — `accounts.rs` goes out of its way to hold none of
it, and a desktop app that quietly edits the config of the CLI it wraps is a worse precedent
than the bug.

If a global hook *is* installed by hand as well, the two do not compound. Measured: with a
compensating hook in both the user's settings and the flag layer, the result was one doubling,
not two — hooks from different sources are each handed the original input, so the last
`updatedInput` wins rather than chaining. Worth knowing because if they *had* chained, every
backslash on such a machine would have quadrupled.

### When to delete this

The day the Bash tool stops halving backslashes, this module starts *adding* them.

`cargo test` exercises `compensate` by round-tripping it through a model of the collapse, so it
proves the inverse is exact — and it cannot see an upstream fix, because the model is a copy of
the bug. Only a live probe can. It is one throwaway session:

```powershell
claude -p "Run this exact Bash command, verbatim: cat > /tmp/bs.txt <<'EOF'
x = `"\\a\\b`"
EOF" --model claude-haiku-4-5-20251001 --dangerously-skip-permissions
```

Two backslashes on each side in `/tmp/bs.txt` is correct with or without the bug, because that
run is against a `"` and protected either way — use a run that is *not* against a quote to tell
them apart. The reproduction harness, including the negative control, is `.scratch/bsprobe`:
with no hook the file came back holding one backslash where two were written, with the layer it
came back holding two.

If the probe shows the collapse is gone, delete `hooks.rs`, the `--settings` call in
`supervisor::spawn`, and the check in `main` — and put `chat`'s allow list back wherever it
then belongs, since `settings()` is now the only thing carrying it.
