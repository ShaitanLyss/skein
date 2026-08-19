/* The one reader behind the accounts panel and, later, the waterfall itself.
 *
 * Same bargain as `ledger.svelte.ts`, and named the same way round and for a
 * sharper version of the same reason. `accounts.svelte.ts` would have been the
 * obvious name and does not survive contact with Windows: `./accounts.svelte`
 * resolves to the *component* `Accounts.svelte` on a case-insensitive
 * filesystem, and `svelte-check` fails with two files differing only in casing.
 * That is the `usage.svelte.ts` trap `ledger.svelte.ts` is named around,
 * one degree worse — not an ambiguity a compiler resolves the wrong way, but
 * one it cannot resolve at all. So the reader is named for what the subsystem
 * *does*, which leaves `accounts.ts` pure and `Accounts.svelte` the panel.
 *
 * Something asks by attaching and stops asking by detaching. With nobody
 * attached nothing is polled, which matters here more than it looks: a wall
 * with three accounts on it makes three requests per pass, against an endpoint
 * that answered `429` to a single account polled on a minute
 * (`.claude/rules/usage.md`). The floor and the backoff that actually guarantee
 * politeness are in `limits.rs`, per account; this interval is only the polite
 * cadence.
 *
 * Every *decision* is in `accounts.ts` — which account is next, whether one is
 * blocked, when the wall comes back. This file holds no policy at all; it reads
 * Rust, keeps the answers in runes, and hands them to the pure functions. See
 * `.claude/rules/accounts.md`.
 */

import { invoke } from "@tauri-apps/api/core";
import { choose, type Account, type Allowance, type Choice } from "./accounts";
import type { Report } from "./limits";

/** Three minutes, the same reasoning `ledger.svelte.ts` sets out at length: a
 *  five-hour window moves one percent in three of them and every face here
 *  floors to whole percents, so anything quicker spends a request to redraw the
 *  same numeral. Multiplied by the account count, which is the other half of
 *  why it is not a minute. */
const EVERY = 180_000;

/** How long a `429` outranks the last reading. See `markSpent`. */
const SPENT_FOR = 5 * 60_000;

/** What `find_claude` answers. Mirrors `claude.rs::Presence`. */
export type Presence =
  | { state: "ready"; path: string; version: string; onPath: boolean; foundIn: string }
  | { state: "missing"; lookedIn: string[] };

/** What `read_allowances` answers per account. Mirrors `limits.rs::Allowance` —
 *  a report or a fault and exactly one of them, kept apart all the way here
 *  because "full" and "could not be asked" are answered differently. */
type RawAllowance = { label: string; report: Report | null; fault: string | null };

export class Waterfall {
  /** The registry, in rank order as Rust returns it. */
  list = $state<Account[]>([]);
  /** Label → the last allowance answer for it. */
  allowances = $state<Record<string, Allowance>>({});
  /** Whether Claude Code is on this machine at all, and where. Null until the
   *  first look — which is a different thing from `missing`, and the panel says
   *  so rather than accusing a machine of having no CLI while it is checking. */
  claude = $state<Presence | null>(null);
  /** Tokens in the store that no registered account claims. Somebody signed in
   *  from a terminal with `cc-add` and never told Skein; the panel offers them
   *  rather than adopting them silently. */
  unregistered = $state<string[]>([]);
  fault = $state<string | null>(null);
  /** Whether a first pass has landed, so "no accounts" and "still looking" are
   *  distinguishable — the same reason `Ledger.ready` exists. */
  ready = $state(false);

  #watchers = new Set<string>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #busy = false;

  get watchers(): number {
    return this.#watchers.size;
  }
  get polling(): boolean {
    return this.#timer !== null;
  }

  attach(id: string) {
    if (this.#watchers.has(id)) return;
    this.#watchers.add(id);
    if (!this.#timer) {
      this.#timer = setInterval(() => void this.poll(), EVERY);
    }
    /* Immediately, not on the first beat: a panel that opened to three minutes
       of blank rows would look broken. */
    void this.refresh();
  }

  detach(id: string) {
    if (!this.#watchers.delete(id)) return;
    if (this.#watchers.size > 0) return;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    /* Deliberately *not* clearing `allowances`. Rust drops its own cached
       readings on `release_limits` and keeps its hushes; what is kept here is
       the last thing seen, so reopening the panel draws the previous answer
       marked stale rather than three empty rows while the first pass runs. The
       same call `Ledger` makes for the same reason. */
  }

  /** The registry and the machine — cheap, local, and the things that change
   *  when you press something rather than when time passes. */
  async refresh() {
    try {
      const [list, stored, claude] = await Promise.all([
        invoke<Account[]>("list_accounts"),
        invoke<string[]>("stored_tokens"),
        invoke<Presence>("find_claude"),
      ]);
      this.list = list;
      this.claude = claude;
      const known = new Set(list.map((a) => a.label));
      this.unregistered = stored.filter((l) => !known.has(l));
      this.fault = null;
      this.ready = true;
    } catch (err) {
      this.fault = String(err);
      this.ready = true;
      return;
    }
    await this.poll();
  }

  /** Ask every account that could actually answer.
   *
   *  Accounts with no token are skipped rather than asked and failed: there is
   *  nothing to ask *with*, the answer is already known, and asking would spend
   *  a request to be told so. `standingOf` reports them `unusable` from the
   *  registry alone. */
  async poll() {
    if (this.#busy) return;
    const labels = this.list.filter((a) => a.hasToken && a.enabled).map((a) => a.label);
    if (labels.length === 0) {
      this.allowances = {};
      return;
    }
    this.#busy = true;
    try {
      const answers = await invoke<RawAllowance[]>("read_allowances", { labels });
      const next: Record<string, Allowance> = {};
      for (const a of answers) {
        next[a.label] = a.report
          ? { ok: true, windows: a.report.windows, at: a.report.at }
          : { ok: false, fault: a.fault ?? "the allowance could not be read" };
      }
      this.allowances = next;
    } catch (err) {
      this.fault = String(err);
    } finally {
      this.#busy = false;
    }
  }

  /** Accounts the server has refused more recently than we have polled, and
   *  when to start believing the poll again.
   *
   *  A 429 outranks our last reading, because it is newer and because it is the
   *  actual refusal rather than a percentage that implies one. Without this the
   *  reactive swap does not work at all: the turn fails, `choose` is asked, and
   *  it hands back the very account that just refused — because the reading it
   *  is looking at is up to a minute old and still says 82%.
   *
   *  It expires rather than being cleared by a poll. Rust's floor means the
   *  next real reading is at most a minute out and will show the account full
   *  on its own, so this only has to bridge that gap; five minutes is slack for
   *  a hush. If the account genuinely is out for hours, the poll keeps it
   *  blocked long after this has lapsed, and if it was a fluke the account
   *  quietly comes back. */
  #spent = new Map<string, number>();

  /** Distrust one account until the reading catches up. */
  markSpent(label: string) {
    this.#spent.set(label, Date.now() + SPENT_FOR);
  }

  /** Which account the next turn would go to, right now.
   *
   *  Straight through to the pure chooser — this class decides nothing — except
   *  for overlaying the refusals above, which is a *fact* about an account
   *  rather than a policy about it. A distrusted account is presented as a
   *  window at 100% with no named reset, which is the honest shape of what a
   *  429 tells us: it is full, and it did not say for how long. `availableAt`
   *  then reports unknown and the hold waits on the poll rather than on a
   *  countdown invented here. */
  next(opts: { bypass?: boolean; stickTo?: string | null } = {}): Choice {
    const now = Date.now();
    let allowances = this.allowances;
    if (this.#spent.size > 0) {
      const overlaid: Record<string, Allowance> = { ...allowances };
      for (const [label, until] of this.#spent) {
        if (until <= now) {
          this.#spent.delete(label);
          continue;
        }
        overlaid[label] = {
          ok: true,
          at: now,
          windows: [
            {
              kind: "session",
              group: "session",
              used: 100,
              severity: "rejected",
              resetsAt: null,
              scope: null,
              active: true,
            },
          ],
        };
      }
      allowances = overlaid;
    }
    return choose(this.list, allowances, opts);
  }

  /* ── the gestures ────────────────────────────────────────────────────────*/

  async add(label: string) {
    await invoke("add_account", { label });
    await this.refresh();
  }

  async remove(label: string) {
    await invoke("remove_account", { label });
    await this.refresh();
  }

  /** Delete the credential, which is the gesture that actually signs an account
   *  out. Kept apart from `remove` because removing a row from a list is not a
   *  thing anybody expects to destroy a token. */
  async forget(label: string) {
    await invoke("forget_token", { label });
    await this.refresh();
  }

  async setEnabled(label: string, enabled: boolean) {
    await invoke("set_account_enabled", { label, enabled });
    await this.refresh();
  }

  async setCaps(label: string, caps: Record<string, number>) {
    await invoke("set_account_caps", { label, caps });
    await this.refresh();
  }

  /** Move one account up or down the order.
   *
   *  The whole list is written rather than the one row, because `rank` is only
   *  meaningful as an ordering: a half-applied reorder leaves two accounts
   *  claiming the same rank, the tie broken by label, and a wall quietly
   *  spending the wrong subscription. `reorder_accounts` takes the list and
   *  writes it in one transaction. */
  async move(label: string, by: -1 | 1) {
    const labels = this.list.map((a) => a.label);
    const at = labels.indexOf(label);
    const to = at + by;
    if (at < 0 || to < 0 || to >= labels.length) return;
    [labels[at], labels[to]] = [labels[to]!, labels[at]!];
    await invoke("reorder_accounts", { labels });
    await this.refresh();
  }

  /** Open a terminal on `claude setup-token`. Returns as soon as it is
   *  launched — there is no completion to wait for, so the panel watches the
   *  store instead (`#watchFor`). */
  async signIn(label: string) {
    await invoke("begin_signin", { label });
  }

  /** Watch for a sign-in to land, and stop watching when it does or when it has
   *  plainly been abandoned.
   *
   *  Polled rather than watched by the filesystem: it is one `readdir` every
   *  two seconds against a directory with three files in it, and a watcher
   *  would be a Rust-side subscription with a lifetime to get wrong for an
   *  event that happens twice a year. The ceiling is generous because the thing
   *  being waited on is somebody finding their browser, signing in, and pasting
   *  — and gives up rather than polling forever if they close the window. */
  watchFor(label: string, onFound: () => void): () => void {
    const started = Date.now();
    const t = setInterval(() => {
      if (Date.now() - started > 10 * 60_000) {
        clearInterval(t);
        return;
      }
      void invoke<string[]>("stored_tokens").then((stored) => {
        if (!stored.includes(label)) return;
        clearInterval(t);
        void this.refresh().then(onFound);
      });
    }, 2000);
    return () => clearInterval(t);
  }

  /** Download and run the official installer. Only ever from an explicit
   *  gesture — `claude.rs` refuses to do it from a lookup, and the panel puts
   *  the question before this is called. */
  async install(): Promise<string> {
    const said = await invoke<string>("install_claude");
    await this.refresh();
    return said;
  }
}

export const waterfall = new Waterfall();
