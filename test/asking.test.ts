import { describe, expect, test } from "bun:test";
import {
  MAX_QUESTIONS,
  NO_ANSWER_NOTE,
  NO_PREFERENCE,
  answerNote,
  answeredCount,
  askHeadline,
  blankAnswers,
  composeAnswer,
  isComplete,
  normalizeAsk,
  overflowOf,
  stepAt,
  type Answers,
  type AskQuestion,
} from "../src/lib/asking";

const q = (header: string, question: string, labels: string[] = []): AskQuestion => ({
  header,
  question,
  options: labels.map((label) => ({ label, detail: null })),
});

describe("normalizeAsk", () => {
  test("the single-question sugar still makes one question", () => {
    const out = normalizeAsk({
      question: "tabs or spaces?",
      options: [{ label: "tabs" }, { label: "spaces", detail: "the right answer" }],
    });
    expect(out.length).toBe(1);
    expect(out[0].question).toBe("tabs or spaces?");
    expect(out[0].options.map((o) => o.label)).toEqual(["tabs", "spaces"]);
    expect(out[0].options[1].detail).toBe("the right answer");
  });

  test("several questions arrive in order", () => {
    const out = normalizeAsk({
      questions: [
        { header: "shape", question: "one widget or two?", options: [{ label: "two" }] },
        { header: "attention", question: "join the ladder?", options: [{ label: "yes" }] },
      ],
    });
    expect(out.map((x) => x.header)).toEqual(["shape", "attention"]);
    expect(out[1].question).toBe("join the ladder?");
  });

  test("both forms in one call keeps both questions", () => {
    /* A call sending both meant both. Dropping either loses a question the
       turn is genuinely parked on. */
    const out = normalizeAsk({
      question: "and one more thing?",
      questions: [{ question: "first?" }],
    });
    expect(out.map((x) => x.question)).toEqual(["first?", "and one more thing?"]);
  });

  test("a header is derived when none is given", () => {
    const out = normalizeAsk({ question: "Should the timer ring?" });
    expect(out[0].header).toBe("Should the timer ring?");
  });

  test("a derived header takes the first sentence when it is short", () => {
    const out = normalizeAsk({
      question: "Which shape? I can do one widget with variants, or two separate ones.",
    });
    expect(out[0].header).toBe("Which shape?");
  });

  test("a derived header from a long opener is cut on a word", () => {
    const out = normalizeAsk({
      question:
        "Two decisions before I build this and I would rather not guess at either of them.",
    });
    expect(out[0].header.length).toBeLessThanOrEqual(48);
    expect(out[0].header.endsWith("…")).toBe(true);
    expect(out[0].header).not.toContain(" …");
  });

  test("blank and malformed questions are dropped, not drawn", () => {
    const out = normalizeAsk({
      questions: [
        { question: "   " },
        { question: "real one?" },
        { question: 42 },
        "nonsense",
      ],
    });
    expect(out.map((x) => x.question)).toEqual(["real one?"]);
  });

  test("options that are not options are dropped", () => {
    const out = normalizeAsk({
      question: "pick?",
      options: [{ label: "" }, { detail: "no label" }, { label: "  keep  " }, 7],
    });
    expect(out[0].options).toEqual([{ label: "keep", detail: null }]);
  });

  test("an empty detail becomes null rather than an empty span", () => {
    const out = normalizeAsk({ question: "pick?", options: [{ label: "a", detail: "  " }] });
    expect(out[0].options[0].detail).toBe(null);
  });

  test("options that are not an array are simply no options", () => {
    const out = normalizeAsk({ question: "pick?", options: "tabs, spaces" });
    expect(out[0].options).toEqual([]);
  });

  test("an ask with nothing in it is still answerable", () => {
    /* The turn is parked either way. A card blocked with nothing on screen
       to unblock it with is the one outcome that cannot be allowed. */
    const out = normalizeAsk({});
    expect(out.length).toBe(1);
    expect(out[0].question).toBe("(no question given)");
  });

  test("the cap holds and the overflow is countable", () => {
    const raw = {
      questions: Array.from({ length: MAX_QUESTIONS + 3 }, (_, i) => ({
        question: `q${i}?`,
      })),
    };
    expect(normalizeAsk(raw).length).toBe(MAX_QUESTIONS);
    expect(overflowOf(raw)).toBe(3);
  });

  test("nothing over the cap means no overflow", () => {
    expect(overflowOf({ questions: [{ question: "a?" }] })).toBe(0);
    expect(overflowOf({})).toBe(0);
  });
});

describe("stepping", () => {
  const qs = [q("shape", "one or two?"), q("attention", "ring?"), q("name", "called?")];

  test("a fresh sheet starts on the first question", () => {
    const a = blankAnswers(qs);
    expect(a).toEqual([null, null, null]);
    expect(stepAt(a)).toBe(0);
    expect(isComplete(a)).toBe(false);
    expect(answeredCount(a)).toBe(0);
  });

  test("the step is the first unanswered question", () => {
    expect(stepAt(["two", null, null])).toBe(1);
    expect(stepAt(["two", "yes", null])).toBe(2);
  });

  test("revising an earlier answer does not strand the cursor", () => {
    /* The step is derived, so going back to change question 1 and answering
       it again lands on 2 rather than on a question already answered. */
    const answers = ["two", "yes", null];
    answers[0] = null;
    expect(stepAt(answers)).toBe(0);
    answers[0] = "three";
    expect(stepAt(answers)).toBe(2);
  });

  test("a complete sheet parks on the last question", () => {
    const a = ["two", "yes", "timer"];
    expect(stepAt(a)).toBe(2);
    expect(isComplete(a)).toBe(true);
    expect(answeredCount(a)).toBe(3);
  });

  test("an empty sheet is not complete", () => {
    expect(isComplete([])).toBe(false);
  });

  test("the sheet may be filled in any order", () => {
    /* The questions in one call are usually independent — that is the reason
       they are asked together — so there is no order to enforce, and the panel
       enforces none. What makes that safe is `composeAnswer` keying on the
       index rather than on when an answer arrived; see the test below. */
    const answers: Answers = [null, null, null];
    answers[2] = "timer";
    expect(stepAt(answers)).toBe(0);
    answers[0] = "two";
    expect(stepAt(answers)).toBe(1);
    expect(isComplete(answers)).toBe(false);
    answers[1] = "yes";
    expect(isComplete(answers)).toBe(true);
  });
});

describe("composeAnswer", () => {
  test("one question composes to the bare answer", () => {
    /* Load-bearing: this is what every ask sent before multi-question, and a
       single question suddenly arriving numbered would change the reply shape
       for every agent already written against it. */
    expect(composeAnswer([q("shape", "one or two?")], ["two widgets"])).toBe("two widgets");
  });

  test("one unanswered question still says something", () => {
    expect(composeAnswer([q("shape", "one or two?")], [null])).toBe(NO_PREFERENCE);
  });

  test("several compose to a numbered list carrying the headers", () => {
    const out = composeAnswer(
      [q("shape", "one or two?"), q("attention", "ring?")],
      ["two widgets", "yes, join the ladder"],
    );
    expect(out).toBe(
      "Answering each in turn:\n1. shape: two widgets\n2. attention: yes, join the ladder",
    );
  });

  test("the reply is the same however the sheet was filled in", () => {
    /* The load-bearing half of "answer them in any order". An answer is keyed
       by its question's index, never by when it was given, so the composed
       reply is identical — which is what makes the panel free to let you
       start anywhere. */
    const qs = [q("shape", "one or two?"), q("attention", "ring?"), q("name", "called?")];

    const inOrder: Answers = [null, null, null];
    inOrder[0] = "two";
    inOrder[1] = "yes";
    inOrder[2] = "timer";

    const backwards: Answers = [null, null, null];
    backwards[2] = "timer";
    backwards[1] = "yes";
    backwards[0] = "two";

    expect(composeAnswer(qs, backwards)).toBe(composeAnswer(qs, inOrder));
    expect(composeAnswer(qs, backwards)).toContain("1. shape: two");
    expect(composeAnswer(qs, backwards)).toContain("3. name: timer");
  });

  test("a skipped question is sent, not omitted", () => {
    /* A gap in a numbered list invites the model to re-align the rest onto
       the wrong questions. */
    const out = composeAnswer(
      [q("shape", "one or two?"), q("attention", "ring?"), q("name", "called?")],
      ["two widgets", null, "timer"],
    );
    expect(out.split("\n")).toEqual([
      "Answering each in turn:",
      "1. shape: two widgets",
      `2. attention: ${NO_PREFERENCE}`,
      "3. name: timer",
    ]);
  });

  test("a whitespace answer is treated as no preference", () => {
    const out = composeAnswer([q("a", "a?"), q("b", "b?")], ["   ", "yes"]);
    expect(out).toContain(`1. a: ${NO_PREFERENCE}`);
  });
});

describe("answerNote", () => {
  test("one question's answer is kept exactly as it was sent", () => {
    expect(answerNote("two widgets")).toEqual({ kind: "answer", text: "two widgets" });
  });

  test("the preamble is dropped and the pairs are kept", () => {
    /* It is a sentence addressed to the model. What you actually decided is the
       numbered pairs under it, and they are the whole of what the transcript
       has to show. */
    const sent = composeAnswer(
      [q("shape", "one or two?"), q("attention", "ring?")],
      ["two widgets", "keep it silent"],
    );
    expect(answerNote(sent)).toEqual({
      kind: "answer",
      text: "1. shape: two widgets\n2. attention: keep it silent",
    });
  });

  test("an answer that happens to mention the preamble keeps it", () => {
    /* Only the whole opening line is the preamble — anything else is a
       sentence you typed, and the panel does not edit those. */
    expect(answerNote("Answering each in turn: sure, go ahead")).toEqual({
      kind: "answer",
      text: "Answering each in turn: sure, go ahead",
    });
  });

  test("what ask.rs says when nobody answered is not something you said", () => {
    /* The same hazard `isStopNote` exists for, one layer over: read off disk
       the timeout is a `tool_result` like any other, and drawn as an answer it
       puts Skein's sentence in your mouth. */
    for (const sent of [
      "The user did not answer within ten minutes. Proceed using your best judgement, and say which way you went and why.",
      "The user dismissed the question. Proceed using your best judgement.",
    ]) {
      expect(answerNote(sent)).toEqual({ kind: "meta", text: NO_ANSWER_NOTE });
    }
  });

  test("an empty reply draws nothing", () => {
    expect(answerNote("")).toBe(null);
    expect(answerNote("   \n  ")).toBe(null);
  });
});

describe("askHeadline", () => {
  test("one question is its own headline", () => {
    expect(askHeadline([q("shape", "one widget or two?")])).toBe("one widget or two?");
  });

  test("several are named by their headers, never by a truncated body", () => {
    /* The peek's line is nowrap with an ellipsis. A question body there is a
       cut-off paragraph naming nothing. */
    expect(askHeadline([q("shape", "one or two?"), q("attention", "ring?")])).toBe(
      "2 decisions: shape · attention",
    );
  });
});
