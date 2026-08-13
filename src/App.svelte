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
    Studio,
    layout,
    clampPanel,
    panelDefault,
    PANEL_MIN,
    PANEL_MAX,
  } from "./lib/studio.svelte";
  import { Skein, type Session } from "./lib/skein.svelte";
  import { Board } from "./lib/images.svelte";
  import { Ambience } from "./lib/ambience.svelte";
  import { Actions, conflictBadge, conflictPrompt, NO_STATUS } from "./lib/actions.svelte";
  import { Control } from "./lib/control.svelte";
  import Canvas from "./lib/Canvas.svelte";
  import Ask from "./lib/Ask.svelte";
  import ContextMenu from "./lib/ContextMenu.svelte";
  import Effects from "./lib/Effects.svelte";
  import Import from "./lib/Import.svelte";
  import {
    completionFor,
    matchCommands,
    resolveCommand,
    typingName,
    type Command,
  } from "./lib/commands";
  import { menuFor, type MenuItem, type MenuTarget } from "./lib/menu";
  import Transcript from "./lib/Transcript.svelte";
  import Servers from "./lib/Servers.svelte";
  import WindowControls from "./lib/WindowControls.svelte";

  const studio = new Studio();
  const skein = new Skein(studio);
  const board = new Board();
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

  /* ── the transcript panel's edge ─────────────────────────────────────────
   *
   * The width is the studio's, saved beside the viewport; the ceiling is the
   * window's, so it is read afresh as the window changes rather than baked
   * into whatever was saved on whatever monitor. */
  let viewW = $state(window.innerWidth);
  const panelW = $derived(
    clampPanel(studio.panel ?? panelDefault(viewW), viewW),
  );
  let sizing = $state(false);
  let sizeFromX = 0;
  let sizeFromW = 0;

  function setPanel(w: number) {
    studio.panel = clampPanel(w, viewW);
  }

  function sizeStart(e: PointerEvent) {
    /* Captured, because a 7px grip is not somewhere the cursor is going to
       stay: without this the drag would end the moment it crossed onto the
       wall, which is the direction that widens the panel. */
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    sizing = true;
    sizeFromX = e.clientX;
    sizeFromW = panelW;
    /* Deliberately no `preventDefault`: it suppresses the compatibility mouse
       events, and with them `dblclick` — so the reset below could never fire,
       which is exactly how it shipped for an afternoon. What the default would
       have cost us instead is a text selection dragged out of the grip, and
       `user-select: none` on the grip itself refuses that at the source.
       Probed 2026-08-13 through the control surface: two real clicks on the
       grip left the panel at 900. */
  }

  function sizeMove(e: PointerEvent) {
    /* The panel is on the right, so leftwards is wider. */
    if (sizing) setPanel(sizeFromW + (sizeFromX - e.clientX));
  }

  function sizeEnd(e: PointerEvent) {
    if (!sizing) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    sizing = false;
    /* Once, at the end. A localStorage write per pointermove is the same
       mistake the viewport does not make during a pan. */
    studio.save();
  }

  /** Back to the default — which is to say, back to tracking the window. */
  function sizeReset() {
    studio.panel = null;
    studio.save();
  }

  function sizeKey(e: KeyboardEvent) {
    const step = e.shiftKey ? 48 : 12;
    if (e.key === "ArrowLeft") setPanel(panelW + step);
    else if (e.key === "ArrowRight") setPanel(panelW - step);
    else return;
    /* The wall's own keydown is on `window` and would read these as something
       else entirely; the grip is focused, so it has first claim on them. */
    e.preventDefault();
    e.stopPropagation();
    studio.save();
  }

  const focused = $derived(skein.convs.find((c) => c.id === focusedId) ?? null);

  /* Paint the wall from disk, then start the servers. Deliberately no agent. */
  $effect(() => {
    void skein.load();
    void board.load();
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
          /* Something to clear means a turn taken or one under way — not a
             line on screen, which a *cleared* card still has (its own "cleared"
             note), and which would leave the item offered forever on a card
             with nothing left to clear. `working` earns its place: abandoning a
             first turn that is going wrong is exactly when this is wanted. */
          spoken: conv.everSpoke || conv.working,
        };
        act = (id) => {
          if (id === "wake") void skein.wake(conv);
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
    } else if (regionEl?.dataset.cwd) {
      const cwd = regionEl.dataset.cwd;
      target = {
        kind: "region",
        empty: !skein.convs.some((c) => c.cwd === cwd),
        moved: territoryMoved(cwd),
      };
      act = (id) => {
        if (id === "new") void openIn(cwd);
        else if (id === "new-worktree") canvas?.startBranch(cwd);
        else if (id === "adopt") void openImport();
        else if (id === "image") void pickImage(where);
        else if (id === "reflow") skein.placeProject(cwd, null, null);
        else if (id === "forget") void skein.forgetProject(cwd);
      };
    } else if (el.closest(".surface")) {
      target = { kind: "ground" };
      act = (id) => {
        if (id === "open") void pickFolder();
        else if (id === "adopt") void openImport();
        else if (id === "image") void pickImage(where);
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
        if (id === "copy") void copyText(selected);
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

  /** Which palette entry is lit. Clamped at use, since the list shortens as
   *  you type and an index left past the end would light nothing. */
  let commandAt = $state(0);
  /** Escape dismissed the palette for this draft — the text stays, so `/clear`
   *  can still be sent to an agent as words if that is what you meant. */
  let commandsOff = $state(false);
  const commands = $derived(commandsOff ? [] : matchCommands(draft));
  const commandPick = $derived(
    commands.length ? commands[Math.min(commandAt, commands.length - 1)] : null,
  );

  /* A draft that stops being a slash-name is a new question, so the dismissal
     does not outlive it. Without this, one Escape silenced the palette for the
     rest of the session. */
  $effect(() => {
    if (typingName(draft) === null) commandsOff = false;
  });

  async function runCommand(cmd: Command, broadcast: boolean) {
    if (targets.length === 0) return;
    /* A command reaches as far as a prompt does and costs the same modifier —
       clearing five cards at once should not be easier than talking to them. */
    if (targets.length > 1 && !broadcast) return;
    draft = "";
    commandAt = 0;
    const on = [...targets];
    if (cmd.name === "clear") {
      for (const c of on) await skein.clear(c);
    }
  }

  async function send(broadcast = false) {
    /* With the palette open the key means "run what is lit", exactly as it
       does in the CLI: `/cle` and Enter runs clear. */
    if (commandPick) return runCommand(commandPick, broadcast);

    const text = draft.trim();
    if (!text || targets.length === 0) return;
    /* A command typed in full and sent without the palette ever opening —
       pasted, or completed and then dismissed. Unknown names fall through this
       and go to the agent as the prompts they are. */
    const cmd = resolveCommand(text);
    if (cmd) return runCommand(cmd, broadcast);

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

  function onDraftKey(e: KeyboardEvent) {
    /* The palette borrows four keys while it is open, and gives them all back
       the moment it closes — which is why it is checked before anything else
       here rather than folded into the branches below. */
    if (commands.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        commandAt =
          (Math.min(commandAt, commands.length - 1) + step + commands.length) %
          commands.length;
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
         before committing to it. */
      if (e.key === "Tab" && commandPick) {
        e.preventDefault();
        draft = completionFor(commandPick);
        return;
      }
    }

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
      board.selected &&
      !isTyping(e.target)
    ) {
      e.preventDefault();
      void board.remove(board.selected);
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
    ambience,
    attention,
    actions,
    canvas: () => canvas,
    focusedId: () => focusedId,
    setFocused: (id) => (focusedId = id),
    draft: () => draft,
    setDraft: (t) => (draft = t),
    commands: () => commands,
    targets: () => targets,
    waiting: () => waiting,
    clashing: () => clashing,
    openIn,
    resolveConflicts,
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

<!-- The window's width is what caps the panel, so it is bound rather than read
     once: the ceiling has to move when the window does, or a panel set wide on
     a maximised window leaves no wall behind a restored one. -->
<svelte:window onkeydown={onGlobalKey} bind:innerWidth={viewW} />

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

  <main class="wall" class:sizing>
    <!-- A project with no cards is still a place on the wall, and the only
         place its "+" lives — so an empty territory keeps the canvas up. -->
    {#if skein.convs.length || skein.projects.length || board.images.length}
      <Canvas
        bind:this={canvas}
        convs={skein.convs}
        projects={skein.projects}
        {studio}
        {board}
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
        conflictFor={(cwd) => conflictBadge(actions.status[cwd] ?? NO_STATUS)}
        onaction={(cwd, id) => void actions.run(cwd, id)}
        onresolve={(cwd) => void resolveConflicts(cwd)}
        onadd={(dir, wt) => openIn(dir, wt)}
        onserver={(groupId) => {
          const g = skein.groups.find((g) => g.group.id === groupId);
          if (!g) return;
          void (g.running ? skein.stopGroup(g) : skein.startGroup(g));
        }}
        onfocus={(id) => (focusedId = id)}
        onclose={closeConv}
        onpin={(id, x, y) => skein.savePlacement(id, x, y, true)}
        onplace={(cwd, x, y) => skein.placeProject(cwd, x, y)}
      />
      {#if focused && showDetail}
        <aside class="side" style:width="{panelW}px">
          <!-- The panel's own edge, draggable. It sits *inside* the panel
               rather than straddling the boundary: the wall clips its cards at
               exactly this line, so a grip hanging over it would be under a
               card wherever one happened to be parked against the edge. Seven
               pixels of the transcript's left padding cost nothing — there is
               no text there. -->
          <!-- A `separator` that is focusable and carries a value is the
               *widget* form of the role, which is exactly what this is. The
               rule below only knows the static form, and calls it
               non-interactive. -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
          <div
            class="grip"
            class:sizing
            role="separator"
            aria-orientation="vertical"
            aria-label="drag to resize the transcript"
            aria-valuenow={panelW}
            aria-valuemin={PANEL_MIN}
            aria-valuemax={PANEL_MAX}
            tabindex="0"
            title="drag to resize · double-click to reset"
            onpointerdown={sizeStart}
            onpointermove={sizeMove}
            onpointerup={sizeEnd}
            onpointercancel={sizeEnd}
            ondblclick={sizeReset}
            onkeydown={sizeKey}
          ></div>
          <Transcript
            conv={focused}
            watching={attention.focused}
            onhistory={(c) => void skein.loadHistory(c)}
            onlink={(href) => void skein.openLink(href)}
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

    <!-- Above the field, so it grows towards the wall rather than pushing the
         field down under the cursor that is typing into it. Only Skein's own
         commands are listed: the agent's are its business, and there is no way
         to enumerate them from here. -->
    {#if commands.length}
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
            <span class="name">/{cmd.name}</span>
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
  /* The whole wall wears the resize cursor for the length of the drag, and
     stops being selectable: the pointer is captured by the grip, so what is
     under it is irrelevant, but a cursor that flickered between `grab` and
     `col-resize` as it crossed the boundary would say the gesture had ended. */
  .wall.sizing {
    cursor: col-resize;
    user-select: none;
  }
  /* Width is set inline from `panelW` — see the note over the panel constants
     in layout.ts. No `min-width`, because it is not a suggestion here. */
  .side {
    flex: 0 0 auto;
    min-height: 0;
    display: flex;
    padding: 0.8rem 0.8rem 0.8rem 0;
    border-left: 1px solid var(--edge);
    position: relative;
  }

  /* A gutter over the panel's left edge, and a hairline that only appears when
     you are near it. Achromatic, like the rest of the chrome: colour on this
     wall is status, and an edge you can move is not a status. */
  .grip {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 7px;
    cursor: col-resize;
    touch-action: none;
    /* What `preventDefault` would otherwise have to do on every press — see
       `sizeStart`. A selection cannot begin in a box that has none to give. */
    user-select: none;
    z-index: 3;
  }
  .grip::after {
    content: "";
    position: absolute;
    top: 0.8rem;
    bottom: 0.8rem;
    left: 3px;
    width: 1px;
    background: var(--paper-faint);
    opacity: 0;
    transition: opacity 120ms ease;
  }
  .grip:hover::after,
  .grip:focus-visible::after,
  .grip.sizing::after {
    opacity: 1;
  }
  .grip.sizing::after {
    background: var(--paper);
  }
  .grip:focus-visible {
    outline: none;
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
