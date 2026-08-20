---
paths:
  - "src-tauri/src/servers.rs"
  - "src/lib/Servers.svelte"
  - "src/lib/ansi.ts"
  - "src/lib/follow.ts"
---

# Dev servers

**A group's log follows its own tail.** Both `pre.log` boxes in `Servers.svelte` — a group's
output and an action run's — carry `{@attach stickToTail}` and nothing else: opened, they show
the newest line rather than the oldest of the last hundred, and they keep showing it unless you
scroll back to read something. That is the whole of what a consumer of `follow.ts` does; the
reasoning behind the judgement is in `panel.md`, where it was learned.

### Dev servers (`src-tauri/src/servers.rs`)

Groups of commands per project, each `cmd /C <command>` through **pipes** — one thread per
stream — with output parsed by `src/lib/ansi.ts`. `pump_lines` splits on **both** `\r` and
`\n`: a progress line redraws with a bare `\r`, and `BufReader::lines()` would hold a whole
build back and then dump it flat. Each group lives in a
Windows **job object** with `KILL_ON_JOB_CLOSE`, because `pnpm dev` spawns node spawns
esbuild and killing the parent leaves orphans holding ports.

**These used to run under a real PTY (`portable-pty`) and it was the right call that could not
be had.** A dev server's output genuinely *is* a terminal, so this was the one place in Skein
where a pseudo-terminal earned its weight, and it stayed on that route after `actions.rs` and
`shell.rs` had each abandoned theirs. It came off on 2026-08-19 because the PTY started
*nothing* on this machine — see the ConPTY section below — and because trying it got the binary
quarantined. `portable-pty` is now a **dev-dependency**, kept only for `examples/pty-probe.rs`,
so the shipped binary contains no ConPTY path at all.

What the retreat actually cost, measured rather than assumed:

- **Colour is kept**, by asking rather than by being a terminal — `force_colour`, below.
- **`\r` redraws are kept** on our side; what is lost is the *program's* willingness to emit
  them, since vite and cargo ask `isatty` before drawing a spinner. Discrete output — HMR
  updates, request logs, compiler errors — is unaffected, and that is most of what a dev
  server says. `cargo watch`'s progress bar is the real casualty.
- **Screen clears** are lost. vite clears the pane on restart; in scrollback that is a gain.
- **Typing into a server** — vite's `r`/`u`/`o` — was lost on paper and not in fact. `PtyServer`
  held no writer and did not even store the master, which was dropped when `spawn_one`
  returned. There was never an input path.

And what it won, none of which the PTY could give:

- **`ServerLog.stderr` stopped lying.** One merged reader meant the field was hardcoded
  `false` for every line ever emitted. Two pipes make it true.
- **A server that dies says so.** `exit_if_last` claims the exit when the second pipe closes.
  Before, a crashed server read `starting` until the port poll gave up and then read `starting`
  for the rest of the session. The port poll therefore emits **only `up`, never `starting`** —
  re-asserting `starting` every 500ms for twenty seconds would bury the `exited` it races.
- **`CREATE_NO_WINDOW`** is set. The ConPTY path never passed it; the pseudo-terminal was what
  hid the window, so a spawn that failed to attach to one had nothing suppressing it.
- The dependency tree loses `portable-pty`, `winapi 0.3`, `shared_library`, `lazy_static`,
  `filedescriptor` and a duplicate `bitflags 1.3.2` from the shipped binary.

**`cmd /C` is kept rather than moved to the `pwsh` the shell and `!` use.** Group commands are
authored against cmd (`&&`, `%VAR%`), `actions.rs` has been running `cmd /C call` through pipes
here all along with no trouble, and `pwsh` would cost the ~4s profile load per server that
`shell.md` measured. The store held zero `server_group` rows when this changed, so nothing
stored had to be re-authored — but that is luck, and a future change of shell is a migration.

### Colour without a terminal (`force_colour`)

**`isatty` cannot be faked, and none of this tries to.** On Windows it is `GetFileType` on the
handle — a pipe answers `FILE_TYPE_PIPE`, a console answers `FILE_TYPE_CHAR` — and node's
`process.stdout.isTTY` is libuv's `uv_guess_handle` asking the same question. It is a property
of the kernel object the child holds, not a claim the parent gets to make. The only way to make
it answer "character device" is to hand over a real one, which is a console, which is the
ConPTY that does not work here. There is no flag, no handle trick, and no environment variable
that changes the answer.

So `force_colour` uses the convention that exists *because* `isatty` is unfakeable — each of
these is a toolchain's documented way of being told "something is capturing your output and it
can render colour":

| variable | who reads it |
|---|---|
| `FORCE_COLOR=1` | `supports-color`: vite, esbuild, tsc, vitest, chalk, picocolors |
| `CLICOLOR_FORCE=1` | Rust's `anstyle`/`termcolor`; the ripgrep/bat/fd family |
| `CARGO_TERM_COLOR=always` | cargo, which reads neither of the above |
| `RUST_LOG_STYLE=always` | `env_logger` — a Rust server's own lines, not its compiler's |
| `PY_COLORS=1` | pytest, pip |
| `TERM=xterm-256color` | tools that check `TERM` first and treat unset or `dumb` as a hard no |
| `NO_COLOR` **removed** | it wins over `FORCE_COLOR` everywhere both are honoured |

`FORCE_COLOR` is deliberately `1` — the 16 basic colours — and **not** `3`. `ansi.ts` renders
exactly bold, dim, reset and those 16; it parses a truecolour `38;2;r;g;b` correctly and then
*leaves the colour alone*, so asking for 24-bit would render as no colour at all. The narrow
ask matches the narrow renderer on purpose, and growing one means growing the other.

What no variable covers is a tool gating **behaviour** rather than colour on `isatty` —
spinners, screen clears, vite's keypress shortcuts. Those are gone and no environment brings
them back.

**`SKEIN_NO_SERVERS=1` suppresses the eager start**, and only that: groups are still listed
and still start when clicked (`servers::servers_quiet` → `Skein.serversQuiet`). It is
advisory rather than enforced in `start_group`, because the flag means "don't start these for
me" and a chip that refused a click would be worse than a port conflict. Its reason for
existing is a second Skein against the same store — a build under test beside the installed
one — which otherwise races the first for every port in the workspace and leaves both walls
reading `exited`. The Servers panel says so at the top when it is set: a wall of groups that
are down for a reason must not look like a wall of groups that failed, since the chips read
`idle` either way. `snapshot.serversQuiet` reports it.

### ConPTY: the symptom is certain, the cause is not

**portable-pty's ConPTY path does not work on this machine.** Probed 2026-08-12 on Windows 11
26200 against portable-pty 0.9.0 (the newest published) with `src-tauri/examples/pty-probe.rs`:
every `openpty`-spawned child dies with `0xC0000142` (STATUS_DLL_INIT_FAILED) having emitted
only ConPTY's own `ESC[6n`, while the same command through `std::process::Command` runs fine —
including `git.exe` with no shell at all, so it is not the argv or the quoting. Project actions
took the pipe route because of this, and so did the floating shell (see `shell.md`, where a PTY
that will not start is the whole feature rather than one chip reading `exited`), and now so have
dev servers.

**This rule used to say "ConPTY is broken on this machine" and that was wider than the
evidence.** What was measured is that *portable-pty 0.9.0's* ConPTY path fails here. Two things
found on 2026-08-19 say the broader claim is probably wrong:

- **VS Code's terminal is not a counterexample, because it does not use the in-box ConPTY.** It
  ships its own, from node-pty:
  `…/Microsoft VS Code/<hash>/resources/app/node_modules.asar.unpacked/node-pty/build/Release/conpty/{conpty.dll,OpenConsole.exe}`
  — three copies, one per installed version — gated behind `terminal.integrated.windowsUseConptyDll`,
  on by default. So VS Code runs against a Microsoft-shipped `conpty.dll` with `OpenConsole.exe`
  as its console host, while portable-pty falls back to the kernel32 exports and `conhost.exe`:
  there is no `conpty.dll` in System32 and none anywhere on this machine's PATH, so
  `load_conpty`'s sideload arm finds nothing. **The two are using different ConPTY
  implementations.** VS Code working says the sideloaded one works and says nothing about the
  in-box one.
- **SentinelOne 25.1.4.434 is installed, with `InProcessClient64.dll` and
  `MinProcessClient.dll`** — injected in-process clients. `0xC0000142` means precisely one
  thing: a DLL's `DllMain` returned FALSE during process initialization. An injected security
  DLL failing to init in a child created with `STARTF_USESTDHANDLES` and all three handles set
  to `INVALID_HANDLE_VALUE` is a textbook instance of that. If this is the cause then the crash
  and the quarantine below are **one event**, not two.

One hypothesis was checked and is dead: a malformed environment block, which is a common
`0xC0000142` cause when the child ends up without `SystemRoot`. portable-pty's
`cmdbuilder.rs::get_base_env` seeds from `std::env::vars_os()`, keys are `BTreeMap`-sorted on a
normalised key, and `environment_block()` double-null terminates. `SystemRoot` is there.

**`pty-probe.rs` has a gap worth knowing before trusting it.** It says "isolate one variable per
variant" and every variant varies only the *argv* — all six call the same `openpty`, so the
ConPTY *configuration* was never a variable. portable-pty hardcodes
`PSUEDOCONSOLE_INHERIT_CURSOR | PSEUDOCONSOLE_RESIZE_QUIRK | PSEUDOCONSOLE_WIN32_INPUT_MODE`;
`INHERIT_CURSOR` is where that `ESC[6n` comes from, and it makes ConPTY consult the *parent's*
console, which a Tauri GUI app has not got. Neither that flag nor the `INVALID_HANDLE_VALUE`
stdio triple — which the probe's own comment fingers — was ever tested with it off.

**REVISIT — not now, deliberately.** Three live suspects (S1 injection, the flag combination,
the invalid-stdio triple) and the probe distinguishes none of them. The decisive experiment is
to drop VS Code's `conpty.dll` + `OpenConsole.exe` beside the probe binary — `load_conpty`
searches the application directory first — and re-run: **works** → it is the in-box ConPTY and
the fix is to ship those two files the way VS Code does; **still `0xC0000142`** → it is S1
injection and no ConPTY will ever work here. Two things make this a later job rather than a
now job:

1. Placing a DLL beside an unsigned binary that then `LoadLibrary`s it by bare relative name is
   *literally* the sideload pattern, on a binary S1 has already quarantined once.
2. `examples/` probes cannot be run on a no-MSVC machine at all — any exe built from this crate
   on the gnu target dies at `0xC0000139` before `main` (see `build.md`). So this needs MSVC, or
   a throwaway crate, or another machine.

The cheap first step costs nothing and risks nothing: get the detection name out of the S1
console. It names the rule and story ID, which says which suspect fired.

### Why trying this got the binary quarantined

SentinelOne quarantined Skein the first time dev servers were started. Nothing else in the app
has ever drawn a complaint — the floating shell, `!` lines, `claude` cards, and the Bash and dev
servers the *agents* spawn are all fine — and the difference was entirely this file. Everything
else spawns through `std::process::Command`, i.e. a plain `CreateProcessW` with three anonymous
pipes and `CREATE_NO_WINDOW`, which is the most ordinary process creation on a developer
machine. The ConPTY path left that road in six ways, roughly in order of signal strength:

1. **`STARTUPINFOEX` + a proc-thread attribute list + invalid stdio** is published offensive
   tradecraft. The "ConPTY shell" family is built on exactly
   `UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE)` plus
   `EXTENDED_STARTUPINFO_PRESENT` plus a stdio triple set to `INVALID_HANDLE_VALUE` — a child
   whose real I/O is bound to something other than its declared handles.
2. **A DLL requested by bare relative name.** `load_conpty`'s `LoadLibraryW("conpty.dll")` has
   no path and is for a DLL not in the import table, so the application directory is searched
   first. It finds nothing here, so nothing is sideloaded — but the *probe* is the signal, and
   nothing else in Skein calls `LoadLibrary` on anything.
3. **`conhost.exe` becomes a child of a GUI app.** `CreatePseudoConsole` launches the console
   host as Skein's own child, and *it* parents `cmd.exe`. An unsigned user-path non-terminal
   binary parenting a console host is a high-value parent/child anomaly.
4. **It fires as a burst at launch with no human action.** Autostart runs inside `#boot`, 250ms
   apart, before `main` is shown — `main` is created hidden. Unsigned exe starts, no window,
   fleet of console hosts. Alt+I, `!` and sending a prompt all carry a keystroke; this carried
   none.
5. **`probe_ports`** is a sequential localhost `connect()` sweep with a 180ms timeout, followed
   by a 40-iteration reconnect loop. A local port scan by shape, and servers-only.
6. **And every one of those children then crashed at DLL init.** A crash-loop of anomalous
   spawns reads as a failing dropper, not a broken dev tool.

Note what is *not* on this list: job objects (shared with `shell.rs`, `bang.rs`, `supervisor.rs`
and `actions.rs`, so they cannot be the discriminator) and `cmd.exe` itself (`actions.rs` runs
`cmd /C call` through pipes and has never been flagged). The binary is also unsigned —
`tauri.conf.json` carries no signing config — so nothing above is suppressed by reputation.

The pipe route deletes 1, 2, 3 and 6 outright. What remains is a process tree of
`Skein → cmd.exe → node`, which is the shape S1 has tolerated from `actions.rs` all along.

