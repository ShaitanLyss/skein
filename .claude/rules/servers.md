---
paths:
  - "src-tauri/src/servers.rs"
  - "src/lib/Servers.svelte"
  - "src/lib/ansi.ts"
---

# Dev servers

### Dev servers (`src-tauri/src/servers.rs`)

Groups of commands per project, run under a real PTY (`portable-pty`) so vite/cargo/tsc keep
their colour and progress rendering — parsed by `src/lib/ansi.ts`. `pump_lines` splits output
on **both** `\r` and `\n` for that reason: a progress line redraws with a bare `\r`, and
`BufReader::lines()` would hold a whole build back and then dump it flat, which is the piped
behaviour the PTY exists to avoid. Each group lives in a
Windows **job object** with `KILL_ON_JOB_CLOSE`, because `pnpm dev` spawns node spawns
esbuild and killing the parent leaves orphans holding ports.

**`SKEIN_NO_SERVERS=1` suppresses the eager start**, and only that: groups are still listed
and still start when clicked (`servers::servers_quiet` → `Skein.serversQuiet`). It is
advisory rather than enforced in `start_group`, because the flag means "don't start these for
me" and a chip that refused a click would be worse than a port conflict. Its reason for
existing is a second Skein against the same store — a build under test beside the installed
one — which otherwise races the first for every port in the workspace and leaves both walls
reading `exited`. The Servers panel says so at the top when it is set: a wall of groups that
are down for a reason must not look like a wall of groups that failed, since the chips read
`idle` either way. `snapshot.serversQuiet` reports it.

**ConPTY is broken on this machine and so, therefore, is this.** Probed 2026-08-12 on Windows
11 26200 against portable-pty 0.9.0 (the newest published) with
`src-tauri/examples/pty-probe.rs`: every `openpty`-spawned child dies with `0xC0000142`
(STATUS_DLL_INIT_FAILED) having emitted only ConPTY's own `ESC[6n`, while the same command
through `std::process::Command` runs fine — including `git.exe` with no shell at all, so it is
not the argv. Project actions took the pipe route instead (below), and so did the floating
shell — see `shell.md`, where a PTY that will not start is the whole feature rather than one
chip reading `exited`. Dev servers have not, since the PTY is the whole point of them. Re-run
the probe to find out whether that is still true.

