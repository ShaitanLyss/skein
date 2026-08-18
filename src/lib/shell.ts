/* The floating shell's own reasoning, with no runes and no Tauri in it.
 *
 * What the panel actually holds is three small things that were each got wrong
 * the obvious way first: a scrollback that must not grow without bound, a
 * command history that must not fill with the same line forty times, and a
 * prompt that has to say where you are inside a column narrower than most of
 * the paths on this machine.
 *
 * Pure, so it is tested directly (`test/shell.test.ts`). */

export type LineKind =
  /** What the shell wrote on stdout. */
  | "out"
  /** What it wrote on stderr — the same weight, a different colour. */
  | "err"
  /** What you typed, echoed by us because the shell echoes nothing. */
  | "you"
  /** Skein talking about the shell rather than the shell talking. */
  | "note";

export type ShellLine = {
  text: string;
  kind: LineKind;
  /** Only ever set on a `you` line, once its marker has come back saying the
   *  command failed. It is what makes a wall of output scannable: the failures
   *  are marked at the command that caused them rather than somewhere in the
   *  middle of what it printed. */
  failed?: boolean;
};

/** How much of the session is kept. A build prints tens of thousands of lines
 *  and every one of them would otherwise be a live DOM node for the rest of the
 *  afternoon; this is roughly a screenful of scrolling at the panel's size. */
export const SCROLLBACK = 1200;

/** How many commands are remembered. Small on purpose — this is the thing Up
 *  walks through, and a history you have to page through is one you retype. */
export const HISTORY = 200;

/** Append, and drop the oldest once the cap is passed.
 *
 *  Returns a new array rather than mutating, because the caller holds it in
 *  `$state` and the panel redraws off the identity. */
export function pushLines(
  lines: ShellLine[],
  incoming: ShellLine[],
  cap = SCROLLBACK,
): ShellLine[] {
  const next = lines.concat(incoming);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Remember a command, unless it is the one already at the top.
 *
 *  The immediate-repeat guard is the whole of it: `git status` five times in a
 *  row is one thing you did, and without this Up walks back through all five
 *  before reaching anything else. A repeat further down the list is kept — it
 *  is genuinely where you were in the session, and moving it would reorder the
 *  history under your hand while you are walking through it. */
export function remember(history: string[], text: string, cap = HISTORY): string[] {
  const line = text.trim();
  if (!line) return history;
  if (history[history.length - 1] === line) return history;
  const next = [...history, line];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Where Up or Down lands.
 *
 *  `at === history.length` is the live draft — what you were typing before you
 *  started reaching backwards — so the range is one wider than the history and
 *  Down off the end returns you to it rather than to the newest command. Both
 *  ends clamp instead of wrapping: a history that loops round to the beginning
 *  when you hold Down is one you cannot get out of. */
export function recall(count: number, at: number, dir: -1 | 1): number {
  return Math.max(0, Math.min(count, at + dir));
}

/** What the prompt says you are looking at.
 *
 *  Two moves, in this order: home becomes `~`, and then anything still deeper
 *  than `keep` segments is cut from the *front*, because the end of a path is
 *  the part that says where you are. That is also why this exists rather than
 *  a `text-overflow: ellipsis`, which cuts the other end and would leave every
 *  prompt in this repo reading `C:\Users\flori\Documents\…`.
 *
 *  `keep` is four rather than three because the drive spends one of them: a
 *  perfectly ordinary `C:\atelier\skein\src-tauri` was coming out as
 *  `…\atelier\skein\src-tauri`, hiding the one segment nobody can infer. */
export function promptPath(cwd: string, home: string, keep = 4): string {
  const sep = cwd.includes("\\") ? "\\" : "/";
  let path = cwd;

  /* Case-insensitively, since Windows hands the same directory back as
     `C:\Users\...` or `c:\users\...` depending on who was asked. Only a whole
     segment counts: `C:\Users\flori2` is not inside `C:\Users\flori`. */
  const norm = (s: string) => s.replace(/[\\/]+$/, "").toLowerCase();
  const h = norm(home);
  if (h && (norm(path) === h || norm(path).startsWith(h + sep.toLowerCase()))) {
    path = "~" + path.slice(home.replace(/[\\/]+$/, "").length);
  }

  const parts = path.split(/[\\/]/).filter((p) => p !== "");
  if (parts.length <= keep) return path;
  return "…" + sep + parts.slice(-keep).join(sep);
}

/** Two directories that are the same directory.
 *
 *  Case-insensitively and ignoring a trailing separator, because Windows hands
 *  the same path back as `C:\atelier\skein` or `c:\atelier\skein\` depending on
 *  who was asked, and a shell keyed by the second is a second shell in the
 *  same project. */
export function sameDir(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/[\\/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** Which project's shell is the active one.
 *
 *  There is one shell per project, and the active one is the last project you
 *  touched a card in — sticky, so letting go of the wall (Escape, closing a
 *  card, clicking the ground) leaves the panel where it was rather than
 *  yanking it back to whichever project happens to be first. Deselecting is
 *  not a statement about which shell you wanted.
 *
 *  The membership check is the other half: a project can be closed while its
 *  name is still the last one you touched, and a panel pointing at a territory
 *  no longer on the wall would offer a shell in a directory nothing on screen
 *  mentions. Its shell is left running — closing a project is not a request to
 *  kill a build — but it stops being the one Alt+I lands in. */
export function activeShellKey(lastTouched: string | null, projects: string[]): string {
  if (lastTouched && projects.some((p) => sameDir(p, lastTouched))) return lastTouched;
  return projects[0] ?? "";
}
