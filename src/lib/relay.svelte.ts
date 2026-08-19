/* What is in the air, and what is waiting.
 *
 * The rune-holding half of `flow.ts` and `relay.ts`, which are both pure. It
 * holds two things and neither of them is durable: the strands currently being
 * drawn, and how many messages each card is holding undelivered. The second is
 * a mirror of `relay.delivered_at IS NULL` in SQLite rather than a fact of its
 * own — read once at restore and then kept in step by the events, which is the
 * bargain `Ledger` strikes with the transcripts.
 *
 * Fed by `Skein`, which is the only place in this app that talks to Rust. There
 * is no `listen()` here on purpose: a second class subscribing to `relay:sent`
 * would be a second thing to release in `App.svelte`'s `onDestroy`, and the one
 * that got forgotten would go on drawing strands for a wall nobody can see.
 */

import { done, retire, type Strand } from "./flow";

/** A strand, plus what only the wall needs. */
export type Flight = Strand & {
  /** How many strands were already running the same way when this one started,
   *  which is how far it is drawn to one side of them. */
  fan: number;
  /** The message, clipped by Rust. Nothing draws it yet; it is here because a
   *  strand you can hover is the obvious next thing to want and dropping the
   *  field would mean changing the event to get it back. */
  preview: string;
};

/** What `relay:sent` carries. Mirrors `relay::RelaySent`. */
export type SentEvent = {
  id: string;
  from: string;
  to: string;
  delivered: boolean;
  broadcast: boolean;
  from_inbox: boolean;
  preview: string;
};

export class Flights {
  /** In flight, oldest first. */
  all = $state<Flight[]>([]);

  /** How many messages each card is holding that it has not been given.
   *
   *  A plain object rather than a Map because `$state` proxies both and the
   *  object reads better at the one place it is drawn. Keyed by conversation
   *  id, absent meaning none. */
  inbox = $state<Record<string, number>>({});

  /** How many strands have been cut short by `MAX_STRANDS` since the wall
   *  opened. Nothing draws it — it is for `snapshot.flights`, so a cap that is
   *  silently dropping work is visible from outside rather than only as a wall
   *  that seemed to miss one. */
  cut = $state(0);

  /** A message went. `now` is passed in so the same call is testable and so a
   *  burst of a broadcast's events all share one clock. */
  sent(ev: SentEvent, now = Date.now()) {
    /* A queued message joins its recipient's inbox; one drained out of it
       leaves. Both are drawn as strands — something did travel either way —
       and only the fresh queued one is a card holding something new. */
    if (ev.from_inbox) this.#bump(ev.to, -1);
    else if (!ev.delivered) this.#bump(ev.to, +1);

    const fan = this.all.filter((f) => f.from === ev.from && f.to === ev.to).length;
    const withNew: Flight[] = [
      ...this.all,
      {
        id: ev.id,
        from: ev.from,
        to: ev.to,
        at: now,
        delivered: ev.delivered,
        broadcast: ev.broadcast,
        fan,
        preview: ev.preview ?? "",
      },
    ];
    /* `retire` does two jobs — expire and cap — and only the second is worth
       reporting. A strand that ran its 1.4 seconds finished; one dropped here
       was cut off mid-flight, and that is the number a snapshot wants. */
    const flying = withNew.filter((f) => !done(now - f.at)).length;
    const kept = retire(withNew, now);
    this.cut += flying - kept.length;
    this.all = kept;
  }

  /** Drop what has finished. Called from the frame loop, which is the only
   *  thing that knows when a strand's time is up. Returns whether anything is
   *  still flying, so the loop can stop rather than clearing an empty canvas
   *  sixty times a second — the rule `Backdrop.svelte` states. */
  sweep(now = Date.now()): boolean {
    const next = retire(this.all, now);
    if (next.length !== this.all.length) this.all = next;
    return this.all.length > 0;
  }

  /** What every card is holding, as the store has it. The one read, at restore. */
  seed(counts: Record<string, number>) {
    this.inbox = { ...counts };
  }

  #bump(id: string, by: number) {
    const at = (this.inbox[id] ?? 0) + by;
    const next = { ...this.inbox };
    if (at > 0) next[id] = at;
    else delete next[id];
    this.inbox = next;
  }
}
