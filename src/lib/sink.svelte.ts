/* The one reader behind however many sinks are on the wall.
 *
 * The same bargain `Board`, `Ledger` and `Meter` strike: a widget asks by
 * attaching and stops asking by detaching, and with nobody asking nothing is
 * read. A wall with no sink up never touches the table.
 *
 * It does not poll, for `Board`'s reason: every write to `sink_item` goes
 * through `sink.rs`, which emits `sink:changed`, so there is an event for every
 * change there is and a timer here would be a poll for news that has already
 * arrived.
 *
 * **It reads the settled list too, in the same pass.** That is the one place it
 * parts company with `Board`, and it is a deliberate trade: two reads for a
 * table whose settled half is the answer to "has anybody already dealt with
 * this", asked from the widget by a person who is looking at the pending half
 * and wondering. Making that a second round trip would put a spinner between a
 * question and its answer for the sake of a query over an indexed column.
 *
 * Fed by `Skein`, for `Flights`' reason: it is the only place that talks to
 * Rust, and a second `listen()` is a second thing to release in `onDestroy`.
 */

import { invoke } from "@tauri-apps/api/core";
import { normalizeAll, type Item, type Kind } from "./sink";

export class Sink {
  /** Everything pending, every project. The widgets filter — one read serves
   *  all of them. */
  items = $state<Item[]>([]);
  /** Everything already dealt with. Read in the same pass; see the note above. */
  settled = $state<Item[]>([]);
  /** What went wrong reading it, drawn on the face rather than swallowed. */
  fault = $state<string | null>(null);
  /** Bumped on every settled read, so a widget can tell "nothing in it" from
   *  "not looked yet" without a second flag. */
  read = $state(0);

  #watchers = new Set<string>();
  #busy = false;

  get watchers(): number {
    return this.#watchers.size;
  }

  get watched(): boolean {
    return this.#watchers.size > 0;
  }

  attach(id: string) {
    const fresh = !this.#watchers.has(id);
    this.#watchers.add(id);
    if (fresh) void this.refresh();
  }

  detach(id: string) {
    this.#watchers.delete(id);
  }

  /** Re-read, if anything is looking.
   *
   *  Guarded against overlap rather than queued, for `Board.refresh`'s reason:
   *  two reads in flight would settle in an order nobody chose and the loser
   *  would paint an older pile over a newer one. */
  async refresh(force = false) {
    if (!force && !this.watched) return;
    if (this.#busy) return;
    this.#busy = true;
    try {
      const [open, done] = await Promise.all([
        invoke<unknown>("read_sink", { projectId: null, settled: false }),
        invoke<unknown>("read_sink", { projectId: null, settled: true }),
      ]);
      this.items = normalizeAll(open);
      this.settled = normalizeAll(done);
      this.fault = null;
    } catch (err) {
      this.fault = err instanceof Error ? err.message : String(err);
    } finally {
      this.#busy = false;
      this.read += 1;
    }
  }

  /** Put something in as yourself. The one thing in the sink that is not a
   *  report from an agent — it is an instruction, and the reading says so. */
  async add(
    title: string,
    body: string,
    kind: Kind = "note",
    paths: string[] = [],
    projectId: string | null = null,
  ) {
    await this.#write(() => invoke("sink_add", { title, body, kind, paths, projectId }));
  }

  /** Mark it dealt with. Kept, not deleted — `restore` is the other half. */
  async settle(id: string) {
    await this.#write(() => invoke("sink_settle", { id }));
  }

  /** Put a settled item back, because it turned out not to be finished. */
  async restore(id: string) {
    await this.#write(() => invoke("sink_unsettle", { id }));
  }

  /** Throw it away for good. The only gesture here that loses a record. */
  async remove(id: string) {
    await this.#write(() => invoke("sink_delete", { id }));
  }

  /** Prise a hold off, because you can see the card holding it is not doing it.
   *  A hold expires on its own eventually; this is for when you know sooner. */
  async release(id: string) {
    await this.#write(() => invoke("sink_release", { id }));
  }

  async #write(op: () => Promise<unknown>) {
    try {
      await op();
      this.fault = null;
    } catch (err) {
      this.fault = err instanceof Error ? err.message : String(err);
    }
    /* Forced, because the event is coming and these are the callers that should
       not wait for it to arrive the long way round. */
    await this.refresh(true);
  }
}
