/* The running half of a project's verbs.
 *
 * `actions.ts` decides *what* a project offers and how to read its output; this
 * drives it — spawns the command, folds the lines as they arrive, waits for a
 * running editor to answer, and holds the result long enough for a chip on the
 * wall to say how it went.
 *
 * Shaped like `Skein`: a plain class with Tauri subscriptions and no lifecycle
 * of its own, so `App.svelte`'s `onDestroy` has to release it through
 * `Listeners`. Skip that and every edit in dev leaves a superseded generation
 * ingesting `action:log` for a wall nobody can see — and polling every project
 * on the machine, forever.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  actionsFor,
  automationStep,
  liveCodingStep,
  progressFrom,
  tallyNote,
  LIVE_CODING,
  NO_STATUS,
  NO_TALLY,
  REMOTE_CONTROL_PORT,
  type Action,
  type ProjectFacts,
  type ProjectStatus,
  type Step,
  type Tally,
} from "./actions";
import { stripAnsi } from "./ansi";
import { Listeners } from "./listeners";

export * from "./actions";

export type RunState = "running" | "ok" | "failed" | "cancelled";

/** `poll_projects` answers with the root it is answering about. */
type StatusRow = ProjectStatus & { root: string };

/** How long a running editor is given to answer before we stop waiting. A cook
 *  or a full rebuild genuinely can take this long. */
const EDITOR_TIMEOUT_MS = 10 * 60 * 1000;
/** If a Live Coding compile has not *started* by now, it is not going to. */
const LIVE_CODING_GRACE_MS = 20_000;
const LIVE_CODING_OFF =
  "the compile never started — is Live Coding enabled? (Editor Preferences → Live Coding)";
/** Long enough for an editor to save a big level and put its prompt away. */
const CLOSE_TIMEOUT_MS = 3 * 60 * 1000;
const POLL_MS = 8_000;
const MAX_LOG = 500;

/** One press of one chip, from the click to the verdict. */
export class Run {
  /** Also the id every Rust primitive is addressed by, for this whole run —
   *  a cycle's close, build and relaunch all share it, because only one of
   *  them is ever live at a time. */
  readonly id = crypto.randomUUID();
  readonly root: string;
  readonly action: string;
  readonly startedAt = Date.now();

  state = $state<RunState>("running");
  /** 0–100 when something in the output actually counts to a total. */
  pct = $state<number | null>(null);
  /** The last thing worth repeating — a file being compiled, a verdict. */
  note = $state<string | null>(null);
  log = $state<string[]>([]);
  endedAt = $state<number | null>(null);

  /** Set to true by `cancel`, so a step that is waiting rather than running —
   *  an editor closing, a log being tailed — can stop as well. */
  cancelling = false;
  /** The live step's own reader, if it has one. */
  watch: ((line: string) => void) | undefined;
  /** Automation output is counted wherever it appears: in a headless run's
   *  stdout, and in the log of an editor running the same tests. */
  tally: Tally = NO_TALLY;

  constructor(root: string, action: string) {
    this.root = root;
    this.action = action;
  }

  push(line: string) {
    /* The log keeps its colour — `FORCE_COLOR` is set precisely so it has some,
       and the panel renders it. Everything that *reads* the line works on the
       stripped text: a `[1/4]` behind an SGR sequence does not match anything,
       and a note carrying raw escapes would put them in a tooltip and on the
       fault bar as literal `ESC[43m`. */
    this.log.push(line);
    if (this.log.length > MAX_LOG) this.log = this.log.slice(-MAX_LOG);

    const plain = stripAnsi(line);
    const p = progressFrom(plain);
    if (p) {
      if (p.pct !== null) this.pct = p.pct;
      if (p.note) this.note = p.note;
    }
    this.tally = automationStep(this.tally, plain);
    this.watch?.(plain);
  }

  /** The tail of the output, for a failure that had nothing else to say. */
  tail(n = 12): string[] {
    return this.log.map(stripAnsi).filter((l) => l.trim()).slice(-n);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A promise something else resolves — the shape of every "and now wait for
 *  the world to answer" in this file. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export class Actions {
  facts = $state<Record<string, ProjectFacts>>({});
  status = $state<Record<string, ProjectStatus>>({});
  /** The most recent run of each `${id}@${root}`. Kept after it
   *  finishes: "the last build failed" is the thing you most want a chip to
   *  still be saying ten minutes later. */
  runs = $state<Record<string, Run>>({});

  #listeners = new Listeners();
  #byRunId = new Map<string, Run>();
  #settle = new Map<string, (v: { state: RunState; code: number | null }) => void>();
  #timer: number | undefined;
  #fault: (message: string) => void;

  constructor(fault: (message: string) => void) {
    this.#fault = fault;
    this.#wire();
    /* `window.setInterval` rather than the bare one, for its number handle —
       see the note on the shared clock in conversation.svelte.ts. */
    this.#timer = window.setInterval(() => void this.poll(), POLL_MS);
  }

  detach() {
    this.#listeners.detach();
    if (this.#timer !== undefined) window.clearInterval(this.#timer);
    this.#timer = undefined;
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  #wire() {
    const keep = this.#listeners.keep.bind(this.#listeners);
    keep(
      listen<{ run_id: string; line: string }>("action:log", (e) => {
        this.#byRunId.get(e.payload.run_id)?.push(e.payload.line);
      }),
    );
    keep(
      listen<{ run_id: string; state: RunState; code: number | null }>(
        "action:state",
        (e) => {
          const settle = this.#settle.get(e.payload.run_id);
          if (!settle) return;
          this.#settle.delete(e.payload.run_id);
          settle({ state: e.payload.state, code: e.payload.code });
        },
      ),
    );
  }

  /* ── what the wall is looking at ──────────────────────────────────────── */

  /** Learn the projects on the wall, and forget the ones that left.
   *
   *  Probing is once per project and never repeated: what a project *is* — its
   *  scripts, its engine — changes when you edit package.json, not while you
   *  are looking at it. What it is *doing* is the poll's business. */
  async sync(roots: string[]) {
    const wanted = new Set(roots);
    for (const root of roots) {
      if (this.facts[root]) continue;
      try {
        const f = await invoke<ProjectFacts>("probe_project", { root });
        this.facts = { ...this.facts, [root]: f };
      } catch {
        /* A folder that has gone away is not a fault worth a red bar. */
      }
    }
    for (const known of Object.keys(this.facts)) {
      if (wanted.has(known)) continue;
      const { [known]: _gone, ...rest } = this.facts;
      this.facts = rest;
    }
    await this.poll();
  }

  /** Re-read what every project is doing. Cheap unless an Unreal project has no
   *  editor window to find, which is the one case that reaches for WMI. */
  async poll() {
    const requests = Object.values(this.facts).map((f) => ({
      root: f.root,
      unrealName: f.unreal?.name ?? null,
      git: f.git,
    }));
    if (!requests.length) return;
    try {
      const rows = await invoke<StatusRow[]>("poll_projects", { requests });
      const next = { ...this.status };
      for (const r of rows) {
        const { root, ...rest } = r;
        next[root] = rest;
      }
      this.status = next;
    } catch {
      /* Never a fault: a poll that fails is a poll, and the wall still works. */
    }
  }

  list(root: string): Action[] {
    const f = this.facts[root];
    return f ? actionsFor(f, this.status[root] ?? NO_STATUS) : [];
  }

  runOf(root: string, action: string): Run | undefined {
    return this.runs[`${action}@${root}`];
  }

  /** This project's runs, most recent first — what the servers panel reads.
   *  A chip carries a state and one line of note; the reason a build failed is
   *  a hundred lines, and those have to be somewhere you can read them. */
  recent(root: string): Run[] {
    return Object.values(this.runs)
      .filter((r) => r.root === root)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Everything a territory draws along its bottom edge. */
  chipsFor(root: string): {
    id: string;
    label: string;
    title: string;
    state: RunState | "idle";
    pct: number | null;
    note: string | null;
    quiet: boolean;
    idle: boolean;
  }[] {
    return this.list(root).map((a) => {
      const run = this.runOf(root, a.id);
      const state = run?.state ?? "idle";
      return {
        id: a.id,
        label: a.label,
        /* The tooltip is where the last line of output goes: the chip itself
           must not resize while a build runs, or the row shuffles under the
           cursor every few seconds. */
        title: run?.note ? `${a.title} — ${run.note}` : a.title,
        state,
        pct: run?.state === "running" ? run.pct : null,
        note: run?.note ?? null,
        quiet: !!a.quiet,
        idle: !a.steps.length,
      };
    });
  }

  /* ── running one ──────────────────────────────────────────────────────── */

  /** Press a chip. A second press while it is running cancels it. */
  async run(root: string, id: string) {
    const facts = this.facts[root];
    if (!facts) return;
    const action = this.list(root).find((a) => a.id === id);
    if (!action || !action.steps.length) return;

    const key = `${id}@${root}`;
    if (this.runs[key]?.state === "running") {
      await this.cancel(root, id);
      return;
    }

    const run = new Run(root, id);
    this.runs = { ...this.runs, [key]: run };
    this.#byRunId.set(run.id, run);

    try {
      for (const step of action.steps) {
        if (run.cancelling) break;
        await this.#step(facts, run, step);
        if (run.state !== "running") break;
      }
      if (run.state === "running") {
        run.state = run.cancelling ? "cancelled" : "ok";
        /* A test run's verdict outlives its exit code: a headless run exits 255
           on any failure, and an in-editor one has no exit code at all. */
        if (run.tally.total > 0 || run.tally.done) run.note = tallyNote(run.tally);
      }
    } catch (err) {
      run.state = "failed";
      run.note = String(err).replace(/^Error:\s*/, "");
    } finally {
      run.endedAt = Date.now();
      run.watch = undefined;
      this.#byRunId.delete(run.id);
      this.#settle.delete(run.id);
      /* Whatever it was, the world has probably moved: an editor opened, a
         branch went out. */
      void this.poll();
      if (run.state === "failed") this.#report(facts, run, id);
    }
  }

  async cancel(root: string, id: string) {
    const run = this.runs[`${id}@${root}`];
    if (!run || run.state !== "running") return;
    run.cancelling = true;
    run.note = "stopping…";
    try {
      await invoke("cancel_action", { runId: run.id });
    } catch {
      /* Already gone is the outcome we wanted. */
    }
  }

  /** Say a failure out loud once, with the most useful line it produced.
   *
   *  A chip going rust-red is enough to notice and not enough to act on, and
   *  the whole log lives one click away in the servers panel — so what goes on
   *  the fault bar is the last thing the run actually said. */
  #report(facts: ProjectFacts, run: Run, id: string) {
    const name = facts.root.split(/[\\/]/).filter(Boolean).pop() ?? facts.root;
    const why = run.note ?? run.tail(1)[0] ?? "no output";
    this.#fault(`${name} · ${id} failed — ${why}`);
  }

  async #step(f: ProjectFacts, run: Run, step: Step) {
    switch (step.kind) {
      case "run": {
        const res = await this.#spawn(run, step.argv, f.root);
        if (res.state !== "ok") {
          run.state = res.state;
          if (res.state === "failed" && !run.tally.done) {
            run.note = run.tail(1)[0] ?? `exit ${res.code ?? "?"}`;
          }
        }
        return;
      }

      case "launch-editor": {
        const u = f.unreal;
        if (!u?.engine) throw new Error("no engine to launch");
        /* Both flags earn their place. `-ModelContextProtocolStartServer`
           short-circuits the ini read, so it works with the shipped
           `bAutoStartServer=False` — which has to stay false, or a cook would
           fight the interactive editor for the port. The port is pinned because
           the editor's own `ServerPortNumber` lives in `Saved/Config`, which is
           not committed, so a fresh clone would come up somewhere else while
           `.mcp.json` still pointed here. */
        const args = [u.uproject, "-ModelContextProtocolStartServer"];
        if (u.mcpPort) args.push(`-ModelContextProtocolPort=${u.mcpPort}`);
        await invoke("launch_detached", {
          program: `${u.engine}\\Engine\\Binaries\\Win64\\UnrealEditor.exe`,
          args,
          cwd: f.root,
        });
        run.note = "editor starting…";
        /* It takes a while to put up a window; ask again once it has. */
        setTimeout(() => void this.poll(), 6000);
        return;
      }

      case "focus-editor": {
        const pid = this.status[f.root]?.editorPid;
        if (!pid) throw new Error("its editor is not open any more");
        const shown = await invoke<boolean>("focus_process", { pid });
        if (!shown) throw new Error("the editor would not come forward");
        run.note = "brought forward";
        return;
      }

      case "close-editor": {
        const pid = this.status[f.root]?.editorPid;
        if (!pid) return; // already closed — nothing to wait for
        await invoke("close_process", { pid });
        run.note = "waiting for the editor to close — answer any save prompt";
        const deadline = Date.now() + CLOSE_TIMEOUT_MS;
        for (;;) {
          if (run.cancelling) {
            run.state = "cancelled";
            return;
          }
          if (!(await invoke<boolean>("process_alive", { pid }))) {
            await this.poll();
            return;
          }
          if (Date.now() > deadline) {
            throw new Error("the editor was still open after three minutes");
          }
          await sleep(800);
        }
      }

      case "live-coding": {
        const u = f.unreal;
        if (!u) throw new Error("not an unreal project");
        let v = LIVE_CODING;
        const done = deferred<void>();
        run.watch = (line) => {
          const next = liveCodingStep(v, line);
          if (next === v) return;
          v = next;
          if (v.note) run.note = v.note;
          if (v.done) done.resolve();
        };
        await this.#tail(run, u.log, async () => {
          await invoke("unreal_exec", {
            port: REMOTE_CONTROL_PORT,
            command: "LiveCoding.Compile",
          });
          /* Nothing at all after twenty seconds means Live Coding is off for
             this editor session — better said now than at the ten-minute mark. */
          await this.#waitFor(run, done.promise, () => (v.started || v.done ? null : LIVE_CODING_OFF));
        });
        if (!v.ok) {
          run.state = "failed";
          /* The compiler's own diagnostics never reach the editor log — they
             live in the Live Coding console and in UBT's log, so that is where
             a failure's reason is fetched from. */
          await this.#appendUbtLog(run);
          run.note = v.note ?? "live coding failed";
        }
        return;
      }

      case "automation": {
        const u = f.unreal;
        if (!u) throw new Error("not an unreal project");
        const done = deferred<void>();
        run.watch = () => {
          if (run.tally.total > 0) {
            const seen = run.tally.passed + run.tally.failed.length;
            run.pct = Math.min(100, Math.round((seen / run.tally.total) * 100));
          }
          if (run.tally.done) done.resolve();
        };
        run.note = "running in the open editor…";
        await this.#tail(run, u.log, async () => {
          await invoke("unreal_exec", {
            port: REMOTE_CONTROL_PORT,
            command: `Automation RunTests ${step.filter}`,
          });
          await this.#waitFor(run, done.promise);
        });
        run.note = tallyNote(run.tally);
        if (run.tally.failed.length || run.tally.total === 0) run.state = "failed";
        return;
      }
    }
  }

  /** Spawn argv and wait for its exit code. */
  async #spawn(
    run: Run,
    argv: string[],
    cwd: string,
  ): Promise<{ state: RunState; code: number | null }> {
    const settled = deferred<{ state: RunState; code: number | null }>();
    this.#settle.set(run.id, settled.resolve);
    try {
      await invoke("run_action", { runId: run.id, argv, cwd });
    } catch (err) {
      this.#settle.delete(run.id);
      throw err;
    }
    return settled.promise;
  }

  /** Tail a log for the duration of `body`, and stop tailing whatever happens.
   *
   *  A tail has no verdict of its own — it is a file being read — so the thing
   *  that started it is the thing that has to end it. Left running, the next
   *  build's lines would arrive at a run that finished ten minutes ago. */
  async #tail(run: Run, path: string, body: () => Promise<void>) {
    await invoke("tail_log", { runId: run.id, path });
    try {
      await body();
    } finally {
      run.watch = undefined;
      await invoke("cancel_action", { runId: run.id }).catch(() => {});
    }
  }

  /** Wait for a running editor to answer, or stop waiting for a good reason.
   *
   *  Three of them: the answer arrived, the run was cancelled, or it has been
   *  long enough that no answer is coming. `grace` is the fourth, for the one
   *  case where waiting the full ten minutes tells you nothing you could not
   *  have been told in twenty seconds.
   *
   *  The single timer matters: a version of this that raced a fresh `setTimeout`
   *  against the answer left the loser pending, and a rejection nobody is
   *  listening for any more is an unhandled rejection in the console every time
   *  a build succeeds. */
  async #waitFor(run: Run, done: Promise<void>, grace?: () => string | null) {
    const started = Date.now();
    let tick: number | undefined;
    const guard = new Promise<never>((_, reject) => {
      tick = window.setInterval(() => {
        const waited = Date.now() - started;
        if (run.cancelling) {
          run.state = "cancelled";
          reject(new Error("stopped"));
        } else if (grace && waited > LIVE_CODING_GRACE_MS) {
          const why = grace();
          if (why) reject(new Error(why));
        } else if (waited > EDITOR_TIMEOUT_MS) {
          reject(new Error("the editor never answered"));
        }
      }, 500);
    });
    try {
      await Promise.race([done, guard]);
    } finally {
      if (tick !== undefined) window.clearInterval(tick);
    }
  }

  /** UnrealBuildTool writes its own log, and after a failed Live Coding compile
   *  it is the only place the compiler errors exist. */
  async #appendUbtLog(run: Run) {
    try {
      const text = await invoke<string | null>("read_tail", {
        path: "%LOCALAPPDATA%\\UnrealBuildTool\\Log.txt",
        maxBytes: 64 * 1024,
      });
      if (!text) return;
      run.log.push("── UnrealBuildTool log ──");
      for (const line of text.split(/\r?\n/).filter((l) => l.trim())) {
        run.log.push(line);
      }
      if (run.log.length > MAX_LOG) run.log = run.log.slice(-MAX_LOG);
    } catch {
      /* No log is not worse than the failure we already have. */
    }
  }
}
