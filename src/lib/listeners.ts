/* Holding on to Tauri event subscriptions so they can be let go of.
 *
 * `listen()` hands back an unlisten function through a promise, and dropping it
 * on the floor is fine in a page that lives as long as the process. This app is
 * developed with `tauri dev`, where Vite destroys and rebuilds App.svelte on
 * every edit — and the classes it constructs (Skein, Attention, Control) are
 * plain objects with no lifecycle of their own. Their listeners survive the
 * component that made them.
 *
 * That is not merely untidy, because these listeners *act*. Two Skeins ingesting
 * one `conv:event` both write to SQLite: a single `result` produced two `turn`
 * rows, one per generation. The database then disagrees with the wall you are
 * looking at, while you are editing the code that draws the wall — which is the
 * worst possible moment for that.
 *
 * Pure, so nothing here needs a Svelte compiler.
 */

import type { UnlistenFn } from "@tauri-apps/api/event";

export class Listeners {
  #handles: Promise<UnlistenFn>[] = [];
  #detached = false;

  /** Keep a subscription, to be released by `detach`.
   *
   *  A subscription registered after `detach` — the promise from a `listen()`
   *  that was already in flight — is released immediately rather than kept, so
   *  a slow registration cannot outlive the object that asked for it. */
  keep(handle: Promise<UnlistenFn>) {
    if (this.#detached) {
      void handle.then((un) => un()).catch(() => {});
      return;
    }
    this.#handles.push(handle);
  }

  /** Release everything. Idempotent, and safe to call before the subscriptions
   *  have finished registering. */
  detach() {
    this.#detached = true;
    const going = this.#handles;
    this.#handles = [];
    for (const handle of going) {
      void handle.then((un) => un()).catch(() => {});
    }
  }

  /** How many subscriptions are currently held. For the control surface, so a
   *  leak is observable from outside rather than only in a profiler. */
  get size(): number {
    return this.#handles.length;
  }
}
