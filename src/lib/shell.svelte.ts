/* The floating shell — one long-lived `pwsh`, and everything the panel draws.
 *
 * The one shape worth knowing before reading this: **the panel closing does not
 * close the shell.** Alt+I is a toggle over something that is already running,
 * the way nvim's floating terminal is, so a build you started stays started
 * while you go back to the wall and read what an agent said about it. The
 * process only ends when you ask it to, or when the app does.
 *
 * Holds Tauri subscriptions and has no lifecycle of its own, so `App.svelte`'s
 * `onDestroy` releases it — see ./listeners.ts for what a leaked one costs.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { Listeners } from "./listeners";
import {
  type ShellLine,
  promptPath,
  pushLines,
  recall,
  remember,
} from "./shell";

/** There is one, and it is the same one every time the panel opens. Keyed
 *  rather than implicit so the Rust side needs no notion of "the" shell. */
const ID = "floating";

/** Lines are batched to a frame rather than pushed one at a time: a build
 *  emits thousands per second, and a `$state` write per line puts Svelte's
 *  scheduler in front of the reader thread. */
const FLUSH_MS = 50;

export class Shell {
  /** Whether the panel is on screen. Not whether a shell is running. */
  open = $state(false);
  /** What we found — `pwsh`, or `powershell` where that is all there is. Null
   *  until one has started, which is what `starting` reads off. */
  program = $state<string | null>(null);
  /** Where the shell is now, straight from its own `$PWD` rather than from
   *  wherever we last thought we sent it: `cd` is a thing you type. */
  cwd = $state("");
  lines = $state<ShellLine[]>([]);
  /** A command has gone in and its marker has not come back. Also true between
   *  the spawn and the first marker, which is the shell reading your profile —
   *  about four seconds of it here, and the reason this is drawn at all. */
  busy = $state(false);
  /** True once a shell has been asked for and has not exited. */
  live = $state(false);
  fault = $state<string | null>(null);

  /** Everything typed this session, oldest first. Plain — nothing draws it. */
  #history: string[] = [];
  /** Where Up and Down have walked to. `#history.length` is the live draft. */
  at = $state(0);
  /** What was in the field before the walk started, so Down can give it back. */
  #stash = "";

  #listeners = new Listeners();
  #pending: ShellLine[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #gone = false;

  constructor() {
    this.#wire();
  }

  /** Stop listening, and drop the batch timer with it — a module-level timer
   *  outliving its generation is the same hazard a subscription is. */
  detach() {
    this.#gone = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#listeners.detach();
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  /** What the prompt says, in the width the panel has. */
  get where(): string {
    return this.cwd ? promptPath(this.cwd, this.#home()) : "";
  }

  /** Home, inferred from the shell's own directory rather than asked for.
   *
   *  There is no `os` plugin in this app and adding one for a tilde would be a
   *  poor trade; every path the shell reports is absolute, and the account's
   *  own folder is the first three segments of a Windows user path. Wrong
   *  guesses cost a `~` that does not appear, which is what the display looked
   *  like before there was one. */
  #home(): string {
    const m = /^([A-Za-z]:[\\/]Users[\\/][^\\/]+)/.exec(this.cwd);
    if (m) return m[1];
    const p = /^(\/(?:home|Users)\/[^/]+)/.exec(this.cwd);
    return p ? p[1] : "";
  }

  #wire() {
    const keep = this.#listeners.keep.bind(this.#listeners);

    keep(
      listen<{ id: string; line: string; stderr: boolean }>("shell:out", (e) => {
        if (e.payload.id !== ID) return;
        this.#push({ text: e.payload.line, kind: e.payload.stderr ? "err" : "out" });
      }),
    );

    keep(
      listen<{ id: string; ok: boolean; cwd: string }>("shell:done", (e) => {
        if (e.payload.id !== ID) return;
        /* Flush first, or the failure mark lands on a command whose output is
           still sitting in the batch and has not been drawn yet. */
        this.#flush();
        this.cwd = e.payload.cwd;
        this.busy = false;
        if (!e.payload.ok) {
          /* Mark the command rather than the output. Which line failed is a
             question you ask while scrolling past a screen of it, and the
             answer wants to be at the top of that screen. */
          for (let i = this.lines.length - 1; i >= 0; i--) {
            if (this.lines[i].kind === "you") {
              this.lines[i] = { ...this.lines[i], failed: true };
              this.lines = [...this.lines];
              break;
            }
          }
        }
      }),
    );

    keep(
      listen<{ id: string }>("shell:exit", (e) => {
        if (e.payload.id !== ID) return;
        this.#flush();
        this.live = false;
        this.busy = false;
        this.#push({ text: "the shell exited — enter starts another", kind: "note" });
        this.#flush();
      }),
    );
  }

  #push(line: ShellLine) {
    this.#pending.push(line);
    if (this.#timer !== null || this.#gone) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#flush();
    }, FLUSH_MS);
  }

  #flush() {
    if (!this.#pending.length) return;
    const batch = this.#pending;
    this.#pending = [];
    this.lines = pushLines(this.lines, batch);
  }

  /** Show the panel, starting a shell in `cwd` if there is not one already.
   *
   *  `cwd` is only ever a *starting* directory: a shell already running is
   *  wherever you last left it, and being moved back to a project root because
   *  you toggled the panel would be the app arguing with something you typed. */
  async show(cwd: string) {
    this.open = true;
    if (this.live) return;
    await this.start(cwd);
  }

  /** Hide the panel. The shell keeps running — see the note at the top. */
  hide() {
    this.open = false;
  }

  async toggle(cwd: string) {
    if (this.open) this.hide();
    else await this.show(cwd);
  }

  async start(cwd: string) {
    this.busy = true;
    this.fault = null;
    try {
      const info = await invoke<{ program: string; started: boolean }>("open_shell", {
        id: ID,
        cwd,
      });
      this.program = info.program;
      this.live = true;
      if (info.started) {
        this.cwd = cwd;
        this.#push({ text: `${info.program} in ${cwd}`, kind: "note" });
        this.#flush();
      }
      /* Nothing is claimed about where an *attached* shell is — Rust answers a
         reattach with a fresh marker, and the marker is the only thing that
         knows. In dev this is every front-end edit: Vite rebuilds `App.svelte`,
         the object holding the session goes with it, and the new one has to
         find a shell that may have been `cd`'d anywhere since. */
    } catch (err) {
      this.busy = false;
      this.live = false;
      this.fault = String(err);
      this.#push({ text: String(err), kind: "err" });
      this.#flush();
    }
  }

  /** Send what was typed, and echo it — the shell echoes nothing back. */
  async send(text: string) {
    const line = text.replace(/\s+$/, "");
    if (!line.trim()) return;

    if (!this.live) {
      await this.start(this.cwd || ".");
      if (!this.live) return;
    }

    this.#history = remember(this.#history, line);
    this.at = this.#history.length;
    this.#stash = "";
    this.#push({ text: line, kind: "you" });
    this.#flush();
    this.busy = true;

    try {
      await invoke("shell_send", { id: ID, text: line });
    } catch (err) {
      this.busy = false;
      this.#push({ text: String(err), kind: "err" });
      this.#flush();
    }
  }

  /** Kill what is running, and open a fresh shell where this one was.
   *
   *  Deliberately not called an interrupt. These children have no console
   *  attached — a GUI app's do not — so there is no Ctrl+C to deliver to them,
   *  and pretending otherwise would be a button that sometimes did nothing to a
   *  process that had hung. Taking the tree down and starting again in the same
   *  directory is what the gesture can actually do, and the panel says so. */
  async stop() {
    const here = this.cwd;
    await this.close();
    this.#push({ text: "stopped — a new shell, same directory", kind: "note" });
    await this.start(here || ".");
  }

  /** End the session. The panel can stay open over nothing; enter starts one. */
  async close() {
    try {
      await invoke("close_shell", { id: ID });
    } catch {
      /* Nothing to close is the state we were asking for. */
    }
    this.live = false;
    this.busy = false;
  }

  /** Clear the scrollback, not the session. */
  clear() {
    this.#pending = [];
    this.lines = [];
  }

  /** Walk the history. Returns what the field should now say, or `null` when
   *  there was nowhere to go and the field should be left exactly alone. */
  step(dir: -1 | 1, draft: string): string | null {
    const count = this.#history.length;
    if (!count) return null;
    /* Stepping off the draft for the first time stashes it, so Down all the
       way back returns what you had half-typed rather than emptying the line. */
    if (this.at === count) this.#stash = draft;
    const next = recall(count, this.at, dir);
    if (next === this.at) return null;
    this.at = next;
    return next === count ? this.#stash : this.#history[next];
  }
}
