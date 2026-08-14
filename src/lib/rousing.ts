/* Waking the wall back up, and what to say to a card whose turn was cut off.
 *
 * Lazy restore is about *painting*: the wall comes back from SQLite with no
 * `claude` process anywhere, which is what makes the first frame instant. It is
 * not an argument for leaving the processes down — a wall of dormant cards is a
 * wall you have to click before it can do anything, and a card that was mid-turn
 * when the app closed has work half-done in a repo and nobody carrying it.
 *
 * So rousing runs *behind* the painted wall, exactly as the transcript reads do:
 * nothing is awaited before the wall is on screen, and a card that has already
 * been spoken to by the time the queue reaches it is simply skipped. This module
 * is the pure half — the order, the pacing, and the words. */

/** How long to leave between spawns.
 *
 *  Sequential with a gap rather than all at once, for the reason `broadcast`
 *  gives: each wake is a `claude` process starting, and thirty of them in the
 *  same tick is a thundering herd on a machine that is also painting a wall and
 *  starting dev servers. The queue is background work; it is allowed to take a
 *  minute. */
export const ROUSE_GAP_MS = 400;

/** The little of a card this module needs. */
export type Rousable = { dormant: boolean; interrupted: boolean; aside?: boolean };

/** Which cards to wake, in the order to wake them.
 *
 *  Interrupted first, and that is the whole of the ordering: those are the ones
 *  that lost a turn, so they are the ones with something to get back to. The
 *  rest keep the wall's own order, which is the order they were opened in.
 *
 *  Two kinds of card are left out. One that already has a process is either one
 *  you are using or one this queue has already reached, and waking it again is a
 *  call that can only fail. And one set aside is a card you deliberately put by
 *  — see `Conversation.aside`, which says stop counting this as waiting; giving
 *  it a process back at every launch is the same instruction ignored. Note it is
 *  left out even when `interrupted`: setting a card aside mid-turn is exactly
 *  the gesture that says "not this, not now". */
export function rouseOrder<T extends Rousable>(cards: T[]): T[] {
  const dormant = cards.filter((c) => c.dormant && !c.aside);
  return [
    ...dormant.filter((c) => c.interrupted),
    ...dormant.filter((c) => !c.interrupted),
  ];
}

/** The line put in the transcript above a prompt nobody typed.
 *
 *  A resumed card is about to show a `you` line you did not write, which is the
 *  one thing the panel must never do silently — the whole point of `echo`'s
 *  pending mark is that the transcript says who has what. So the prompt is
 *  introduced by a meta note, in the same register as `cleared` and `stopped`. */
export const RESUME_NOTE = "resumed by skein — this turn was cut off when the app closed";

/** What to say to a card that was working when the app went away.
 *
 *  It is deliberately not "continue". The turn died somewhere unknown: a file
 *  may be half-written, a command may have run and its output lost, and the
 *  agent's own last message is the least reliable account of where things got
 *  to, because it was interrupted before it could say so. So the prompt spends
 *  its length on *looking first* — and on the case where looking does not
 *  settle it, where stopping and asking beats guessing at half-finished work.
 *
 *  Hand-wrapped, like `conflictPrompt`: the panel renders GFM, where a single
 *  newline is a line break, so a paragraph arriving as one long line stays one
 *  long line beside the others. */
export function resumePrompt(): string {
  return [
    "you were part-way through a turn when skein closed, so that turn was cut",
    "off mid-flight. this is the same session resumed — everything you can see",
    "above is yours.",
    "",
    "work out where it actually got to before you carry on:",
    "",
    "- your last message is the *least* reliable account of it, since you were",
    "  interrupted before you could report. read the tree instead.",
    "- `git status` and `git diff` if this is a repo; otherwise the files you",
    "  had been editing. a half-written file is the normal failure here.",
    "- a command you had started may have run to completion with its output",
    "  lost, or not at all. check the effect rather than assuming either.",
    "",
    "then pick the work back up and finish it.",
    "",
    "if you cannot tell what you were in the middle of, say so and stop rather",
    "than guessing — a guess at half-finished work is worse than a question,",
    "because it looks finished.",
  ].join("\n");
}
