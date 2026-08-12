/* What a project can be *asked to do*, decided away from the app.
 *
 * A territory on the wall is a project, and a project has a small vocabulary of
 * things you want from it all day: build it, test it, open its editor, ship it,
 * push it. Those verbs are the same words in every project; what they *mean* is
 * not, and working that out is the whole of this file.
 *
 * Pure, and out here rather than inside Canvas.svelte, for the reason
 * `classify.ts` is: this is where the toolchain knowledge lives — package
 * managers, UnrealBuildTool's argv, what a Live Coding compile prints when it
 * succeeds — and it should be testable without a window. The runtime half is
 * `actions.svelte.ts`; the facts come from `project.rs`.
 *
 * Steps carry **argv, never a shell string**. Every command ends up going
 * through `cmd /C call …` (see actions.rs), and cmd does not understand the
 * `\"` escaping that a Windows argv is quoted with — so a path with a space in
 * it, which is where every engine install lives, would arrive in pieces. An
 * argv array is quoted once, correctly, at the point of spawn.
 */

export type Manager = "pnpm" | "npm" | "yarn" | "bun";

/** Everything Unreal-shaped that `project.rs` could find on disk. */
export type UnrealFacts = {
  /** Full path to the `.uproject`. */
  uproject: string;
  /** `Caravan` — the project name UBT targets are built from. */
  name: string;
  /** Engine root, resolved from `EngineAssociation`. Null when the lookup
   *  failed, which is worth saying out loud rather than hiding the chips. */
  engine: string | null;
  /** The port this repo's committed `.mcp.json` declares, if any. */
  mcpPort: number | null;
  /** `Saved/Logs/<Name>.log` — where a running editor answers from. */
  log: string;
};

/** What a project *is*, read once when it appears on the wall. */
export type ProjectFacts = {
  root: string;
  /** Which of the four to type. Lockfile first, `packageManager` field before
   *  that, and pnpm when a package.json exists with nothing to say either way. */
  manager: Manager;
  /** package.json's script names, empty when there is no package.json. */
  scripts: string[];
  node: boolean;
  /** A Tauri app: `src-tauri/tauri.conf.json`, or a `tauri` script. */
  tauri: boolean;
  /** A `Cargo.toml` at the root — not the one inside `src-tauri`, which is
   *  part of a Tauri project rather than a project of its own. */
  cargo: boolean;
  git: boolean;
  unreal: UnrealFacts | null;
};

/** What a project is *doing*, re-read on a slow poll. */
export type ProjectStatus = {
  /** This project's editor, if one is up. Its own, not any UnrealEditor.exe —
   *  another project's must never receive our compile and test triggers. */
  editorPid: number | null;
  branch: string | null;
  /** Whether the branch is tracking anything, which decides what push means. */
  upstream: boolean;
  ahead: number;
  dirty: boolean;
};

export const NO_STATUS: ProjectStatus = {
  editorPid: null,
  branch: null,
  upstream: false,
  ahead: 0,
  dirty: false,
};

/** One thing an action does. Most are a command; the Unreal ones that talk to a
 *  *running* editor are not commands at all, which is why this is a union. */
export type Step =
  /** Spawn argv under a PTY and read its output. */
  | { kind: "run"; argv: string[] }
  /** Ask the open editor to Live-Coding-compile itself, and read the answer out
   *  of its log. */
  | { kind: "live-coding" }
  /** Run automation tests inside the open editor, same way. */
  | { kind: "automation"; filter: string }
  | { kind: "launch-editor" }
  | { kind: "focus-editor" }
  /** WM_CLOSE to the editor's own window, then wait for it to go. Graceful on
   *  purpose: the editor must get to ask about unsaved work. */
  | { kind: "close-editor" };

export type Action = {
  id: string;
  /** What the chip says. Lowercase, like the rest of the wall's prose. */
  label: string;
  title: string;
  steps: Step[];
  /** Drawn, but with nothing to do — a push with nothing ahead of it. */
  quiet?: boolean;
};

/* ── package managers ──────────────────────────────────────────────────────
 *
 * pnpm is the default when a package.json says nothing, rather than npm. Only
 * npm needs `--` to forward arguments through a script, which is the whole of
 * the difference that matters here. */

const MANAGERS: Manager[] = ["pnpm", "npm", "yarn", "bun"];

/** `pnpm@9.1.0` in package.json's `packageManager` field → `pnpm`. */
export function managerFromField(field: string | null | undefined): Manager | null {
  if (!field) return null;
  const name = field.split("@")[0].trim().toLowerCase();
  return (MANAGERS as string[]).includes(name) ? (name as Manager) : null;
}

/** `pnpm run build`, and the one dialect difference that bites. */
export function scriptArgv(m: Manager, script: string, args: string[] = []): string[] {
  /* npm treats everything after the script name as its own; a `--` is how you
     hand arguments to the script. pnpm, yarn and bun forward them as typed, and
     pnpm in particular treats a stray `--` as an argument in its own right. */
  if (m === "npm" && args.length) return ["npm", "run", script, "--", ...args];
  return [m, "run", script, ...args];
}

/* ── Unreal ────────────────────────────────────────────────────────────────
 *
 * The shape of all of this is lifted from a working nvim setup (`unreal.lua`),
 * which had already paid for the two facts that make it non-obvious:
 *
 * - While the editor is up with Live Coding, UBT *refuses* an external build of
 *   the editor target — it probes the Live Coding mutex and throws. So `build`
 *   means two different things depending on whether the editor is open, and the
 *   open case is a console command sent to the editor rather than a process.
 * - A headless test run boots a second editor, ~30s before the first
 *   assertion. With one already open, the tests run inside it instantly. */

/** Where a running editor listens. Loopback, fixed, and shared by every editor
 *  on the machine — which is exactly why a compile is only ever sent after the
 *  poll has confirmed the open editor is *this* project's. */
export const REMOTE_CONTROL_PORT = 30010;

function ueBuildArgv(u: UnrealFacts, engine: string): string[] {
  return [
    `${engine}\\Engine\\Build\\BatchFiles\\Build.bat`,
    `${u.name}Editor`,
    "Win64",
    "Development",
    `-Project=${u.uproject}`,
    /* Wait rather than fail if another UBT holds the mutex, and emit the
       `@progress` markers `progressFrom` reads. */
    "-WaitMutex",
    "-Progress",
  ];
}

function ueTestArgv(u: UnrealFacts, engine: string, filter: string): string[] {
  return [
    `${engine}\\Engine\\Binaries\\Win64\\UnrealEditor-Cmd.exe`,
    u.uproject,
    `-ExecCmds=Automation RunTests ${filter}; Quit`,
    "-unattended",
    "-nopause",
    "-nosplash",
    "-nullrhi",
    /* An engine formatting test breaks under fr-FR, and a headless run has no
       reason to inherit the machine's culture. */
    "-culture=en",
    "-LogCmds=LogAutomationTest Log",
    "-stdout",
    "-FullStdOutLogOutput",
    "-NoLogTimes",
  ];
}

function ueShipArgv(u: UnrealFacts, engine: string, root: string): string[] {
  return [
    `${engine}\\Engine\\Build\\BatchFiles\\RunUAT.bat`,
    "BuildCookRun",
    `-project=${u.uproject}`,
    "-noP4",
    "-platform=Win64",
    "-clientconfig=Shipping",
    "-cook",
    "-build",
    "-stage",
    "-pak",
    "-archive",
    `-archivedirectory=${root}\\Build`,
    "-utf8output",
    "-unattended",
  ];
}

/* ── the vocabulary ────────────────────────────────────────────────────── */

/** Everything this project offers right now, in the order the chips read.
 *
 *  Order is deliberate and stable: the editor first because it is the thing you
 *  are looking at, then the loop you run all day (build, cycle, test), then the
 *  two that leave the machine (ship, push). A chip that appears and disappears
 *  as state changes — `cycle` — sits in the middle rather than at the end, so
 *  nothing you aim at moves under the cursor. */
export function actionsFor(f: ProjectFacts, s: ProjectStatus = NO_STATUS): Action[] {
  const out: Action[] = [];
  const u = f.unreal;

  if (u) {
    if (!u.engine) {
      /* Saying so beats silently offering a project with no verbs. Every Unreal
         command is `<engine>\Engine\...`, so without the engine root there is
         nothing honest to draw. */
      out.push({
        id: "engine",
        label: "no engine",
        title: `could not resolve the engine for ${u.name} — check the .uproject's EngineAssociation`,
        steps: [],
        quiet: true,
      });
    } else {
      const engine = u.engine;
      const open = s.editorPid !== null;

      out.push({
        id: "editor",
        label: open ? "focus" : "editor",
        title: open
          ? `bring ${u.name}'s editor to the front`
          : `open ${u.name} in the Unreal editor${u.mcpPort ? ` (MCP on :${u.mcpPort})` : ""}`,
        steps: [open ? { kind: "focus-editor" } : { kind: "launch-editor" }],
      });

      out.push({
        id: "build",
        label: "build",
        title: open
          ? "live coding — patch the running editor in place"
          : `build ${u.name}Editor Win64 Development`,
        steps: [
          open ? { kind: "live-coding" } : { kind: "run", argv: ueBuildArgv(u, engine) },
        ],
      });

      /* Only while the editor is up: with it closed, `build` already is the
         whole of what cycle would do. */
      if (open) {
        out.push({
          id: "cycle",
          label: "cycle",
          title:
            "close the editor, build, reopen — the loop for changes Live Coding cannot patch",
          steps: [
            { kind: "close-editor" },
            { kind: "run", argv: ueBuildArgv(u, engine) },
            { kind: "launch-editor" },
          ],
        });
      }

      out.push({
        id: "test",
        label: "test",
        title: open
          ? `run ${u.name}'s automation tests in the open editor`
          : `run ${u.name}'s automation tests headless (~30s of editor boot first)`,
        steps: [
          open
            ? { kind: "automation", filter: u.name }
            : { kind: "run", argv: ueTestArgv(u, engine, u.name) },
        ],
      });

      out.push({
        id: "ship",
        label: "ship",
        title: `cook and package Win64 Shipping into ${f.root}\\Build`,
        steps: [{ kind: "run", argv: ueShipArgv(u, engine, f.root) }],
      });
    }
  } else if (f.node) {
    const m = f.manager;
    const has = (s: string) => f.scripts.includes(s);

    if (has("build")) {
      out.push({
        id: "build",
        label: "build",
        title: `${m} run build`,
        steps: [{ kind: "run", argv: scriptArgv(m, "build") }],
      });
    }
    if (has("test")) {
      out.push({
        id: "test",
        label: "test",
        title: `${m} run test`,
        steps: [{ kind: "run", argv: scriptArgv(m, "test") }],
      });
    }
    /* A Tauri app's "ship" is the bundle, which is a different and much longer
       thing than `build` — the same distinction Unreal draws between compiling
       and packaging, so it gets the same word. */
    if (f.tauri && has("tauri")) {
      out.push({
        id: "ship",
        label: "ship",
        title: `${m} run tauri build — the installer, not the front end`,
        steps: [{ kind: "run", argv: scriptArgv(m, "tauri", ["build"]) }],
      });
    }
  } else if (f.cargo) {
    out.push({
      id: "build",
      label: "build",
      title: "cargo build",
      steps: [{ kind: "run", argv: ["cargo", "build"] }],
    });
    out.push({
      id: "test",
      label: "test",
      title: "cargo test",
      steps: [{ kind: "run", argv: ["cargo", "test"] }],
    });
    out.push({
      id: "ship",
      label: "ship",
      title: "cargo build --release",
      steps: [{ kind: "run", argv: ["cargo", "build", "--release"] }],
    });
  }

  if (f.git) {
    /* Nothing tracking this branch yet is the one case where push has to say
       *where*, and getting it wrong is a push to the wrong place — so it is
       decided here from what the poll saw, not left to git's own guess. */
    const argv = s.upstream ? ["git", "push"] : ["git", "push", "-u", "origin", "HEAD"];
    out.push({
      id: "push",
      label: s.ahead > 0 ? `push ↑${s.ahead}` : "push",
      title: s.upstream
        ? s.ahead > 0
          ? `${s.ahead} commit${s.ahead === 1 ? "" : "s"} ahead${s.branch ? ` on ${s.branch}` : ""}`
          : `nothing to push${s.branch ? ` on ${s.branch}` : ""}`
        : `publish ${s.branch ?? "this branch"} to origin`,
      steps: [{ kind: "run", argv }],
      quiet: s.upstream && s.ahead === 0,
    });
  }

  return out;
}

/* ── reading progress out of build output ──────────────────────────────────
 *
 * A build with no sign of life is indistinguishable from a hung one, and the
 * three toolchains here all say where they are — in three different dialects,
 * none of them a percentage on its own line. So a line is folded into either a
 * fraction, a short note, or nothing at all.
 *
 * `pct` is only ever set from something that genuinely counts to a known total.
 * A note with no number is not a failure of this function: for cargo and vite
 * there is no total, and "compiling serde" is still the difference between a
 * build working and a build stuck. */

export type Progress = { pct: number | null; note: string | null };

/** `[12/345] Compile Foo.cpp` — UBT, and ninja, and a few others. */
const COUNTED = /^\s*\[(\d+)\/(\d+)\]\s*(.*)$/;
/** UBT's machine-readable markers, emitted because of `-Progress`. */
const UBT_PROGRESS = /^@progress\s+(.*)$/;
const QUOTED = /'([^']*)'/;
const TRAILING_PCT = /(\d{1,3})%\s*$/;
/** The cook's own counter, which is the long half of a package. */
const COOK = /Cooked packages\s+(\d+)\s+Packages Remain\s+(\d+)\s+Total\s+(\d+)/;
/** vite, tsc, rollup and friends: no total, but plenty of life. */
const NOTES = [
  /^\s*(?:✓|√)?\s*(\d+ modules transformed.*)$/,
  /^\s*(transforming\b.*)$/,
  /^\s*(rendering chunks.*)$/,
  /^\s*(computing gzip size.*)$/,
  /^\s*(built in .*)$/,
  /^\s*(Compiling \S+.*)$/,
  /^\s*(Finished\b.*)$/,
  /^\s*(Building \d+ actions?.*)$/,
  /LogLiveCoding:\s+\w+:\s+(.*)$/,
  /LogCook:\s+\w+:\s+(.*)$/,
];

/** What this line says about how far along a run is, or null if nothing. */
export function progressFrom(line: string): Progress | null {
  const ubt = line.match(UBT_PROGRESS);
  if (ubt) {
    const rest = ubt[1].trim();
    /* `push`/`pop`/`increment` scope a *sub*-range — the number on them is a
       share of the whole, not a position in it, and reading it as absolute made
       a bar that jumped to 5% and stayed there. Only the plain form counts. */
    if (/^(push|pop|increment)\b/.test(rest)) {
      const msg = rest.match(QUOTED);
      return msg ? { pct: null, note: msg[1] } : null;
    }
    const msg = rest.match(QUOTED);
    const pct = rest.match(TRAILING_PCT);
    if (!msg && !pct) return null;
    return {
      pct: pct ? clampPct(Number(pct[1])) : null,
      note: msg ? msg[1] : null,
    };
  }

  const counted = line.match(COUNTED);
  if (counted) {
    const done = Number(counted[1]);
    const total = Number(counted[2]);
    return {
      pct: total > 0 ? clampPct((done / total) * 100) : null,
      note: counted[3].trim() || null,
    };
  }

  const cook = line.match(COOK);
  if (cook) {
    const done = Number(cook[1]);
    const total = Number(cook[3]);
    return {
      pct: total > 0 ? clampPct((done / total) * 100) : null,
      note: `cooked ${done}/${total}`,
    };
  }

  for (const re of NOTES) {
    const m = line.match(re);
    if (m) return { pct: null, note: m[1].trim() };
  }

  return null;
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/* ── the two things a running editor answers with ──────────────────────────
 *
 * Neither Live Coding nor an in-editor test run has an exit code to read: the
 * trigger is an HTTP call that returns the moment the editor accepts it, and
 * the result appears some seconds later in the editor's log. So both are folds
 * over log lines, and both are here rather than in the runtime so that the
 * marker vocabulary can be tested against real captured output. */

export type LiveCoding = {
  started: boolean;
  done: boolean;
  ok: boolean;
  note: string | null;
  /** Set when the compile succeeded but changed data types — the patch is in,
   *  and it is not to be trusted until the editor has been cycled. */
  stale: boolean;
};

export const LIVE_CODING: LiveCoding = {
  started: false,
  done: false,
  ok: false,
  note: null,
  stale: false,
};

/** Fold one line of the editor's log into a Live Coding verdict. */
export function liveCodingStep(prev: LiveCoding, line: string): LiveCoding {
  if (prev.done) return prev;
  const m = line.match(/LogLiveCoding:\s+\w+:\s+(.*?)\s*$/);
  if (!m) return prev;
  const say = m[1];

  if (say.includes("Starting Live Coding compile")) {
    return { ...prev, started: true, note: "compiling…" };
  }
  if (say.includes("Live coding succeeded")) {
    const stale = say.includes("data type changes");
    return {
      ...prev,
      done: true,
      ok: true,
      stale,
      note: say.includes("no code changes detected")
        ? "no code changes"
        : stale
          ? "patched, but data types changed — cycle before trusting it"
          : "patched the running editor",
    };
  }
  if (
    say.includes("Live coding failed") ||
    say.includes("Live coding canceled") ||
    say.includes("Unable to start live coding")
  ) {
    return { ...prev, done: true, ok: false, note: say };
  }
  return prev;
}

export type Tally = {
  total: number;
  passed: number;
  failed: string[];
  /** `file(line): message`, ready to read. */
  errors: string[];
  done: boolean;
};

export const NO_TALLY: Tally = {
  total: 0,
  passed: 0,
  failed: [],
  errors: [],
  done: false,
};

/** Fold one line of automation output into a tally. Works on both paths: the
 *  editor's log and a headless run's stdout carry the same sentences. */
export function automationStep(prev: Tally, line: string): Tally {
  if (prev.done) return prev;
  let next = prev;

  const found = line.match(/Found (\d+) automation tests/);
  if (found) next = { ...next, total: Number(found[1]) };

  if (line.includes("Test Completed. Result={Success}")) {
    next = { ...next, passed: next.passed + 1 };
  }

  const failed = line.match(/Test Completed\. Result=\{Fail\}.*?Path=\{(.*?)\}/);
  if (failed) next = { ...next, failed: [...next.failed, failed[1]] };

  const err = line.match(/LogAutomationController:\s+Error:\s+(.*?)\s+\[(.*?)\((\d+)\)\]\s*$/);
  if (err) {
    next = { ...next, errors: [...next.errors, `${err[2]}(${err[3]}): ${err[1]}`] };
  }

  if (line.includes("Automation Test Queue Empty")) next = { ...next, done: true };

  return next;
}

/** How a finished tally reads on a chip. */
export function tallyNote(t: Tally): string {
  if (t.total === 0) return "no tests matched";
  const failed = t.failed.length || Math.max(0, t.total - t.passed);
  return failed === 0
    ? `${t.passed}/${t.total} passed`
    : `${failed}/${t.total} failed`;
}
