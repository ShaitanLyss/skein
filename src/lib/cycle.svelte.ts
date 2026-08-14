/* The studio's pomodoro cycle. One, for the whole wall.
 *
 * Not a widget's config, and the difference is the point. A `pomodoro` widget is
 * a *view*: hang two up and they are two readings of one afternoon, so a second
 * one holding its own phase would be two clocks telling different times. The
 * cycle also outlives any one of them, so taking a view down and putting another
 * up carries on rather than starting again.
 *
 * It does not outlive *all* of them, though — see `watched`. A cycle with no
 * view anywhere on the wall pauses, exactly as the process sampler stops when
 * the last meter comes down.
 *
 * All the arithmetic and every transition is in `timing.ts`, which is pure and
 * tested. This file owns the copy in memory, the round trip to SQLite, and the
 * one-second tick that drives the machine — the same split `widgets.svelte.ts`
 * has with `widgets.ts`.
 *
 * Written to disk on every transition and on a slow beat while running, for the
 * reason `timing.ts::bank` gives: the reading is derived from an epoch, so a row
 * written when a phase started says nothing about how far it got. */

import { invoke } from "@tauri-apps/api/core";
import {
  begin,
  cadenceOf,
  finish,
  normalizeCycle,
  pause,
  phaseOf,
  posture,
  push,
  remaining,
  resume,
  runOfCycle,
  settleCycle,
  step,
  bank,
  type Cadence,
  type CycleState,
  type Phase,
  type Posture,
  CYCLE,
} from "./timing";

/** How often a running cycle's earned seconds are written down. Bounds what a
 *  crash can lose to a minute rather than to the length of a phase — see
 *  `Widgets.beat`, which does the same for the timers and for the same reason. */
const BEAT_MS = 60_000;

export class Cycle {
  cycle = $state<CycleState>({ ...CYCLE });
  fault = $state<string | null>(null);

  /** Is there a pomodoro widget on the wall to be the instrument for this?
   *
   *  Injected rather than imported, the way `Attention.instruments` and
   *  `Widgets.others` are: the widgets and the cycle each own their own state
   *  and neither may own the other. Defaults to true so anything constructing a
   *  `Cycle` without a wall — a test, a second window — is not silently inert.
   *
   *  The rule it enforces is the one the process meter already has: the sampler
   *  runs only while a `performance` widget is up, and a cycle runs only while a
   *  `pomodoro` widget is. An instrument you took off the wall should not still
   *  be running the room — the rest screen takes the whole window, and taking it
   *  over with nothing anywhere to explain why is the wall arguing with itself.
   *
   *  This is not a way to skip a break, which was the worry that first kept the
   *  cycle independent. `end the cycle` is already an unrestricted exit on the
   *  rest screen itself, so the enforcement was never "you cannot stop" — it was
   *  "you cannot skip a break and keep the cycle". Taking the last view down is
   *  the same statement, made with a different gesture. */
  watched: () => boolean = () => true;

  /** The wall's own clock, handed in rather than imported, so this class can be
   *  driven from a test at whatever time it likes.
   *
   *  `$state`, and that is load-bearing rather than tidy. Everything a pomodoro
   *  widget draws goes through the getters below — `left`, `posture`,
   *  `returning` — and each of them reads *this* as well as `cycle`. Held as a
   *  plain field it was invisible to the deriveds that read them, so a face only
   *  repainted when `cycle` itself changed to a new object: on a real transition,
   *  or on the once-a-minute banking beat. The time in the middle of the ring
   *  therefore sat still for a minute and then jumped a minute, while the arc
   *  around it moved every second — because the arc is computed in the component
   *  from `clock.t` directly and never touched this at all. That disagreement
   *  between the two halves of the same ring is the tell. */
  #now = $state(0);
  #banked = 0;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;

  async load() {
    try {
      const raw = await invoke<unknown>("read_pomodoro");
      /* Always paused, however it was left. A cycle that rolled forward across
         a night would come back four pomodoros deep and owing a long break for
         work nobody did — see `settleCycle`. */
      this.cycle = settleCycle(normalizeCycle(raw));
    } catch (err) {
      this.fault = String(err);
    }
  }

  /* ── reading it ─────────────────────────────────────────────────────── */

  get phase(): Phase {
    return phaseOf(this.cycle);
  }

  get cadence(): Cadence {
    return cadenceOf(this.cycle.cadence);
  }

  get posture(): Posture {
    return posture(this.cycle, this.#now);
  }

  /** Is the wall locked for a break right now. The one question `App.svelte`
   *  asks, and the only thing that puts the rest screen up.
   *
   *  `watched` is checked here as well as in `tick`, which is not belt and
   *  braces: the tick is what *pauses* an unwatched cycle, and it runs once a
   *  second, so without this the rest screen would stay over the window for up
   *  to a second after the last pomodoro widget came down. */
  get resting(): boolean {
    return this.watched() && this.posture === "resting";
  }

  /** Seconds left of whatever is in hand — the focus you are in, or the break
   *  you are taking. A pushed-back break reports what is left *of the break*,
   *  not of the push, since that is what you are being told you still owe. */
  get left(): number {
    return remaining(runOfCycle(this.cycle), this.phase.seconds, this.#now);
  }

  /** Seconds until a pushed-back break comes round again. Zero when nothing is
   *  pushed back. */
  get returning(): number {
    return Math.max(0, Math.ceil((this.cycle.snoozedUntil - this.#now) / 1000));
  }

  /* ── driving it ─────────────────────────────────────────────────────── */

  /** One tick. Called from the studio's existing one-second clock effect, so
   *  the most obviously timed thing in the app still costs no timer of its own.
   *
   *  `step` returns the same object when nothing is due, which is what makes
   *  this safe to call every second: a write only happens on a real transition,
   *  or once a minute to bank what a running phase has earned. */
  tick(now: number) {
    this.#now = now;
    if (!this.cycle.on) return;

    /* Nothing on the wall is showing this, so it stops advancing.
     *
     * Paused rather than ended, and the difference matters twice over. Taking a
     * widget down to rearrange the wall must not throw away the afternoon —
     * hang one back up and `carry on` picks the same phase up where it was. And
     * a break you owed is *still owed* when you do, which is the same promise
     * `push` makes: a break is delayed by getting out of its way, never spent.
     *
     * `pause` returns the same object when it is already paused, so this costs
     * one comparison a second on a wall with no pomodoro on it. */
    if (!this.watched()) {
      this.#apply(pause(this.cycle, now));
      return;
    }

    const next = step(this.cycle, now);
    if (next !== this.cycle) {
      this.cycle = next;
      this.#banked = now;
      void this.#save();
      return;
    }

    if (!this.cycle.paused && now - this.#banked >= BEAT_MS) {
      this.#banked = now;
      this.cycle = { ...this.cycle, ...bank(runOfCycle(this.cycle), now) };
      this.#saveSoon();
    }
  }

  /* Each of these is one pure transition and one write. They take `now` from
     the last tick rather than reading the clock, so a gesture and the tick that
     preceded it agree about what time it is. */

  begin() {
    this.#apply(begin(this.cycle, this.#now));
  }

  /** Push the break back. The partial break already taken is banked rather than
   *  discarded — a snooze delays what is left, it does not spend it. */
  push() {
    this.#apply(push(this.cycle, this.#now));
  }

  /** Stop the cycle. The honest way out of a break: you are saying you have
   *  finished working this way, not that you are skipping the rest and carrying
   *  on. `done` is kept, since what you got through is worth reading. */
  finish() {
    this.#apply(finish(this.cycle));
  }

  pause() {
    this.#apply(pause(this.cycle, this.#now));
  }

  resume() {
    this.#apply(resume(this.cycle, this.#now));
  }

  /** Turn a knob. The cadence and how many pomodoros go before a long break are
   *  reached through a widget's right-click, but they are the *cycle's*, so they
   *  are written here — which is why `App.svelte` builds a pomodoro's menu
   *  options itself rather than off `optionsOf`. */
  set(key: "cadence" | "per", value: string) {
    const next =
      key === "cadence"
        ? { ...this.cycle, cadence: value }
        : { ...this.cycle, per: Math.max(1, Math.floor(Number(value) || 4)) };
    this.#apply(next);
  }

  #apply(next: CycleState) {
    if (next === this.cycle) return;
    this.cycle = next;
    this.#banked = this.#now;
    void this.#save();
  }

  async #save() {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = null;
    }
    try {
      await invoke("save_pomodoro", { state: $state.snapshot(this.cycle) });
    } catch (err) {
      this.fault = String(err);
    }
  }

  /** The beat's write is not urgent — nothing is waiting on it and the next
   *  transition writes anyway. */
  #saveSoon() {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => void this.#save(), 250);
  }
}
