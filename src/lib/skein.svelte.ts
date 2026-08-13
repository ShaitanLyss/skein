/* The studio, in the front end: projects, conversations, dev servers, and the
 * traffic between them and Rust.
 *
 * The restore model is *lazy*. On launch the wall paints itself entirely from
 * SQLite — every card in its pinned position, drawn hollow — and no `claude`
 * process starts at all. Dev servers do start eagerly, because they are the
 * slow thing and nothing about them is speculative. A conversation wakes only
 * when you speak to it. */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { windowForObserved } from "./classify";
import { Conversation } from "./conversation.svelte";
import { foldTranscript, trimOverlap } from "./history";
import { layout } from "./layout";
import { Listeners } from "./listeners";
import type { Studio } from "./studio.svelte";

export type Project = {
  id: string;
  name: string;
  root_path: string;
  /** Where its territory was put, or null while the grid still decides. */
  x: number | null;
  y: number | null;
};

/** A conversation Claude Code recorded, as read off disk by `sessions.rs`.
 *
 *  Field names are the Rust struct's, so they arrive snake_case. `model` is the
 *  bare API name with no window tier — the transcript has no `system/init` in
 *  it — which is why `ctx_tokens` is a count rather than a fraction. */
export type Session = {
  id: string;
  cwd: string;
  branch: string | null;
  title: string | null;
  model: string | null;
  ctx_tokens: number;
  born_at: string | null;
  last_at: string | null;
  bytes: number;
};

export type ServerSpec = {
  label: string;
  command: string;
  cwd: string | null;
  port: number | null;
};

export type ServerGroup = {
  id: string;
  project_id: string;
  label: string;
  autostart: boolean;
  start_order: number;
  servers: ServerSpec[];
};

export type ServerHealth = "idle" | "starting" | "up" | "exited";

export class GroupRuntime {
  readonly group: ServerGroup;
  running = $state(false);
  health = $state<Record<string, ServerHealth>>({});
  log = $state<{ label: string; line: string; stderr: boolean }[]>([]);

  constructor(group: ServerGroup) {
    this.group = group;
  }

  /** One state for the whole group, for the chip on the wall. */
  overall = $derived.by<ServerHealth>(() => {
    const vals = this.group.servers.map((s) => this.health[s.label] ?? "idle");
    if (vals.some((v) => v === "exited")) return "exited";
    if (vals.length && vals.every((v) => v === "up")) return "up";
    if (vals.some((v) => v === "starting" || v === "up")) return "starting";
    return "idle";
  });
}

const MAX_LOG = 400;

export class Skein {
  projects = $state<Project[]>([]);
  convs = $state<Conversation[]>([]);
  groups = $state<GroupRuntime[]>([]);
  fault = $state<string | null>(null);
  loaded = $state(false);
  /** `SKEIN_NO_SERVERS` was set, so no group was started on load. Kept as state
   *  rather than checked where it is needed, because it has to be *sayable*: a
   *  wall whose servers are all down for a reason must not look like a wall
   *  whose servers all failed. */
  serversQuiet = $state(false);

  #byId = new Map<string, Conversation>();
  #studio: Studio;
  /** Held so `detach` can give them back — see ./listeners.ts for why that
   *  matters to a class with no lifecycle of its own. */
  #listeners = new Listeners();

  constructor(studio: Studio) {
    this.#studio = studio;
    this.#wire();
  }

  /** Stop listening. Called when the component that built this goes away, which
   *  in dev is every time a file is edited. Without it a superseded Skein keeps
   *  ingesting events and writing rows for a wall nobody can see. */
  detach() {
    this.#listeners.detach();
  }

  /** How many subscriptions are live, so the control surface can prove there is
   *  exactly one Skein listening. */
  get listenerCount(): number {
    return this.#listeners.size;
  }

  #wire() {
    const keep = this.#listeners.keep.bind(this.#listeners);

    keep(
      listen<{ id: string; event: any }>("conv:event", (e) => {
        const c = this.#byId.get(e.payload.id);
        if (!c) return;
        c.ingest(e.payload.event);
        this.#persistConv(c, e.payload.event);
      }),
    );
    keep(
      listen<{ id: string; line: string }>("conv:stderr", (e) => {
        this.#byId.get(e.payload.id)?.noteStderr(e.payload.line);
      }),
    );
    keep(
      listen<{ id: string; code: number | null }>("conv:exit", (e) => {
        this.#byId.get(e.payload.id)?.markExited(e.payload.code);
      }),
    );

    keep(
      listen<{
        conversation_id: string;
        ask_id: string;
        question: string;
        options: { label: string; detail?: string | null }[];
      }>("ask:opened", (e) => {
        const c = this.#byId.get(e.payload.conversation_id);
        if (!c) return;
        c.pendingAsk = {
          askId: e.payload.ask_id,
          question: e.payload.question,
          options: e.payload.options ?? [],
          since: Date.now(),
        };
        c.activity = "asked you";
      }),
    );

    keep(
      listen<{ ask_id: string }>("ask:closed", (e) => {
        for (const c of this.#byId.values()) {
          if (c.pendingAsk?.askId === e.payload.ask_id) c.pendingAsk = null;
        }
      }),
    );

    keep(
      listen<{ group_id: string; label: string; line: string; stderr: boolean }>(
        "server:log",
        (e) => {
          const g = this.groups.find((g) => g.group.id === e.payload.group_id);
          if (!g) return;
          g.log.push({
            label: e.payload.label,
            line: e.payload.line,
            stderr: e.payload.stderr,
          });
          if (g.log.length > MAX_LOG) g.log = g.log.slice(-MAX_LOG);
        },
      ),
    );
    keep(
      listen<{ group_id: string; label: string; state: ServerHealth }>(
        "server:state",
        (e) => {
          const g = this.groups.find((g) => g.group.id === e.payload.group_id);
          if (!g) return;
          g.health = { ...g.health, [e.payload.label]: e.payload.state };
        },
      ),
    );
  }

  /** Paint the wall from disk, then start the servers. No agent is spawned. */
  async load() {
    try {
      const s = await invoke<{
        projects: Project[];
        conversations: any[];
        server_groups: ServerGroup[];
      }>("load_studio");

      this.projects = s.projects;

      for (const row of s.conversations) {
        const c = Conversation.restore(row);
        this.#byId.set(c.id, c);
        if (row.x !== null && row.y !== null) {
          this.#studio.placements[c.id] = {
            x: row.x,
            y: row.y,
            pinned: row.pinned,
          };
        }
      }
      this.convs = [...this.#byId.values()];
      /* After the cards, not before: territories are packed against their real
         heights, and a wall of projects that all looked empty would pack tight
         enough to overlap the moment the cards arrived. Anything from before
         territories could be moved has no position at all, and this is where it
         becomes memory rather than something re-derived on every load. */
      this.#settlePlaces();

      this.groups = s.server_groups.map((g) => new GroupRuntime(g));
      this.loaded = true;

      /* Scrollback is filled in behind the painted wall. Not awaited: the wall
         is already on screen and correct without it, and a card whose file is
         still being read simply has nothing under its title yet.

         This does not compromise lazy restore, which is about *processes* —
         reading a transcript spawns nothing and costs a file read. Waiting for
         a click to do it meant every card was blank until you touched it, and
         the one thing you might want before touching a card is to see what it
         was doing. */
      void this.#fillHistory(this.convs);

      /* Servers start eagerly, staged by start_order — backend before
         frontend, because the frontend usually wants the backend up.

         Unless asked not to: `SKEIN_NO_SERVERS=1` leaves every group listed and
         clickable but starts none of them, which is what makes it safe to run a
         second Skein against the same store — two instances racing for every
         port in the workspace leave both walls showing `exited`. Asked of Rust
         rather than read from a query string, since only the process knows its
         own environment. */
      this.serversQuiet = await invoke<boolean>("servers_quiet").catch(() => false);
      if (!this.serversQuiet) {
        for (const g of this.groups.filter((g) => g.group.autostart)) {
          await this.startGroup(g);
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    } catch (err) {
      this.fault = String(err);
    }
  }

  projectFor(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id);
  }

  /** `worktree` branches the conversation into its own git worktree via the
   *  CLI's own `--worktree`, so we never shell out to git ourselves. */
  async open(cwd: string, worktree?: string): Promise<Conversation | null> {
    try {
      const project = await invoke<Project>("ensure_project", { rootPath: cwd });
      if (!this.projects.some((p) => p.id === project.id)) {
        this.projects = [...this.projects, project];
        /* A new territory flows into the first free cell — once, here, and then
           it is somewhere rather than wherever the list implies. */
        this.#settlePlaces();
      }
      const id = crypto.randomUUID();
      const wt = worktree?.trim() || null;
      await invoke("spawn_conversation", { id, cwd, worktree: wt });
      await invoke("record_conversation", {
        id,
        projectId: project.id,
        cwd,
        worktree: wt,
      });
      const conv = new Conversation(id, cwd, project.id, wt);
      /* We just spawned it, so it has a process — even though `system/init`
         has not arrived yet. It cannot: claude emits init only after it
         receives its first message. Leaving this dormant meant `send` tried to
         wake an already-running process and the first message never landed. */
      conv.dormant = false;
      conv.activity = "ready";
      this.#byId.set(id, conv);
      this.convs = [...this.convs, conv];
      /* A brand-new session has no transcript, so this settles on "none"
         immediately. It runs anyway so that "every card on the wall has been
         read for" holds without exception — including the `--worktree` case,
         where the CLI may have branched from a session that does have one. */
      void this.loadHistory(conv);
      return conv;
    } catch (err) {
      this.fault = String(err);
      return null;
    }
  }

  /** Conversations Claude Code has recorded that no card points at yet.
   *
   *  Filtered here rather than in Rust because the wall is the thing that knows
   *  what is on it. A session whose card was *closed* stays in this list on
   *  purpose — closing takes a card off the wall without deleting the row, and
   *  adopting it again is how you bring it back. */
  async importable(): Promise<Session[]> {
    /* By session, not by card: what `list_sessions` returns are sessions, and
       after a card has been cleared its own fresh session is not its id. Keyed
       on `id` the wall would offer to adopt a session that is already standing
       on it — and, correctly, would go on offering the one that was cleared,
       which is exactly how a clear is undone. */
    const known = new Set(this.convs.map((c) => c.sessionId));
    try {
      const all = await invoke<Session[]>("list_sessions");
      return all.filter((s) => !known.has(s.id));
    } catch (err) {
      this.fault = String(err);
      return [];
    }
  }

  /** Put a session started outside Skein on the wall.
   *
   *  Nothing is copied and nothing moves: the row points at the transcript
   *  where the CLI wrote it, and waking the card resumes that same session in
   *  place. The card arrives dormant, which is the honest state — it has a
   *  history and no process — and lazy restore already knows how to draw that. */
  async importSession(s: Session): Promise<Conversation | null> {
    try {
      const project = await invoke<Project>("ensure_project", {
        rootPath: s.cwd,
      });
      if (!this.projects.some((p) => p.id === project.id)) {
        this.projects = [...this.projects, project];
        this.#settlePlaces();
      }

      const window = windowForObserved(s.model ?? undefined, s.ctx_tokens);
      const frac = Math.min(1, s.ctx_tokens / window);
      await invoke("import_conversation", {
        id: s.id,
        projectId: project.id,
        cwd: s.cwd,
        title: s.title,
        model: s.model,
        lastCtxFrac: frac,
        /* Its own age, not the moment it was adopted. */
        bornAt: s.born_at ? Date.parse(s.born_at) : null,
      });

      const conv = Conversation.restore({
        id: s.id,
        cwd: s.cwd,
        project_id: project.id,
        title: s.title ?? "untitled",
        model: s.model,
        interrupted: false,
        last_ctx_frac: frac,
        /* Non-null so the card counts as having spoken, and therefore wakes
           with `--resume`. See `import_conversation` — we know a transcript
           exists, not how its last turn ended. */
        last_ending: "ok",
      });
      /* `restore` can only infer tokens back out of the fraction, against the
         window a bare model id implies. Here the true count is in hand, so it
         is set directly rather than round-tripped through 200k. */
      conv.contextWindow = window;
      conv.ctxTokens = s.ctx_tokens;

      this.#byId.set(conv.id, conv);
      this.convs = [...this.convs, conv];
      /* An adopted card is the case that most needs this: it is nothing *but*
         history until you speak to it. */
      void this.loadHistory(conv);
      return conv;
    } catch (err) {
      this.fault = String(err);
      return null;
    }
  }

  /** Take a project off the wall for good.
   *
   *  A territory outlives its last card on purpose, so this is the only way one
   *  ever leaves — otherwise every folder ever opened stays forever. Its dev
   *  servers are stopped first: the rows go with the project, and a running
   *  group whose row has been deleted is a process nothing owns. */
  async forgetProject(cwd: string): Promise<boolean> {
    try {
      const project = this.projects.find((p) => p.root_path === cwd);
      if (project) {
        for (const g of this.groupsFor(project.id).filter((g) => g.running)) {
          await this.stopGroup(g);
        }
        this.groups = this.groups.filter((g) => g.group.project_id !== project.id);
      }
      const gone = await invoke<boolean>("forget_project", { rootPath: cwd });
      if (gone) this.projects = this.projects.filter((p) => p.root_path !== cwd);
      return gone;
    } catch (err) {
      /* Refusing because something is still open there is the common case, and
         it is worth saying out loud rather than doing nothing. */
      this.fault = String(err);
      return false;
    }
  }

  /** Give a dormant card a process again, resuming its history in place. */
  async wake(conv: Conversation): Promise<boolean> {
    if (!conv.dormant) return true;
    conv.activity = "waking…";
    try {
      await invoke("spawn_conversation", {
        id: conv.id,
        /* Not the card id: a cleared card keeps its own id and points at a
           fresh session. They are the same for every card that has never been
           cleared, which is most of them. */
        sessionId: conv.sessionId,
        cwd: conv.cwd,
        /* Only resume something that has a transcript to resume. */
        resume: conv.everSpoke,
        worktree: null,
      });
      conv.dormant = false;
      return true;
    } catch (err) {
      /* Belt and braces: if the supervisor says it is already running, then it
         is awake, whatever this card believed about itself. */
      if (String(err).includes("already open")) {
        conv.dormant = false;
        return true;
      }
      this.fault = String(err);
      conv.activity = "could not wake";
      return false;
    }
  }

  async send(conv: Conversation, text: string) {
    if (conv.dormant && !(await this.wake(conv))) return;
    if (conv.title === "untitled") {
      conv.title = text.length > 42 ? text.slice(0, 41) + "…" : text;
      void invoke("update_conversation", { id: conv.id, title: conv.title });
    }
    try {
      await invoke("send_prompt", { id: conv.id, text });
    } catch (err) {
      this.fault = String(err);
    }
  }

  /** Start this card over: same card, same place, a brand-new session.
   *
   *  What Claude Code's own `/clear` does, on a wall where the terminal window
   *  is a card. There is no way to ask a running `claude -p` to forget its
   *  context — the CLI's `/clear` is a TUI gesture and never reaches the
   *  stream — so this is the honest equivalent: end the process and point the
   *  card at a fresh session id. The card stays dormant afterwards, exactly as
   *  a restored one does, and the next thing you say to it spawns it.
   *
   *  Nothing is destroyed. The old transcript stays where Claude Code wrote it,
   *  so `adopt a recorded session…` puts it back on the wall as its own card —
   *  which is the whole reason this is not offered as a danger item.
   *
   *  Order matters: `retiring` before the kill, or the exit code from our own
   *  `close_conversation` lands as a crash on the fresh session that replaced
   *  it. It is only set when there is a child to kill, since nothing would
   *  clear it otherwise and a later genuine crash would go unreported. */
  async clear(conv: Conversation) {
    try {
      if (!conv.dormant) {
        conv.retiring = true;
        await invoke("close_conversation", { id: conv.id });
      }
      const sessionId = crypto.randomUUID();
      await invoke("clear_conversation", { id: conv.id, sessionId });
      conv.clear(sessionId);
    } catch (err) {
      conv.retiring = false;
      this.fault = String(err);
    }
  }

  /** Resolve a parked question. The agent's turn resumes from exactly where it
   *  stopped — no new turn, no re-prompt, no lost context. */
  async answerAsk(conv: Conversation, answer: string) {
    const ask = conv.pendingAsk;
    if (!ask) return;
    conv.pendingAsk = null;
    conv.activity = "responding";
    try {
      await invoke("answer_ask", { askId: ask.askId, answer });
    } catch (err) {
      this.fault = String(err);
    }
  }

  /** Every card currently blocked on a question. These are facts, not
   *  inferences, so they sort ahead of anything merely overdue. */
  blocked = $derived(this.convs.filter((c) => c.pendingAsk));

  /* ── the horizon ─────────────────────────────────────────────────────
   *
   * Global usage, kept as one number so the ground itself can carry it. The
   * design's argument is that a running total belongs in your peripheral
   * vision, not in a corner you have to go and read. */

  /** Everything spent by cards currently on the wall, this session. */
  spend = $derived(this.convs.reduce((sum, c) => sum + c.costUsd, 0));

  /** Total context held open across the wall. Not a cost — a weight. */
  heldTokens = $derived(this.convs.reduce((sum, c) => sum + c.ctxTokens, 0));

  /** How many cards are actually burning tokens right now. */
  live = $derived(this.convs.filter((c) => c.working).length);

  /** Send one prompt to several cards.
   *
   *  Dormant targets wake first, so lazy restore and broadcast compose without
   *  a special case. Sends are sequential rather than parallel: waking three
   *  `claude` processes at once is a thundering herd, and the ordering is
   *  visible on the wall anyway. */
  async broadcast(convs: Conversation[], text: string) {
    for (const c of convs) {
      await this.send(c, text);
    }
  }

  /** Which of these cards have already edited the same files as each other.
   *
   *  This is the collision feature paying a dividend before it exists: the
   *  moment before a prompt fans out is exactly when you want to know that two
   *  of your targets share a working tree. */
  async sharedTree(convs: Conversation[]): Promise<string[]> {
    if (convs.length < 2) return [];
    const ids = new Set(convs.map((c) => c.id));
    const clashing = new Set<string>();
    await Promise.all(
      convs.map(async (c) => {
        try {
          const others = await invoke<string[]>("overlapping_conversations", {
            conversationId: c.id,
          });
          if (others.some((o) => ids.has(o))) clashing.add(c.id);
        } catch {
          /* the warning is a courtesy, not a gate */
        }
      }),
    );
    return [...clashing];
  }

  async close(conv: Conversation) {
    try {
      await invoke("close_conversation", { id: conv.id });
      await invoke("close_conversation_record", { id: conv.id });
    } catch (err) {
      this.fault = String(err);
    }
    this.#byId.delete(conv.id);
    this.convs = this.convs.filter((c) => c.id !== conv.id);
    this.#studio.unpin(conv.id);
  }

  savePlacement(id: string, x: number, y: number, pinned: boolean) {
    void invoke("save_placement", { conversationId: id, x, y, pinned }).catch(
      () => {},
    );
  }

  /* ── where the territories sit ────────────────────────────────────────
   *
   * The wall reads a territory's position off the project row, so this updates
   * the row in hand *and* on disk: a drag asks for the new position on the very
   * next frame, and waiting for SQLite to answer would drop the territory back
   * where it started for one of them. */

  /** Put a territory somewhere. Nulls settle it back in among the others. */
  placeProject(cwd: string, x: number | null, y: number | null) {
    this.projects = this.projects.map((p) =>
      p.root_path === cwd ? { ...p, x, y } : p,
    );
    void invoke("place_project", { rootPath: cwd, x, y }).catch(() => {});
    /* Settling it back still ends in a position of its own — see `#settlePlaces`
       for why nothing is left unsettled for long. */
    if (x === null || y === null) this.#settlePlaces();
  }

  /** Re-pack every territory, as if the wall were being arranged fresh.
   *
   *  A deliberate gesture, on the wall's own menu — never automatic. The packing
   *  is dense, so a project that has grown a lot since it was placed can end up
   *  reaching into its neighbour; this is how you ask for the whole wall to be
   *  laid out again around what is actually standing on it now. */
  tidyProjects() {
    this.projects = this.projects.map((p) => ({ ...p, x: null, y: null }));
    this.#settlePlaces();
  }

  /** Write down where the packing put any territory that has no position yet.
   *
   *  Settling is for the moment a project first appears — or is asked for — and
   *  not a state to live in. Left unsettled, a territory's position would depend
   *  on the project list *and* on how many cards each project happens to be
   *  holding, so the wall would rearrange itself every time a conversation was
   *  opened or closed, and the cards pinned inside a territory that moved —
   *  absolute canvas coordinates, by design — would be left standing where the
   *  territory used to be.
   *
   *  Idempotent, and cheap: a project that has a position is left alone. */
  #settlePlaces() {
    const { regions } = layout(this.convs, this.#studio.placements, this.projects);
    for (const p of this.projects) {
      if (p.x !== null && p.y !== null) continue;
      const r = regions.find((r) => r.cwd === p.root_path);
      if (r) this.placeProject(p.root_path, r.x, r.y);
    }
  }

  /* ── dev servers ──────────────────────────────────────────────────── */

  async startGroup(g: GroupRuntime) {
    const project = this.projectFor(g.group.project_id);
    try {
      await invoke("start_group", {
        group: g.group,
        cwd: project?.root_path ?? ".",
      });
      g.running = true;
    } catch (err) {
      this.fault = String(err);
    }
  }

  async stopGroup(g: GroupRuntime) {
    try {
      await invoke("stop_group", { groupId: g.group.id });
    } catch (err) {
      this.fault = String(err);
    }
    g.running = false;
    g.health = {};
  }

  async addGroup(projectId: string, label: string, servers: ServerSpec[]) {
    const group: ServerGroup = {
      id: crypto.randomUUID(),
      project_id: projectId,
      label,
      autostart: true,
      start_order: this.groups.length,
      servers,
    };
    try {
      await invoke("save_server_group", { group });
      this.groups = [...this.groups, new GroupRuntime(group)];
    } catch (err) {
      this.fault = String(err);
    }
  }

  async removeGroup(g: GroupRuntime) {
    await this.stopGroup(g);
    try {
      await invoke("delete_server_group", { id: g.group.id });
    } catch (err) {
      this.fault = String(err);
    }
    this.groups = this.groups.filter((x) => x !== g);
  }

  /** Open a link the transcript rendered, outside the app.
   *
   *  Not a navigation: this window is the studio, undecorated and with nowhere
   *  to go back to, so following an `href` in it would be a one-way trip. Rust
   *  checks the scheme again — see `open.rs`. */
  async openLink(href: string) {
    try {
      await invoke("open_external", { url: href });
    } catch (err) {
      this.fault = String(err);
    }
  }

  groupsFor(projectId: string): GroupRuntime[] {
    return this.groups.filter((g) => g.group.project_id === projectId);
  }

  /** Read every card's transcript, a few at a time.
   *
   *  Bounded rather than fired all at once: each read crosses IPC carrying up
   *  to the tail cap, and a wall of thirty cards would otherwise ask for all
   *  thirty files in the same tick. Four keeps the disk busy without a spike. */
  async #fillHistory(convs: Conversation[]) {
    const queue = [...convs];
    const worker = async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        await this.loadHistory(c);
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  }

  /** Fill a card's scrollback from the transcript on disk.
   *
   *  Nothing else can: `--resume` hands the model its history but puts none of
   *  it on the wire, which is why a card the app has not seen speak is blank
   *  without this. Runs once per card — see the note on `Conversation.history`
   *  — from the wall's own load, and again when a card is opened or adopted so
   *  that no card is ever left waiting to be clicked. */
  async loadHistory(c: Conversation) {
    if (c.historyState !== "unread") return;
    c.historyState = "loading";
    try {
      const t = await invoke<{ text: string; dropped_bytes: number } | null>(
        "read_transcript",
        { cwd: c.cwd, sessionId: c.sessionId },
      );
      if (!t) {
        /* No file at all — a card that was opened and never spoken to. */
        c.historyState = "none";
        return;
      }
      const h = foldTranscript(t.text, { partial: t.dropped_bytes > 0 });
      /* The card may have started speaking while the file was being read, in
         which case the turn is in both places. The wire wins. */
      c.history = c.lines.length ? trimOverlap(h.lines, c.lines) : h.lines;
      c.historyPartial = h.partial || h.dropped > 0;
      c.historyState = h.lines.length ? "ready" : "none";
    } catch {
      c.historyState = "error";
    }
  }

  /* ── persistence of live state ────────────────────────────────────── */

  /** Claude Code writes a generated title into the transcript as the session
   *  takes shape. It never reaches the stream, so we go and read it — a card
   *  called "Wire the supervisor to job objects" beats one called by whatever
   *  the first prompt happened to say. */
  async #adoptAiTitle(c: Conversation) {
    try {
      const title = await invoke<string | null>("read_ai_title", {
        cwd: c.cwd,
        sessionId: c.sessionId,
      });
      if (!title || title === c.title) return;
      c.title = title;
      await invoke("update_conversation", { id: c.id, title });
    } catch {
      /* No transcript yet is the normal case early in a session. */
    }
  }

  /** Keep the row current enough that a dormant card can show what it reached
   *  without ever spawning the session behind it. */
  #persistConv(c: Conversation, ev: any) {
    if (ev?.type === "result") {
      void this.#adoptAiTitle(c);
      void invoke("update_conversation", {
        id: c.id,
        model: c.model ?? null,
        lastCtxFrac: c.ctx,
        /* `lastEnding`, not `lastTier`: the column holds how the turn *ended*
           (ok / question / asked / error), which is a fact about the turn. The
           tier is a derived colour that decays with neglect, so persisting it
           would restore a card as whatever urgency it happened to be wearing.
           The name has to match the command's `last_ending` parameter too — an
           unknown key is silently dropped, and the COALESCE then leaves the
           column NULL, which is what made every restored card claim it had
           never spoken and wake with --session-id instead of --resume. */
        lastEnding: c.ending,
      }).catch(() => {});
      void invoke("record_turn", {
        conversationId: c.id,
        statusTier: c.tier,
        inTokens: 0,
        outTokens: 0,
        cacheTokens: c.ctxTokens,
        usd: c.costUsd,
      }).catch(() => {});
    } else if (ev?.type === "assistant") {
      for (const b of ev.message?.content ?? []) {
        if (b.type !== "tool_use") continue;
        const path = b.input?.file_path ?? b.input?.notebook_path;
        if (typeof path !== "string") continue;
        const op = b.name === "Read" ? "read" : "write";
        void invoke("record_file_touch", {
          conversationId: c.id,
          path,
          op,
        }).catch(() => {});
      }
    }
  }
}
