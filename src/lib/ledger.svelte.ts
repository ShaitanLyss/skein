/* The one reader behind however many usage widgets are on the wall.
 *
 * Named for the class rather than for the widget, the way `meter.svelte.ts` is:
 * `usage.svelte.ts` beside the pure `usage.ts` is one import specifier with two
 * answers, and which one you get depends on what the compiler saw first.
 *
 * Same bargain as the process sampler otherwise. A widget asks by attaching and
 * stops asking by detaching; with nobody asking, nothing is read and Rust's
 * index is simply never touched. That matters more here than it looks: the
 * first reading walks every transcript written in the past week, and a wall
 * with no usage widget on it should never pay for that.
 *
 * Polling is the same deliberate exception the sampler is. A turn taken in a
 * terminal emits no event this app can hear — it appends to a file — and the
 * whole point of reading the files rather than Skein's own `turn` table is to
 * count those turns too. */

import { invoke } from "@tauri-apps/api/core";
import type { Slice } from "./usage";

/** Slow, because nothing here moves fast: a five-hour window shifts by a third
 *  of a percent in this long, and every pass after the first reads only the
 *  bytes appended since. */
const EVERY = 20_000;

type Scan = { slices: Slice[]; read: number; added: number; since: number };

export class Ledger {
  slices = $state<Slice[]>([]);
  fault = $state<string | null>(null);
  /** Whether a reading has ever landed. A wall with nothing spent and a wall
   *  whose first pass is still walking a week of transcripts look identical
   *  otherwise, and the first one is worth saying out loud. */
  ready = $state(false);
  /** When the last pass finished, so a stalled reader is visible from outside. */
  at = $state(0);

  #watchers = new Set<string>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #busy = false;

  get watchers(): number {
    return this.#watchers.size;
  }

  attach(id: string) {
    if (this.#watchers.has(id)) return;
    this.#watchers.add(id);
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.#tick(), EVERY);
    void this.#tick();
  }

  detach(id: string) {
    this.#watchers.delete(id);
    if (this.#watchers.size === 0) this.stop();
  }

  /** Also called from App's `onDestroy` — a superseded generation left ticking
   *  by a hot reload would go on reading transcripts for a wall nobody can see,
   *  which is the `Listeners` hazard in the shape a listener cannot fix. The
   *  slices are kept rather than cleared: a widget hung straight back up should
   *  draw the reading it already had instead of blanking for twenty seconds. */
  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Take a reading now rather than at the next beat.
   *
   *  The seam the timer sits on, not a path beside it — the control surface's
   *  `usage` op calls this so a wall test does not have to wait out twenty
   *  seconds to see a turn land. It obeys the same rule the timer does and
   *  reads nothing while nobody is watching, or an op could quietly undo the
   *  one property this class exists to have. */
  async refresh(): Promise<void> {
    await this.#tick();
  }

  async #tick() {
    if (this.#busy || this.#watchers.size === 0) return;
    this.#busy = true;
    try {
      const scan = await invoke<Scan>("read_usage");
      this.slices = scan.slices;
      this.at = Date.now();
      this.ready = true;
      this.fault = null;
    } catch (err) {
      /* On the widget's own face, not the studio's fault bar — a ledger that
         cannot read the transcripts is a broken instrument, not a broken
         conversation. Same call `Meter` makes. */
      this.fault = String(err);
    } finally {
      this.#busy = false;
    }
  }
}
