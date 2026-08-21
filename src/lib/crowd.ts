/* How a workflow's crowd is drawn, given what its journal said.
 *
 * Pure, and tested directly (`test/crowd.test.ts`). The same split `perf.ts` has
 * with `meter.svelte.ts` and for the same reason — and the same naming care:
 * `crowd.ts` is the arithmetic and `crowds.svelte.ts` is the poller, deliberately
 * different stems, because two files whose names differ only by a suffix are one
 * file on this filesystem and the imports resolve to whichever the compiler saw
 * first.
 *
 * Everything here is a function of two numbers, because two numbers is all a
 * workflow's journal holds: how many agents are out and how many are back. It
 * carries no phase and no label (`workflow.rs` has the measurement), so nothing
 * below infers one. A crowd says how many and how far, and stops. */

/** How far one run has got. Mirrors `workflow::Progress`. */
export type Progress = { out: number; back: number };

/** Past this many, a crowd is a card-width of identical silhouettes.
 *
 *  The cap is on the *drawing* only — `tallyOf` still says forty, so the reading
 *  is never wrong, only abbreviated. That is the same bargain the transcript's
 *  result clamp strikes: what is cut is said. */
export const FIGURES_MAX = 9;

/** The stand-in for a crowd of unknown size.
 *
 *  Three, and three is a real answer rather than a placeholder: the first
 *  seconds of every workflow have no journal, and a receipt that named no
 *  directory never will. Drawing one figure there would say "a subagent", which
 *  is the wrong number; drawing none would say the card is doing nothing, which
 *  is the bug this whole seam exists to fix. Three says "a crowd, size unknown",
 *  which is exactly what is known. */
export const UNKNOWN_CROWD = 3;

/** The figures to draw, back-most first. `true` is an agent that has returned.
 *
 *  Returned agents come first so the crowd fills up from the back as the run
 *  goes on. The alternative — drawing them in the order the journal lists them
 *  — would have figures change state in the middle of the row and read as the
 *  crowd shuffling rather than as work coming home.
 *
 *  `null` progress and a run with nobody out are the same drawing, because they
 *  are the same reading: a crowd is convened and nothing has been heard yet. */
export function figuresFor(
  crowd: boolean,
  progress: Progress | null | undefined,
): boolean[] {
  if (!crowd) return [false];
  if (!progress || progress.out <= 0) return Array(UNKNOWN_CROWD).fill(false);
  const shown = Math.min(progress.out, FIGURES_MAX);
  /* Clamped against `shown` rather than against `out`: a journal caught between
     two writes can name more results than starts, and a crowd of nine with ten
     of them home is a row that draws every figure as returned and then asks for
     a tenth. */
  const home = Math.min(Math.max(0, progress.back), shown);
  return Array.from({ length: shown }, (_, i) => i < home);
}

/** The count under the figures, or null when there is nothing counted yet.
 *
 *  Null rather than `0 of 0`, and the distinction is the whole point: an absence
 *  said as a zero is a workflow that looks like it failed to start anybody. */
export function tallyOf(progress: Progress | null | undefined): string | null {
  if (!progress || progress.out <= 0) return null;
  const back = Math.min(Math.max(0, progress.back), progress.out);
  return `${back} of ${progress.out} back`;
}

/** Is every agent this run started back?
 *
 *  Not the same question as "has the workflow finished" and must never be drawn
 *  as one: a pipeline stage that has returned is a stage whose *next* stage is
 *  about to start, so a crowd can be entirely home twice in a run and still have
 *  ten minutes left. Only the notification says a workflow is done. This is here
 *  for the one thing it honestly answers — whether anything is out right now. */
export function allHome(progress: Progress | null | undefined): boolean {
  return !!progress && progress.out > 0 && progress.back >= progress.out;
}
