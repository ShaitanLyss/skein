/* Quitting while the wall is still working.
 *
 * Closing Skein takes every card's process tree down with it — the agent, its
 * MCP servers, and every `bash` it had running (`supervisor.rs`, the job object
 * with `KILL_ON_JOB_CLOSE`). That is deliberate and is not up for negotiation:
 * a background job spared at shutdown is a process nothing can ever reap, which
 * is the leak the job object was added to stop. See `turns.md`, "a row is not a
 * handle".
 *
 * What follows from *that* is this: the cost of quitting is real, it is paid
 * silently, and the only signal you get is a card at the next launch saying its
 * work was stopped. So it is said beforehand instead. The default is still to
 * quit; what changes is that a wall with a twenty-five-minute import on it
 * asks first.
 *
 * Pure — the wording and the arithmetic. `Quit.svelte` draws it, `quit.rs`
 * holds the latch that makes the second close go through. */

/** A card with work running, as much of one as the sentence reads. */
export type BusyCard = {
  name: string;
  /** What it is running, most interesting first. */
  jobs: string[];
};

/** How many cards are holding work, in the register the rest of the wall uses.
 *
 *  Cards rather than jobs, because a card is the thing you recognise and the
 *  thing you would go and look at. The job count is on the line below. */
export function quitTitle(cards: BusyCard[]): string {
  const n = cards.length;
  if (n === 1) return "a card still has work running";
  return `${n} cards still have work running`;
}

/** What quitting will actually do, which is the whole reason to ask.
 *
 *  It says the two halves separately because they are genuinely different
 *  outcomes and only one of them is a loss: the *process* dies, and whatever it
 *  had already written does not. The second sentence is only true because jobs
 *  are persisted now — a card really is told where to look when it comes back
 *  (`turns.md`, "jobs that outlive the process"), so this can promise it. */
export const QUIT_NOTE =
  "quitting stops it where it stands. what it has already written stays on disk, and the card will be told where to look when you come back.";

/** One line per card: what it is called and what it is running.
 *
 *  Capped, because a wall can have twenty cards on it and a dialog that scrolls
 *  is a dialog nobody reads. The overflow is counted rather than dropped — "and
 *  4 more" is a different sentence from silence, and the difference matters when
 *  you are deciding whether to lose it. */
export function quitLines(cards: BusyCard[], cap = 5): string[] {
  const shown = cards.slice(0, cap);
  const lines = shown.map((c) => {
    const [first, ...rest] = c.jobs;
    if (!first) return c.name;
    const more = rest.length ? ` +${rest.length}` : "";
    return `${c.name} — ${first}${more}`;
  });
  const hidden = cards.length - shown.length;
  if (hidden > 0) lines.push(`and ${hidden} more`);
  return lines;
}

/** The count the title is about, for the aria label and for `note_busy`. */
export function busyCount(cards: BusyCard[]): number {
  return cards.length;
}
