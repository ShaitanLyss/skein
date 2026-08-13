<script lang="ts">
  import { onDestroy, tick } from "svelte";
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
  import {
    WIDGETS,
    optionFor,
    optionsOf,
    variantsOf,
    VARIANT,
    type WidgetKind,
  } from "./lib/widgets";
  import { Ambience } from "./lib/ambience.svelte";
  import { Actions } from "./lib/actions.svelte";
  import { Control } from "./lib/control.svelte";
  import Canvas from "./lib/Canvas.svelte";
  import Ask from "./lib/Ask.svelte";
  import ContextMenu from "./lib/ContextMenu.svelte";
  import Effects from "./lib/Effects.svelte";
  import Import from "./lib/Import.svelte";
  import { menuFor, type MenuItem, type MenuTarget } from "./lib/menu";
  import { selectionMarkdown } from "./lib/copy";
  import Transcript from "./lib/Transcript.svelte";
  import Servers from "./lib/Servers.svelte";
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
  /* The wall's own weather. Owns no subscriptions, so unlike the four below it
     needs nothing releasing on destroy. */
  const ambience = new Ambience();
  /* Project verbs. Its faults go to the same red bar everything else's do —
     a build that failed is not a different kind of news from a spawn that did. */
  const actions = new Actions((message) => (skein.fault = message));
  const attention = new Attention(
    () => skein.convs,
    (id) => {
      focusedId = id;
      studio.selectOnly(id);
    },
  );

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
    /* Not a subscription but the same hazard: a superseded generation's sampler
       would go on enumerating every process on the machine every two seconds
       for a wall nobody can see. */
    meter.stop();
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
  let showDetail = $state(true);
  let showServers = $state(false);
  let showEffects = $state(false);
  let focusedId = $state<string | null>(null);
  let draft = $state("");
  /** The dock's field, so typing on the wall can hand it the keystroke. */
  let prompt: HTMLTextAreaElement | undefined = $state();
  let spawning = $state(false);

  const focused = $derived(skein.convs.find((c) => c.id === focusedId) ?? null);

  /* Paint the wall from disk, then start the servers. Deliberately no agent. */
  $effect(() => {
    void skein.load();
    void board.load();
    void widgets.load();
    void ambience.load();
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

  /* How loudly each tier is asking. Drives both the Ctrl+Tab order and the count
     in the dock, so "what wants me" is defined in exactly one place.
     Plain Tab walks the whole wall in reading order (`cycleConv`) — that is a
     navigation gesture and has nothing to do with urgency. */
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
    if (spawning) return;
    spawning = true;
    const conv = await skein.open(dir, worktree);
    if (conv) {
      focusedId = conv.id;
      studio.selectOnly(conv.id);
    }
    spawning = false;
  }

  /* Adoption: conversations that already exist on disk, from the CLI or from a
     card that was closed. The list is read when the panel opens rather than
     kept current — it is a catalogue of files, and scanning them all on a timer
     would be work nobody asked for. */
  let showImport = $state(false);
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
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    /* The transcript is the one place in this app you are meant to be able to
       select text, so a drag that starts on its edge must say it is not that. */
    e.preventDefault();
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
        };
        act = (id) => {
          if (id === "wake") void skein.wake(conv);
          /* The session id is what `--resume` takes, and this is the only place
             the UI hands it over — see the note on adoption in CLAUDE.md. */
          else if (id === "copy-resume") void copyText(`claude --resume ${conv.id}`);
          else if (id === "copy-cwd") void copyText(conv.cwd);
          else if (id === "unpin") {
            studio.unpin(conv.id);
            void skein.savePlacement(conv.id, 0, 0, false);
          } else if (id === "close") void closeConv(conv);
        };
      }
    } else if (imageEl?.dataset.image) {
      const id = imageEl.dataset.image;
      target = { kind: "image" };
      act = (which) => {
        if (which === "front") board.bringToFront(id);
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
          picks: variantsOf(w.kind).map((v) => ({
            id: v.value,
            label: v.label,
            on: v.value === now,
          })),
          options: optionsOf(w),
        };
        act = (which) => {
          if (which.startsWith("set:")) {
            widgets.set(id, VARIANT, which.slice(4));
          } else if (which.startsWith("cfg:")) {
            const o = optionFor(w, which);
            if (o) widgets.set(id, o.key, o.value);
          } else if (which === "front") widgets.bringToFront(id);
          else if (which === "remove") void widgets.remove(id);
        };
      }
    } else if (regionEl?.dataset.cwd) {
      const cwd = regionEl.dataset.cwd;
      target = {
        kind: "region",
        empty: !skein.convs.some((c) => c.cwd === cwd),
        moved: territoryMoved(cwd),
        offers: widgetOffers(),
      };
      act = (id) => {
        if (id === "new") void openIn(cwd);
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
      return c ? (c.title && c.title !== "untitled" ? c.title : c.project) : "a conversation";
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

  async function send(broadcast = false) {
    const text = draft.trim();
    if (!text || targets.length === 0) return;
    /* Friction scales with reach: Enter sends to one, Ctrl+Enter to many.
       With permissions bypassed a broadcast is the most destructive gesture in
       the app, and one modifier is the cheapest possible insurance. */
    if (targets.length > 1 && !broadcast) return;
    draft = "";
    if (targets.length === 1) await skein.send(targets[0], text);
    else await skein.broadcast(targets, text);
  }

  function cycleWaiting() {
    if (waiting.length === 0) return;
    const at = waiting.findIndex((c) => c.id === focusedId);
    focusCard(waiting[(at + 1) % waiting.length]);
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
    /* Tab reaches the wall from inside the field too — you write to one card,
       then step to the next without going by way of the mouse. */
    if (e.key === "Tab") {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) cycleWaiting();
      else cycleConv(e.shiftKey ? -1 : 1);
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(e.ctrlKey || e.metaKey);
    }
  }

  async function onGlobalKey(e: KeyboardEvent) {
    if (e.key === "F11") {
      e.preventDefault();
      const win = getCurrentWindow();
      await win.setFullscreen(!(await win.isFullscreen()));
    } else if (e.key === "Home") {
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
    } else if (e.key === "Escape") {
      /* One step back out, innermost first. Anything that closes on Escape owns
         the key while it is open — the menu and the import panel both listen on
         the window themselves, so this only has to stay out of their way, and
         it runs first because App mounts before either of them.

         A field is a step of its own: Escape with the caret in the draft means
         "give the wall the key back", not "throw away what I aimed this at".
         Letting go of the card there would leave a written prompt pointed at
         nothing, so the draft survives and a second press does the deselect. */
      if (menu || showImport) return;
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
      if (focused?.working) void skein.stop(focused);
      else if (board.selected) board.selected = null;
      else if (widgets.selected) widgets.selected = null;
      else ondeselect();
    } else if (e.key === "Tab" && !isTyping(e.target)) {
      /* Tab means "the next card" everywhere on the wall, not only in the dock.
         It does cost the browser's own focus ring, which would otherwise walk a
         card's close button and the transcript's links — reachable by mouse, and
         not by Tab, deliberately: a card is the only thing on this wall there
         are dozens of, and stepping between them is what the key is for.
         Fields keep their Tab (`isTyping`); the draft field claims it back for
         this in onDraftKey, since that is where you already are when you want
         the next card. */
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) cycleWaiting();
      else cycleConv(e.shiftKey ? -1 : 1);
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

  /* The horizon saturates around $20 of session spend — far enough that a
     normal afternoon barely lifts it, close enough that a runaway wall is
     unmistakable without anyone reading a number. */
  const HORIZON_FULL_USD = 20;
  const burn = $derived(Math.min(1, skein.spend / HORIZON_FULL_USD));

  async function closeConv(conv: Conversation) {
    await skein.close(conv);
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
    ambience,
    attention,
    actions,
    canvas: () => canvas,
    focusedId: () => focusedId,
    setFocused: (id) => (focusedId = id),
    deselect: ondeselect,
    draft: () => draft,
    setDraft: (t) => (draft = t),
    targets: () => targets,
    waiting: () => waiting,
    clashing: () => clashing,
    openIn,
    submit: send,
    flags: () => ({ showDetail, showServers, showEffects, chime: attention.chime }),
    setFlag: (name, value) => {
      if (name === "showDetail") showDetail = value;
      else if (name === "showServers") showServers = value;
      else if (name === "showEffects") showEffects = value;
      else if (name === "chime") attention.chime = value;
    },
  });
</script>

<svelte:window onkeydown={onGlobalKey} bind:innerWidth={winW} />

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
      <span
        class="spend"
        title="{skein.heldTokens.toLocaleString()} tokens held across the wall"
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

  <main class="wall">
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
        {meter}
        naming={nameFor}
        onreveal={revealRow}
        ambience={ambience.active}
        {focusedId}
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
        onaction={(cwd, id) => void actions.run(cwd, id)}
        onadd={(dir, wt) => openIn(dir, wt)}
        onserver={(groupId) => {
          const g = skein.groups.find((g) => g.group.id === groupId);
          if (!g) return;
          void (g.running ? skein.stopGroup(g) : skein.startGroup(g));
        }}
        onfocus={(id) => (focusedId = id)}
        {ondeselect}
        onclose={closeConv}
        onpin={(id, x, y) => skein.savePlacement(id, x, y, true)}
        onplace={(cwd, x, y) => skein.placeProject(cwd, x, y)}
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
            conv={focused}
            read={reading}
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
        onanswer={(text) => skein.answerAsk(target, text)}
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
            {t.title}
          </span>
        {/each}
      {:else if focused}
        <span class="count">To</span>
        <span class="tgt"><b>{focused.project}</b> {focused.title}</span>
        {#if focused.dormant}
          <span class="hint">dormant — will wake on send</span>
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
        <button class="cycle" onclick={cycleWaiting}>
          {waiting.length} waiting <span class="kbd">⌃⇥</span>
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

    <div class="field">
      <textarea
        bind:this={prompt}
        bind:value={draft}
        onkeydown={onDraftKey}
        placeholder={targets.length > 1
          ? `Say something to all ${targets.length}…`
          : focused
            ? "Say something…"
            : "Open a conversation first"}
        disabled={targets.length === 0}
        rows="1"
      ></textarea>
      <span class="key">{targets.length > 1 ? "Ctrl ↵" : "↵"}</span>
    </div>
  </footer>
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
     total climbs, so you feel the session getting expensive before you ever
     go looking for the figure. */
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
  .grip {
    position: absolute;
    top: 0;
    bottom: 0;
    left: -4px;
    width: 7px;
    cursor: col-resize;
    z-index: 3;
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

  .field {
    display: flex;
    align-items: flex-end;
    gap: 0.6rem;
    background: var(--well);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.5rem 0.65rem;
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
