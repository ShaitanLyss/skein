/* A parked question, as a thing with parts.
 *
 * `ask_user` began as one question with a flat list of options, which is the
 * right shape for most asks and the wrong one for the ask that matters. An
 * agent about to build something rarely has one decision outstanding; it has
 * two or three, on independent axes. With one question to put them in, it
 * fuses them — and the options it writes are then a *cross-product*:
 *
 *     two widgets, and yes to attention
 *     two widgets, but keep it silent
 *     one widget with three variants (attention: yes)
 *     three widgets (attention: yes)
 *
 * Four of the eight combinations, presented as if they were the whole set, so
 * "three widgets, keep it silent" was not merely hard to pick — it was not
 * there. That is worse than a long question. It is a list that looks complete
 * and is not, and the length is a symptom of the same fusing: every option has
 * to spell out both halves, which is what turns four choices into four
 * paragraphs.
 *
 * So a call carries N questions and the panel walks you through them one at a
 * time. The parking is unchanged and cannot change — one `tools/call` is one
 * HTTP request and gets one reply — so the answers are composed into that
 * single reply when the last one is given. This module is the pure half: what a
 * call asked, where you are in answering it, and what the reply says.
 */

export type AskOption = { label: string; detail?: string | null };

export type AskQuestion = {
  /** A few words naming the decision. Shown on the panel's spine and in the
   *  peek, which is a single ellipsised line and can do nothing with a
   *  paragraph. Derived from the question when the agent gives none. */
  header: string;
  question: string;
  options: AskOption[];
};

/** One slot per question, in step order. `null` means not answered yet. */
export type Answers = (string | null)[];

/** What a skipped question sends. The agent asked, so it is owed a reply — and
 *  "you decide" is a real answer that reads as one, where an empty string
 *  reads as a bug. */
export const NO_PREFERENCE = "no preference — your call";

/** Past this many, a call is not asking a question, it is administering a
 *  survey. The excess is dropped rather than truncated silently mid-list: see
 *  `overflowOf`, which exists so the panel can say so. */
export const MAX_QUESTIONS = 5;

/** Enough of a question to name it, when the agent named nothing. */
function headerFrom(question: string): string {
  const flat = question.replace(/\s+/g, " ").trim();
  /* The first sentence, if there is a short one — an agent's opener is
     "Two decisions before I build." far more often than it is the decision, but
     when it *is* the decision it is the best label available. */
  const stop = flat.search(/[.?!](\s|$)/);
  const first = stop > 0 ? flat.slice(0, stop + 1) : flat;
  const pick = first.length <= 48 ? first : flat;
  if (pick.length <= 48) return pick;
  const cut = pick.slice(0, 47);
  const space = cut.lastIndexOf(" ");
  return (space > 28 ? cut.slice(0, space) : cut.trimEnd()) + "…";
}

type RawOption = { label?: unknown; detail?: unknown };
type RawQuestion = { header?: unknown; question?: unknown; options?: unknown };

function optionsFrom(raw: unknown): AskOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AskOption[] = [];
  for (const o of raw as RawOption[]) {
    const label = typeof o?.label === "string" ? o.label.trim() : "";
    if (!label) continue;
    const detail = typeof o?.detail === "string" ? o.detail.trim() : "";
    out.push({ label, detail: detail || null });
  }
  return out;
}

/** What the wire said, as questions we can draw.
 *
 *  Tolerant on purpose, and in the same spirit as `normalizeWidget`: this runs
 *  on a payload an agent composed, so a missing field, a string where an array
 *  belongs, or a question that is nothing but whitespace has to degrade to
 *  something answerable. An ask that arrives with no question at all is still a
 *  parked turn — refusing to draw it would leave the card blocked with nothing
 *  on screen to unblock it with. */
export function normalizeAsk(raw: {
  question?: unknown;
  options?: unknown;
  questions?: unknown;
}): AskQuestion[] {
  const list: RawQuestion[] = Array.isArray(raw?.questions)
    ? (raw.questions as RawQuestion[])
    : [];

  const out: AskQuestion[] = [];
  for (const q of list) {
    const text = typeof q?.question === "string" ? q.question.trim() : "";
    if (!text) continue;
    const header = typeof q?.header === "string" ? q.header.trim() : "";
    out.push({
      header: header || headerFrom(text),
      question: text,
      options: optionsFrom(q?.options),
    });
  }

  /* The single-question sugar. Kept because most asks are one decision and a
     one-line call should stay a one-line call — and because it is what every
     already-running agent is holding. It is *appended* rather than preferred:
     a call sending both meant both, and dropping either would lose a question
     the turn is parked on. */
  const single = typeof raw?.question === "string" ? raw.question.trim() : "";
  if (single) {
    out.push({
      header: headerFrom(single),
      question: single,
      options: optionsFrom(raw?.options),
    });
  }

  if (!out.length) {
    out.push({
      header: "no question given",
      question: "(no question given)",
      options: [],
    });
  }

  return out.slice(0, MAX_QUESTIONS);
}

/** How many questions were dropped for being past the cap. The panel says so,
 *  because an agent that asked six things and got five answers will act on the
 *  sixth regardless, and you should know which one it is guessing at. */
export function overflowOf(raw: { questions?: unknown }): number {
  const n = Array.isArray(raw?.questions) ? raw.questions.length : 0;
  return Math.max(0, n - MAX_QUESTIONS);
}

/** A fresh sheet of answers. */
export function blankAnswers(questions: AskQuestion[]): Answers {
  return questions.map(() => null);
}

/** Which question you are on: the first one still unanswered.
 *
 *  Derived rather than held, so going back to revise an earlier answer and then
 *  moving on cannot leave a cursor pointing at a question already answered. */
export function stepAt(answers: Answers): number {
  const i = answers.findIndex((a) => a === null);
  return i === -1 ? answers.length - 1 : i;
}

export function isComplete(answers: Answers): boolean {
  return answers.length > 0 && answers.every((a) => a !== null);
}

export function answeredCount(answers: Answers): number {
  return answers.filter((a) => a !== null).length;
}

/** The line a multi-question reply opens with. Named rather than inlined
 *  because the transcript's own record of that reply has to strip exactly this
 *  and nothing else — see `answerNote`. */
const PREAMBLE = "Answering each in turn:";

/** The reply the parked request unparks with.
 *
 *  One question composes to the bare answer and nothing else. That is not
 *  tidiness — it is what every ask before this one sent, and a single question
 *  suddenly arriving numbered and headed would change the shape of a reply for
 *  every agent already written against it.
 *
 *  Several compose to a numbered list carrying each question's header, so the
 *  model cannot mis-pair an answer with the decision it belongs to. Unanswered
 *  slots are sent as `NO_PREFERENCE` rather than omitted, for the same reason:
 *  a list with a gap in it invites the model to re-align the rest. */
export function composeAnswer(questions: AskQuestion[], answers: Answers): string {
  if (questions.length === 1) {
    const only = answers[0];
    return (only ?? NO_PREFERENCE).trim();
  }
  const lines = questions.map((q, i) => {
    const a = (answers[i] ?? NO_PREFERENCE).trim() || NO_PREFERENCE;
    return `${i + 1}. ${q.header}: ${a}`;
  });
  return `${PREAMBLE}\n${lines.join("\n")}`;
}

/* What `ask.rs` sends the agent when the question is never answered: the
   ten-minute timeout, and the card being closed while it was still asking.
   Duplicated across the language boundary on purpose — the same bargain
   `isStopNote` strikes with the CLI's own wording, and for the same reason.
   The transcript fold reads a reply back off disk with nothing but its text to
   go on, so without this Skein's own sentence about an unanswered question is
   drawn as a sentence you said. Matched on the opening, since both go on to
   tell the agent what to do instead. */
const UNANSWERED = [
  "The user did not answer within ten minutes.",
  "The user dismissed the question.",
];

/** What the panel says when the reply was Skein's rather than yours.
 *
 *  One wording for both cases, because the live path only ever learns *that*
 *  the ask closed unanswered (`ask:closed` carries a boolean) and never which
 *  of the two it was — and a line that reads one way live and another way after
 *  a restart is the seam `history.ts` exists to avoid. */
export const NO_ANSWER_NOTE =
  "no answer sent — the agent went on with its own judgement";

export type AnswerNote = {
  /** `answer` is yours and is drawn as such. `meta` is Skein talking *about*
   *  the conversation, the register `cleared` and `stopped` are written in. */
  kind: "answer" | "meta";
  text: string;
};

/** What the transcript keeps of a parked question's reply.
 *
 *  Both folds go through here — live, from the text `answerAsk` sent, and off
 *  disk, from the `tool_result` the CLI recorded against the call — so what the
 *  panel shows after a restart is what it showed when you clicked. History that
 *  renders differently from live is a visible seam in the middle of one column
 *  of speech, which is the thing `foldTranscript` is written to avoid.
 *
 *  The preamble is dropped: it is addressed to the model, and the numbered
 *  pairs under it are the whole of what you actually said. */
export function answerNote(sent: string): AnswerNote | null {
  const text = sent.trim();
  if (!text) return null;
  if (UNANSWERED.some((u) => text.startsWith(u))) {
    return { kind: "meta", text: NO_ANSWER_NOTE };
  }
  const head = `${PREAMBLE}\n`;
  const body = text.startsWith(head) ? text.slice(head.length).trim() : text;
  return body ? { kind: "answer", text: body } : null;
}

/** What the peek and the dock say a card is waiting on.
 *
 *  The peek's line is `white-space: nowrap` with an ellipsis, so a question
 *  body put there is a truncated paragraph that names nothing. The headers are
 *  short by construction, which is most of why they exist. */
export function askHeadline(questions: AskQuestion[]): string {
  if (questions.length === 1) return questions[0].question;
  return `${questions.length} decisions: ${questions.map((q) => q.header).join(" · ")}`;
}
