<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { getCurrentWebview } from "@tauri-apps/api/webview";
  import { invoke } from "@tauri-apps/api/core";
  import { open as openDialog } from "@tauri-apps/plugin-dialog";
  import type { Conversation } from "./lib/conversation.svelte";
  import { clock } from "./lib/conversation.svelte";
  import { Attention } from "./lib/attention.svelte";
  import type { Tier } from "./lib/classify";
  import {
    READ_REST,
    Studio,
    layout,
    panelWidth,
    readingScale,
  } from "./lib/studio.svelte";
  import { Skein, type Session } from "./lib/skein.svelte";
  import { Board } from "./lib/images.svelte";
  import { Widgets } from "./lib/widgets.svelte";
  import { Meter } from "./lib/meter.svelte";
  import { Ledger } from "./lib/ledger.svelte";
  import { DevOps } from "./lib/devops.svelte";
  import { Cycle } from "./lib/cycle.svelte";
  import {
    WIDGETS,
    limitIn,
    optionFor,
    optionsOf,
    runIn,
    variantsOf,
    VARIANT,
    type WidgetKind,
  } from "./lib/widgets";
  import {
    CADENCES,
    PERS,
    lengthLabel,
    overrun,
    said,
    standing,
  } from "./lib/timing";
  import Rest from "./lib/Rest.svelte";
  import { Ambience } from "./lib/ambience.svelte";
  import { Actions, conflictBadge, conflictPrompt, NO_STATUS } from "./lib/actions.svelte";
  import { Control } from "./lib/control.svelte";
  import { ink } from "./lib/theme.svelte";
  import Canvas from "./lib/Canvas.svelte";
  import Ask from "./lib/Ask.svelte";
  import ContextMenu from "./lib/ContextMenu.svelte";
  import Effects from "./lib/Effects.svelte";
  import Import from "./lib/Import.svelte";
  import Themes from "./lib/Themes.svelte";
  import {
    cliCommand,
    completionFor,
    completionForChoice,
    matchChoices,
    matchCommands,
    resolveCommand,
    typingChoice,
    typingName,
    type Command,
  } from "./lib/commands";
  import { menuFor, type MenuItem, type MenuTarget } from "./lib/menu";
  import { spotOf } from "./lib/glass";
  import { selectionMarkdown } from "./lib/copy";
  import { displayName, nameBesideProject } from "./lib/naming";
  import { Drafts } from "./lib/drafts";
  import Transcript from "./lib/Transcript.svelte";
  import Servers from "./lib/Servers.svelte";
  /* The component is `Console` and the class it draws is `Shell`, which is not
     a whim: a `.svelte.ts` module and a `.svelte` component of the same name
     are one file to a case-insensitive filesystem, and TypeScript says so. The
     same split `cycle.svelte.ts` and `Pomodoro.svelte` already have. */
  import Console from "./lib/Console.svelte";
  import { Shell } from "./lib/shell.svelte";
  /* `!` in the dock: a shell line where a prompt goes. `bang.ts` is the pure
     half — what a draft means, how the line is coloured, where a completion
     lands — and `Bang` is the session behind it. See `.claude/rules/bang.md`. */
  import { Bang } from "./lib/bang.svelte";
  import {
    BANG,
    type Completion,
    type Match,
    applyCompletion,
    bangOf,
    commandCursor,
    isBang,
    kindLabel,
    tokens,
  } from "./lib/bang";
  import { activeShellKey, promptPath } from "./lib/shell";
  import WindowControls from "./lib/WindowControls.svelte";

  const studio = new Studio();
  const skein = new Skein(studio);
  const board = new Board();
  const widgets = new Widgets();
  /* One stacking order for the whole wall (see layout.ts), so each of the two
     hand-placed things has to be able to see the other's z — otherwise "bring
     to front" would only mean "in front of the other clocks". */
  board.others = () => widgets.items.map((w) => w.z);
  widgets.others = () => board.images.map((i) => i.z);
  /* The process sampler. Idle — and holding nothing — until a performance
     widget attaches to it. */
  const meter = new Meter();
  /* The transcript reader behind the usage widget. Idle — and reading nothing —
     until one attaches, which matters more here than for the sampler: the first
     reading walks every session file written in the past week. */
  const ledger = new Ledger();
  /* The one connection to Azure DevOps, behind however many pipelines and
     reviews widgets are up. Idle — and holding no credential — until one of them
     attaches, which matters more here than for either of the other two: this is
     the only thing in the app besides `git fetch` that leaves the machine, and a
     wall nobody is looking at must not be polling a corporate server. */
  const devops = new DevOps();
  /* Which organisations to ask about, read off the wall rather than configured:
     the AzDO orgs worth watching are the ones whose repos are standing on it.
     Injected as a function, the way `Cycle.watched` and `Widgets.others` are, so
     opening a folder brings its org into the reading on the next tick with
     nothing to re-wire. */
  devops.roots = () => skein.projects.map((p) => p.root_path);
  /* The studio's one pomodoro cycle. Not a widget's state — hang two pomodoro
     widgets up and they are two readings of one afternoon, and the break it
     enforces has to outlive every view of it. See `pomodoro.svelte.ts`. */
  const pomodoro = new Cycle();
  /* A cycle runs only while something on the wall is showing it — the same rule
     the process sampler has, and for the same reason: an instrument you took
     down should not still be running the room, least of all one whose breaks
     take the whole window. Removing the last view pauses rather than ends, so
     hanging one back up picks the same phase up where it was. */
  pomodoro.watched = () => widgets.has("pomodoro");
  /* The wall's own weather. Owns no subscriptions, so unlike the four below it
     needs nothing releasing on destroy. */
  const ambience = new Ambience();
  /* The shell behind Alt+I. Holds subscriptions and a batch timer, so it is
     released on destroy with the rest of them — and it holds a *process*, which
     the panel being toggled shut deliberately does not end. */
  const shell = new Shell();

  /* The `!` line. Given a way to find a card and a way to say something to one,
     rather than the whole of `Skein` — the same injection `devops.roots` and
     `widgets.others` use, and it keeps `bang.svelte.ts` unable to reach the
     wall. */
  const bang = new Bang(
    (id) => skein.convs.find((c) => c.id === id) ?? null,
    (conv, text) => skein.send(conv, text),
  );
  /* Project verbs. Its faults go to the same red bar everything else's do —
     a build that failed is not a different kind of news from a spawn that did. */
  const actions = new Actions((message) => (skein.fault = message));
  const attention = new Attention(
    () => skein.convs,
    (id) => {
      /* The peek can now point at an instrument as well as a card, and they are
         reached differently: a widget has no transcript to open and is not in
         the layout, so it is selected and panned to rather than focused. */
      if (widgets.items.some((w) => w.id === id)) {
        widgets.selected = id;
        board.selected = null;
        canvas?.revealWidget(id);
        return;
      }
      focusedId = id;
      studio.selectOnly(id);
    },
    () => rungTimers(),
  );

  /** Countdowns that have run out, as things wanting your attention.
   *
   *  Built here rather than in `attention.svelte.ts` because it needs the
   *  catalogue's vocabulary, and rebuilt on the clock like everything else the
   *  peek reads. `project` is the small-caps label the peek prints, so it says
   *  what kind of instrument rang; `title` is what it was set for. */
  function rungTimers() {
    const now = clock.t;
    const out = [];
    for (const w of widgets.items) {
      if (w.kind !== "timer") continue;
      const limit = limitIn(w);
      if (limit === null) continue;
      const run = runIn(w);
      if (standing(run, limit, now) !== "rung") continue;
      out.push({
        id: w.id,
        project: "timer",
        title: lengthLabel(String(w.config.length ?? "")),
        kind: "rang" as const,
        detail: "time is up",
        waitedSeconds: Math.floor(overrun(run, limit, now)),
      });
    }
    return out;
  }

  /* These three own Tauri subscriptions and have no lifecycle of their own, so
     this component's is the one that has to release them. In dev that is not a
     nicety: Vite destroys and rebuilds App on every edit, and a superseded Skein
     goes on ingesting events and writing rows for a wall nobody can see — one
     `result` used to become two `turn` rows, one per generation. */
  onDestroy(() => {
    skein.detach();
    attention.detach();
    actions.detach();
    control.detach();
    shell.detach();
    bang.detach();
    /* Not a subscription but the same hazard: a superseded generation's sampler
       would go on enumerating every process on the machine every two seconds
       for a wall nobody can see. */
    meter.stop();
    ledger.stop();
    devops.stop();
  });

  /* Learn what each territory can do, and forget the ones that leave.
     `sync` is deliberately not called from inside the tracking scope: it reads
     `actions.facts` to decide what still needs probing and writes it when the
     answer comes back, which read synchronously here would be an effect that
     retriggers itself forever. */
  $effect(() => {
    const roots = skein.projects.map((p) => p.root_path);
    void Promise.resolve().then(() => actions.sync(roots));
  });

  /* One tick drives the peek: the clock already ticks for urgency decay, so
     reading it here means the peek reacts to a card going overdue without a
     second timer. */
  $effect(() => {
    void clock.t;
    void attention.items.length;
    void attention.focused;
    void attention.sync();
  });

  let canvas = $state<ReturnType<typeof Canvas> | undefined>();
  /** The open panel, for the keys that move the reading. Undefined whenever
   *  there is no card focused, which is what makes those keys a no-op there
   *  without anything having to ask. */
  let transcript = $state<ReturnType<typeof Transcript> | undefined>();
  let showDetail = $state(true);
  let showServers = $state(false);
  let showEffects = $state(false);
  let focusedId = $state<string | null>(null);
  /** The field's text — whatever card is holding it. Everything in the dock
   *  reads and writes this one; `drafts` is only the parking, and swaps it out
   *  from under the field when the focus moves. */
  let draft = $state("");
  /** Every other card's unsent line, and the wall's own. See `drafts.ts`: one
   *  field over a wall of cards is one Enter away from saying what you wrote at
   *  one of them to another, and the parking is what stops it. */
  const drafts = new Drafts();
  /* The whole of the per-card behaviour, in the one place the focus is known to
     have moved. Deliberately an effect rather than something `focusCard` does:
     the focus is set from a dozen places — the wall, Tab, the attention list,
     opening a card, closing one — and a rule with a dozen call sites is a rule
     with one that forgot.

     `draft` is read untracked, or this would re-run on every keystroke and the
     swap would be a function of what you are typing rather than of where you
     are. */
  $effect(() => {
    const id = focusedId;
    if (drafts.holds(id)) return;
    draft = drafts.switchTo(id, untrack(() => draft));
    /* A dismissal belongs to the draft it was made over, and a new draft has
       not been dismissed. Both flags are reset by their own effects when the
       text stops looking like a command or a shell line, so the only case left
       for here is the one they cannot see: landing on a card whose draft looks
       like exactly the same thing the last one did. */
    bangOff = false;
    commandsOff = false;
    commandAt = 0;
  });
  /** The dock's field, so typing on the wall can hand it the keystroke. */
  let prompt: HTMLTextAreaElement | undefined = $state();
  let spawning = $state(false);

  const focused = $derived(skein.convs.find((c) => c.id === focusedId) ?? null);

  /** The project whose card you touched last, which is the one whose shell the
   *  panel shows. Sticky: letting go of the wall — Escape, the ground click,
   *  closing the card — is not a statement about which shell you wanted, and a
   *  panel that snapped back to the first project every time you deselected
   *  would be one you could not leave pointing anywhere.
   *
   *  Chat cards do not move it. A chat card stands in a folder of Skein's own
   *  and has no project at all (`kind`), so following one would open a `pwsh`
   *  in the directory beside the database — a shell whose first command would
   *  have to be `cd` somewhere else. */
  let lastTouched = $state<string | null>(null);
  $effect(() => {
    const conv = focused;
    if (conv && conv.kind === "project") lastTouched = conv.cwd;
  });

  /* The panel follows the wall, open or shut.
     Which project is active is tracked either way — the shell's own verbs
     (stop, clear, close) act on it, and with the panel down they would
     otherwise have nothing to act on. It is `select` that declines to *start*
     anything while the panel is shut, so clicking past five cards does not
     leave five shells reading five profiles.

     Nothing to follow until the wall has been painted, and the guard is what
     keeps the `.` fallback out of the session list: that fallback belongs to
     Alt+I on an empty wall — a shell somewhere rather than no shell at all —
     and is not a project this should file a record under before `load` has
     said what the projects are. */
  $effect(() => {
    void shell.open;
    if (skein.projects.length) void shell.select(shellCwd());
  });

  /* Paint the wall from disk, then start the servers. Deliberately no agent. */
  $effect(() => {
    void skein.load();
    void board.load();
    void widgets.load();
    void ambience.load();
    void pomodoro.load();
  });

  /* The instruments run off the same one-second tick everything else does: the
     cycle's phase machine steps here, the running timers write down what they
     have earned about once a minute, and the day's spend notices midnight
     going past. All three are cheap when nothing has changed, and none of them
     is a second wake-up on an idle machine.

     `untrack` because all of them *write* — the cycle is `$state`, a beat
     patches a widget's config, and a rollover re-reads the figure — and an
     effect that re-ran on what it had just written would never stop. The clock
     is the only thing it may depend on. */
  $effect(() => {
    const t = clock.t;
    untrack(() => {
      pomodoro.tick(t);
      widgets.beat(t);
      skein.dayTick(t);
    });
  });

  /* Throw things at the wall and it works out what you meant: a folder becomes
     a conversation, an image gets pinned up. Tauri hands us real filesystem
     paths, so both are imports rather than browser blobs. */
  $effect(() => {
    const un = getCurrentWebview().onDragDropEvent(async (e) => {
      if (e.payload.type !== "drop") return;
      /* The payload carries a PHYSICAL pixel position; getBoundingClientRect
         works in CSS pixels. On a 150% display those differ by 1.5×, so
         skipping this makes every drop land well off from where you aimed. */
      const dpr = window.devicePixelRatio || 1;
      const at = canvas?.toCanvas(
        e.payload.position.x / dpr,
        e.payload.position.y / dpr,
      );

      const sorted = await invoke<{ dirs: string[]; images: string[] }>(
        "classify_drop",
        { paths: e.payload.paths },
      );

      for (const dir of sorted.dirs) await openIn(dir);

      if (!at) return;
      let { x, y } = at;
      for (const path of sorted.images) {
        await board.add(path, x, y);
        /* Stagger a multi-file drop so they land as a small stack rather than
           perfectly on top of each other. */
        x += 28;
        y += 28;
      }
    });
    return () => {
      void un.then((f) => f());
    };
  });

  /* How loudly each tier is asking. Drives the Tab order and the count in the
     dock, so "what wants me" is defined in exactly one place — and, because
     Tab falls back to the wall when this list is empty, it also decides which
     of the two things Tab means at any moment. Ctrl+Tab walks the whole wall in
     reading order (`cycleConv`) — that is a navigation gesture and has nothing
     to do with urgency.

     A card you have set aside needs nothing here, deliberately: it is folded
     into `urgencyFor`, so it reads `rest` and falls out of this by the same
     rule everything else does. Filtering it out here instead would leave it
     out of the cycle while still blooming amber on the wall. */
  const URGENCY: Record<Tier, number> = {
    fail: 3,
    ask: 2,
    soft: 1,
    rest: 0,
    work: 0,
  };
  const waiting = $derived(
    skein.convs
      .filter((c) => !c.working && !c.dormant && URGENCY[c.tier] > 0)
      .sort(
        (a, b) => URGENCY[b.tier] - URGENCY[a.tier] || b.idleSeconds - a.idleSeconds,
      ),
  );

  /** Open a conversation somewhere. Nobody should ever type a path to do this:
   *  you either drop a folder on the wall, add one to a territory you already
   *  have, or pick a folder the way you pick a folder. */
  async function openIn(dir: string, worktree?: string) {
    if (spawning) return null;
    spawning = true;
    const conv = await skein.open(dir, worktree);
    if (conv) {
      focusedId = conv.id;
      studio.selectOnly(conv.id);
    }
    spawning = false;
    return conv;
  }

  /** A card with no project and no reach onto this machine — see
   *  `Skein.openChat`. Guarded by the same `spawning` latch as `openIn`, since
   *  both cost a process and a double click on either should cost one card. */
  async function openChat() {
    if (spawning) return null;
    spawning = true;
    const conv = await skein.openChat();
    if (conv) {
      focusedId = conv.id;
      studio.selectOnly(conv.id);
    }
    spawning = false;
    return conv;
  }

  /** Put an agent on a half-finished merge.
   *
   *  A fresh card rather than a broadcast to whatever is standing in that
   *  territory: the cards already there are mid-thought on something else, and
   *  a conflict is its own piece of work with its own transcript worth keeping.
   *
   *  The status is read *now* rather than when the badge was drawn, so the
   *  prompt names the operation and the count the repo has at the moment you
   *  pressed it — the poll is eight seconds wide, and a merge finished in a
   *  terminal in between should not produce a card asking about conflicts that
   *  are no longer there. */
  async function resolveConflicts(cwd: string) {
    const status = actions.status[cwd];
    if (!status?.conflicts) return;
    const conv = await openIn(cwd);
    if (conv) await skein.send(conv, conflictPrompt(status));
  }

  /* Adoption: conversations that already exist on disk, from the CLI or from a
     card that was closed. The list is read when the panel opens rather than
     kept current — it is a catalogue of files, and scanning them all on a timer
     would be work nobody asked for. */
  let showImport = $state(false);
  /* The theme panel. `ink` itself is a module singleton — it has to be applied
     before the first paint, and the peek needs it too — so this flag is only
     whether the panel over it is up. */
  let showThemes = $state(false);
  let importing = $state(false);
  let sessions = $state<Session[]>([]);

  async function openImport() {
    if (showImport) {
      showImport = false;
      return;
    }
    showImport = true;
    importing = true;
    sessions = await skein.importable();
    importing = false;
  }

  async function adopt(s: Session) {
    const conv = await skein.importSession(s);
    if (!conv) return;
    focusedId = conv.id;
    studio.selectOnly(conv.id);
  }

  /* ── how wide the reading panel is ────────────────────────────────────
     Its left border is the handle. The panel is a column you set rather than
     one that sizes itself: what it holds — a table, a fence — scrolls inside
     itself, because re-measuring the paragraph somebody is halfway through
     reading is the same kind of wrong as reshuffling the wall when a card
     opens. The width is decided by `panelWidth` (pure, tested) and lives with
     the viewport, which is the other half of how this window is divided. */
  let winW = $state(window.innerWidth);
  const panelPx = $derived(panelWidth(studio.panelW, winW));
  let grip = $state<{ x: number; w: number } | null>(null);

  function gripDown(e: PointerEvent) {
    if (e.button !== 0) return;
    grip = { x: e.clientX, w: panelPx };
    /* Captured, because a 7px grip is not somewhere the cursor is going to
       stay: without this the drag would end the moment it crossed onto the
       wall, which is the direction that widens the panel. */
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    /* Deliberately no `preventDefault` here. The transcript is the one place in
       this app you are meant to be able to select text, so a drag starting on
       its edge does have to refuse that — but cancelling pointerdown suppresses
       the compatibility mouse events and takes `dblclick` with them, so
       `gripReset` below could never fire. Probed 2026-08-13 through the control
       surface: two real clicks on the grip left the panel where it was.
       `user-select: none` on `.grip` refuses the selection at the source
       instead, which costs nothing. */
  }

  function gripMove(e: PointerEvent) {
    if (!grip) return;
    /* The panel is on the right: leftwards is wider. */
    studio.panelW = panelWidth(grip.w + (grip.x - e.clientX), winW);
  }

  function gripUp() {
    if (!grip) return;
    grip = null;
    studio.save();
  }

  /* Back to fitting the window. Nothing else offers a way back, and a panel
     dragged to the wrong width on a monitor you are no longer at is otherwise
     something you have to drag back by eye. */
  function gripReset() {
    studio.panelW = null;
    studio.save();
  }

  /* ── how big the reading is ───────────────────────────────────────────
     The panel's other dimension, and the same shape of thing: decided by a
     pure function (`readingScale`), stored beside the viewport, and set by a
     gesture in the panel that is routed back out to here — Transcript does not
     own how this window is set up to be read from.

     Saved on the notch rather than debounced. A pan writes every frame, which
     is why the viewport's save is deferred; a wheel notch is discrete and
     there is no moment afterwards to hang a save on, the way the width's drag
     has its pointerup. */
  const reading = $derived(readingScale(studio.readScale));

  function setRead(next: number) {
    studio.readScale = next;
    studio.save();
  }

  /* ── the right-click ──────────────────────────────────────────────────
     Chromium's menu is suppressed globally in main.ts. What replaces it is
     decided in menu.ts and dispatched here: the component turns ids into calls
     and knows nothing about what the ids mean. Where a target has nothing to
     offer, `items` is empty and no menu opens at all. */
  let menu = $state<{
    x: number;
    y: number;
    items: MenuItem[];
    act: (id: string) => void;
  } | null>(null);

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      skein.fault = "could not reach the clipboard";
    }
  }

  function onContextMenu(e: MouseEvent) {
    const el = e.target as HTMLElement | null;
    if (!el?.closest) return;
    e.preventDefault();
    menu = null;

    const field = el.closest("input, textarea") as
      | HTMLInputElement
      | HTMLTextAreaElement
      | null;
    const cardEl = el.closest("[data-conv]") as HTMLElement | null;
    const imageEl = el.closest("[data-image]") as HTMLElement | null;
    const widgetEl = el.closest("[data-widget]") as HTMLElement | null;
    /* Both the territory and the name that carries it — right-clicking the
       handle you just dragged should reach the project it belongs to. */
    const regionEl = el.closest("[data-cwd]") as HTMLElement | null;
    const selection = window.getSelection();
    const selected = (selection?.toString() ?? "").trim();

    /* Where on the wall this was, so anything the menu pins up lands under the
       cursor rather than at the origin. */
    const where = canvas?.toCanvas(e.clientX, e.clientY) ?? { x: 0, y: 0 };

    let target: MenuTarget | null = null;
    let act: (id: string) => void = () => {};

    if (field) {
      target = {
        kind: "editable",
        hasSelection: field.selectionStart !== field.selectionEnd,
        /* Reading the clipboard can be refused; offering an item that throws
           is worse than not offering it. */
        canPaste: typeof navigator.clipboard?.readText === "function",
      };
      act = async (id) => {
        const from = field.selectionStart ?? 0;
        const to = field.selectionEnd ?? 0;
        if (id === "select-all") return field.select();
        if (id === "copy" || id === "cut") {
          await copyText(field.value.slice(from, to));
          if (id === "cut") {
            field.setRangeText("", from, to, "end");
            field.dispatchEvent(new Event("input", { bubbles: true }));
          }
          return;
        }
        if (id === "paste") {
          try {
            const text = await navigator.clipboard.readText();
            field.setRangeText(text, from, to, "end");
            field.dispatchEvent(new Event("input", { bubbles: true }));
          } catch {
            skein.fault = "could not read the clipboard";
          }
        }
      };
    } else if (cardEl?.dataset.conv) {
      const conv = skein.convs.find((c) => c.id === cardEl.dataset.conv);
      if (conv) {
        focusedId = conv.id;
        studio.selectOnly(conv.id);
        target = {
          kind: "card",
          dormant: conv.dormant,
          pinned: !!studio.placements[conv.id]?.pinned,
          /* Its *own* spot, not whether it happens to be drawn on the pane. */
          glass: !!spotOf(studio.placements[conv.id]),
          /* A card drawn on the glass because its whole territory is stuck is
             not a card anybody stuck, and there is nothing honest for the item
             to say about it: "put it back on the wall" would be a promise it
             cannot keep, since the territory would still be carrying it. So it
             is not offered, which is a real answer here — see menu.ts. */
          held: heldByGlassTerritory(conv.cwd, conv.id),
          /* Something to clear means a turn taken or one under way — not a
             line on screen, which a *cleared* card still has (its own "cleared"
             note), and which would leave the item offered forever on a card
             with nothing left to clear. `working` earns its place: abandoning a
             first turn that is going wrong is exactly when this is wanted. */
          spoken: conv.everSpoke || conv.working,
          aside: conv.aside,
        };
        act = (id) => {
          if (id === "wake") void skein.wake(conv);
          else if (id === "aside") skein.setAside(conv, !conv.aside);
          /* The session id is what `--resume` takes, and this is the only place
             the UI hands it over — see the note on adoption in CLAUDE.md. It is
             `sessionId` rather than `id`, or a cleared card would hand over a
             resume command for a session that never existed. */
          else if (id === "copy-resume")
            void copyText(`claude --resume ${conv.sessionId}`);
          else if (id === "copy-cwd") void copyText(conv.cwd);
          else if (id === "clear") void skein.clear(conv);
          else if (id === "unpin") {
            studio.unpin(conv.id);
            savePlacement(conv.id);
          } else if (id === "glass") canvas?.toggleGlass("card", conv.id);
          else if (id === "close") void closeConv(conv);
        };
      }
    } else if (imageEl?.dataset.image) {
      const id = imageEl.dataset.image;
      target = {
        kind: "image",
        glass: !!spotOf(board.images.find((i) => i.id === id)),
      };
      act = (which) => {
        if (which === "front") board.bringToFront(id);
        else if (which === "glass") canvas?.toggleGlass("image", id);
        else if (which === "remove") void board.remove(id);
      };
    } else if (widgetEl?.dataset.widget) {
      const id = widgetEl.dataset.widget;
      const w = widgets.items.find((w) => w.id === id);
      if (w) {
        widgets.selected = id;
        board.selected = null;
        const now = w.config[VARIANT];
        target = {
          kind: "widget",
          glass: !!spotOf(w),
          picks: variantsOf(w.kind).map((v) => ({
            id: v.value,
            label: v.label,
            on: v.value === now,
          })),
          /* A pomodoro's cadence is the *cycle's*, not this view's — there is one
             cadence for the studio, and two widgets offering their own would be
             two clocks telling different times. Those items are built by hand
             here for that reason rather than off `optionsOf`, which only ever
             knows about a widget's own config. Everything else is the catalogue —
             `optionsOf` is still asked, and has to be, or the knobs every widget
             has (its frame) would be missing from the one kind whose menu is
             partly written out here. */
          options:
            w.kind === "pomodoro" ? [...cycleOptions(), ...optionsOf(w)] : optionsOf(w),
        };
        act = (which) => {
          if (which.startsWith("set:")) {
            widgets.set(id, VARIANT, which.slice(4));
          } else if (which.startsWith("cfg:")) {
            /* The cycle's two keys first, then anything else as the widget's
               own. Not an either/or on the kind: a pomodoro has a frame like
               everything else, and reading its `cfg:` items as cadence-or-
               nothing silently dropped every one of them. */
            const [key, ...rest] = which.slice(4).split(":");
            if (w.kind === "pomodoro" && (key === "cadence" || key === "per")) {
              pomodoro.set(key, rest.join(":"));
            } else {
              const o = optionFor(w, which);
              if (o) widgets.set(id, o.key, o.value);
            }
          } else if (which === "front") widgets.bringToFront(id);
          else if (which === "glass") canvas?.toggleGlass("widget", id);
          else if (which === "remove") void widgets.remove(id);
        };
      }
    } else if (regionEl?.dataset.cwd) {
      const cwd = regionEl.dataset.cwd;
      target = {
        kind: "region",
        empty: !skein.convs.some((c) => c.cwd === cwd),
        moved: territoryMoved(cwd),
        glass: !!spotOf(skein.projects.find((p) => p.root_path === cwd)),
        chat: skein.isChatHome(cwd),
        offers: widgetOffers(),
      };
      act = (id) => {
        if (id === "glass") canvas?.toggleGlass("region", cwd);
        else if (id === "chat") void openChat();
        else if (id === "new") void openIn(cwd);
        else if (id === "new-worktree") canvas?.startBranch(cwd);
        else if (id === "adopt") void openImport();
        else if (id === "image") void pickImage(where);
        else if (id.startsWith("widget:")) hangWidget(id.slice(7), where);
        else if (id === "reflow") skein.placeProject(cwd, null, null);
        else if (id === "forget") void skein.forgetProject(cwd);
      };
    } else if (el.closest(".surface")) {
      target = { kind: "ground", offers: widgetOffers() };
      act = (id) => {
        if (id === "open") void pickFolder();
        else if (id === "chat") void openChat();
        else if (id === "adopt") void openImport();
        else if (id === "image") void pickImage(where);
        else if (id.startsWith("widget:")) hangWidget(id.slice(7), where);
        else if (id === "fit") canvas?.fitAll();
        else if (id === "tidy") skein.tidyProjects();
        /* The ground is the thing the effects are drawn on, so this is where
           asking about them belongs. */
        else if (id === "ambience") showEffects = true;
      };
    } else if (selected) {
      /* Read-only prose — the transcript, mostly. */
      target = { kind: "prose", hasSelection: true };
      act = (id) => {
        /* The same markdown ctrl+C hands over, and taken now rather than then:
           opening a menu can cost the selection, and two routes to "copy" that
           put different text on the clipboard would be two clipboards. */
        if (id === "copy") void copyText(selectionMarkdown() || selected);
      };
    }

    const items = target ? menuFor(target) : [];
    if (!items.length) return;
    menu = { x: e.clientX, y: e.clientY, items, act };
  }

  /** Is this card on the glass only because its territory is?
   *
   *  Two ways to be drawn on the pane, and only one of them is a thing you did
   *  to the card. A territory carries its cards, so a card inside a stuck one
   *  is there without ever having been stuck — and the menu item, which is one
   *  state with two sides, has no side to be on. It is left off rather than
   *  offered as a no-op; see the note where it is passed. */
  function heldByGlassTerritory(cwd: string, id: string): boolean {
    if (spotOf(studio.placements[id])) return false;
    return !!spotOf(skein.projects.find((p) => p.root_path === cwd));
  }

  /** Write a card's placement down, whole.
   *
   *  Taken off `studio.placements` rather than passed in piece by piece,
   *  because the row now carries two positions that mean different things —
   *  where the card belongs on the wall and where it is drawn on the glass —
   *  and every call site that spelled out only the first would quietly clear
   *  the second. That is the same silent-drop shape as the `lastTier` bug the
   *  schema note in CLAUDE.md is about, and there is no error to see it by. */
  function savePlacement(id: string) {
    const p = studio.placements[id];
    skein.savePlacement(id, p ?? { x: 0, y: 0, pinned: false });
  }

  /** Is this territory somewhere other than where the grid would have put it?
   *
   *  The counterpart to a card's "let it flow again": a territory dragged out
   *  into the far wall needs a way back that is not hunting for it. Offered only
   *  when it would do something — computed on the right-click rather than kept,
   *  since it is one layout pass and nothing else asks. */
  function territoryMoved(cwd: string): boolean {
    const p = skein.projects.find((p) => p.root_path === cwd);
    if (!p || p.x === null || p.y === null) return false;
    const flowed = layout(
      [],
      {},
      /* This one handed back to the grid, the rest holding their cells — so a
         territory sitting exactly where it was first put reads as unmoved. */
      skein.projects.map((q) =>
        q.root_path === cwd ? { ...q, x: null, y: null } : q,
      ),
    ).regions.find((r) => r.cwd === cwd);
    return !!flowed && (Math.abs(flowed.x - p.x) > 1 || Math.abs(flowed.y - p.y) > 1);
  }

  /** What the wall can be given, straight off the catalogue — so a new kind of
   *  widget appears in the menu by existing. */
  function widgetOffers(): { id: string; label: string }[] {
    return WIDGETS.map((w) => ({ id: w.kind, label: `hang up a ${w.label}` }));
  }

  /** Hang one at a point on the wall. Unlike a conversation it needs nothing
   *  else — no folder, no dialog, no process. */
  function hangWidget(kind: string, at: { x: number; y: number }) {
    void widgets.add(kind as WidgetKind, at.x, at.y);
  }

  /** The cycle's own knobs, as marked menu options — the shape `optionsOf`
   *  returns, so `ContextMenu` cannot tell the difference. Two groups' worth of
   *  choices in one list, which is what the widget menu already does with a
   *  clock's four toggles. */
  function cycleOptions(): { id: string; label: string; on: boolean }[] {
    return [
      ...CADENCES.map((c) => ({
        id: `cfg:cadence:${c.value}`,
        label: c.label,
        on: c.value === pomodoro.cycle.cadence,
      })),
      ...PERS.map((p) => ({
        id: `cfg:per:${p.value}`,
        label: p.label,
        on: Number(p.value) === pomodoro.cycle.per,
      })),
    ];
  }

  /** What a performance row's role and reference are called up here.
   *
   *  This is the whole reason a process meter is worth having inside Skein:
   *  `perf.rs` can say "conversation 5f3c…" and nothing more, because the title
   *  of that card is front-end knowledge. Six identical `claude.exe` become six
   *  cards you can name. */
  function nameFor(role: string, reference: string | null): string | null {
    if (!reference) return role === "studio" ? "skein" : null;
    if (role === "conversation") {
      const c = skein.convs.find((c) => c.id === reference);
      return c ? displayName(c.title, c.project) : "a conversation";
    }
    if (role === "server") {
      const g = skein.groups.find((g) => g.group.id === reference);
      return g ? g.group.label : "a dev server";
    }
    if (role === "action") {
      /* A run id is `<cwd>:<action>` — the action alone is what reads, since
         the territory it belongs to is on the wall behind it. */
      const bit = reference.split(":").pop();
      return bit ? bit.replace(/-/g, " ") : "a build";
    }
    return null;
  }

  /** Clicking a row goes to the thing it is about. A meter that tells you which
   *  card is eating a core, and then makes you find it, has done half a job. */
  function revealRow(role: string, reference: string) {
    if (role !== "conversation") return;
    const conv = skein.convs.find((c) => c.id === reference);
    if (!conv) return;
    focusedId = conv.id;
    studio.selectOnly(conv.id);
    canvas?.reveal(conv.id);
  }

  /** Pin up an image from a file, at a point on the wall.
   *
   *  The counterpart to dropping one in from another window — which was the
   *  only way, and is no help when what you want is a file rather than
   *  something already on screen. Same path afterwards: `board.add` copies it
   *  into `$APPDATA/references/`, which is the only place the asset protocol
   *  will serve from. */
  async function pickImage(at: { x: number; y: number }) {
    const picked = await openDialog({
      multiple: true,
      title: "Pin up on the wall…",
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"],
        },
      ],
    });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    let { x, y } = at;
    for (const path of paths) {
      await board.add(path, x, y);
      /* Stagger, as a multi-file drop does — a stack you can pull apart beats
         several images landing exactly on top of each other. */
      x += 28;
      y += 28;
    }
  }

  /** Where the cursor last was, and whether it was over the wall at the time.
   *
   *  Deliberately not `$state`: a pointermove fires dozens of times a second and
   *  nothing here is drawn from it — it is read once, by a paste. Made reactive
   *  it would invalidate whatever happened to touch it on every mouse move. */
  let pointer = { x: 0, y: 0, onWall: false };

  function trackPointer(e: PointerEvent) {
    const el = e.target as Element | null;
    pointer = {
      x: e.clientX,
      y: e.clientY,
      onWall: !!el?.closest?.(".surface"),
    };
  }

  /** Paste a screenshot onto the wall, where the cursor is.
   *
   *  Drag-and-drop and the file picker both need the image to already be a file,
   *  and a screen capture is not one: Windows' capture tools put a bitmap on the
   *  clipboard and write nothing to disk. So the bytes come off the clipboard
   *  and Rust gives them a home — from there it is the same path a drop takes.
   *
   *  It listens for the `paste` event rather than reading
   *  `navigator.clipboard.read()`, which wants a permission the webview may
   *  prompt for or refuse outright. A paste is already a gesture you made, and
   *  the event carries the bytes with it — nothing has to be asked for.
   *
   *  The image goes where the *cursor* is, not where the keyboard focus is,
   *  because ctrl+V has no position of its own and the cursor is the only thing
   *  on screen that does. With the cursor off the wall — over the transcript, or
   *  never moved since launch — it goes to the middle of the view, which is at
   *  least somewhere you are looking. */
  async function onPaste(e: ClipboardEvent) {
    const data = e.clipboardData;
    if (!data) return;

    /* Read the files out synchronously: `clipboardData` is only valid during
       the event, so anything taken after the first await is gone. */
    const images = [...data.files].filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;

    /* Text on the clipboard beside the image wins inside a field. Copying from
       a web page puts both there, and a paste into the draft you are writing
       means the words — pinning a picture up instead would be an ordinary
       ctrl+V doing something nobody asked for. Image-only in a field still
       pins: there is nothing else it could mean. */
    if (isTyping(e.target) && data.types.includes("text/plain")) return;

    e.preventDefault();

    const at =
      pointer.onWall && canvas
        ? canvas.toCanvas(pointer.x, pointer.y)
        : (canvas?.center() ?? { x: 0, y: 0 });

    let { x, y } = at;
    for (const file of images) {
      await board.paste(await file.arrayBuffer(), x, y);
      /* Stagger, as a multi-file drop does. */
      x += 28;
      y += 28;
    }
  }

  async function pickFolder() {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "Open a conversation in…",
    });
    if (typeof picked === "string") await openIn(picked);
  }

  /** The cards a prompt would reach right now. */
  const targets = $derived(
    studio.selected.length > 1
      ? skein.convs.filter((c) => studio.isSelected(c.id))
      : focused
        ? [focused]
        : [],
  );

  /** The reach of the draft, for the cards that draw it as their name-to-be.
   *
   *  Derived apart from `targets` so a keystroke does not re-derive the objects:
   *  this changes when the gathering does, which is rarely, and never while you
   *  are typing. */
  const targetIds = $derived(targets.map((c) => c.id));

  /** Ids among the targets that have already edited the same files as another
   *  target. Recomputed when the gathering changes, never during typing. */
  let clashing = $state<string[]>([]);
  $effect(() => {
    const t = targets;
    if (t.length < 2) {
      clashing = [];
      return;
    }
    let live = true;
    void skein.sharedTree(t).then((ids) => {
      if (live) clashing = ids;
    });
    return () => {
      live = false;
    };
  });

  /* ── slash commands ────────────────────────────────────────────────────
   *
   * `commands.ts` owns the vocabulary and what a half-typed draft matches;
   * this is only the palette's state and the arm that runs each one — the same
   * split as `menu.ts` and `ContextMenu.svelte`.
   *
   * The rule that matters is that Skein reads *only* its own names. `claude`
   * has slash commands of its own and they work in `--print` mode, so `/commit`
   * is the project's and goes to the agent untouched; nothing here may swallow
   * a command it does not recognise. */

  /** Which palette entry is lit — an index into whichever list is up. Clamped
   *  at use, since the list shortens as you type and an index left past the end
   *  would light nothing. */
  let commandAt = $state(0);
  /** Escape dismissed the palette for this draft — the text stays, so `/clear`
   *  can still be sent to an agent as words if that is what you meant. */
  let commandsOff = $state(false);
  const commands = $derived(commandsOff ? [] : matchCommands(draft));
  /** The second stage: a command with a fixed set of values, named but not yet
   *  given one. `/model ` is not a thing that can be run, so the palette stays
   *  up past the space and offers the values — see `typingChoice`. */
  const choosing = $derived(commandsOff ? null : typingChoice(draft));
  const choices = $derived(commandsOff ? [] : matchChoices(draft));
  const commandPick = $derived(
    commands.length ? commands[Math.min(commandAt, commands.length - 1)] : null,
  );
  const choicePick = $derived(
    choices.length ? choices[Math.min(commandAt, choices.length - 1)] : null,
  );
  /** Is anything being chosen? The keys the palette borrows are borrowed by
   *  both of its stages. */
  const palette = $derived(commands.length > 0 || choices.length > 0);

  /** What an unnamed card should wear while you type.
   *
   *  An unnamed card shows the draft as the name it is about to have — but a
   *  command is not a name. It is withheld while the palette is lit, because
   *  `/clear` is about to be *run* rather than sent; and withheld for one of
   *  the CLI's own, because `/model sonnet` is sent but is not something said
   *  to the agent, and `#deliver` will not name the card from it either. The
   *  two have to agree, or the face previews a name the send does not give it.
   *
   *  `/rename` is the one command that has a name in it, and so is the one case
   *  where the preview is the argument rather than nothing: what a card is about
   *  to be called is exactly what this gesture is for, and drawing `/rename the
   *  auth work` in the title line would preview a name no card will ever wear.
   *  `titleFromPrompt` does the cutting in `cardName` either way, so the preview
   *  is cut the same way `Skein.rename` is about to cut it. */
  const previewDraft = $derived.by(() => {
    /* A `!` line is not a name either, and for the strongest version of the
       reason: it is not even said to the agent. `#deliver` never sees it, so a
       card previewing `!bun run check` would be showing a name no card can ever
       wear. */
    if (banging) return "";
    const found = resolveCommand(draft);
    if (found?.cmd.name === "rename") return found.arg;
    if (palette || found || cliCommand(draft)) return "";
    return draft;
  });

  /* ── the `!` line ──────────────────────────────────────────────────────
   *
   * `bang.ts` owns what a draft means and how it is coloured; `Bang` owns the
   * runs and the completion. This is the dock's half: which mode the field is
   * in, which card the line will run in, and the keys.
   *
   * The palette and this can never both be up — one needs a leading slash and
   * the other a leading bang — so nothing here has to negotiate with it. */

  /** Escape said "I did not mean a shell line" for this draft. The text stays,
   *  exactly as it does for the palette: a prompt beginning with `!` is a
   *  perfectly ordinary thing to say to an agent ("!! this is the bug"), and
   *  that is the way to say it. */
  let bangOff = $state(false);
  /** Is the field a shell line? */
  const banging = $derived(!bangOff && isBang(draft));
  /** The command in it, or null while it is still only a `!`. */
  const bangText = $derived(banging ? bangOf(draft) : null);
  /** Which card the line runs in.
   *
   *  One card, never the gathering, and the bar says which — a shell command
   *  runs in *a* directory, and broadcasting one would run it once per card in
   *  what is very often the same tree. Falling back to the first of a marquee
   *  gathering rather than to nothing, so a line typed over a selection with no
   *  ring still has somewhere honest to go, and the bar names it. */
  const bangCard = $derived(focused ?? targets[0] ?? null);

  /* A draft that stops being a shell line is a new question, so the dismissal
     does not outlive it — the same rule the palette's has, for the same reason. */
  $effect(() => {
    if (!isBang(draft)) bangOff = false;
  });

  /* An offering standing over a draft that is no longer a shell line would be a
     popup completing paths into a sentence. */
  $effect(() => {
    if (!banging) bang.close();
  });

  /** Run the line, and hand the result over if that is what was asked.
   *
   *  Cleared before the run rather than after, so the field is ready for the
   *  next thing while a build is still going — a `!` run does not own the dock,
   *  and the transcript is where it reports. */
  async function runBang(handOver: boolean) {
    const cmd = bangText;
    const card = bangCard;
    if (!cmd || !card) return;
    bang.close();
    draft = "";
    await bang.run(card, cmd, handOver);
  }

  /** Put a completion into the line, and the caret after it.
   *
   *  The `!` is added back here because the shell was asked about the *command*
   *  and answers in the command's own offsets — see `commandCursor`. */
  async function takeCompletion(offer: Completion, match: Match) {
    const done = applyCompletion(draft.slice(BANG.length), offer, match);
    draft = BANG + done.cmd;
    bang.close();
    await tick();
    prompt?.setSelectionRange(
      done.cursor + BANG.length,
      done.cursor + BANG.length,
    );
  }

  /** Ask the shell what it would complete, and apply it if there is only one. */
  async function askCompletion() {
    const card = bangCard;
    if (!card) return;
    const cmd = draft.slice(BANG.length);
    const at = commandCursor(draft, prompt?.selectionStart ?? draft.length);
    const only = await bang.complete(card, cmd, at);
    if (only) await takeCompletion(only.offer, only.only);
  }

  /* A draft that stops being a command being typed is a new question, so the
     dismissal does not outlive it. Without this, one Escape silenced the
     palette for the rest of the session. Both stages count: dismissing over
     `/model son` must not be undone by the very next keystroke. */
  $effect(() => {
    if (typingName(draft) === null && typingChoice(draft) === null) {
      commandsOff = false;
    }
  });

  /* The lit row goes back to the top when the list under it is replaced, or
     stepping from the names to the values would land on whichever value
     happened to share an index with the command you just picked. */
  const stage = $derived(choosing ? `values:${choosing.cmd.name}` : "names");
  $effect(() => {
    stage;
    commandAt = 0;
  });

  async function runCommand(cmd: Command, broadcast: boolean, arg = "") {
    if (targets.length === 0) return;
    /* A command that takes a value is not finished being chosen, so Enter on it
       means "show me them" rather than running anything — there is nothing yet
       to run. Tab does the identical thing, which is the point: at this row the
       two keys agree. One that takes prose is in exactly the same position with
       nothing typed after it, and gets the same answer: `/rename` names
       nothing, so Enter opens the space to write in. */
    if (cmd.choices || (cmd.takesText && !arg)) {
      draft = completionFor(cmd);
      commandAt = 0;
      return;
    }
    /* A command reaches as far as a prompt does and costs the same modifier —
       clearing five cards at once should not be easier than talking to them. */
    if (targets.length > 1 && !broadcast) return;
    /* The CLI's own commands are carried out by sending them. Skein has nothing
       to do here beyond having helped you type it: `/compact` goes down the
       same stdin as any prompt, and the agent answers it. */
    if (cmd.by === "cli") return sendText(`/${cmd.name}`, broadcast);
    draft = "";
    commandAt = 0;
    const on = [...targets];
    if (cmd.name === "clear") {
      for (const c of on) await skein.clear(c);
    } else if (cmd.name === "rename") {
      /* Reaching the whole gathering, like everything else here, and gated by
         the same modifier above. Renaming five cards to one word is a strange
         thing to want, but it is a strange thing you asked for twice — where a
         rename that silently only took on the focused card would be the dock
         quietly disagreeing with its own target line. */
      for (const c of on) await skein.rename(c, arg);
    }
  }

  /** Say something to every target, with the reach gate the dock's Enter has. */
  async function sendText(text: string, broadcast: boolean) {
    if (!text || targets.length === 0) return;
    /* Friction scales with reach: Enter sends to one, Ctrl+Enter to many.
       With permissions bypassed a broadcast is the most destructive gesture in
       the app, and one modifier is the cheapest possible insurance. */
    if (targets.length > 1 && !broadcast) return;
    draft = "";
    commandAt = 0;
    if (targets.length === 1) await skein.send(targets[0], text);
    else await skein.broadcast(targets, text);
  }

  async function send(broadcast = false) {
    /* With a value lit the line is complete, so Enter sends it. */
    if (choicePick && choosing) {
      return sendText(completionForChoice(choosing.cmd, choicePick), broadcast);
    }
    /* With the palette open the key means "run what is lit", exactly as it
       does in the CLI: `/cle` and Enter runs clear. */
    if (commandPick) return runCommand(commandPick, broadcast);

    const text = draft.trim();
    if (!text || targets.length === 0) return;
    /* A command typed in full and sent without the palette ever opening —
       pasted, or completed and then dismissed. Only Skein's own arrive here:
       the CLI's, and every unknown name, fall through and go to the agent as
       the prompts they are. */
    const found = resolveCommand(text);
    if (found) return runCommand(found.cmd, broadcast, found.arg);

    await sendText(text, broadcast);
  }

  /** Step along the cards that want something, in urgency order.
   *
   *  Same both-ends rule as `cycleConv`, and it earns it more often here: the
   *  focused card is usually *not* in this list — you were reading one thing
   *  when another went amber — so `at < 0` is the common case rather than the
   *  cold-start one, and forwards has to mean the loudest while backwards
   *  means the quietest. */
  function cycleWaiting(step: 1 | -1) {
    if (waiting.length === 0) return;
    const at = waiting.findIndex((c) => c.id === focusedId);
    const to =
      at < 0
        ? step > 0
          ? 0
          : waiting.length - 1
        : (at + step + waiting.length) % waiting.length;
    focusCard(waiting[to]);
  }

  /** Step the focus along the wall: Tab forwards, shift+Tab back.
   *
   *  In the wall's own reading order (`wallOrder`) rather than open order,
   *  because what you are stepping through is what you are looking at. Cyclic,
   *  and with nothing focused Tab starts at the beginning while shift+Tab starts
   *  at the end — the two gestures should reach the same card from either end of
   *  a wall you have not touched yet. */
  function cycleConv(step: 1 | -1) {
    const order = canvas?.order() ?? [];
    if (order.length === 0) return;
    const at = order.findIndex((c) => c.id === focusedId);
    const to =
      at < 0
        ? step > 0
          ? 0
          : order.length - 1
        : (at + step + order.length) % order.length;
    focusCard(order[to]);
  }

  /** What Tab does, wherever it is pressed.
   *
   *  Tab is one gesture — "the next card I care about" — and what that means
   *  depends on whether anything is asking. With cards waiting, they *are* the
   *  next card you care about, and walking the whole wall past them is work you
   *  did not ask for; with none waiting, the wall is the only thing left to
   *  step through. So the plain key changes its footing under you, which is
   *  deliberate and is why Ctrl+Tab exists beside it: that one always walks the
   *  whole wall, so there is a key whose meaning does not move. It used to be
   *  the other way round — Ctrl for the waiting list — but the unmodified key
   *  should be the one aimed at the thing that wants you. */
  function cycleTab(step: 1 | -1, wholeWall: boolean) {
    if (!wholeWall && waiting.length > 0) cycleWaiting(step);
    else cycleConv(step);
  }

  /** Land on a card the way clicking it does.
   *
   *  Both halves matter: the gathering has to follow, or Tab would move the ring
   *  while the dock still pointed a broadcast at whatever was picked before it. */
  function focusCard(conv: Conversation) {
    focusedId = conv.id;
    studio.selectOnly(conv.id);
    canvas?.reveal(conv.id);
  }

  /** Let go of the card: no ring, no gathering, no panel.
   *
   *  Both halves again, and the focus is the half that was missing — clicking
   *  the ground cleared the gathering while leaving the card lit and its
   *  transcript open, so there was no way back to a bare wall short of closing
   *  a conversation. Having nothing in hand is a state the wall is meant to
   *  have: it is what the dock's "no card focused" says, and it is where the
   *  keystroke-to-the-field rule stops firing. */
  function ondeselect() {
    focusedId = null;
    studio.clearSelection();
  }

  function onDraftKey(e: KeyboardEvent) {
    /* A shell line borrows the same keys the palette does, and is checked first
       for the same reason. The two are mutually exclusive, so the order between
       them is arbitrary; what matters is that both come before the branches that
       assume the field holds prose. */
    if (banging) {
      const offer = bang.offer;
      /* With an offering up, the keys are the popup's. Bare arrows only —
         ctrl+arrow scrolls the transcript from wherever the keyboard is, which
         is a different question asked of a different part of the window. */
      if (offer) {
        if (
          (e.key === "ArrowDown" || e.key === "ArrowUp") &&
          !e.ctrlKey &&
          !e.metaKey
        ) {
          e.preventDefault();
          bang.move(e.key === "ArrowDown" ? 1 : -1);
          return;
        }
        /* Enter *completes* rather than running, which is where this
           deliberately parts company with the command palette. There, Enter
           runs what is lit, because the palette is for choosing what to do; here
           the popup is for choosing what to *type*, and a half-written path is
           the one moment you certainly did not mean to run anything. Escape
           first, then Enter, is how you run it. Tab agrees, as it does
           everywhere. */
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const lit = bang.lit;
          if (lit) void takeCompletion(offer, lit);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          bang.close();
          return;
        }
        /* Anything else typed invalidates the span the shell answered with, so
           the offering goes rather than being applied at an index the line no
           longer has. `applyCompletion` clamps as a backstop; this is the actual
           fix. */
        if (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete") {
          bang.close();
        }
      }

      if (e.key === "Tab") {
        e.preventDefault();
        void askCompletion();
        return;
      }
      /* Up and Down walk this card's own `!` history. Free to take here in a way
         they are not in an ordinary draft: a shell line is one line, so there is
         no caret to move vertically. */
      if (
        (e.key === "ArrowUp" || e.key === "ArrowDown") &&
        !e.ctrlKey &&
        !e.metaKey &&
        bangCard
      ) {
        const was = bang.step(
          bangCard,
          e.key === "ArrowUp" ? -1 : 1,
          draft.slice(BANG.length),
        );
        if (was !== null) {
          e.preventDefault();
          draft = BANG + was;
          void tick().then(() =>
            prompt?.setSelectionRange(draft.length, draft.length),
          );
        }
        return;
      }
      if (e.key === "Escape") {
        /* One step back out: this leaves the shell line and keeps the text, and
           a second press does what Escape in a field always did. Stopped from
           bubbling, or the window's handler would blur the field on the same
           press and take both steps at once. */
        e.preventDefault();
        e.stopPropagation();
        bangOff = true;
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        /* Ctrl is what it is everywhere in this dock — the modifier that widens
           what the key reaches. It cannot mean "more cards" here, since a run is
           one directory, so it means the other thing a run can reach: the agent.
           Same friction, and the expensive gesture is still the one that costs a
           modifier. */
        e.preventDefault();
        void runBang(e.ctrlKey || e.metaKey);
        return;
      }
    }

    /* The palette borrows four keys while it is open, and gives them all back
       the moment it closes — which is why it is checked before anything else
       here rather than folded into the branches below. */
    if (palette) {
      /* However many rows are up, in whichever stage. */
      const rows = choices.length || commands.length;
      /* Bare arrows only. Ctrl+arrow scrolls the transcript from anywhere the
         keyboard happens to be, the palette included — it is a different
         question ("what does that answer say") asked of a different part of the
         window, and a palette open over the draft is no reason to stop
         answering it. Falling through here lets it reach the window. */
      if (
        (e.key === "ArrowDown" || e.key === "ArrowUp") &&
        !e.ctrlKey &&
        !e.metaKey
      ) {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        commandAt = (Math.min(commandAt, rows - 1) + step + rows) % rows;
        return;
      }
      if (e.key === "Escape") {
        /* The text stays. Dismissing is "I did not mean a command", not "undo
           what I typed" — and a draft beginning with a slash is a perfectly
           ordinary thing to say to an agent. */
        e.preventDefault();
        commandsOff = true;
        return;
      }
      /* Tab completes without running, which is how you read the detail line
         before committing to it. At the values it fills the whole line in, so
         the last thing before Enter is the command exactly as it will be sent. */
      if (e.key === "Tab" && (choicePick || commandPick)) {
        e.preventDefault();
        draft =
          choicePick && choosing
            ? completionForChoice(choosing.cmd, choicePick)
            : completionFor(commandPick!);
        return;
      }
    }

    /* Tab reaches the wall from inside the field too — you write to one card,
       then step to the next without going by way of the mouse. */
    if (e.key === "Tab") {
      e.preventDefault();
      cycleTab(e.shiftKey ? -1 : 1, e.ctrlKey || e.metaKey);
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(e.ctrlKey || e.metaKey);
    }
  }

  /** Which project's shell is the one on screen.
   *
   *  The last project you touched a card in, then whichever is first on the
   *  wall, then nowhere in particular. Only ever names a *project* — a card,
   *  a worktree card included, carries its project root as its `cwd`, so this
   *  is one key per territory rather than one per card.
   *
   *  Only ever consulted for which shell to show and where a *new* one starts:
   *  one already running is wherever you last `cd`'d it to, and moving it back
   *  because you clicked a card would be the app arguing with something you
   *  typed. */
  function shellCwd(): string {
    return activeShellKey(lastTouched, skein.projects.map((p) => p.root_path)) || ".";
  }

  async function onGlobalKey(e: KeyboardEvent) {
    /* Alt+I, from anywhere at all — the wall, the draft, the shell's own field.
       It is the one binding here that fires while you are typing, and it can
       afford to be: Alt+letter is not a text gesture Chromium binds, and this
       window has no menu bar for it to collide with (`decorations: false`).
       Checked before everything else because it is also how you get *out*. */
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "i" || e.key === "I")) {
      e.preventDefault();
      await shell.toggle(shellCwd());
      return;
    }
    /* An open shell owns the keyboard. Every branch below is aimed at the wall
       or at the reading, and the two that reach past a field regardless —
       ctrl+arrow's scroll and ctrl+0's reading size — would otherwise fire
       from inside a console into a transcript nobody is looking at. Escape and
       the history keys are the panel's own, handled in Shell.svelte. */
    if (shell.open) return;

    if (e.key === "F11") {
      e.preventDefault();
      const win = getCurrentWindow();
      await win.setFullscreen(!(await win.isFullscreen()));
    } else if (e.ctrlKey && e.shiftKey && (e.key === "T" || e.key === "t")) {
      /* Round the ring of themes. A cycle and not a picker because the point
         of the thing is comparison: a picker costs two gestures per look and
         puts a menu over the reading you are trying to judge. One direction
         only — the ring is short and `paper` is always at the head of it, so
         the way back is never more than a few presses. Free here — the webview
         has no tab strip for ctrl+shift+T to reopen anything into. */
      e.preventDefault();
      ink.cycle(1);
    } else if (e.key === "Home" && !isTyping(e.target)) {
      /* Fit the wall — but only where Home has nothing else to mean. In a field
         it is the start of the line, and this branch called `preventDefault`,
         so the key was not merely doubled up: it was swallowed, and the caret
         did not move at all. Every other key here that a field has a use for is
         already guarded this way (Tab, Delete, and a bare printable character);
         Home was the one that was not.

         Note ctrl+arrow a few branches down is the deliberate exception, and it
         is only an exception because it costs a modifier a textarea does not
         bind. A bare key that means something to a field belongs to the field. */
      e.preventDefault();
      canvas?.fitAll();
    } else if (e.key === "0" && (e.ctrlKey || e.metaKey)) {
      /* Back to the size the transcript always was — the same key that means
         that in every reader, and free here because the webview's own zoom
         hotkeys are off (Tauri 2 leaves `zoomHotkeysEnabled` false). It is
         worth having: ctrl+wheel is easy to turn by accident with a hand
         already on the wheel, and there is otherwise nothing that says what
         100% was. Aimed at the reading and not at the wall, which has Home. */
      e.preventDefault();
      setRead(READ_REST);
    } else if (
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      (e.key === "ArrowUp" ||
        e.key === "ArrowDown" ||
        e.key === "PageUp" ||
        e.key === "PageDown")
    ) {
      /* Read the answer without touching the mouse.
       *
       * Deliberately *not* conditional on where the keyboard is. Everything else
       * on this wall that reaches past a field checks `isTyping` first, and this
       * one must not: the moment you most want to scroll an answer is the moment
       * you have just pressed Enter, and the caret is sitting in the draft then
       * — a binding that worked everywhere except there would fail exactly where
       * it is for. So it costs ctrl, which is what buys it the right to fire
       * inside the field. Bare arrows stay the caret's and bare page keys stay
       * the field's; ctrl+arrow is not a text gesture Chromium binds in a
       * textarea, so nothing is taken away.
       *
       * Aimed at the focused card alone, like Escape's stop — the panel only
       * ever shows one conversation, and a gathering has no reading to move.
       * With no panel open `transcript` is undefined and the keys are somebody
       * else's, hence the guard before `preventDefault`. */
      if (!transcript) return;
      e.preventDefault();
      const up = e.key === "ArrowUp" || e.key === "PageUp";
      transcript.step(e.key.startsWith("Page") ? "page" : "line", up ? -1 : 1);
    } else if (e.key === "Escape") {
      /* One step back out, innermost first. Anything that closes on Escape owns
         the key while it is open — the menu, the import panel and the theme
         panel all listen on the window themselves, so this only has to stay out
         of their way, and it runs first because App mounts before any of them.

         A field is a step of its own: Escape with the caret in the draft means
         "give the wall the key back", not "throw away what I aimed this at".
         Letting go of the card there would leave a written prompt pointed at
         nothing, so the draft survives and a second press does the deselect. */
      if (menu || showImport || showThemes) return;
      if (isTyping(e.target)) {
        (e.target as HTMLElement).blur();
        return;
      }
      /* A running turn is the innermost thing of all, so it is the first thing
         Escape reaches — which is also what the key does in Claude Code, and
         the hands arriving here already know that. It only ever takes the step
         it has: with nothing working, Escape lets go exactly as it always did,
         and a second press after a stop does the letting go.
         Aimed at the focused card alone, never at the gathering. A stop is
         cheap and undoable — the context survives, and you can say the next
         thing straight away — but firing one at everything a wide marquee
         happened to catch is not a gesture anybody means. */
      /* A `!` run is the innermost thing of all — more recent than a turn, and
         a card can be doing both at once — so it is what Escape reaches first.
         The same key, for the same reason it stops a turn: this is the thing
         this card is doing that you might want to take back. */
      if (focused?.bangCmd) void bang.stop(focused);
      else if (focused?.working) void skein.stop(focused);
      else if (board.selected) board.selected = null;
      else if (widgets.selected) widgets.selected = null;
      else ondeselect();
    } else if (e.key === "Tab" && !isTyping(e.target)) {
      /* Tab means "the next card" everywhere on the wall, not only in the dock
         — the next card that wants you if any do, otherwise simply the next one
         along (`cycleTab`). It does cost the browser's own focus ring, which
         would otherwise walk a card's close button and the transcript's links —
         reachable by mouse, and not by Tab, deliberately: a card is the only
         thing on this wall there are dozens of, and stepping between them is
         what the key is for.
         Fields keep their Tab (`isTyping`); the draft field claims it back for
         this in onDraftKey, since that is where you already are when you want
         the next card. */
      e.preventDefault();
      cycleTab(e.shiftKey ? -1 : 1, e.ctrlKey || e.metaKey);
    } else if (
      (e.key === "Delete" || e.key === "Backspace") &&
      (board.selected || widgets.selected) &&
      !isTyping(e.target)
    ) {
      e.preventDefault();
      if (board.selected) void board.remove(board.selected);
      else if (widgets.selected) void widgets.remove(widgets.selected);
    } else if (
      /* Start typing with a card in hand and the words go to it. The wall has
         no single-letter shortcuts, so a printable key means only one thing —
         and reaching for the mouse to click a field you were already looking at
         is the sort of small tax that adds up across a day. */
      e.key.length === 1 &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !menu &&
      targets.length > 0 &&
      !isTyping(e.target)
    ) {
      /* The character is carried across by hand rather than left to the
         browser: focus moves during this same keydown, and what happens to the
         keystroke that caused it is not something to leave to chance. */
      e.preventDefault();
      draft += e.key;
      void focusDraft();
    }
  }

  function isTyping(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLInputElement ||
      (target instanceof HTMLElement && target.isContentEditable)
    );
  }

  /** Put the caret at the end of the draft, after the value has landed. */
  async function focusDraft() {
    await tick();
    prompt?.focus();
    prompt?.setSelectionRange(draft.length, draft.length);
  }

  /* The horizon saturates around $20 of the day's spend — far enough that a
     normal afternoon barely lifts it, close enough that a runaway wall is
     unmistakable without anyone reading a number. A day rather than a session,
     so restarting the app does not put the ground back to cold; see the note
     over `Skein.spend`. */
  const HORIZON_FULL_USD = 20;
  const burn = $derived(Math.min(1, skein.spend / HORIZON_FULL_USD));

  async function closeConv(conv: Conversation) {
    await skein.close(conv);
    /* Before the focus moves, so a line still being written is handed to the
       wall rather than parked under a card that no longer exists — which is the
       same as losing it. What the card had parked goes with the card. */
    draft = drafts.release(conv.id, draft);
    if (focusedId === conv.id) focusedId = skein.convs[0]?.id ?? null;
  }

  /* The control surface, off unless SKEIN_CONTROL asked for it. It gets the
     same handles a pair of hands would — nothing here is a second code path,
     which is the only way a green run says anything about the real app. */
  const control = new Control({
    skein,
    studio,
    board,
    widgets,
    meter,
    ledger,
    devops,
    pomodoro,
    ambience,
    attention,
    actions,
    shell,
    bang,
    canvas: () => canvas,
    focusedId: () => focusedId,
    setFocused: (id) => (focusedId = id),
    deselect: ondeselect,
    draft: () => draft,
    setDraft: (t) => (draft = t),
    commands: () => commands,
    choices: () => choices.map((c) => c.value),
    targets: () => targets,
    waiting: () => waiting,
    clashing: () => clashing,
    openIn,
    openChat,
    resolveConflicts,
    submit: send,
    flags: () => ({
      showDetail,
      showServers,
      showEffects,
      /* Reported separately from `shellLive`, because the panel being shut is
         not the shell being gone — that is the whole shape of the thing, and a
         surface that could not tell them apart could not test it. */
      showShell: shell.open,
      shellLive: shell.live,
      chime: attention.chime,
    }),
    setFlag: (name, value) => {
      if (name === "showDetail") showDetail = value;
      else if (name === "showServers") showServers = value;
      else if (name === "showEffects") showEffects = value;
      else if (name === "showShell") {
        if (value) void shell.show(shellCwd());
        else shell.hide();
      } else if (name === "chime") attention.chime = value;
    },
    shellCwd,
  });
</script>

<svelte:window
  onkeydown={onGlobalKey}
  onpaste={onPaste}
  onpointermove={trackPointer}
  bind:innerWidth={winW}
/>

<div
  class="studio"
  style:--burn={burn}
  oncontextmenu={onContextMenu}
  role="presentation"
>
  <!-- This bar IS the title bar. Undecorated window, so dragging, double-click
       to maximise, and the window buttons all live here. -->
  <header class="bar" data-tauri-drag-region>
    <span class="wordmark" data-tauri-drag-region>Skein</span>
    <span class="tag" data-tauri-drag-region>
      {skein.convs.length} card{skein.convs.length === 1 ? "" : "s"} ·
      {skein.projects.length} project{skein.projects.length === 1 ? "" : "s"}
    </span>
    <span class="grow" data-tauri-drag-region></span>
    <!-- A surface that can drive the app must never be quietly on. -->
    {#if control.endpoint}
      <span class="ctl" title="External control is listening on 127.0.0.1:{control.endpoint.port}"
        >control :{control.endpoint.port}</span
      >
    {/if}
    {#if skein.spend > 0}
      <!-- Dated in the tooltip, because a day's spend and a session's are the
           same six characters and only one of them survives a restart. -->
      <span
        class="spend"
        title="spent today · {skein.heldTokens.toLocaleString()} tokens held across the wall"
        >${skein.spend.toFixed(2)}</span
      >
    {/if}
    {#if skein.live > 0}
      <span class="livecount">{skein.live} live</span>
    {/if}
    <span class="zoom" title="Semantic zoom — wheel; shift+wheel pans">{studio.lod}</span>
    <button class="ghost" onclick={() => canvas?.fitAll()} title="Fit everything (Home)">fit</button>
    <button
      class="ghost"
      class:on={showServers}
      onclick={() => (showServers = !showServers)}>servers</button
    >
    <button
      class="ghost"
      class:on={shell.open}
      onclick={() => shell.toggle(shellCwd())}
      title="A shell over the middle of the wall (alt+I)">shell</button
    >
    <button
      class="ghost"
      class:on={showEffects}
      onclick={() => (showEffects = !showEffects)}
      title="What the wall does when nobody is asking it anything">ambience</button
    >
    <button class="ghost" class:on={showDetail} onclick={() => (showDetail = !showDetail)}>read</button>
    <!-- `data-adopt` is the control surface's only handle on this button; the
         other chrome buttons are reachable by the panel they open. -->
    <button
      class="ghost"
      class:on={showImport}
      data-adopt
      onclick={openImport}
      title="Put a conversation started elsewhere on the wall">adopt</button
    >
    <button
      class="ghost"
      class:on={showThemes}
      onclick={() => (showThemes = !showThemes)}
      title="How the transcript is set — ctrl+shift+T cycles without opening this"
      >themes</button
    >
    <button
      class="ghost"
      class:on={attention.chime}
      onclick={() => (attention.chime = !attention.chime)}
      title="Play a soft chime when a card wants you and Skein isn't focused"
      >chime</button
    >
    <button class="open" onclick={pickFolder} disabled={spawning}>
      {spawning ? "opening…" : "Open a folder…"}
    </button>
    <WindowControls />
  </header>

  {#if skein.fault}
    <button class="fault" onclick={() => (skein.fault = null)}>{skein.fault}</button>
  {/if}

  {#if menu}
    <ContextMenu
      x={menu.x}
      y={menu.y}
      items={menu.items}
      onpick={(id) => {
        menu?.act(id);
        menu = null;
      }}
      onclose={() => (menu = null)}
    />
  {/if}

  {#if showThemes}
    <Themes onclose={() => (showThemes = false)} />
  {/if}

  {#if showImport}
    <Import
      {sessions}
      loading={importing}
      onpick={adopt}
      onclose={() => (showImport = false)}
    />
  {/if}

  {#if showServers}
    <Servers {skein} {actions} />
  {/if}

  {#if showEffects}
    <Effects {ambience} />
  {/if}

  {#if shell.open}
    <Console {shell} />
  {/if}

  <main class="wall" class:sizing={!!grip}>
    <!-- A project with no cards is still a place on the wall, and the only
         place its "+" lives — so an empty territory keeps the canvas up. -->
    {#if skein.convs.length || skein.projects.length || board.images.length || widgets.items.length}
      <Canvas
        bind:this={canvas}
        convs={skein.convs}
        projects={skein.projects}
        {studio}
        {board}
        {widgets}
        {pomodoro}
        {meter}
        {ledger}
        {devops}
        naming={nameFor}
        onreveal={revealRow}
        onopen={(url) => void skein.openLink(url)}
        ambience={ambience.active}
        {focusedId}
        draft={previewDraft}
        draftIds={targetIds}
        chipsFor={(cwd) => {
          const c = skein.convs.find((c) => c.cwd === cwd);
          if (!c) return [];
          return skein.groupsFor(c.projectId).map((g) => ({
            id: g.group.id,
            label: g.group.label,
            state: g.overall,
            running: g.running,
          }));
        }}
        actionsFor={(cwd) => actions.chipsFor(cwd)}
        conflictFor={(cwd) => conflictBadge(actions.status[cwd] ?? NO_STATUS)}
        onaction={(cwd, id) => void actions.run(cwd, id)}
        onresolve={(cwd) => void resolveConflicts(cwd)}
        onadd={(dir, wt) =>
          /* The chat territory's `+` means the thing that territory holds.
             Routed here rather than in `Canvas`, which knows where a territory
             is drawn and has no business knowing what belongs in one. */
          skein.isChatHome(dir) ? openChat() : openIn(dir, wt)}
        onserver={(groupId) => {
          const g = skein.groups.find((g) => g.group.id === groupId);
          if (!g) return;
          void (g.running ? skein.stopGroup(g) : skein.startGroup(g));
        }}
        onfocus={(id) => (focusedId = id)}
        {ondeselect}
        onclose={closeConv}
        onpin={(id) => savePlacement(id)}
        onplace={(cwd, x, y) => skein.placeProject(cwd, x, y)}
        onstick={(id) => savePlacement(id)}
        onstickproject={(cwd, at) => skein.stickProject(cwd, at)}
      />
      {#if focused && showDetail}
        <aside class="side" style:width="{panelPx}px">
          <!-- The border, made draggable. `role="presentation"` for the same
               reason the studio root has one: this is a gesture surface, not a
               control, and there is nothing here to announce. -->
          <div
            class="grip"
            class:on={grip}
            role="presentation"
            title="drag to resize · double-click to reset"
            onpointerdown={gripDown}
            onpointermove={gripMove}
            onpointerup={gripUp}
            onpointercancel={gripUp}
            ondblclick={gripReset}
          ></div>
          <Transcript
            bind:this={transcript}
            conv={focused}
            read={reading}
            watching={attention.focused}
            onhistory={(c) => void skein.loadHistory(c)}
            onlink={(href) => void skein.openLink(href)}
            onread={setRead}
          />
        </aside>
      {/if}
    {:else}
      <div class="empty">
        <p>{skein.loaded ? "Nothing open yet." : "Waking the studio…"}</p>
        <p class="sub">
          Drop a project folder anywhere on this wall to start a conversation in
          it. It spawns headless — no terminal, just the stream.
        </p>
        <p class="sub">
          Drop an image instead and it gets pinned up as reference.
        </p>
      </div>
    {/if}
  </main>

  <footer class="dock">
    <!-- A blocked card jumps the queue: it is the only state where an agent is
         genuinely stopped, so answering it comes before anything else. -->
    {#if skein.blocked.length}
      {@const target = focused?.pendingAsk ? focused : skein.blocked[0]}
      <Ask
        conv={target}
        onanswer={() => skein.answerAsk(target)}
        onlink={(href) => void skein.openLink(href)}
      />
      {#if skein.blocked.length > 1}
        <button class="more" onclick={() => (focusedId = skein.blocked.find((c) => c !== target)?.id ?? focusedId)}>
          {skein.blocked.length - 1} more waiting on an answer
        </button>
      {/if}
    {/if}

    <div class="targets">
      {#if targets.length > 1}
        <span class="count bcast">Broadcast to {targets.length}</span>
        {#each targets as t (t.id)}
          <span class="tgt" class:clash={clashing.includes(t.id)}>
            <b>{t.project}</b>
            {nameBesideProject(t.title)}
          </span>
        {/each}
      {:else if focused}
        <span class="count">To</span>
        <span class="tgt"><b>{focused.project}</b> {nameBesideProject(focused.title)}</span>
        {#if focused.dormant}
          <span class="hint">dormant — will wake on send</span>
        {/if}
        <!-- Said here as well as on the card, because this is the one place
             where it is about to stop being true: a prompt picks the card back
             up, and a card quietly rejoining the waiting cycle is worth one
             clause of warning rather than a surprise later. -->
        {#if focused.aside}
          <span class="hint">set aside — sending picks it back up</span>
        {/if}
        {#if focused.interrupted}
          <span class="hint warn">last turn was interrupted</span>
        {/if}
      {:else}
        <span class="count dim">No card focused</span>
      {/if}
      <!-- The counterpart of the send below it, and only ever offered while
           there is a turn to end. It names the card when the row above is a
           broadcast readout, because "stop" beside a list of four is a
           question rather than a verb — the key and the button both aim at
           the focused card alone. -->
      {#if focused?.working}
        <button class="stop" onclick={() => skein.stop(focused)}>
          <span class="sq"></span>
          stop{targets.length > 1 ? ` ${focused.project}` : ""}
          <span class="kbd">esc</span>
        </button>
      {/if}
      <span class="grow"></span>
      {#if waiting.length}
        <button class="cycle" onclick={() => cycleWaiting(1)}>
          {waiting.length} waiting <span class="kbd">⇥</span>
        </button>
      {/if}
    </div>
    {#if clashing.length > 1}
      <div class="clashwarn">
        <span>⚠</span>
        <span>
          {clashing.length} of these {targets.length} have edited the same files —
          they'll work on one tree
        </span>
      </div>
    {/if}

    <!-- Above the field, so it grows towards the wall rather than pushing the
         field down under the cursor that is typing into it.

         Two stages, never both: the commands, and then — for one that takes a
         fixed set of values — the values. Listed here are Skein's own and the
         handful of the CLI's that this window knows the shape of; everything
         else the agent offers is its business, and there is no way to enumerate
         it from here. -->
    {#if choices.length && choosing}
      <div class="palette" role="listbox" aria-label="/{choosing.cmd.name} values">
        {#each choices as choice, i (choice.value)}
          {@const on = choice === choicePick}
          <button
            class="cmd"
            class:on
            role="option"
            aria-selected={on}
            onmousedown={(e) => {
              /* mousedown, not click: the field must not lose focus first, or
                 the draft is cleared while the caret is somewhere else. */
              e.preventDefault();
              commandAt = i;
              void sendText(
                completionForChoice(choosing!.cmd, choice),
                targets.length > 1,
              );
            }}
            onmouseenter={() => (commandAt = i)}
          >
            <span class="name">{choice.value}</span>
            <span class="summary">{choice.summary}</span>
            <span class="grow"></span>
            {#if targets.length > 1}
              <span class="reach">{targets.length} cards</span>
            {/if}
          </button>
        {/each}
        <p class="detail">{choosing.cmd.detail}</p>
      </div>
    {:else if commands.length}
      <div class="palette" role="listbox" aria-label="skein commands">
        {#each commands as cmd, i (cmd.name)}
          {@const on = cmd === commandPick}
          <button
            class="cmd"
            class:on
            role="option"
            aria-selected={on}
            onmousedown={(e) => {
              /* mousedown, not click: the field must not lose focus first, or
                 the draft is cleared while the caret is somewhere else. */
              e.preventDefault();
              commandAt = i;
              void runCommand(cmd, targets.length > 1);
            }}
            onmouseenter={() => (commandAt = i)}
          >
            <!-- The ellipsis is the menus' own convention for a gesture that
                 opens something further rather than doing a thing: this row
                 leads to the values, and Enter on it says so by showing them. -->
            <span class="name">/{cmd.name}{cmd.choices ? "…" : ""}</span>
            <span class="summary">{cmd.summary}</span>
            <span class="grow"></span>
            <!-- A click is the one way in here that does not pass through the
                 Ctrl gate, so the row has to say how far it reaches. The
                 keyboard path still costs the modifier. -->
            {#if targets.length > 1}
              <span class="reach">{targets.length} cards</span>
            {/if}
          </button>
        {/each}
        {#if commandPick}
          <p class="detail">{commandPick.detail}</p>
        {/if}
      </div>
    {/if}

    <!-- The `!` line's own two rows, above the field like the palette and for
         the same reason: they grow towards the wall rather than pushing the
         field down under the cursor typing into it.

         Never up at the same time as the palette — one needs a leading slash
         and the other a leading bang — so this is its own block rather than
         another arm of that chain. -->
    {#if banging}
      {#if bang.offer}
        <div class="palette bang" role="listbox" aria-label="what the shell offers">
          {#each bang.offer.matches as m, i (m.text + i)}
            {@const on = m === bang.lit}
            <button
              class="cmd"
              class:on
              role="option"
              aria-selected={on}
              onmousedown={(e) => {
                /* mousedown, not click: the field must not lose focus first, or
                   the caret is somewhere else by the time the text lands. */
                e.preventDefault();
                bang.at = i;
                void takeCompletion(bang.offer!, m);
              }}
              onmouseenter={() => (bang.at = i)}
            >
              <span class="name">{m.label}</span>
              <span class="summary">{kindLabel(m.kind)}</span>
              <span class="grow"></span>
            </button>
          {/each}
        </div>
      {/if}
      <!-- Which directory, because that is the whole of what a `!` line needs
           you to know and the one thing the field itself cannot say. It also
           replaces the dock's usual claim about reach: a run is one directory,
           so the target line's "5 cards" would be a lie here. -->
      <p class="bangbar">
        <span class="where">{bangCard ? promptPath(bangCard.cwd, "") : "no card"}</span>
        {#if bangCard?.bangCmd}
          <span class="going">running {bangCard.bangCmd} · esc stops it</span>
        {:else if bang.asking}
          <span class="going">asking the shell…</span>
        {:else}
          <span class="hint">↵ run · ctrl ↵ run and tell the agent · tab completes</span>
        {/if}
      </p>
    {/if}

    <div class="field">
      <!-- The highlight is drawn *behind* a transparent textarea, which is why
           `tokens` has to concatenate back to exactly what went in: one dropped
           space and every colour on the line sits over the wrong character. The
           `!` is drawn here rather than tokenised, since it is the mode marker
           and not part of the command — and the remainder is passed untrimmed,
           because trimming it would shift everything after a leading space. -->
      <div class="ink" class:shell={banging}>
        {#if banging}
          <div class="ghost" aria-hidden="true"><span class="t-mark"
              >{BANG}</span
            >{#each tokens(draft.slice(BANG.length)) as t, i (i)}<span
                class="t-{t.kind}">{t.text}</span
              >{/each}</div>
        {/if}
        <textarea
          bind:this={prompt}
          bind:value={draft}
          onkeydown={onDraftKey}
          placeholder={banging
            ? "run a command in this card's directory…"
            : targets.length > 1
              ? `Say something to all ${targets.length}…`
              : focused
                ? "Say something…"
                : "Open a conversation first"}
          disabled={targets.length === 0}
          spellcheck={!banging}
          rows="1"
        ></textarea>
      </div>
      <span class="key">{banging || targets.length <= 1 ? "↵" : "Ctrl ↵"}</span>
    </div>
  </footer>

  <!-- The break, taken. Last in the studio and above everything in it, panel
       and dock included — this is the one thing in the app that stops *you*
       rather than reporting on something, and the work carries on behind it. -->
  {#if pomodoro.resting}
    <Rest {pomodoro} />
  {/if}
</div>

<style>
  .studio {
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--ink);
    position: relative;
  }
  /* A faint warm bloom from above, like light falling on a studio wall. */
  .studio::before {
    content: "";
    position: absolute;
    inset: 0 0 auto 0;
    height: 46%;
    background: radial-gradient(
      120% 100% at 50% 0%,
      rgba(233, 161, 59, 0.05),
      transparent 70%
    );
    pointer-events: none;
  }

  /* The horizon: the day's spend, carried by the ground rather than by a
     number in a corner. It warms from nothing to a low band of light as the
     total climbs, so you feel the day getting expensive before you ever go
     looking for the figure — and it stays warm across a restart, since what it
     reads is the day and not this run of the app. */
  .studio::after {
    content: "";
    position: absolute;
    inset: auto 0 0 0;
    height: 38%;
    background: linear-gradient(
      to top,
      rgba(233, 161, 59, calc(0.16 * var(--burn, 0))),
      transparent 78%
    );
    pointer-events: none;
    transition: background 2s ease;
    z-index: 0;
  }

  .bar,
  .dock,
  .wall {
    position: relative;
    z-index: 1;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    padding: 0.6rem 0.9rem;
    border-bottom: 1px solid var(--edge);
    flex: 0 0 auto;
    user-select: none;
  }
  .bar button {
    user-select: auto;
  }
  .wordmark {
    font-family: var(--display);
    font-size: 1.05rem;
    letter-spacing: -0.01em;
  }
  .tag {
    font-family: var(--util);
    font-size: 0.66rem;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--paper-faint);
    white-space: nowrap;
  }
  .grow {
    flex: 1 1 auto;
  }

  .open {
    font-family: var(--util);
    font-size: 0.74rem;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper);
    padding: 0.35rem 0.7rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .open:hover:not(:disabled) {
    background: var(--raised);
    border-color: var(--rule);
  }
  .open:disabled {
    color: var(--paper-faint);
    cursor: default;
  }

  .zoom {
    font-family: var(--mono);
    font-size: 0.66rem;
    color: var(--st-work);
    min-width: 4ch;
  }
  /* The figure exists for when you do go looking; the horizon is what you
     actually read without looking. */
  .spend {
    font-family: var(--mono);
    font-size: 0.68rem;
    color: var(--paper-mute);
    font-variant-numeric: tabular-nums;
  }
  .livecount {
    font-family: var(--util);
    font-size: 0.66rem;
    color: var(--st-work);
  }
  /* Deliberately the fail colour: this is a hole in the wall, and it should
     look like one for as long as it is open. */
  .ctl {
    font-family: var(--mono);
    font-size: 0.62rem;
    color: var(--st-fail);
    border: 1px solid color-mix(in srgb, var(--st-fail) 40%, var(--edge));
    border-radius: 3px;
    padding: 0.06rem 0.34rem;
    white-space: nowrap;
  }
  .ghost {
    font-family: var(--util);
    font-size: 0.7rem;
    background: none;
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper-mute);
    padding: 0.22rem 0.5rem;
    cursor: pointer;
  }
  .ghost:hover {
    color: var(--paper);
    border-color: var(--rule);
  }
  .ghost.on {
    color: var(--paper);
    border-color: var(--paper-faint);
  }

  .fault {
    display: block;
    width: 100%;
    text-align: left;
    font-family: var(--mono);
    font-size: 0.7rem;
    color: var(--st-fail);
    padding: 0.5rem 0.9rem;
    border: 0;
    border-bottom: 1px solid var(--edge);
    background: color-mix(in srgb, var(--st-fail) 8%, var(--ink));
    cursor: pointer;
  }

  .wall {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }
  /* Width is set inline from `panelWidth` — see the note by `gripDown`. It must
     not be given one here as well, or a drag would fight a stylesheet. */
  .side {
    flex: 0 0 auto;
    min-height: 0;
    display: flex;
    padding: 0.8rem 0.8rem 0.8rem 0;
    border-left: 1px solid var(--edge);
    /* The grip hangs on this. */
    position: relative;
  }

  /* Seven pixels of hit area over a one-pixel line, because nobody can hit a
     one-pixel line. It sits mostly *outside* the panel, over the wall — three
     pixels in, which is nowhere near the rails, and the wall under it still
     pans everywhere the cursor is not this. Invisible until asked for: an edge
     you can drag should say so under the cursor, not draw a second border down
     the middle of the window all day. */
  /* The whole wall wears the resize cursor for the length of the drag, and
     stops being selectable: the pointer is captured by the grip, so what is
     under it is irrelevant, but a cursor that flickered between `grab` and
     `col-resize` as it crossed the boundary would say the gesture had ended. */
  .wall.sizing {
    cursor: col-resize;
    user-select: none;
  }
  .grip {
    position: absolute;
    top: 0;
    bottom: 0;
    left: -4px;
    width: 7px;
    cursor: col-resize;
    z-index: 3;
    /* Refuses the text selection a drag would otherwise start, at the source —
       which is what lets `gripDown` leave the default alone. See the note
       there: `preventDefault` on pointerdown takes `dblclick` with it. */
    user-select: none;
  }
  .grip::after {
    content: "";
    position: absolute;
    inset: 0 3px;
    background: var(--paper-faint);
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  .grip:hover::after,
  .grip.on::after {
    opacity: 1;
  }

  .empty {
    margin: auto;
    text-align: center;
    max-width: 46ch;
  }
  .empty p {
    margin: 0;
    color: var(--paper-mute);
  }
  .empty .sub {
    font-family: var(--util);
    font-size: 0.82rem;
    color: var(--paper-faint);
    margin-top: 0.5rem;
    line-height: 1.5;
  }

  .dock {
    flex: 0 0 auto;
    border-top: 1px solid var(--edge);
    padding: 0.6rem 0.9rem 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }
  .targets {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-family: var(--util);
    font-size: 0.7rem;
  }
  .count {
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.11em;
    text-transform: uppercase;
    color: var(--paper);
  }
  .count.dim {
    color: var(--paper-faint);
  }
  .tgt {
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.08rem 0.42rem;
    color: var(--paper-dim);
    font-size: 0.69rem;
    max-width: 40ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tgt b {
    color: var(--paper-faint);
    font-weight: 600;
  }
  .hint {
    font-size: 0.66rem;
    color: var(--paper-faint);
  }
  .hint.warn {
    color: var(--st-soft);
  }
  .count.bcast {
    color: var(--st-ask);
  }
  .tgt.clash {
    border-color: color-mix(in srgb, var(--st-ask) 50%, var(--edge));
  }
  .clashwarn {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-family: var(--util);
    font-size: 0.72rem;
    color: var(--st-ask);
  }

  .cycle {
    font-family: var(--util);
    font-size: 0.68rem;
    background: none;
    border: 1px solid color-mix(in srgb, var(--st-ask) 45%, var(--edge));
    border-radius: 3px;
    color: var(--st-ask);
    padding: 0.1rem 0.45rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .cycle:hover {
    background: color-mix(in srgb, var(--st-ask) 12%, transparent);
  }
  /* Celadon, like the card it acts on: this button only exists while something
     is working, so the colour is that status rather than a decoration. */
  .stop {
    font-family: var(--util);
    font-size: 0.68rem;
    background: none;
    border: 1px solid color-mix(in srgb, var(--st-work) 45%, var(--edge));
    border-radius: 3px;
    color: var(--st-work);
    padding: 0.1rem 0.45rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    white-space: nowrap;
  }
  .stop:hover {
    background: color-mix(in srgb, var(--st-work) 12%, transparent);
  }
  /* Drawn, not typed. `■` falls through to Segoe UI Emoji on this machine and
     comes out as somebody else's blue — the same trap the ambience panel's
     layer-order buttons avoid by saying "back" and "front" in words. */
  .stop .sq {
    width: 0.42rem;
    height: 0.42rem;
    background: currentColor;
    border-radius: 1px;
  }

  .more {
    align-self: flex-start;
    font-family: var(--util);
    font-size: 0.68rem;
    background: none;
    border: 0;
    color: var(--st-ask);
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .kbd {
    font-family: var(--mono);
    font-size: 0.64rem;
    color: var(--paper-faint);
  }

  /* Achromatic, like the rest of the chrome: colour on this wall is status, and
     a command that has not run yet has none. */
  .palette {
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.25rem;
    gap: 1px;
  }
  .palette .cmd {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    width: 100%;
    background: none;
    border: 0;
    border-radius: 2px;
    padding: 0.3rem 0.45rem;
    text-align: left;
    cursor: pointer;
    color: var(--paper-dim);
    font-family: var(--util);
    font-size: 0.74rem;
  }
  .palette .cmd.on {
    background: var(--raised);
    color: var(--paper);
  }
  .palette .name {
    font-family: var(--mono);
    font-size: 0.72rem;
  }
  .palette .summary {
    color: var(--paper-mute);
  }
  .palette .grow {
    flex: 1 1 auto;
  }
  .palette .reach {
    color: var(--paper-mute);
    font-size: 0.68rem;
  }
  .palette .cmd.on .summary {
    color: var(--paper-dim);
  }
  /* One line about the lit entry, since a summary short enough to scan cannot
     also say what will be lost. */
  .palette .detail {
    margin: 0.15rem 0.45rem 0.2rem;
    padding-top: 0.3rem;
    border-top: 1px solid var(--edge);
    color: var(--paper-mute);
    font-family: var(--util);
    font-size: 0.7rem;
  }

  .field {
    display: flex;
    align-items: flex-end;
    gap: 0.6rem;
    background: var(--well);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.5rem 0.65rem;
  }
  /* ── the `!` line ────────────────────────────────────────────────────────
     The field holds two things in the same box: a textarea whose text is
     transparent, and the coloured copy of it underneath. */
  .ink {
    position: relative;
    flex: 1 1 auto;
    display: flex;
  }
  .ghost {
    position: absolute;
    inset: 0;
    pointer-events: none;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    overflow: hidden;
  }
  /* Both halves get the same metrics, or the colours drift off the characters as
     the line grows. */
  .ink.shell textarea,
  .ink.shell .ghost {
    font-family: var(--mono);
    font-size: 0.82rem;
    line-height: 1.45;
  }
  .ink.shell textarea {
    /* The caret stays, which is the whole trick: the text is drawn once,
       underneath, and this is only where it is typed. */
    color: transparent;
    caret-color: var(--paper);
  }
  .ink.shell textarea::selection {
    /* Transparent text with an ordinary selection is an invisible highlight, so
       the selection has to be something you can see against the ghost. */
    background: var(--edge);
  }

  /* Colour on a shell line, which is the one place on this wall it is not
     status. The exemption is `ansi.ts`'s, already taken and for the same reason:
     a terminal register reads by hue — that is how every shell on earth is read
     — and these are the same warm-neutral takes on the standard 16 that the
     console panel renders output with, so a `!` line looks like it belongs on an
     ink wall rather than in somebody else's editor. Amber is deliberately absent:
     it means "wants you" here, and nothing in a line you are typing does. */
  .t-mark {
    color: var(--paper-mute);
  }
  .t-cmd {
    color: var(--paper);
    font-weight: 600;
  }
  .t-param {
    color: #9bb8d8;
  }
  .t-str {
    color: #9bd4bf;
  }
  .t-var {
    color: #c4a8d8;
  }
  .t-num {
    color: #8fd0d0;
  }
  .t-op {
    color: var(--paper-mute);
  }
  .t-comment {
    color: var(--paper-faint);
    font-style: italic;
  }
  .t-plain {
    color: var(--paper-dim);
  }

  /* Where it will run, and what the keys do. The register of a meta note — this
     is the dock talking about itself rather than anything an agent said. */
  .bangbar {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin: 0 0 0.35rem;
    font-family: var(--util);
    font-size: 0.68rem;
    color: var(--paper-faint);
  }
  .bangbar .where {
    font-family: var(--mono);
    color: var(--paper-mute);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* Celadon, because a run is working and that is what celadon means here. */
  .bangbar .going {
    color: var(--st-work);
  }
  .bangbar .hint {
    margin-left: auto;
    white-space: nowrap;
  }
  /* The offering reuses the palette's rows — it is the same gesture over a
     different vocabulary — and only the leading column differs: a completion is
     a thing you are about to type, so it is set in the mono it will land in. */
  .palette.bang .name {
    font-family: var(--mono);
  }

  .field textarea {
    flex: 1 1 auto;
    background: none;
    border: 0;
    resize: none;
    color: var(--paper);
    font-family: var(--body);
    font-size: 0.9rem;
    line-height: 1.45;
    max-height: 7rem;
    field-sizing: content;
  }
  .field textarea:focus {
    outline: none;
  }
  .field textarea::placeholder {
    color: var(--paper-faint);
  }
  .key {
    font-family: var(--mono);
    font-size: 0.66rem;
    color: var(--paper-faint);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.06rem 0.32rem;
  }
</style>
