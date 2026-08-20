/* A dev server's own words, hung on the wall.
 *
 * The other instruments in the catalogue read something nobody else is
 * watching — a clock, a process table, an allowance. This one reads a thing the
 * app already holds: `servers.rs` pipes every group's stdout and stderr up as
 * `server:log`, and `GroupRuntime.log` is where the wall keeps it. So there is
 * no sampler here and nothing to attach to, which is the whole reason a
 * `Servers` holder was not invented for it: the lines arrive as events and this
 * is a second reading of state that is already live. See `.claude/rules/servers.md`
 * for why they arrive through pipes rather than a pseudo-terminal, and
 * `ansi.ts` for how the colour survives that.
 *
 * Pure — no runes, no DOM — so which group a widget is about, what a filter
 * hides, and what to say about a server that is not saying anything are all
 * testable directly. `ServerLog.svelte` draws it. */

/** What one server in a group is doing.
 *
 * The same four states `servers.rs` emits, mirrored structurally rather than
 * imported: `ServerHealth` lives in `skein.svelte.ts`, which is a rune file,
 * and this one is on the other side of the purity boundary. */
export type Health = "idle" | "starting" | "up" | "exited";

/** One line a server printed, as the wall holds it. `stderr` is real — one
 *  reader per pipe, which is what made it true (it was hardcoded `false` for
 *  every line ever emitted under the merged PTY reader). */
export type LogLine = { label: string; line: string; stderr: boolean };

/** A group, as much of one as a log needs to draw itself.
 *
 * Flat and structural rather than `GroupRuntime`, for the reason `Health` is:
 * the adapting happens once, in `App.svelte`, beside the `chipsFor` that
 * already flattens the same groups for a territory's chips. */
export type Reading = {
  id: string;
  label: string;
  /** Whose server this is, in words. A widget belongs to no project — see the
   *  head of `widgets.ts` — so a log has to say which one it is a log of, or
   *  two walls' worth of `dev` are the same three letters. */
  project: string;
  running: boolean;
  overall: Health;
  servers: { label: string; port: number | null }[];
  health: Record<string, Health>;
  log: LogLine[];
};

/** The `group` knob's one literal value: follow the wall rather than name a
 *  group. The default, and the only setting that stays right on a wall whose
 *  groups are added and deleted after the widget was hung up. */
export const FOLLOW = "running";

/** How many lines a log of this height has room for.
 *
 * The box you drag it to is the setting, which is the rule the whole catalogue
 * is built on — and here it is load-bearing rather than tasteful: `Canvas`
 * preventDefaults every wheel on the surface to zoom the wall, so a pane on the
 * wall cannot be scrolled with the wheel. A widget that overflowed would hide
 * its newest lines behind a scrollbar nothing could move. So it does not
 * overflow: what fits is what is drawn, anchored to the tail, and scrollback
 * lives in the Servers panel, which is a panel and does scroll.
 *
 * Not `rowsFor`, which the meter, the pipelines and the reviews faces share:
 * those are three lists of the same one-line rows at the same size, and a log
 * is monospace and denser. Sharing it would have made this arithmetic wrong
 * about its own CSS, which is the one thing it is for. Measured against `.log`
 * in `ServerLog.svelte` — change that font size and this comes with it. */
const HEAD = 22;
const LINE = 15;

export function linesFor(h: number): number {
  return Math.max(1, Math.floor((h - HEAD - 6) / LINE));
}

/** Which group this widget is a reading of, and why it is a reading of nothing
 *  when it is.
 *
 * Two absences, and they are different things to say. `none` is a wall with no
 * dev server groups on it at all — the widget is fine and there is nothing yet
 * to point it at. `gone` is a widget that names a group which is not here any
 * more, which is the deleted-group case and the one thing that must not be
 * papered over by quietly showing a different server's output: the log would
 * be somebody else's and nothing would say so. Following is not that case — a
 * widget set to follow claims no particular group, and the header names
 * whatever it settled on. */
export function subjectOf(
  want: string,
  groups: Reading[],
): { group: Reading } | { group: null; because: "none" | "gone" } {
  if (!groups.length) return { group: null, because: "none" };
  if (want && want !== FOLLOW) {
    const named = groups.find((g) => g.id === want);
    return named ? { group: named } : { group: null, because: "gone" };
  }
  /* What is running, and only then whatever is there. You hang a log up to
     watch the thing that is working; a wall where nothing is up has one honest
     answer and it is the first group, with a start button under it. */
  return { group: groups.find((g) => g.running) ?? groups[0] };
}

/** The tail this widget has room for, and how much the filter is keeping back.
 *
 * `hidden` counts what the *filter* dropped rather than what did not fit: a
 * stderr-only reading of a server that has printed two hundred clean lines is
 * legitimately empty, and an empty pane that cannot say why reads as a widget
 * that has broken. What scrolled off the top needs no such apology — it is
 * simply older, and a taller widget shows more of it. */
export function tail(
  log: LogLine[],
  showing: string,
  rows: number,
): { lines: LogLine[]; hidden: number } {
  const kept = showing === "stderr" ? log.filter((l) => l.stderr) : log;
  return {
    lines: kept.length > rows ? kept.slice(kept.length - rows) : kept,
    hidden: log.length - kept.length,
  };
}

/** The last thing each server in the group said.
 *
 * The other reading: a group of two is two lines rather than a scroll, which is
 * what a log dropped to the size of a card can still say — "ready in 342ms",
 * "compiled with 1 error". Walked backwards and stopped as soon as every server
 * has answered, so a group whose last line is recent costs a few comparisons
 * rather than the length of the log.
 *
 * Every server in the group gets a row whether or not it has spoken, because
 * the silent one is the interesting one. */
export function latest(
  servers: { label: string }[],
  log: LogLine[],
  showing: string,
): { label: string; line: string | null; stderr: boolean }[] {
  const want = new Set(servers.map((s) => s.label));
  const found = new Map<string, LogLine>();
  for (let i = log.length - 1; i >= 0 && found.size < want.size; i--) {
    const l = log[i];
    if (!want.has(l.label) || found.has(l.label)) continue;
    if (showing === "stderr" && !l.stderr) continue;
    found.set(l.label, l);
  }
  return servers.map((s) => {
    const l = found.get(s.label);
    return { label: s.label, line: l?.line ?? null, stderr: !!l?.stderr };
  });
}

/** Whether this group is down, and what to call the gesture that starts it.
 *
 * **A crashed group is down**, and that is the half this would have got wrong:
 * `running` is a flag the wall sets when it asks for a start and clears when it
 * asks for a stop, so a server that exited on its own — a port already bound, a
 * config that will not parse, a compiler that gave up — comes back `running:
 * true, overall: "exited"`. A start button that appeared only for a group
 * nobody had started would be missing from exactly the case you are looking at
 * the log to understand.
 *
 * `word` is what stands in for the log while there is none worth drawing, and
 * is null once the thing is up: then the reading is the lines, and a widget
 * narrating "it is running" over the top of its own output is a label on a
 * window. */
export function standing(g: Reading): {
  down: boolean;
  word: string | null;
  verb: "start" | "start again";
} {
  if (!g.running) return { down: true, word: "not started", verb: "start" };
  if (g.overall === "exited") {
    const out = g.servers.filter((s) => g.health[s.label] === "exited").length;
    return {
      down: true,
      /* Which of them went is on the chips already; what the body owes is
         whether the group as a whole has stopped saying anything. */
      word: out < g.servers.length ? "one of them exited" : "exited",
      verb: "start again",
    };
  }
  /* Starting, up, or asked for and not yet heard from — one answer, because all
     three are a group nobody needs to press anything about. What the pane says
     while a starting group has printed nothing is the pane's own business: it
     knows whether the filter emptied it, and this does not. */
  return { down: false, word: null, verb: "start again" };
}

/** How a group names itself on the wall: the project, then the group.
 *
 * One function so the header and the menu cannot disagree about it — the menu
 * is the only place you can pin a widget to a particular group, and it would be
 * a poor menu that offered five entries all reading `dev`. */
export function nameOf(g: { project: string; label: string }): string {
  return g.project ? `${g.project} · ${g.label}` : g.label;
}

/** What the `groups` source resolves to for the right-click, in the order the
 *  wall holds them. Pure so the ordering is testable; the caller supplies the
 *  groups because they live in a rune. */
export function groupOptions(groups: Reading[]): { value: string; label: string }[] {
  return groups.map((g) => ({ value: g.id, label: nameOf(g) }));
}
