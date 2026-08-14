import { expect, test, describe } from "bun:test";
import { HISTORY_MAX_LINES, foldTranscript, trimOverlap } from "../src/lib/history";

/** One NDJSON record per argument, the way a transcript is written. */
const jsonl = (...recs: unknown[]) => recs.map((r) => JSON.stringify(r)).join("\n");

const user = (text: unknown, extra: object = {}) => ({
  type: "user",
  message: { role: "user", content: text },
  ...extra,
});
const assistant = (content: unknown[], extra: object = {}) => ({
  type: "assistant",
  message: { role: "assistant", content },
  ...extra,
});

describe("what a transcript says", () => {
  test("both prompt shapes are the same speech", () => {
    /* The TUI writes a bare string, the SDK writes a text block. 877 and 67
       records respectively on this machine — a reader that took only one shape
       would show every Skein card's half of the conversation and no CLI card's,
       or the reverse. */
    const h = foldTranscript(
      jsonl(user("typed in the terminal"), user([{ type: "text", text: "sent by skein" }])),
    );
    expect(h.lines).toEqual([
      { kind: "you", text: "typed in the terminal" },
      { kind: "you", text: "sent by skein" },
    ]);
  });

  test("an assistant turn folds to the same lines the live stream produces", () => {
    const h = foldTranscript(
      jsonl(
        assistant([
          { type: "thinking", thinking: "at length, and mostly" },
          { type: "text", text: "here is the answer" },
          { type: "tool_use", name: "Read", input: { file_path: "C:\\atelier\\skein\\src\\lib\\layout.ts" } },
        ]),
      ),
    );
    expect(h.lines).toEqual([
      { kind: "text", text: "here is the answer" },
      { kind: "tool", text: "reading layout.ts" },
    ]);
  });

  test("tool results are not speech", () => {
    // 6680 of the 7624 `user` records here are tool results, not prompts.
    const h = foldTranscript(
      jsonl(user([{ type: "tool_result", tool_use_id: "t1", content: "1400 lines of output" }])),
    );
    expect(h.lines).toEqual([]);
  });
});

describe("what a transcript carries that the wire never does", () => {
  test("a subagent's own turns stay inside their seat", () => {
    /* The live card collapses subagents into seats. Replaying their turns would
       render a card's history as mostly other agents talking. */
    const h = foldTranscript(
      jsonl(
        user("do the thing", { isSidechain: true }),
        assistant([{ type: "text", text: "subagent thinking out loud" }], { isSidechain: true }),
        assistant([{ type: "text", text: "the card's own answer" }]),
      ),
    );
    expect(h.lines).toEqual([{ kind: "text", text: "the card's own answer" }]);
  });

  test("injected context is not something anybody said", () => {
    const h = foldTranscript(
      jsonl(
        user("<local-command-caveat>Caveat: …</local-command-caveat>", { isMeta: true }),
        user("Continue from where you left off.", { isMeta: true }),
        user("what I actually asked"),
      ),
    );
    expect(h.lines).toEqual([{ kind: "you", text: "what I actually asked" }]);
  });

  test("a stop is a note, not a sentence you typed", () => {
    /* The CLI writes this as an ordinary `user` record with no `isMeta` on it,
       so nothing above sorts it out. Left alone it comes back after a restart
       as a prompt you appear to have sent — and reads differently from the same
       stop live, which draws a meta line. */
    const h = foldTranscript(
      jsonl(
        user("count to four hundred"),
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "1 — one" }] } },
        user([{ type: "text", text: "[Request interrupted by user]" }]),
        user("never mind, do this instead"),
      ),
    );
    expect(h.lines).toEqual([
      { kind: "you", text: "count to four hundred" },
      { kind: "text", text: "1 — one" },
      { kind: "meta", text: "stopped" },
      { kind: "you", text: "never mind, do this instead" },
    ]);
  });

  test("a background job reporting in is the CLI talking, not you", () => {
    /* Same shape as the stop note above and the same hazard: a bare string on a
       `user` record with no `isMeta` to sort it out by. Read as speech it puts a
       block of XML into the transcript as words you appear to have typed, and
       it has to read the same here as it does live, or a restart changes what a
       card said. Verbatim from this machine's transcripts, 2026-08-14. */
    const summary =
      'Background command "Wait for LCD test results" completed (exit code 0)';
    const note = [
      "<task-notification>",
      "<task-id>b1i328ewu</task-id>",
      "<tool-use-id>toolu_01DAtQaKTV5KhC7ULgtFK68w</tool-use-id>",
      "<output-file>C:/Temp/claude/x/tasks/b1i328ewu.output</output-file>",
      "<status>completed</status>",
      `<summary>${summary}</summary>`,
      "</task-notification>",
    ].join("\n");
    const h = foldTranscript(
      jsonl(
        user("run the LCD tests in the background"),
        user(note),
        user("and now commit it"),
      ),
    );
    expect(h.lines).toEqual([
      { kind: "you", text: "run the LCD tests in the background" },
      { kind: "meta", text: summary },
      { kind: "you", text: "and now commit it" },
    ]);
  });

  test("compaction is marked rather than replayed or silently dropped", () => {
    const h = foldTranscript(
      jsonl(
        {
          type: "system",
          subtype: "compact_boundary",
          compactMetadata: { trigger: "manual", preTokens: 624_414, postTokens: 11_500 },
        },
        user("This session is being continued from a previous conversation…", {
          isCompactSummary: true,
        }),
      ),
    );
    expect(h.lines[0]).toEqual({ kind: "meta", text: "context compacted · 624k → 12k" });
    expect(h.lines[1].kind).toBe("meta");
    expect(h.lines[1].text).toStartWith("earlier turns summarised —");
  });

  test("bookkeeping records draw nothing", () => {
    // ai-title, last-prompt, mode, attachment and friends outnumber speech.
    const h = foldTranscript(
      jsonl(
        { type: "ai-title", aiTitle: "Fix the slug" },
        { type: "last-prompt", prompt: "…" },
        { type: "mode", mode: "default" },
        { type: "attachment", attachment: { content: "a wall of skill descriptions" } },
        { type: "file-history-snapshot", messageId: "x" },
        { type: "system", subtype: "turn_duration", durationMs: 4200 },
        { type: "queue-operation", operation: "enqueue" },
      ),
    );
    expect(h.lines).toEqual([]);
  });
});

describe("history read while the card is speaking", () => {
  const h = (kind: any, text: string) => ({ kind, text });

  test("the wire wins over the file for anything both carried", () => {
    /* Since reading now starts with the wall rather than with a click, a card
       woken immediately can have its new turn reach the transcript before the
       read does. */
    const history = [h("you", "older question"), h("text", "older answer"), h("you", "the new turn")];
    const live = [h("you", "the new turn"), h("text", "answering now")];
    expect(trimOverlap(history, live)).toEqual([
      h("you", "older question"),
      h("text", "older answer"),
    ]);
  });

  test("with nothing live, history is untouched", () => {
    const history = [h("you", "a"), h("text", "b")];
    expect(trimOverlap(history, [])).toEqual(history);
  });

  test("a live line the file never had leaves history whole", () => {
    const history = [h("you", "a")];
    expect(trimOverlap(history, [h("you", "something else")])).toEqual(history);
  });

  test("skein's own note is not the anchor — the prompt under it is", () => {
    /* A roused card's live column opens with the meta note rousing writes above
       the resume prompt. It is Skein talking, so it is in no transcript: anchor
       on it and nothing matches, and the file's copy of the prompt is kept
       directly above the live one. The read and the send genuinely race — the
       transcripts are still being filled in while the rousing queue works along
       the wall. */
    const history = [h("you", "carry on"), h("text", "half an answer")];
    const live = [h("meta", "resumed by skein"), h("you", "carry on")];
    expect(trimOverlap(history, live)).toEqual([]);
  });

  test("a repeated line cuts at the last one, not the first", () => {
    // "continue" gets typed a lot; cutting at the first would eat the session.
    const history = [h("you", "continue"), h("text", "ok"), h("you", "continue")];
    expect(trimOverlap(history, [h("you", "continue")])).toEqual([
      h("you", "continue"),
      h("text", "ok"),
    ]);
  });
});

describe("reading a file that is being written", () => {
  test("a half-written last line is skipped, not fatal", () => {
    const h = foldTranscript(jsonl(user("landed")) + '\n{"type":"assist');
    expect(h.lines).toEqual([{ kind: "you", text: "landed" }]);
  });

  test("only the tail is kept, and says so", () => {
    const many = Array.from({ length: HISTORY_MAX_LINES + 20 }, (_, i) => user(`p${i}`));
    const h = foldTranscript(jsonl(...many), { partial: true });
    expect(h.lines.length).toBe(HISTORY_MAX_LINES);
    expect(h.dropped).toBe(20);
    expect(h.lines[0].text).toBe("p20");
    expect(h.partial).toBe(true);
  });

  test("an absent or empty transcript folds to nothing", () => {
    expect(foldTranscript("").lines).toEqual([]);
    expect(foldTranscript("\n\n").lines).toEqual([]);
  });
});
