/* What Skein does when it isn't the window you're looking at.
 *
 * Three layers, quietest first:
 *   1. the taskbar button asks for attention — cheap, native, ignorable
 *   2. the peek window slides in at the corner of the screen, in our design
 *   3. an optional chime, off by default
 *
 * Deliberately not an OS toast. A Windows toast would be the one part of this
 * app wearing somebody else's design, and it disappears before you've read it. */

import { emit, listen } from "@tauri-apps/api/event";
import {
  getCurrentWindow,
  primaryMonitor,
  UserAttentionType,
  Window,
} from "@tauri-apps/api/window";
import type { Conversation } from "./conversation.svelte";
import { clock } from "./conversation.svelte";
import { Listeners } from "./listeners";

export type PeekItem = {
  id: string;
  project: string;
  title: string;
  kind: "blocked" | "overdue" | "failed";
  detail: string;
  waitedSeconds: number;
};

/** Margin from the screen edge, in logical pixels. */
const EDGE = 18;
/** Matches the peek window size declared in tauri.conf.json. */
const PEEK_W = 420;
const PEEK_H = 210;

/** A card must want you for this long before the peek appears. Without it,
 *  every finished turn would throw a window at you the moment you looked away. */
const GRACE_S = 20;

export class Attention {
  /** Off by default: a sound is the most intrusive thing here, and it should
   *  be something you opt into rather than something you have to switch off. */
  chime = $state(false);
  enabled = $state(true);

  focused = $state(true);
  #listeners = new Listeners();
  #peek: Window | null = null;
  #shown = false;
  #lastSignature = "";
  #placed = false;

  constructor(
    private convs: () => Conversation[],
    private onGoto: (id: string) => void,
  ) {
    this.#wire();
  }

  /** Stop listening — see ./listeners.ts. Without this, an edit in dev leaves a
   *  superseded Attention subscribed, and a single click on the peek asks the
   *  window to unminimise, show and take focus once per generation. */
  detach() {
    this.#listeners.detach();
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  async #wire() {
    const main = getCurrentWindow();
    const keep = this.#listeners.keep.bind(this.#listeners);

    /* Registered before the first await, so nothing can slip past while we are
       asking the window whether it has focus. */
    keep(
      main.onFocusChanged(({ payload }) => {
        this.focused = payload;
        /* Coming back to the studio is itself the acknowledgement. */
        if (payload) void this.hide();
      }),
    );

    keep(
      listen<{ id: string }>("peek:goto", async (e) => {
        await this.hide();
        const w = getCurrentWindow();
        await w.unminimize().catch(() => {});
        await w.show().catch(() => {});
        await w.setFocus().catch(() => {});
        this.onGoto(e.payload.id);
      }),
    );

    keep(
      listen("peek:dismiss", () => {
        this.#shown = false;
        /* Don't re-show for the same set — it was dismissed on purpose. */
        this.#lastSignature = this.#signature(this.items);
      }),
    );

    this.focused = await main.isFocused().catch(() => true);
  }

  /** Everything that wants you, loudest first. Blocked outranks overdue,
   *  because a blocked agent is stopped rather than merely quiet. */
  items = $derived.by<PeekItem[]>(() => {
    const out: PeekItem[] = [];
    for (const c of this.convs()) {
      /* A card with no process cannot want anything. Restoring the wall from
         disk brings back whatever ending each card closed on, so without this a
         conversation that errored last week announces itself as failed the first
         time you look away — for a session that isn't even running. A card that
         died on us in *this* session is the exception, and the one case here
         worth a window: that is news, and nothing else reports it. */
      if (c.dormant && !c.died) continue;
      if (c.pendingAsk) {
        out.push({
          id: c.id,
          project: c.project,
          title: c.title,
          kind: "blocked",
          detail: c.pendingAsk.question,
          waitedSeconds: Math.floor((clock.t - c.pendingAsk.since) / 1000),
        });
      } else if (c.tier === "fail") {
        out.push({
          id: c.id,
          project: c.project,
          title: c.title,
          kind: "failed",
          detail: c.lastError ?? "stopped",
          waitedSeconds: c.idleSeconds,
        });
      } else if (c.tier === "ask" && c.idleSeconds >= GRACE_S) {
        out.push({
          id: c.id,
          project: c.project,
          title: c.title,
          kind: "overdue",
          detail: c.activity,
          waitedSeconds: c.idleSeconds,
        });
      }
    }
    const rank = { blocked: 0, failed: 1, overdue: 2 } as const;
    return out.sort(
      (a, b) => rank[a.kind] - rank[b.kind] || b.waitedSeconds - a.waitedSeconds,
    );
  });

  /** Identity of *what* is waiting, so a card ageing by a second doesn't
   *  count as something new to announce. */
  #signature(items: PeekItem[]): string {
    return items.map((i) => `${i.kind}:${i.id}`).join("|");
  }

  async #peekWindow(): Promise<Window | null> {
    if (this.#peek) return this.#peek;
    this.#peek = await Window.getByLabel("peek");
    return this.#peek;
  }

  /** Bottom-right, above the taskbar. Placed once, then left where it is. */
  async #place(w: Window) {
    if (this.#placed) return;
    try {
      const mon = await primaryMonitor();
      if (!mon) return;
      const s = mon.scaleFactor || 1;
      const sw = mon.size.width / s;
      const sh = mon.size.height / s;
      const { LogicalPosition } = await import("@tauri-apps/api/dpi");
      await w.setPosition(
        new LogicalPosition(sw - PEEK_W - EDGE, sh - PEEK_H - EDGE - 48),
      );
      this.#placed = true;
    } catch {
      /* An unplaced peek in the wrong corner still beats no peek at all. */
    }
  }

  async hide() {
    this.#shown = false;
    const w = await this.#peekWindow();
    await w?.hide().catch(() => {});
  }

  /** Called on a tick from the studio. Idempotent — it only acts on change. */
  async sync() {
    if (!this.enabled) return;
    const items = this.items;
    const sig = this.#signature(items);

    // Focused, or nothing wants you: make sure the peek is away.
    if (this.focused || items.length === 0) {
      if (this.#shown) await this.hide();
      if (items.length === 0) this.#lastSignature = "";
      return;
    }

    void emit("peek:set", { items });

    if (sig === this.#lastSignature) return;
    this.#lastSignature = sig;

    const w = await this.#peekWindow();
    if (!w) return;
    await this.#place(w);
    await w.show().catch(() => {});
    /* Never steal focus — the peek is a glance, not an interruption. */
    this.#shown = true;

    await getCurrentWindow()
      .requestUserAttention(UserAttentionType.Informational)
      .catch(() => {});

    if (this.chime) sound(items[0]?.kind === "blocked");
  }
}

/** A chime synthesised on the spot rather than shipped as an asset — two soft
 *  sine tones, so it reads as a bell rather than a system alert. */
function sound(urgent: boolean) {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const notes = urgent ? [587.33, 880.0] : [523.25, 783.99];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const at = now + i * 0.11;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.075, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.9);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 1);
    });
    setTimeout(() => void ctx.close(), 1400);
  } catch {
    /* No audio device is not an error worth surfacing. */
  }
}
