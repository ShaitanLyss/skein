/* The one poller behind however many workflows are running on the wall.
 *
 * A workflow is the largest thing a card can start and the quietest: the tool
 * returns a receipt, and its dozen agents run on a stream this app never sees.
 * So `Seat.crew` could say a crowd was convened but not one word about how it
 * was getting on — which is the half of "it looks like nothing is happening"
 * that survived giving the card a job to hold.
 *
 * What the runtime leaves on disk is a journal, and `workflow.rs` has the shape
 * of it and the argument for reading it: **there is no phase and no label in it
 * anywhere**, so the whole of what can be known is how many agents are out and
 * how many are back. That is enough. Six out and three back is a card visibly
 * getting somewhere, where "running" is a card you have to take on faith.
 *
 * Deliberately the same shape as `meter.svelte.ts`, down to the reasoning: a
 * card asks by attaching and stops by detaching, the timer exists only while
 * somebody is asking, and there is exactly one of it however many workflows are
 * up. Polling at all is the second deliberate exception to "nothing polls" and
 * it is the same exception the sampler is — nothing emits an event when a
 * workflow agent finishes, so there is no fold to be had.
 *
 * It is here rather than in `skein.svelte.ts` for the reason the `Meter` is:
 * this is one command, asked on its own clock, on behalf of a thing that is not
 * a conversation. `conversation.svelte.ts` still never talks to Rust — it holds
 * the journal directory the receipt named and nothing else, and `App.svelte`
 * reconciles what is running against what is being asked for. */

import { invoke } from "@tauri-apps/api/core";

/** How far one run has got. Two counts, because two counts is what the journal
 *  holds — see `workflow.rs`. */
export type Progress = { out: number; back: number };

/** Slow on purpose.
 *
 *  A workflow agent takes minutes, so a reading that changes every two seconds
 *  would be a reading that changes twice in an hour drawn three hundred times.
 *  Four seconds is inside the beat of "did that just move" and is a rounding
 *  error against the file it reads — but the number is a compromise about *this*
 *  poll being cheap, not a licence: the honest reading only ever moves when an
 *  agent starts or returns. */
const EVERY = 4000;

export class Crowds {
  /** Keyed on the workflow's tool_use id, which is what the seat is keyed on —
   *  the only identity the call, the receipt and the notification share. */
  seen = $state<Record<string, Progress>>({});
  fault = $state<string | null>(null);

  #asks = new Map<string, string>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #busy = false;

  /** How many runs are being watched, for the control surface's snapshot. */
  get watchers(): number {
    return this.#asks.size;
  }

  /** Which runs are being watched, for the reconciliation in `App.svelte` to
   *  detach the ones that have settled. A plain object rather than the map, so
   *  the caller does not hold a handle on this class's own state. */
  get watching(): Record<string, string> {
    return Object.fromEntries(this.#asks);
  }

  /** Start asking about a run, or keep asking. Idempotent, because the caller
   *  is an effect that re-runs whenever anything about a card changes. */
  attach(toolId: string, dir: string) {
    const before = this.#asks.get(toolId);
    this.#asks.set(toolId, dir);
    if (this.#timer) {
      /* A run that has only just appeared should not wait out the interval to
         say anything, but a card merely being redrawn must not restart the
         clock for every run already being watched. */
      if (before !== dir) void this.#tick();
      return;
    }
    this.#timer = setInterval(() => void this.#tick(), EVERY);
    void this.#tick();
  }

  detach(toolId: string) {
    if (!this.#asks.delete(toolId)) return;
    /* The last reading goes with it. A settled workflow's verdict comes from
       its notification, and a stale count sitting under it would be a second,
       older account of the same run. */
    const { [toolId]: _gone, ...rest } = this.seen;
    this.seen = rest;
    if (this.#asks.size === 0) this.stop();
  }

  /** Also called from `App.svelte`'s `onDestroy`: a module-level timer left
   *  running by a hot edit polls forever for a wall nobody can see, which is
   *  the leak `Listeners` exists to prevent one layer up. */
  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async #tick() {
    /* One read at a time. A journal on a slow disk taking longer than the
       interval would otherwise queue reads until the disk decided. */
    if (this.#busy) return;
    const asks = [...this.#asks.entries()];
    if (!asks.length) return;
    this.#busy = true;
    try {
      const got = await invoke<(Progress | null)[]>("workflow_progress", {
        dirs: asks.map(([, dir]) => dir),
      });
      const next: Record<string, Progress> = {};
      asks.forEach(([toolId], i) => {
        const p = got[i];
        /* Null is "no journal yet", which is the first second of every run.
           Carrying the previous reading forward rather than dropping to nothing
           is what stops a count flickering if the file is briefly unreadable —
           and there is nothing to carry on the first tick, which is the case
           null is really for. */
        const carried = p ?? this.seen[toolId];
        if (carried) next[toolId] = carried;
      });
      this.seen = next;
      this.fault = null;
    } catch (e) {
      /* Said once and not drawn on the cards. A journal that cannot be read is
         a workflow whose progress is unknown, and the crowd falls back to
         saying only that it is out — which is what it said before any of this. */
      this.fault = String(e);
    } finally {
      this.#busy = false;
    }
  }
}

export const crowds = new Crowds();
