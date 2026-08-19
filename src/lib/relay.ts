/* What a message from another card looks like once it is in a transcript.
 *
 * The recipient's CLI replays a relayed prompt as a plain `user` message —
 * exactly the shape of something you typed — so the panel has one job here and
 * it is not cosmetic: say that this was not you. Left alone it would be drawn
 * in your register, in your card, with nothing on the page distinguishing an
 * instruction another agent gave from one you gave.
 *
 * Recognised off the words themselves, the way `rousing.ts::isResumePrompt`
 * recognises a resume and for the same reason: the live fold and the one that
 * reads a session back off disk share nothing but the text. Nothing on the wire
 * carries a flag, and a column would not survive `--resume` reading the
 * transcript from the CLI's own file.
 *
 * `relay.rs::envelope` writes what this reads. Pure — no runes — so both ends
 * of the round trip can be asserted directly.
 */

/** The first line of every relayed message. Must match `relay::RELAY_MARK`. */
export const RELAY_MARK = "[skein relay]";

/** Who a message came from, as far as the envelope says. */
export type RelayFrom = {
  /** The sender's title when it was sent, which is not necessarily its title
   *  now — cards are renamed as the work clarifies, and what the transcript
   *  keeps is what was true. */
  name: string;
  handle: string;
  project: string | null;
};

/* Two shapes, because a sender can be closed between writing a message and its
 * recipient waking up to read it. The second keeps the handle, which is still
 * the only thing that identifies what said it. */
const HEADED =
  /^\[skein relay\] from "(.*?)" \(([0-9a-f]{4,36})\)(?: in (.+?))? —\s*$/;
const ORPHANED =
  /^\[skein relay\] from a card that has since been closed \(([0-9a-f]{4,36})\) —\s*$/;

export function isRelayPrompt(text: string): boolean {
  return text.trimStart().startsWith(RELAY_MARK);
}

/** Who sent it, or `null` for anything that is not one of ours.
 *
 *  Degrades rather than refuses, the bargain `normalizeAsk` strikes: a message
 *  whose header this build cannot parse is still a message the agent was given
 *  and acted on, so it is drawn as a relay from nobody rather than redrawn as
 *  something you typed. Getting that wrong in the other direction is the whole
 *  bug this file exists to prevent. */
export function relayFrom(text: string): RelayFrom | null {
  if (!isRelayPrompt(text)) return null;
  const head = text.trimStart().split("\n", 1)[0] ?? "";
  const m = HEADED.exec(head);
  if (m) return { name: m[1], handle: m[2], project: m[3] ?? null };
  const o = ORPHANED.exec(head);
  if (o) return { name: "a closed card", handle: o[1], project: null };
  return { name: "another card", handle: "", project: null };
}

/** The message itself, without the header or the note under it.
 *
 *  The note is addressed to the model — it says who this is from and that
 *  silence is a legitimate reply — and reading it is not the same as reading
 *  the message. Kept out of the drawn body rather than out of the fold: opening
 *  the line shows what the agent was actually handed, which is the point of
 *  having the line at all. */
export function relayBody(text: string): string {
  const t = text.trimStart();
  if (!isRelayPrompt(t)) return text;
  const nl = t.indexOf("\n");
  let body = nl === -1 ? "" : t.slice(nl + 1);
  /* Written by `envelope` as its own trailing paragraph, so it is matched
     whole. A message that happens to end in a parenthesis is untouched. */
  const note = body.lastIndexOf("\n\n(This came from another agent");
  if (note !== -1) body = body.slice(0, note);
  return body.trim();
}

/** What the fold says while it is closed.
 *
 *  Short, because a fold cap is `nowrap` with an ellipsis in a panel a third of
 *  a window wide — the same constraint `RESUME_CAP` is written to. It names the
 *  sender rather than quoting the message, for the reason `askHeadline` does:
 *  a cut-off first sentence names nothing. */
export function relayCap(text: string): string {
  const from = relayFrom(text);
  return from ? `from ${from.name}` : "from another card";
}

/** What a card is called on the roster, given only its id.
 *
 *  Must agree with `relay::handle_of`. Here so the wall can label a strand
 *  whose endpoint has already been closed, which is the one case where there is
 *  no title left to use. */
export function handleOf(id: string): string {
  return id.slice(0, 8);
}
