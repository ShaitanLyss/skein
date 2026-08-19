/* The billboard, as the wall reads it.
 *
 * `board.rs` owns what a notice *means* — who may post one, when it goes stale,
 * whether a path is covered by it. This is the reading: normalizing a row into
 * something drawable, putting it in the order a board is read in, and saying in
 * a few words what it is about.
 *
 * `normalize` strikes the same bargain `normalizeAsk` and the widget configs do
 * (see `store.rs::migrate_v5`): a row from a newer build, a field renamed, a
 * null where a string belongs — all of it degrades to something that draws
 * rather than refusing. The cost of refusing here is a board that silently
 * shows less than is on it, which is the one failure this feature cannot have.
 *
 * Pure — no runes — so the ordering and the labels are tested directly.
 */

export type Notice = {
  id: string;
  /** `project` or `skein`. */
  scope: string;
  projectId: string | null;
  /** The conversation that posted it, or null when you did. */
  from: string | null;
  subject: string;
  body: string;
  /** The globs it covers. Empty means it is about the work, not about files. */
  paths: string[];
  postedAt: number;
  touchedAt: number;
  /** Computed in Rust off `STALE_AFTER_MS`, never here — the reading an agent
   *  gets and the reading you get must not disagree about what is current. */
  stale: boolean;
};

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function normalize(raw: unknown): Notice | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const subject = str(r.subject);
  /* The two things a notice cannot be drawn without. Everything else has a
     sensible absence; a row with no id could not be taken down and a row with
     no subject is a blank line on the board. */
  if (!id || !subject) return null;
  return {
    id,
    scope: str(r.scope, "project"),
    projectId: typeof r.projectId === "string" ? r.projectId : null,
    from: typeof r.from === "string" ? r.from : null,
    subject,
    body: str(r.body),
    paths: Array.isArray(r.paths) ? r.paths.filter((p): p is string => typeof p === "string") : [],
    postedAt: num(r.postedAt),
    touchedAt: num(r.touchedAt),
    stale: r.stale === true,
  };
}

export function normalizeAll(raw: unknown): Notice[] {
  return Array.isArray(raw) ? raw.map(normalize).filter((n): n is Notice => n !== null) : [];
}

/** The order a board is read in.
 *
 *  Stale last, and that is the only rule with an argument behind it: a notice
 *  that has been up since this morning is the one least likely to still be
 *  true, so it must not be the first thing read — and it must not be *hidden*
 *  either, because a long refactor is a real thing. Newest first within each
 *  group, since a board is a thing you glance at for what has changed. */
export function reading(notices: Notice[]): Notice[] {
  const by = (a: Notice, b: Notice) => b.postedAt - a.postedAt;
  return [
    ...notices.filter((n) => !n.stale).sort(by),
    ...notices.filter((n) => n.stale).sort(by),
  ];
}

/** How long a notice has been up, in the register the rest of the wall uses. */
export function since(notice: Notice, now: number): string {
  const mins = Math.floor(Math.max(0, now - notice.postedAt) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** What the files line says, or empty for a notice that is not about files.
 *
 *  Clipped rather than wrapped: the widget's rows are one line each, and a
 *  notice with eight globs on it would otherwise be the whole board. */
export function covering(notice: Notice, max = 3): string {
  if (notice.paths.length === 0) return "";
  const shown = notice.paths.slice(0, max).join(", ");
  const rest = notice.paths.length - max;
  return rest > 0 ? `${shown} +${rest}` : shown;
}

/** Who posted it, for a board that has the roster to hand.
 *
 *  `names` maps a conversation id to what that card is called. A notice whose
 *  author has been closed since is not in it — the sweep in Rust means that row
 *  should already be gone, and this is what is drawn in the moment before the
 *  next read catches up. */
export function author(notice: Notice, names: Map<string, string>): string {
  if (notice.from === null) return "you";
  return names.get(notice.from) ?? notice.from.slice(0, 8);
}

/** Whether this board is worth drawing anything but a line of prose for. */
export function isEmpty(notices: Notice[]): boolean {
  return notices.length === 0;
}
