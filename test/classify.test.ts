import { expect, test, describe } from "bun:test";
import {
  CLEAN_BLOOM_S,
  CLEAN_WARM_S,
  QUESTION_BLOOM_S,
  baseModel,
  contextWindowFor,
  describeTool,
  endingFor,
  endsOnQuestion,
  sameModel,
  textOf,
  urgencyFor,
  windowForObserved,
} from "../src/lib/classify";

describe("urgency decays with neglect", () => {
  test("a break is loud immediately and stays loud", () => {
    expect(urgencyFor("error", 0)).toBe("fail");
    expect(urgencyFor("error", 99_999)).toBe("fail");
  });

  test("a clean finish starts quiet, warms, then blooms", () => {
    expect(urgencyFor("ok", 0)).toBe("rest");
    expect(urgencyFor("ok", CLEAN_WARM_S - 1)).toBe("rest");
    expect(urgencyFor("ok", CLEAN_WARM_S)).toBe("soft");
    expect(urgencyFor("ok", CLEAN_BLOOM_S - 1)).toBe("soft");
    expect(urgencyFor("ok", CLEAN_BLOOM_S)).toBe("ask");
  });

  test("an unanswered question escalates faster than a clean finish", () => {
    expect(urgencyFor("question", 0)).toBe("soft");
    expect(urgencyFor("question", QUESTION_BLOOM_S)).toBe("ask");
    // At two minutes a question is already loud; a clean finish is still quiet.
    expect(urgencyFor("question", 120)).toBe("ask");
    expect(urgencyFor("ok", 120)).toBe("rest");
  });

  test("a structured ask is loud regardless of age", () => {
    expect(urgencyFor("asked", 0)).toBe("ask");
  });
});

describe("endsOnQuestion", () => {
  test("plain closing question", () => {
    expect(endsOnQuestion("I've done the thing. Want me to push it?")).toBe(true);
  });

  test("question followed by a list still counts — the last line is what matters", () => {
    expect(endsOnQuestion("Done.\n\n- a\n- b\n\nShall I continue?")).toBe(true);
  });

  test("a question in the middle does not count", () => {
    expect(endsOnQuestion("Should I? I did it anyway. All tests pass.")).toBe(false);
  });

  test("tolerates trailing markdown and quotes", () => {
    expect(endsOnQuestion("Is that right?**")).toBe(true);
    expect(endsOnQuestion('He asked "is that right?"')).toBe(true);
  });

  test("statements are not questions", () => {
    expect(endsOnQuestion("All done. 14 passing, 1 skipped.")).toBe(false);
    expect(endsOnQuestion("")).toBe(false);
  });
});

describe("describeTool degrades before arguments arrive", () => {
  test("bare verb at content_block_start, sharpened when the block lands", () => {
    expect(describeTool("Read", {})).toBe("reading a file");
    expect(describeTool("Read", { file_path: "C:\\a\\b\\package.json" })).toBe(
      "reading package.json",
    );
  });

  test("never renders a dangling preposition", () => {
    for (const t of ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "Task"]) {
      expect(describeTool(t, {}).trim()).toBe(describeTool(t, {}));
      expect(describeTool(t, {})).not.toMatch(/\s$/);
    }
  });

  test("unknown tools fall through to their name, since the tool list is per-session", () => {
    expect(describeTool("DesignSync", {})).toBe("DesignSync");
    expect(describeTool("mcp__foo__bar", {})).toBe("mcp__foo__bar");
  });
});

describe("contextWindowFor", () => {
  test("recognises the 1M variant", () => {
    expect(contextWindowFor("claude-opus-5[1m]")).toBe(1_000_000);
    expect(contextWindowFor("claude-opus-5")).toBe(200_000);
    expect(contextWindowFor(undefined)).toBe(200_000);
  });
});

describe("a session read off disk has no declared tier", () => {
  /* A transcript records the bare per-message id only, so occupancy is the one
     piece of evidence about the window. The real case: a caravan session whose
     last request carried 443k tokens. */
  test("occupancy above the known window can only mean a wider one", () => {
    expect(windowForObserved("claude-opus-5", 443_000)).toBe(1_000_000);
    expect(windowForObserved(undefined, 228_416)).toBe(1_000_000);
  });

  test("occupancy that fits is not evidence of anything", () => {
    expect(windowForObserved("claude-opus-5", 78_000)).toBe(200_000);
    expect(windowForObserved("claude-opus-5", 200_000)).toBe(200_000);
    expect(windowForObserved(undefined, 0)).toBe(200_000);
  });

  test("a declared tier is not narrowed by a smaller reading", () => {
    expect(windowForObserved("claude-opus-5[1m]", 12_000)).toBe(1_000_000);
  });
});

describe("the window tier only exists on the init id", () => {
  /* Probed against claude 2.1.227: system/init says claude-opus-5[1m], every
     assistant message on the same session says claude-opus-5. Believing the
     second one shrinks a 1M ring to 200k and reports 46% for 9%. */
  test("the bare per-message id is the same model as the declared one", () => {
    expect(sameModel("claude-opus-5", "claude-opus-5[1m]")).toBe(true);
    expect(sameModel("claude-opus-5[1m]", "claude-opus-5")).toBe(true);
  });

  test("a genuinely different model is not the same model", () => {
    expect(sameModel("claude-sonnet-5", "claude-opus-5[1m]")).toBe(false);
    expect(sameModel("claude-opus-4-5", "claude-opus-5")).toBe(false);
  });

  test("nothing is the same as nothing", () => {
    expect(sameModel(undefined, undefined)).toBe(false);
    expect(sameModel("", "")).toBe(false);
    expect(sameModel("claude-opus-5", undefined)).toBe(false);
  });

  test("both spellings of the tier are stripped", () => {
    expect(baseModel("claude-opus-5[1m]")).toBe("claude-opus-5");
    expect(baseModel("claude-sonnet-4-5-1m")).toBe("claude-sonnet-4-5");
    expect(baseModel("claude-opus-5")).toBe("claude-opus-5");
  });

  test("and the window still follows from the declared id", () => {
    expect(contextWindowFor("claude-opus-5[1m]")).toBe(1_000_000);
    expect(contextWindowFor(baseModel("claude-opus-5[1m]"))).toBe(200_000);
  });
});

describe("textOf", () => {
  test("blocks, in order, text only", () => {
    expect(
      textOf([
        { type: "text", text: "one" },
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "two" },
      ]),
    ).toBe("one\ntwo");
  });

  test("a bare string is content too — tool results use both shapes", () => {
    expect(textOf("  done  ")).toBe("done");
  });

  test("a message with no prose is empty, not noise", () => {
    expect(textOf([{ type: "tool_use", name: "Read", input: {} }])).toBe("");
    expect(textOf(undefined)).toBe("");
    expect(textOf(null)).toBe("");
    expect(textOf(42)).toBe("");
  });
});

describe("endingFor", () => {
  test("api_error_status marks a break even when is_error is absent", () => {
    const { ending, detail } = endingFor(
      { subtype: "success", api_error_status: "rate_limit_error" },
      "whatever",
      false,
    );
    expect(ending).toBe("error");
    expect(detail).toBe("rate_limit_error");
  });

  test("a non-success subtype is a break", () => {
    expect(endingFor({ subtype: "error_max_turns" }, "", false).ending).toBe("error");
  });

  test("clean success on a statement is 'ok'", () => {
    expect(endingFor({ subtype: "success" }, "All done.", false).ending).toBe("ok");
  });

  test("clean success ending on a question is 'question'", () => {
    expect(endingFor({ subtype: "success" }, "Push it?", false).ending).toBe("question");
  });

  test("an ask tool outranks the text heuristic", () => {
    expect(endingFor({ subtype: "success" }, "All done.", true).ending).toBe("asked");
  });
});
