/* The studio's side of the control surface.
 *
 * Rust takes an op off a loopback socket and emits it here; this dispatches it
 * and replies. See src-tauri/src/control.rs for why any of this exists.
 *
 * Two rules kept this honest, and they are worth stating because breaking
 * either would turn a green run into a lie:
 *
 *  1. **Drive the app's own seams, not its internals.** Injecting a stream event
 *     goes out as a real `conv:event` and comes back through Rust to the same
 *     listener the supervisor talks to. A dropped file goes out as a real
 *     `tauri://drag-drop`. So these ops exercise the wiring, not a parallel
 *     path built to be easy to test.
 *
 *  2. **Say which pointer you mean.** `click` dispatches a synthetic event: it
 *     proves the handlers are connected to each other and nothing more.
 *     `real.click` moves the actual cursor through Win32. Only the second can
 *     see the bug that shipped here twice — Chromium retargeting a *real* click
 *     after `setPointerCapture` is invisible to any event you dispatch yourself.
 *
 * There is no `eval` op, on purpose. A fixed vocabulary is a description of
 * what the app can be asked to do; an eval hole is a description of nothing. */

import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import type { Conversation } from "./conversation.svelte";
import type { Ambience } from "./ambience.svelte";
import { living, type EffectKind } from "./ambience";
import { readingScale } from "./layout";
import type { Board } from "./images.svelte";
import type { Widgets } from "./widgets.svelte";
import type { Meter } from "./meter.svelte";
import { variantOf, type WidgetKind } from "./widgets";
import type { Skein } from "./skein.svelte";
import type { Studio } from "./studio.svelte";
import type { Attention } from "./attention.svelte";
import type { Actions } from "./actions.svelte";

export type Endpoint = { port: number; token: string };

/** The handles a pair of hands would have. Passed in rather than imported so
 *  the control surface owns no state of its own and can't drift from the UI. */
export type ControlHost = {
  skein: Skein;
  studio: Studio;
  board: Board;
  widgets: Widgets;
  meter: Meter;
  ambience: Ambience;
  attention: Attention;
  actions: Actions;
  canvas: () => { toCanvas(x: number, y: number): { x: number; y: number }; fitAll(): void } | undefined;
  focusedId: () => string | null;
  setFocused: (id: string | null) => void;
  /** Letting go of everything, the wall's own way — same function the ground
   *  click and Escape call, so the op cannot drift from the gesture. */
  deselect: () => void;
  draft: () => string;
  setDraft: (text: string) => void;
  /** What the slash palette is offering for the draft as it stands. */
  commands: () => { name: string }[];
  targets: () => Conversation[];
  waiting: () => Conversation[];
  clashing: () => string[];
  /** Resolves to the card it opened, which this only ever awaits — the op finds
   *  the new conversation by diffing ids, so it needs nothing from the value. */
  openIn: (dir: string, worktree?: string) => Promise<unknown>;
  /** Open a card on a project's half-finished merge, prompt already sent. */
  resolveConflicts: (cwd: string) => Promise<void>;
  submit: (broadcast: boolean) => Promise<void>;
  flags: () => Record<string, boolean>;
  setFlag: (name: string, value: boolean) => void;
};

type Op = Record<string, any>;
type Handler = (op: Op) => unknown | Promise<unknown>;

const MAX_ERRORS = 40;

/** Which Control is allowed to serve.
 *
 *  Editing this file makes Vite swap `App.svelte` in place, which constructs a
 *  second Control while the first one's `listen` is still attached — nothing
 *  unregisters it. Both then answered every op, and because ops *act*, one
 *  `open` spawned two agents and wrote two conversation rows before this was
 *  caught. Rust accepts only the first reply, so the second spawn left no trace
 *  in the response: the harness reported one card and had made two.
 *
 *  The counter has to live outside this module. A module-scoped `let` is
 *  re-evaluated by the very reload it is guarding against, so each generation
 *  would start its own count and every instance would believe it was newest —
 *  which is precisely the bug, wearing a guard. */
const SLOT = "__skeinControlGeneration";

function claim(): number {
  const w = window as unknown as Record<string, number>;
  w[SLOT] = (w[SLOT] ?? 0) + 1;
  return w[SLOT];
}

function newest(): number {
  return (window as unknown as Record<string, number>)[SLOT] ?? 0;
}

function raf(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

/** Let Svelte flush and the browser paint. Every op returns after this, so a
 *  snapshot taken straight after a mutation sees the mutation. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await raf();
  await raf();
}

/** Strip reactive proxies and anything else that won't survive the IPC. */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? null));
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export class Control {
  endpoint = $state<Endpoint | null>(null);

  /** Anything the page threw. Silent front-end errors are exactly what a
   *  screenshot can't show me, so they ride along in every snapshot. */
  #errors: { at: number; text: string }[] = [];
  #host: ControlHost;
  #ops: Record<string, Handler>;
  readonly #gen: number;
  #unlisten: (() => void) | null = null;

  constructor(host: ControlHost) {
    this.#gen = claim();
    this.#host = host;
    this.#ops = this.#table();
    this.#watchErrors();
    void this.#attach();
  }

  /** True only for the instance the live component tree belongs to. */
  get current(): boolean {
    return this.#gen === newest();
  }

  detach() {
    this.#unlisten?.();
    this.#unlisten = null;
  }

  get live(): boolean {
    return this.endpoint !== null;
  }

  #note(text: string) {
    this.#errors.push({ at: Date.now(), text: clip(text, 400) });
    if (this.#errors.length > MAX_ERRORS) this.#errors = this.#errors.slice(-MAX_ERRORS);
  }

  #watchErrors() {
    window.addEventListener("error", (e) => {
      this.#note(`${e.message} @ ${e.filename}:${e.lineno}`);
    });
    window.addEventListener("unhandledrejection", (e) => {
      this.#note(`unhandled rejection: ${String((e as PromiseRejectionEvent).reason)}`);
    });
    const original = console.error;
    console.error = (...args: unknown[]) => {
      this.#note(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
      original(...args);
    };
  }

  async #attach() {
    const ep = await invoke<Endpoint | null>("control_endpoint").catch(() => null);
    if (!ep) return;
    this.endpoint = ep;

    this.#unlisten = await listen<{ rid: string; op: Op }>("control:op", async (e) => {
      /* A superseded instance must neither answer nor act. Silence is correct:
         the live instance is listening to the same event and will reply. */
      if (!this.current) {
        this.detach();
        return;
      }
      const { rid, op } = e.payload;
      let value: unknown;
      try {
        const name = String(op?.op ?? "");
        const fn = this.#ops[name];
        if (!fn) {
          value = {
            ok: false,
            error: `no op "${name}"`,
            ops: Object.keys(this.#ops).sort(),
          };
        } else {
          const result = await fn(op);
          await settle();
          value = { ok: true, ...(result && typeof result === "object" ? result : { result }) };
        }
      } catch (err) {
        value = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      /* Who answered. If this ever disagrees with `generation` from /health, a
         superseded studio is serving and nothing else in the reply is
         trustworthy — which took twenty minutes to work out the first time. */
      await invoke("control_reply", {
        rid,
        value: plain({ ...(value as object), gen: this.#gen }),
      }).catch(() => {});
    });

    /* Only now can an op be delivered, so only now do we admit to being here. */
    await invoke("control_attach", { generation: this.#gen }).catch(() => {});
  }

  /* ── lookups ─────────────────────────────────────────────────────────── */

  /** Find a card by id, by exact title, or by 1-based index on the wall.
   *  Tests read better as `{"card": "caravan"}` than as a pasted uuid. */
  #card(op: Op, key = "id"): Conversation {
    const want = op[key] ?? op.card ?? op.conversationId;
    const convs = this.#host.skein.convs;
    if (want === undefined || want === null) {
      const f = convs.find((c) => c.id === this.#host.focusedId());
      if (f) return f;
      throw new Error("no card named and none focused");
    }
    if (typeof want === "number") {
      const c = convs[want];
      if (!c) throw new Error(`no card at index ${want}`);
      return c;
    }
    const s = String(want);
    const hit =
      convs.find((c) => c.id === s) ??
      convs.find((c) => c.title === s) ??
      convs.find((c) => c.title.toLowerCase().includes(s.toLowerCase())) ??
      convs.find((c) => c.project.toLowerCase().includes(s.toLowerCase()));
    if (!hit) throw new Error(`no card matching "${s}"`);
    return hit;
  }

  #cards(op: Op): Conversation[] {
    const want = op.ids ?? op.cards;
    if (!Array.isArray(want)) return [this.#card(op)];
    return want.map((w) => this.#card({ id: w }));
  }

  #el(op: Op): HTMLElement {
    const sel = String(op.selector ?? "");
    if (!sel) throw new Error("no selector given");
    const all = document.querySelectorAll<HTMLElement>(sel);
    const at = Number(op.index ?? 0);
    const el = all[at];
    if (!el) {
      throw new Error(`selector "${sel}" matched ${all.length} elements, wanted #${at}`);
    }
    return el;
  }

  /* ── what the wall looks like right now ──────────────────────────────── */

  #snapshot() {
    const h = this.#host;
    return {
      focusedId: h.focusedId(),
      selected: [...h.studio.selected],
      draft: h.draft(),
      flags: h.flags(),
      loaded: h.skein.loaded,
      fault: h.skein.fault,
      /* Whether SKEIN_NO_SERVERS suppressed the eager start, so a test that
         finds every group idle can tell which kind of idle it is. */
      serversQuiet: h.skein.serversQuiet,
      spend: h.skein.spend,
      heldTokens: h.skein.heldTokens,
      live: h.skein.live,
      viewport: {
        x: h.studio.x,
        y: h.studio.y,
        scale: h.studio.scale,
        lod: h.studio.lod,
      },
      /** How the panel is set up to be read from. Both halves, and they are
       *  different claims: `reading` is the multiplier the studio holds,
       *  `linePx` is the size a line is actually drawn at. A `--read` that
       *  never reached a rule would leave the first one moving and the second
       *  one still. Null with no panel open, which is not the same as zero. */
      panel: {
        reading: readingScale(h.studio.readScale),
        linePx: (() => {
          const line = document.querySelector(".lines .line");
          if (!line) return null;
          const px = parseFloat(getComputedStyle(line).fontSize);
          return Number.isFinite(px) ? Math.round(px * 100) / 100 : null;
        })(),
      },
      projects: h.skein.projects.map((p) => ({
        id: p.id,
        name: p.name,
        root: p.root_path,
        /* Where the territory sits. Null means the grid is still deciding, which
           after a load should be true of nothing — see `#settlePlaces`. */
        x: p.x,
        y: p.y,
      })),
      cards: h.skein.convs.map((c) => ({
        id: c.id,
        /* Equal to `id` until the card is cleared, and the only way to see from
           outside that a clear actually repointed it. */
        sessionId: c.sessionId,
        project: c.project,
        cwd: c.cwd,
        worktree: c.worktree,
        title: c.title,
        tier: c.tier,
        activity: c.activity,
        dormant: c.dormant,
        /* What separates a crash from a card restored off disk — both are
           dormant, and only one of them is something to announce. */
        died: c.died,
        working: c.working,
        ending: c.ending,
        everSpoke: c.everSpoke,
        interrupted: c.interrupted,
        idleSeconds: c.idleSeconds,
        ctx: c.ctx,
        ctxTokens: c.ctxTokens,
        contextWindow: c.contextWindow,
        model: c.model ?? null,
        costUsd: c.costUsd,
        turns: c.turns,
        lastError: c.lastError,
        streaming: clip(c.streaming, 200),
        lineCount: c.lines.length,
        lastLine: c.lines.length ? clip(c.lines[c.lines.length - 1].text, 160) : null,
        pendingAsk: c.pendingAsk
          ? {
              askId: c.pendingAsk.askId,
              question: c.pendingAsk.question,
              options: c.pendingAsk.options.map((o) => o.label),
            }
          : null,
        seats: c.seats.map((s) => ({
          id: s.id,
          persona: s.persona,
          state: s.state,
          thought: clip(s.thought, 120),
          verdict: s.verdict,
        })),
        placement: h.studio.placements[c.id] ?? null,
      })),
      images: h.board.images.map((i) => ({
        id: i.id,
        path: i.path,
        x: i.x,
        y: i.y,
        w: i.w,
        h: i.h,
        rotation: i.rotation,
        z: i.z,
        selected: h.board.selected === i.id,
      })),
      /* The instruments, and whether anything is actually sampling for them.
         `sampling` is reported apart from the widget count for the same reason
         the ambience's `drawing` is: a meter on the wall with a dead sampler
         and one with a live one look identical from outside. */
      widgets: h.widgets.items.map((w) => ({
        id: w.id,
        kind: w.kind,
        variant: variantOf(w),
        config: { ...w.config },
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
        z: w.z,
        selected: h.widgets.selected === w.id,
      })),
      meter: {
        watchers: h.meter.watchers,
        sampling: !!h.meter.latest,
        at: h.meter.latest?.at ?? null,
        scope: h.meter.latest?.scope ?? null,
        procs: h.meter.latest?.procs.length ?? 0,
        fault: h.meter.fault,
      },
      /* What the wall is doing when nobody is asking it anything.
         `canvas` and `drawing` are reported apart on purpose: one is whether the
         backdrop is on the page at all, the other whether anything in the
         profile would paint. A canvas with a dead frame loop and a canvas
         clearing sixty times a second look identical from outside. */
      ambience: {
        activeId: h.ambience.activeId,
        active: h.ambience.active?.name ?? null,
        canvas: !!document.querySelector("canvas.backdrop"),
        drawing: living(h.ambience.active),
        profiles: h.ambience.profiles.map((p) => ({
          id: p.id,
          name: p.name,
          layers: p.layers.map((l) => ({
            id: l.id,
            kind: l.kind,
            on: l.on,
            opacity: l.opacity,
            params: { ...l.params },
          })),
        })),
      },
      /* What each territory offers, and how its last press of each verb went.
         Reported off the same `chipsFor` the wall draws from, so a test cannot
         pass against a vocabulary the chips never had. */
      actions: h.skein.projects.map((p) => ({
        root: p.root_path,
        facts: h.actions.facts[p.root_path] ?? null,
        status: h.actions.status[p.root_path] ?? null,
        chips: h.actions.chipsFor(p.root_path),
        runs: h.actions.recent(p.root_path).map((r) => ({
          id: r.id,
          action: r.action,
          state: r.state,
          pct: r.pct,
          note: r.note,
          logLines: r.log.length,
          lastLog: r.log.length ? clip(r.log[r.log.length - 1], 160) : null,
        })),
      })),
      groups: h.skein.groups.map((g) => ({
        id: g.group.id,
        label: g.group.label,
        projectId: g.group.project_id,
        running: g.running,
        overall: g.overall,
        health: { ...g.health },
        logLines: g.log.length,
        lastLog: g.log.length ? clip(g.log[g.log.length - 1].line, 160) : null,
      })),
      /* What the dock is offering for the draft as it stands, so a test can see
         the palette without reading the DOM. Empty for every draft that is not
         a bare slash-name — including `/commit`, which is the agent's command
         and is not Skein's to intercept. */
      commands: h.commands().map((c) => c.name),
      targets: h.targets().map((c) => c.id),
      waiting: h.waiting().map((c) => c.id),
      clashing: h.clashing(),
      blocked: h.skein.blocked.map((c) => c.id),
      /* One studio should hold one set of subscriptions. If these climb across
         an edit, a superseded generation is still listening — and still acting,
         which is how one `result` event became two `turn` rows. */
      listeners: {
        skein: h.skein.listenerCount,
        attention: h.attention.listenerCount,
        actions: h.actions.listenerCount,
      },
      attention: {
        windowFocused: h.attention.focused,
        chime: h.attention.chime,
        items: h.attention.items.map((i) => ({
          id: i.id,
          kind: i.kind,
          title: i.title,
          detail: clip(i.detail, 120),
          waitedSeconds: i.waitedSeconds,
        })),
      },
      /* What is actually on screen, as opposed to what state says. A card in
         the model but not in the DOM is a rendering bug the model can't see. */
      dom: {
        cardNodes: [...document.querySelectorAll<HTMLElement>("[data-conv]")].map((n) => {
          const r = n.getBoundingClientRect();
          const card = n.querySelector<HTMLElement>(".card");
          return {
            id: n.dataset.conv!,
            tier: card?.dataset.st ?? null,
            dormant: card?.hasAttribute("data-dormant") ?? null,
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
          };
        }),
        imageNodes: document.querySelectorAll("[data-image]").length,
        seatNodes: document.querySelectorAll("[data-seat]").length,
        transcriptOpen: !!document.querySelector(".side"),
        askOpen: !!document.querySelector(".ask"),
        /* A drag on the wall must be a gesture, never a text selection. That
           distinction is invisible to a synthetic pointer — only a real one
           makes Chromium start selecting — so the count is reported here rather
           than asserted anywhere in the app. */
        selectionChars: (window.getSelection()?.toString() ?? "").length,
        /* Where the keyboard is pointed. Typing on the wall is supposed to move
           it into the dock's field, and "the draft changed" alone would not
           show that focus went with it. */
        focusedTag: document.activeElement?.tagName ?? null,
      },
      errors: [...this.#errors],
    };
  }

  /* ── the vocabulary ──────────────────────────────────────────────────── */

  #table(): Record<string, Handler> {
    const h = this.#host;

    /** Emit an event the way Rust emits it, then let the UI settle. Going
     *  through Tauri rather than calling `ingest` directly is the whole point:
     *  the listener under test is the one the supervisor talks to. */
    const asRust = async (name: string, payload: unknown) => {
      await emit(name, payload);
      await settle();
    };

    return {
      /* ── reading ── */

      ops: () => ({ ops: Object.keys(this.#ops).sort() }),

      snapshot: () => this.#snapshot(),

      /** One card, in full — including its whole transcript.
       *
       *  `history` is reported apart from `lines` because that is how the card
       *  holds it: one comes off the file, the other off the wire, and a test
       *  that could not tell them apart could not see the scrollback appear. */
      card: (op) => {
        const c = this.#card(op);
        return {
          card: {
            ...this.#snapshot().cards.find((x) => x.id === c.id),
            /* `state` is reported only when a line has one, so a settled
               transcript reads exactly as it did before this existed — and an
               optimistic echo that never got claimed is visible from outside. */
            lines: c.lines.map((l) => ({
              kind: l.kind,
              text: clip(l.text, 400),
              ...(l.state ? { state: l.state } : {}),
            })),
            historyState: c.historyState,
            historyPartial: c.historyPartial,
            history: c.history.map((l) => ({ kind: l.kind, text: clip(l.text, 400) })),
          },
        };
      },

      /** Query the rendered page. Text, geometry, and computed styles, because
       *  "is the ring amber" is a question about paint, not about state. */
      dom: (op) => {
        const sel = String(op.selector ?? "");
        if (!sel) throw new Error("dom needs a selector");
        const nodes = [...document.querySelectorAll<HTMLElement>(sel)];
        const wanted: string[] = Array.isArray(op.styles) ? op.styles.map(String) : [];
        const read = (n: HTMLElement) => {
          const r = n.getBoundingClientRect();
          const cs = wanted.length ? getComputedStyle(n) : null;
          return {
            tag: n.tagName.toLowerCase(),
            classes: n.className?.toString() ?? "",
            text: clip((n.textContent ?? "").trim().replace(/\s+/g, " "), 240),
            data: { ...n.dataset },
            disabled: (n as HTMLButtonElement).disabled ?? null,
            visible: r.width > 0 && r.height > 0,
            rect: {
              x: Math.round(r.x),
              y: Math.round(r.y),
              w: Math.round(r.width),
              h: Math.round(r.height),
              cx: Math.round(r.x + r.width / 2),
              cy: Math.round(r.y + r.height / 2),
            },
            styles: cs
              ? Object.fromEntries(wanted.map((p) => [p, cs.getPropertyValue(p).trim()]))
              : undefined,
          };
        };
        return { count: nodes.length, nodes: nodes.slice(0, Number(op.limit ?? 25)).map(read) };
      },

      /** Poll the snapshot until a dotted path matches. Saves a caller from a
       *  sleep-and-hope loop over HTTP. */
      wait: async (op) => {
        const path = String(op.path ?? "");
        if (!path) throw new Error("wait needs a path, e.g. cards.0.tier");
        const deadline = Date.now() + Number(op.timeoutMs ?? 15000);
        const at = (o: any) =>
          path.split(".").reduce((v, k) => (v == null ? v : v[k]), o as any);
        const matches = (v: unknown) =>
          "equals" in op ? JSON.stringify(v) === JSON.stringify(op.equals) : !!v;

        let last: unknown;
        for (;;) {
          last = at(this.#snapshot());
          if (matches(last)) return { path, value: plain(last), waitedMs: 0 };
          if (Date.now() > deadline) {
            throw new Error(
              `timed out waiting for ${path} to be ${JSON.stringify(op.equals ?? "truthy")}; ` +
                `it is ${JSON.stringify(last)}`,
            );
          }
          await new Promise((r) => setTimeout(r, 120));
        }
      },

      /** Is the peek window actually up? The only question about attention that
       *  state can't answer, because showing it is a side effect. */
      peek: async () => {
        const { Window } = await import("@tauri-apps/api/window");
        const w = await Window.getByLabel("peek");
        return {
          exists: !!w,
          visible: (await w?.isVisible().catch(() => false)) ?? false,
          position: w ? await w.outerPosition().catch(() => null) : null,
          windowFocused: h.attention.focused,
          items: h.attention.items.length,
        };
      },

      "errors.clear": () => {
        this.#errors = [];
        return {};
      },

      /* ── the same gestures a hand makes ── */

      focus: (op) => {
        const c = this.#card(op);
        h.setFocused(c.id);
        h.studio.selectOnly(c.id);
        return { id: c.id };
      },

      select: (op) => {
        h.studio.selected = this.#cards(op).map((c) => c.id);
        return { selected: [...h.studio.selected] };
      },

      /** The gathering *and* the focus, because on the wall they are one
       *  gesture: a click on bare ground, or Escape. */
      deselect: () => {
        h.deselect();
        return { focusedId: h.focusedId(), selected: [...h.studio.selected] };
      },

      /** Press a project's chip — the same call the wall's own button makes,
       *  including its rule that a second press cancels a running one. */
      action: async (op) => {
        const root = String(op.project ?? op.cwd ?? op.root ?? "");
        const id = String(op.id ?? op.action ?? "");
        if (!root || !id) throw new Error("action needs a project and an id");
        /* Not awaited: a build takes minutes, and the op that starts it must
           not hold the socket for all of them. `wait` on the snapshot is how a
           test follows it — the same way it follows a turn. */
        void h.actions.run(root, id);
        await settle();
        return { root, id, state: h.actions.runOf(root, id)?.state ?? null };
      },

      "action.cancel": async (op) => {
        const root = String(op.project ?? op.cwd ?? op.root ?? "");
        const id = String(op.id ?? op.action ?? "");
        await h.actions.cancel(root, id);
        return { root, id, state: h.actions.runOf(root, id)?.state ?? null };
      },

      /** Re-read what every project is doing, rather than waiting out the poll. */
      "action.poll": async () => {
        await h.actions.poll();
        return { status: plain(h.actions.status) };
      },

      /** Fetch every git project now, rather than waiting out its five minutes.
       *  The fetch itself is fire-and-forget, so the status this answers with is
       *  from before it landed — `action.poll` again to see what it found. */
      "action.fetch": async () => {
        await h.actions.fetchNow();
        return { status: plain(h.actions.status) };
      },

      /** Press a torn territory's badge. Spawns a real agent and sends it a real
       *  prompt — the same seam the chip goes through, and the same cost. */
      "action.resolve": async (op) => {
        const root = String(op.project ?? op.cwd ?? op.root ?? "");
        if (!root) throw new Error("action.resolve needs a project");
        const before = new Set(h.skein.convs.map((c) => c.id));
        await h.resolveConflicts(root);
        await settle();
        const fresh = h.skein.convs.find((c) => !before.has(c.id));
        return { root, id: fresh?.id ?? null };
      },

      /** Open a conversation in a folder — the same call the folder picker and
       *  a dropped directory both land on. */
      open: async (op) => {
        const dir = String(op.dir ?? op.cwd ?? "");
        if (!dir) throw new Error("open needs a dir");
        const before = new Set(h.skein.convs.map((c) => c.id));
        await h.openIn(dir, op.worktree ? String(op.worktree) : undefined);
        await settle();
        const fresh = h.skein.convs.find((c) => !before.has(c.id));
        return { id: fresh?.id ?? null, fault: h.skein.fault };
      },

      /** Speak to one card. Wakes it if dormant, exactly as the dock does. */
      send: async (op) => {
        const c = this.#card(op);
        const text = String(op.text ?? "");
        if (!text) throw new Error("send needs text");
        await h.skein.send(c, text);
        return { id: c.id, dormant: c.dormant, fault: h.skein.fault };
      },

      /** End the turn a card is in the middle of, the way Escape and the dock's
       *  button both do. The card is still there afterwards — that is the half
       *  worth asserting, so the process is reported back alongside the tier. */
      stop: async (op) => {
        const c = this.#card(op);
        await h.skein.stop(c);
        return {
          id: c.id,
          working: c.working,
          dormant: c.dormant,
          tier: c.tier,
          ending: c.ending,
          fault: h.skein.fault,
        };
      },

      broadcast: async (op) => {
        const cards = this.#cards(op);
        const text = String(op.text ?? "");
        if (!text) throw new Error("broadcast needs text");
        await h.skein.broadcast(cards, text);
        return { ids: cards.map((c) => c.id), fault: h.skein.fault };
      },

      /** Type into the dock without sending — for testing the target readout,
       *  the Ctrl+Enter gate, and the placeholder. */
      type: (op) => {
        h.setDraft(String(op.text ?? ""));
        return { draft: h.draft() };
      },

      /** Submit the draft through the dock's own path, including its rule that
       *  a multi-card send needs the modifier. */
      submit: async (op) => {
        await h.submit(!!op.broadcast);
        return { draft: h.draft(), targets: h.targets().map((c) => c.id) };
      },

      /** Start a card over. The card keeps its id and its place; only the
       *  session behind it changes, which is what `sessionId` in the snapshot
       *  is there to show. */
      clear: async (op) => {
        const c = this.#card(op);
        const before = c.sessionId;
        await h.skein.clear(c);
        return {
          id: c.id,
          was: before,
          sessionId: c.sessionId,
          dormant: c.dormant,
          fault: h.skein.fault,
        };
      },

      close: async (op) => {
        const c = this.#card(op);
        await h.skein.close(c);
        return { closed: c.id, remaining: h.skein.convs.length };
      },

      answer: async (op) => {
        const c = this.#card(op);
        if (!c.pendingAsk) throw new Error(`${c.title} is not waiting on an answer`);
        await h.skein.answerAsk(c, String(op.text ?? op.answer ?? ""));
        return { id: c.id };
      },

      /* ── standing in for the supervisor ──────────────────────────────
       *
       * These emit the events Rust emits. Nothing here fakes card state; it
       * feeds the wire and lets the fold do its work. That makes a whole
       * committee, a context ring at 91%, or a crashed turn reachable in a
       * millisecond and for no tokens. */

      feed: async (op) => {
        const c = this.#card(op);
        const events: unknown[] = Array.isArray(op.events)
          ? op.events
          : op.event !== undefined
            ? [op.event]
            : [];
        if (!events.length) throw new Error("feed needs `event` or `events`");
        for (const event of events) {
          await asRust("conv:event", { id: c.id, event });
        }
        return { id: c.id, fed: events.length, tier: c.tier, activity: c.activity };
      },

      stderr: async (op) => {
        const c = this.#card(op);
        await asRust("conv:stderr", { id: c.id, line: String(op.line ?? "") });
        return { id: c.id };
      },

      exit: async (op) => {
        const c = this.#card(op);
        const code = op.code === null ? null : Number(op.code ?? 0);
        await asRust("conv:exit", { id: c.id, code });
        return { id: c.id, dormant: c.dormant, tier: c.tier };
      },

      /** Park a question on a card without an agent to ask it. The real MCP
       *  path is reachable too — /health reports `mcpPort`, and POSTing a
       *  `tools/call` to /mcp/<id> there exercises the whole round trip. */
      ask: async (op) => {
        const c = this.#card(op);
        const askId = op.askId ? String(op.askId) : crypto.randomUUID();
        await asRust("ask:opened", {
          conversation_id: c.id,
          ask_id: askId,
          question: String(op.question ?? "Which way?"),
          options: Array.isArray(op.options)
            ? op.options.map((o: any) =>
                typeof o === "string" ? { label: o } : { label: String(o.label), detail: o.detail ?? null },
              )
            : [],
        });
        return { id: c.id, askId, tier: c.tier };
      },

      "server.log": async (op) => {
        await asRust("server:log", {
          group_id: String(op.groupId ?? ""),
          label: String(op.label ?? ""),
          line: String(op.line ?? ""),
          stderr: !!op.stderr,
        });
        return {};
      },

      "server.state": async (op) => {
        await asRust("server:state", {
          group_id: String(op.groupId ?? ""),
          label: String(op.label ?? ""),
          state: String(op.state ?? "up"),
        });
        return {};
      },

      "server.toggle": async (op) => {
        const g = h.skein.groups.find(
          (g) => g.group.id === op.groupId || g.group.label === op.label,
        );
        if (!g) throw new Error("no such server group");
        await (g.running ? h.skein.stopGroup(g) : h.skein.startGroup(g));
        return { id: g.group.id, running: g.running };
      },

      /* ── the wall itself ── */

      /** A dropped file, delivered the way the OS delivers it — including the
       *  physical-pixel payload, so the DPI conversion is under test too. */
      drop: async (op) => {
        const paths: string[] = Array.isArray(op.paths)
          ? op.paths.map(String)
          : op.path
            ? [String(op.path)]
            : [];
        if (!paths.length) throw new Error("drop needs `path` or `paths`");
        const dpr = window.devicePixelRatio || 1;
        /* The caller thinks in CSS pixels; the OS payload is physical. */
        const x = Number(op.x ?? window.innerWidth / 2);
        const y = Number(op.y ?? window.innerHeight / 2);
        await emit("tauri://drag-drop", {
          paths,
          position: { x: Math.round(x * dpr), y: Math.round(y * dpr) },
        });
        /* A drop imports files and may spawn a process; give it real time. */
        await new Promise((r) => setTimeout(r, Number(op.settleMs ?? 900)));
        await settle();
        return {
          images: h.board.images.length,
          cards: h.skein.convs.length,
          fault: h.skein.fault ?? h.board.fault,
        };
      },

      "image.add": async (op) => {
        const at = h.canvas()?.toCanvas(Number(op.x ?? 300), Number(op.y ?? 300)) ?? {
          x: Number(op.x ?? 300),
          y: Number(op.y ?? 300),
        };
        const img = await h.board.add(String(op.path ?? ""), at.x, at.y);
        return { id: img?.id ?? null, fault: h.board.fault };
      },

      "image.update": (op) => {
        const id = String(op.id ?? h.board.selected ?? "");
        const patch: Record<string, number> = {};
        for (const k of ["x", "y", "w", "h", "rotation", "z"]) {
          if (op[k] !== undefined) patch[k] = Number(op[k]);
        }
        h.board.update(id, patch);
        return { id, patch };
      },

      "image.remove": async (op) => {
        const id = String(op.id ?? h.board.selected ?? "");
        await h.board.remove(id);
        return { id, remaining: h.board.images.length };
      },

      "image.select": (op) => {
        h.board.selected = op.id ? String(op.id) : null;
        return { selected: h.board.selected };
      },

      /* ── the instruments ──────────────────────────────────────────────
       *
       * The same four verbs an image has, because they are the same kind of
       * thing to the wall. `widget.set` goes through `Widgets.set`, which is
       * what the menu calls — an op that wrote the config object itself could
       * pass a variant the catalogue has never heard of and prove nothing. */
      "widget.add": async (op) => {
        const at = h.canvas()?.toCanvas(Number(op.x ?? 300), Number(op.y ?? 300)) ?? {
          x: Number(op.x ?? 300),
          y: Number(op.y ?? 300),
        };
        const w = await h.widgets.add(String(op.kind ?? "clock") as WidgetKind, at.x, at.y);
        return { id: w?.id ?? null, kind: w?.kind ?? null, fault: h.widgets.fault };
      },

      "widget.set": (op) => {
        const id = String(op.id ?? h.widgets.selected ?? "");
        const key = String(op.key ?? "variant");
        h.widgets.set(id, key, op.value as string | number | boolean);
        const w = h.widgets.items.find((w) => w.id === id);
        if (!w) throw new Error(`no widget ${id}`);
        /* What it *became*, not what was asked for: the config is normalised on
           the way back off disk, so an unknown value has to be visible here. */
        return { id, config: { ...w.config } };
      },

      "widget.update": (op) => {
        const id = String(op.id ?? h.widgets.selected ?? "");
        const patch: Record<string, number> = {};
        for (const k of ["x", "y", "w", "h", "z"]) {
          if (op[k] !== undefined) patch[k] = Number(op[k]);
        }
        h.widgets.update(id, patch);
        return { id, patch };
      },

      "widget.remove": async (op) => {
        const id = String(op.id ?? h.widgets.selected ?? "");
        await h.widgets.remove(id);
        return { id, remaining: h.widgets.items.length };
      },

      "widget.select": (op) => {
        h.widgets.selected = op.id ? String(op.id) : null;
        return { selected: h.widgets.selected };
      },

      /** Take a project off the wall — the same call the territory's menu
       *  makes. The suite needs it: now that a territory outlives its last
       *  card, a test run would leave one behind every time. */
      forget: async (op) => {
        const cwd = String(op.cwd ?? "");
        if (!cwd) throw new Error("forget needs a cwd");
        const gone = await h.skein.forgetProject(cwd);
        return { cwd, gone, fault: h.skein.fault };
      },

      /** Pin a card at a canvas position — the same two calls a drag makes when
       *  it lets go, so a wall can be arranged without lending out the mouse.
       *  Not a parallel path: `real.drag` ends in exactly these. */
      pin: async (op) => {
        const c = this.#card(op);
        const x = Number(op.x ?? 0);
        const y = Number(op.y ?? 0);
        h.studio.pin(c.id, x, y);
        await h.skein.savePlacement(c.id, x, y, true);
        await settle();
        return { id: c.id, placement: h.studio.placements[c.id] ?? null };
      },

      /** Put a territory somewhere — the same call the drag makes when it lets
       *  go. Omitting x and y hands it back to the grid, as the territory menu's
       *  "tidy back onto the grid" does. The cards it carries are moved by the
       *  drag itself, so this op moves the territory and nothing else. */
      place: async (op) => {
        const cwd = String(op.cwd ?? op.root ?? "");
        if (!cwd) throw new Error("place needs a cwd");
        const x = op.x === undefined || op.x === null ? null : Number(op.x);
        const y = op.y === undefined || op.y === null ? null : Number(op.y);
        h.skein.placeProject(cwd, x, y);
        await settle();
        return {
          cwd,
          project: this.#snapshot().projects.find((p) => p.root === cwd) ?? null,
        };
      },

      /* ── the wall's ambience ──────────────────────────────────────────
       *
       * The same calls the panel's own controls make, which is the whole rule
       * here: no op reaches past the class into the renderer. A test can only
       * ask for what a hand could ask for, and then read `snapshot.ambience`
       * for what the wall says it is doing. */

      /** Show a profile — by id, by name, or `null` for a bare wall. */
      "ambience.use": async (op) => {
        const want = op.id ?? op.profile ?? op.name ?? null;
        let id: string | null = null;
        if (want !== null && want !== undefined) {
          const s = String(want);
          const hit =
            h.ambience.profiles.find((p) => p.id === s) ??
            h.ambience.profiles.find((p) => p.name === s) ??
            h.ambience.profiles.find((p) => p.name.toLowerCase().includes(s.toLowerCase()));
          if (!hit) throw new Error(`no ambience profile matching "${s}"`);
          id = hit.id;
        }
        await h.ambience.use(id);
        return { activeId: h.ambience.activeId, drawing: living(h.ambience.active) };
      },

      "ambience.profile": async (op) => {
        const what = String(op.do ?? "create");
        if (what === "create") {
          const p = await h.ambience.create(String(op.name ?? "new profile"));
          return { id: p.id, name: p.name };
        }
        if (what === "duplicate") {
          const p = await h.ambience.duplicate(String(op.id ?? h.ambience.activeId ?? ""));
          return { id: p?.id ?? null, name: p?.name ?? null };
        }
        if (what === "rename") {
          const id = String(op.id ?? h.ambience.activeId ?? "");
          h.ambience.rename(id, String(op.name ?? ""));
          return { id, name: h.ambience.profiles.find((p) => p.id === id)?.name ?? null };
        }
        if (what === "delete") {
          const id = String(op.id ?? h.ambience.activeId ?? "");
          await h.ambience.destroy(id);
          return { deleted: id, remaining: h.ambience.profiles.length };
        }
        throw new Error(`ambience.profile: no such thing as "${what}"`);
      },

      /** Add, remove, reorder, switch off, or turn one knob of a layer on the
       *  profile that is showing. */
      "ambience.layer": (op) => {
        const a = h.ambience;
        const active = a.active;
        if (!active) throw new Error("no ambience profile is showing");
        const what = String(op.do ?? "add");

        if (what === "add") {
          a.addLayer(String(op.kind ?? "swirls") as EffectKind);
          return { layers: active.layers.map((l) => ({ id: l.id, kind: l.kind })) };
        }
        /* By id, or by kind — a test reads better as `{"layer": "leaves"}` than
           as a uuid it had to fish out of a snapshot first. */
        const want = String(op.id ?? op.layer ?? op.kind ?? "");
        const l =
          active.layers.find((x) => x.id === want) ??
          active.layers.find((x) => x.kind === want);
        if (!l) throw new Error(`no layer matching "${want}"`);

        if (what === "remove") a.removeLayer(l.id);
        else if (what === "move") a.moveLayer(l.id, Number(op.by ?? 1));
        else if (what === "reset") a.resetLayer(l.id);
        else if (what === "set") {
          const patch: { on?: boolean; opacity?: number } = {};
          if (op.on !== undefined) patch.on = !!op.on;
          if (op.opacity !== undefined) patch.opacity = Number(op.opacity);
          a.setLayer(l.id, patch);
        } else if (what === "param") {
          const key = String(op.key ?? "");
          if (!key) throw new Error("ambience.layer param needs a key");
          a.setParam(l.id, key, Number(op.value));
        } else throw new Error(`ambience.layer: no such thing as "${what}"`);

        return {
          layers: a.active?.layers.map((x) => ({
            id: x.id,
            kind: x.kind,
            on: x.on,
            opacity: x.opacity,
            params: { ...x.params },
          })),
        };
      },

      viewport: (op) => {
        if (op.x !== undefined) h.studio.x = Number(op.x);
        if (op.y !== undefined) h.studio.y = Number(op.y);
        if (op.scale !== undefined) h.studio.scale = Number(op.scale);
        return { viewport: { x: h.studio.x, y: h.studio.y, scale: h.studio.scale, lod: h.studio.lod } };
      },

      fit: () => {
        h.canvas()?.fitAll();
        return { viewport: { x: h.studio.x, y: h.studio.y, scale: h.studio.scale, lod: h.studio.lod } };
      },

      flag: (op) => {
        const name = String(op.name ?? "");
        if (op.value !== undefined) h.setFlag(name, !!op.value);
        return { flags: h.flags() };
      },

      /* ── input ── */

      /** A wheel over the wall, at a point in the surface.
       *
       *  Non-passive by necessity on the app's side, so this dispatches a real
       *  `WheelEvent` at the element the listener is bound to and lets the same
       *  handler decide what it means. `shift` is what separates panning from
       *  zooming — see the note in Canvas.svelte.
       *
       *  `target: "panel"` aims it at the transcript instead, which is the
       *  other surface with a hand-bound non-passive wheel listener and which
       *  reads it the other way round: ctrl resizes the reading, bare scrolls.
       *  Same op rather than a second one, because it is the same gesture at a
       *  different address — and it goes through the real listener rather than
       *  setting the size, so a `--read` that never reached the column would
       *  still show up as a failure. */
      wheel: async (op) => {
        const panel = op.target === "panel";
        const el = document.querySelector<HTMLElement>(panel ? ".detail" : ".surface");
        if (!el) {
          throw new Error(
            panel ? "no transcript panel to wheel over" : "no wall surface to scroll over",
          );
        }
        const r = el.getBoundingClientRect();
        el.dispatchEvent(
          new WheelEvent("wheel", {
            deltaX: Number(op.dx ?? 0),
            deltaY: Number(op.dy ?? 0),
            clientX: r.left + Number(op.x ?? r.width / 2),
            clientY: r.top + Number(op.y ?? r.height / 2),
            shiftKey: !!op.shift,
            ctrlKey: !!op.ctrl,
            bubbles: true,
            cancelable: true,
          }),
        );
        await settle();
        const s = h.studio;
        return {
          viewport: { x: s.x, y: s.y, scale: s.scale, lod: s.lod },
          reading: readingScale(s.readScale),
        };
      },

      /** Right-click something, and report what the wall offered instead of
       *  Chromium's menu.
       *
       *  `defaultPrevented` is the interesting half: it is the only way from
       *  out here to see that the native menu was suppressed, since the menu
       *  itself is drawn by the OS and is invisible to the DOM. An empty
       *  `items` with `defaultPrevented` true is the correct answer for a
       *  target with nothing to offer — see menu.ts. */
      menu: async (op) => {
        const el = this.#el(op);
        const r = el.getBoundingClientRect();
        const ev = new MouseEvent("contextmenu", {
          clientX: op.x !== undefined ? Number(op.x) : r.x + r.width / 2,
          clientY: op.y !== undefined ? Number(op.y) : r.y + r.height / 2,
          button: 2,
          buttons: 2,
          bubbles: true,
          cancelable: true,
        });
        el.dispatchEvent(ev);
        await settle();
        return {
          defaultPrevented: ev.defaultPrevented,
          open: !!document.querySelector(".menu"),
          items: [...document.querySelectorAll<HTMLElement>("[data-menu]")].map(
            (n) => n.dataset.menu,
          ),
        };
      },

      /** A synthetic click. Proves the handlers are connected; proves nothing
       *  about how Chromium routes a real one. Use real.click for that. */
      click: (op) => {
        const el = this.#el(op);
        el.click();
        return { clicked: el.className?.toString() ?? el.tagName };
      },

      key: (op) => {
        const target: EventTarget =
          op.selector ? this.#el(op) : (document.querySelector("textarea") ?? window);
        const ev = new KeyboardEvent("keydown", {
          key: String(op.key ?? "Enter"),
          ctrlKey: !!op.ctrl,
          shiftKey: !!op.shift,
          metaKey: !!op.meta,
          bubbles: true,
          cancelable: true,
        });
        target.dispatchEvent(ev);
        return { key: String(op.key ?? "Enter"), defaultPrevented: ev.defaultPrevented };
      },

      /** The real cursor, the real button. Aim by selector or by CSS point. */
      "real.click": async (op) => {
        const p = op.selector
          ? (() => {
              const r = this.#el(op).getBoundingClientRect();
              if (r.width === 0 || r.height === 0) {
                throw new Error(`"${op.selector}" has no box — nothing to aim at`);
              }
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            })()
          : { x: Number(op.x), y: Number(op.y) };
        await invoke("control_real_click", { x: p.x, y: p.y, restore: !!op.restore });
        await settle();
        return { at: { x: Math.round(p.x), y: Math.round(p.y) } };
      },

      /** Hover, then aim: a control that only exists on hover needs the mouse
       *  parked over its parent before its box is real. */
      "real.hover": async (op) => {
        const r = this.#el(op).getBoundingClientRect();
        await invoke("control_real_click", {
          x: r.x + r.width / 2,
          y: r.y + r.height / 2,
          restore: false,
        });
        await settle();
        return { at: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } };
      },

      "real.drag": async (op) => {
        const p = op.selector
          ? (() => {
              const r = this.#el(op).getBoundingClientRect();
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            })()
          : { x: Number(op.x), y: Number(op.y) };
        await invoke("control_real_drag", {
          x: p.x,
          y: p.y,
          dx: Number(op.dx ?? 0),
          dy: Number(op.dy ?? 0),
          steps: Number(op.steps ?? 12),
          /** "right" pans the wall too — and must not leave a menu behind. */
          button: op.button ? String(op.button) : null,
        });
        await settle();
        return { from: { x: Math.round(p.x), y: Math.round(p.y) }, dx: op.dx ?? 0, dy: op.dy ?? 0 };
      },
    };
  }
}
