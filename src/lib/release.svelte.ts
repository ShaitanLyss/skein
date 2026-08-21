/* Whether a newer Volery is out, and getting onto it.
 *
 * The reader the header watches, on `ledger.svelte.ts`'s pattern and named the
 * same way — for what the subsystem *is* rather than for the module it serves.
 * `update.svelte.ts` is the name this wanted and cannot have: on a
 * case-insensitive filesystem it collides with anything called `Update.svelte`,
 * which is the trap `waterfall.svelte.ts` is named around and which `svelte-check`
 * refuses outright. There is no `Update.svelte` today; there is no reason to
 * leave the collision lying there for whoever writes one.
 *
 * `update.ts` beside it is pure and holds every judgement — is that tag newer,
 * can that file be installed, what is any of it called. What is here is only the
 * asking and the doing: one call to GitHub, one download, and an arming.
 *
 * ### Asked once, at launch, and never on a clock
 *
 * There is no event to fold — GitHub does not tell anybody a tag appeared — so
 * this is one of the very few things in the app that goes and looks. It looks
 * *once*, when the wall is painted, which is the smallest amount of looking that
 * answers the question at all and is why it needs none of the bounded-poller
 * machinery `meter.svelte.ts` and `crowds.svelte.ts` carry. A release you missed
 * because it landed at four is a release you are told about tomorrow morning.
 *
 * ### Every failure is silence on the wall
 *
 * No network, GitHub down, a rate limit, a tag nothing can order: all of it
 * leaves the header exactly as it was. `fault` is kept so a wall test can see
 * what happened, and nothing draws it — an app that reported its own inability
 * to check for updates, in the chrome, every launch, would be an app nagging
 * about its own plumbing. The one failure that *is* drawn is one you asked for:
 * a download that broke after you pressed the button. */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { offerFrom, sayProgress, type Latest, type Offer } from "./update";

/** What is happening, for the header to draw one thing at a time. */
export type Stage = "quiet" | "offered" | "fetching" | "armed" | "failed";

export class Releases {
  /** The update worth taking, or null — which is every launch but a few. */
  offer = $state<Offer | null>(null);
  stage = $state<Stage>("quiet");
  /** What the button says under itself while it works. */
  note = $state<string | null>(null);
  /** Kept for the control surface and never drawn. See the module note. */
  fault = $state<string | null>(null);

  #asked = false;
  #unlisten: UnlistenFn | null = null;

  /** Ask GitHub, once per run of the app.
   *
   *  Guarded rather than merely called once, because `App.svelte` mounting twice
   *  under a hot edit is a real thing and a second question would spend one of
   *  the sixty an hour for an answer already in hand. */
  async check() {
    if (this.#asked) return;
    this.#asked = true;
    try {
      const latest = await invoke<Latest | null>("latest_release");
      const offer = offerFrom(latest);
      if (offer) {
        this.offer = offer;
        this.stage = "offered";
      }
    } catch (e) {
      this.fault = String(e);
    }
  }

  /** Download the installer and arm it for the way out.
   *
   *  It does **not** close the window, and that is `update.rs`'s reasoning from
   *  this end: quitting can be refused, and an installer already running while
   *  somebody chooses to stay would be rewriting a live exe. So this arms, and
   *  the caller closes the window through the ordinary path — where the wall
   *  gets to ask about its own background work first, exactly as it does for a
   *  quit nobody is updating for. */
  async fetch(): Promise<boolean> {
    const offer = this.offer;
    if (!offer || this.stage === "fetching") return false;
    this.stage = "fetching";
    this.note = sayProgress(0, offer.size);
    /* Attached before the call and released whatever happens, or a download
       that failed leaves a subscription behind — the `Listeners` rule one layer
       down, in the one place here that takes one out. */
    this.#unlisten = await listen<{ got: number; total: number }>(
      "update:progress",
      (e) => {
        this.note = sayProgress(e.payload.got, e.payload.total);
      },
    );
    try {
      const path = await invoke<string>("fetch_update", { url: offer.url });
      await invoke("arm_update", { path });
      this.stage = "armed";
      this.note = null;
      return true;
    } catch (e) {
      /* Drawn, unlike everything else here: you pressed a button and it did not
         happen, and the version you are on is still the one you have. */
      this.stage = "failed";
      this.fault = String(e);
      this.note = String(e);
      return false;
    } finally {
      this.#unlisten?.();
      this.#unlisten = null;
    }
  }

  /** Released from `App.svelte`'s `onDestroy`, like everything else holding a
   *  Tauri subscription. */
  release() {
    this.#unlisten?.();
    this.#unlisten = null;
  }
}

export const releases = new Releases();
