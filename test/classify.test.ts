import { expect, test, describe } from "bun:test";
import {
  CLEAN_BLOOM_S,
  CLEAN_WARM_S,
  QUESTION_BLOOM_S,
  backgroundKind,
  baseModel,
  contextWindowFor,
  describeTool,
  endingFor,
  endsOnQuestion,
  isStopNote,
  isTaskNotification,
  jobLabel,
  localAnswer,
  parseTaskNotification,
  sameModel,
  startedJob,
  taskNumberOf,
  textOf,
  urgencyFor,
  wasStopped,
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

describe("a card set aside stops decaying", () => {
  /* The whole feature, in one place: what warms a card is nothing but how long
     you have left it, so a card you put by deliberately would go amber for
     doing exactly what you asked. Everything downstream — the waiting cycle,
     the dock's count, the peek, the card's colour — reads the tier, so
     silencing it here silences all four together. */
  test("neglect no longer warms it, however long it stands", () => {
    expect(urgencyFor("ok", 0, true)).toBe("rest");
    expect(urgencyFor("ok", CLEAN_WARM_S, true)).toBe("rest");
    expect(urgencyFor("ok", CLEAN_BLOOM_S, true)).toBe("rest");
    expect(urgencyFor("ok", 99_999, true)).toBe("rest");
  });

  test("a question it was left on goes quiet too", () => {
    /* Prose ending in a question mark is an *inference* about a turn nobody
       came back to, which is the same reading `aside` withdraws. */
    expect(urgencyFor("question", QUESTION_BLOOM_S, true)).toBe("rest");
  });

  test("a turn you stopped yourself goes quiet too", () => {
    expect(urgencyFor("stopped", CLEAN_BLOOM_S, true)).toBe("rest");
  });

  test("but a break still says so", () => {
    /* Not neglect: something happened. In practice a card set aside has no
       process doing anything, so this is the one you set aside mid-turn — and
       it must still be able to report that it broke. */
    expect(urgencyFor("error", 0, true)).toBe("fail");
    expect(urgencyFor("asked", 0, true)).toBe("ask");
  });

  test("and left out, nothing changes", () => {
    expect(urgencyFor("ok", CLEAN_BLOOM_S, false)).toBe("ask");
    expect(urgencyFor("ok", CLEAN_BLOOM_S)).toBe("ask");
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

describe("a turn somebody stopped", () => {
  /* Verbatim from `tools/probe-interrupt.ts` against claude 2.1.229, minus the
     fields nothing here reads. Every mark of a failure is on it — which is the
     whole reason `terminal_reason` has to be consulted first. */
  const aborted = {
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    stop_reason: null,
    terminal_reason: "aborted_streaming",
    errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],
  };

  test("is not a failure, though it arrives dressed as one", () => {
    expect(endingFor(aborted, "half an answ", false).ending).toBe("stopped");
  });

  test("outranks the question heuristic, which is reading a severed sentence", () => {
    /* The partial answer can end anywhere, including on a question mark it was
       nowhere near finished asking. */
    expect(endingFor(aborted, "Should I also", false).ending).toBe("stopped");
    expect(endingFor(aborted, "Shall I go on?", false).ending).toBe("stopped");
  });

  test("an interrupt during a tool call reads the same way", () => {
    expect(wasStopped({ ...aborted, terminal_reason: "aborted_tools" })).toBe(true);
  });

  test("a real break is still a break", () => {
    expect(wasStopped({ terminal_reason: "model_error" })).toBe(false);
    expect(wasStopped({ terminal_reason: "budget_exhausted" })).toBe(false);
    /* Older results carry no terminal_reason at all. */
    expect(wasStopped({ subtype: "error_during_execution", is_error: true })).toBe(false);
    expect(endingFor({ subtype: "error_max_turns" }, "", false).ending).toBe("error");
  });

  test("a clean turn is not stopped", () => {
    expect(wasStopped({ terminal_reason: "completed", subtype: "success" })).toBe(false);
  });

  test("the card warms on the same clock a clean finish does", () => {
    /* Nothing went wrong and nobody is waiting on an answer — but a card you
       stopped is just as easy to walk away from. */
    expect(urgencyFor("stopped", 0)).toBe("rest");
    expect(urgencyFor("stopped", CLEAN_WARM_S)).toBe("soft");
    expect(urgencyFor("stopped", CLEAN_BLOOM_S)).toBe("ask");
  });
});

describe("the CLI's own note about a stop", () => {
  /* Both wordings are real: taken from the transcripts on this machine, where
     the second appears when a tool call was in flight. */
  test("is known on sight, in either wording", () => {
    expect(isStopNote("[Request interrupted by user]")).toBe(true);
    expect(isStopNote("[Request interrupted by user for tool use]")).toBe(true);
    expect(isStopNote("  [Request interrupted by user]  ")).toBe(true);
  });

  test("does not swallow somebody quoting it", () => {
    /* It has to be the whole line. Otherwise a prompt *about* interrupting —
       which is a thing you would type at this app — would vanish from the
       transcript instead of being sent visibly. */
    expect(isStopNote("why did [Request interrupted by user] appear?")).toBe(false);
    expect(isStopNote("[Request interrupted]")).toBe(false);
    expect(isStopNote("interrupted")).toBe(false);
  });
});

describe("a turn the CLI answered by itself", () => {
  /* The three shapes below are cut from `tools/probe-commands.ts` run against
     claude 2.1.232 with Skein's exact argv. `num_turns: 0` is the whole test:
     it counts round trips to a model, so zero means nothing was asked of one
     and the sentence in `result` is the CLI's own. */
  test("a local command's answer is the only thing it said", () => {
    expect(
      localAnswer({
        type: "result",
        num_turns: 0,
        subtype: "success",
        is_error: false,
        result: "Set model to Sonnet 5 for this session only",
      }),
    ).toBe("Set model to Sonnet 5 for this session only");

    expect(
      localAnswer({ type: "result", num_turns: 0, result: "Not enough messages to compact." }),
    ).toBe("Not enough messages to compact.");

    /* A refusal is still an answer, and the card has to show it or the gesture
       looks like it did nothing. */
    expect(
      localAnswer({ type: "result", num_turns: 0, result: "/rewind isn't available in this environment." }),
    ).toBe("/rewind isn't available in this environment.");
  });

  test("an ordinary turn is not one, however short", () => {
    /* `result` on a real turn is the answer the transcript already carries, so
       reading it here would print every reply twice. */
    expect(localAnswer({ type: "result", num_turns: 1, result: "Hi" })).toBeNull();
    /* The rate-limited turn that sat beside them in the probe: refused before
       a token was generated, and still one turn. */
    expect(
      localAnswer({
        type: "result",
        num_turns: 1,
        is_error: true,
        api_error_status: 429,
        result: "You've hit your session limit",
      }),
    ).toBeNull();
  });

  test("nothing said is nothing to draw", () => {
    expect(localAnswer({ type: "result", num_turns: 0, result: "" })).toBeNull();
    expect(localAnswer({ type: "result", num_turns: 0, result: "   " })).toBeNull();
    expect(localAnswer({ type: "result", num_turns: 0 })).toBeNull();
    expect(localAnswer(undefined)).toBeNull();
  });
});

/* ── Work that outlives a turn ────────────────────────────────────────────
 *
 * Every string below is verbatim from this machine's transcripts, read
 * 2026-08-14 across all 496 files. The receipts and the notification are the
 * only account the wire gives of a job, so getting them wrong is the difference
 * between a card that says it is busy and one that says it is at rest while
 * twelve pytest workers run underneath it. */
describe("background jobs", () => {
  test("a backgrounded command is one; an ordinary command is not", () => {
    expect(
      backgroundKind("Bash", {
        command: "uv run pytest tests/ -n 6",
        run_in_background: true,
      }),
    ).toBe("command");
    expect(backgroundKind("Bash", { command: "ls nova rise" })).toBeNull();
    expect(backgroundKind("Bash", { command: "ls", run_in_background: false })).toBeNull();
  });

  test("a subagent backgrounds unless it is told not to", () => {
    /* The default in this build, which is why an `Agent` call that nobody
       configured still ends its turn with the work outstanding. */
    expect(backgroundKind("Agent", { subagent_type: "Explore" })).toBe("agent");
    expect(backgroundKind("Agent", { run_in_background: true })).toBe("agent");
    expect(backgroundKind("Agent", { run_in_background: false })).toBeNull();
    /* The old name for the same tool. */
    expect(backgroundKind("Task", { description: "x" })).toBe("agent");
  });

  test("a monitor is always one, and a read is never one", () => {
    expect(backgroundKind("Monitor", { command: "while true; do :; done" })).toBe("watch");
    expect(backgroundKind("Read", { file_path: "a.ts" })).toBeNull();
    expect(backgroundKind("TaskOutput", { task_id: "b4lq9y6zq" })).toBeNull();
  });

  test("the label prefers the words written to be read", () => {
    expect(
      jobLabel("Bash", {
        command: "uv run python scripts/batch_new_plans.py manifest.txt out",
        description: "Run pipeline over 15 new/changed plans",
        run_in_background: true,
      }),
    ).toBe("Run pipeline over 15 new/changed plans");
    /* No description: the command is what there is. */
    expect(jobLabel("Bash", { command: "uv run pytest tests/ -n 6" })).toBe(
      "uv run pytest tests/ -n 6",
    );
    expect(jobLabel("Agent", {})).toBe("a subagent");
  });

  test("the three receipts, verbatim", () => {
    expect(
      startedJob(
        "Command running in background with ID: btuqox9zy. Output is being written to: C:/Temp/claude/x/tasks/btuqox9zy.output. You will be notified when it completes.",
      ),
    ).toEqual({ started: true, taskId: "btuqox9zy" });

    expect(startedJob("Monitor started (task bc4v3btv8, timeout 1800000ms). You will be notified on each event.")).toEqual(
      { started: true, taskId: "bc4v3btv8" },
    );

    /* The agent's receipt names no job id we may keep — it carries an
       `agentId` and instructs in the same breath that it never be repeated.
       The tool_use id is the key anyway. */
    const agent = startedJob(
      "Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: aabf084cb860a82c6",
    );
    expect(agent.started).toBe(true);
    expect(agent.taskId).toBeNull();
  });

  test("an inline answer is not a receipt, which is how a job is dropped", () => {
    /* The only thing separating an `Agent` that backgrounded from one that ran
       to completion in place. */
    expect(startedJob("Here are the three files you asked for: …")).toEqual({
      started: false,
      taskId: null,
    });
    expect(startedJob("")).toEqual({ started: false, taskId: null });
  });
});

describe("task notifications", () => {
  const done = `<task-notification>
<task-id>b1i328ewu</task-id>
<tool-use-id>toolu_01DAtQaKTV5KhC7ULgtFK68w</tool-use-id>
<output-file>C:/Temp/claude/x/tasks/b1i328ewu.output</output-file>
<status>completed</status>
<summary>Background command "Wait for post-fix LCD test result" completed (exit code 0)</summary>
</task-notification>`;

  const killed = `<task-notification>
<task-id>b4lq9y6zq</task-id>
<tool-use-id>toolu_0187H9iorRy1KQB29RVTiqrj</tool-use-id>
<output-file>C:/Temp/claude/x/tasks/b4lq9y6zq.output</output-file>
<status>killed</status>
<summary>Background command "Re-run DB probe" was stopped</summary>
</task-notification>`;

  test("it is recognised as the CLI talking, not as anything you typed", () => {
    /* The whole reason this exists: read as speech, both folds pushed this
       block as a `you` line and opened a turn on it. */
    expect(isTaskNotification(done)).toBe(true);
    expect(isTaskNotification(killed)).toBe(true);
    expect(isTaskNotification("run the tests again please")).toBe(false);
    /* Prose that merely mentions one is still prose. */
    expect(isTaskNotification("what does <task-notification> mean?")).toBe(false);
  });

  test("a completed job carries the sentence worth drawing", () => {
    const n = parseTaskNotification(done)!;
    expect(n.toolId).toBe("toolu_01DAtQaKTV5KhC7ULgtFK68w");
    expect(n.taskId).toBe("b1i328ewu");
    expect(n.end).toBe("done");
    expect(n.summary).toBe(
      'Background command "Wait for post-fix LCD test result" completed (exit code 0)',
    );
  });

  test("a job stopped on purpose is not a job that failed", () => {
    expect(parseTaskNotification(killed)!.end).toBe("killed");
  });

  test("completed with a non-zero exit code is a failure", () => {
    /* The exit code rides in the summary rather than in a field of its own, and
       a background test run that came back red must not read as done. */
    const red = done.replace("(exit code 0)", "(exit code 1)");
    expect(parseTaskNotification(red)!.end).toBe("failed");
  });

  test("anything that is not one parses to nothing", () => {
    expect(parseTaskNotification("just a prompt")).toBeNull();
    expect(parseTaskNotification("")).toBeNull();
  });
});

describe("the plan", () => {
  test("a created item's number is what every later update names", () => {
    expect(
      taskNumberOf(
        "Task #1 created successfully: Prove the HTTP client reaches AzDO through Netskope",
      ),
    ).toBe("1");
    expect(taskNumberOf("Task #12 created successfully: x")).toBe("12");
    expect(taskNumberOf("Updated task #1 status")).toBeNull();
    expect(taskNumberOf("No tasks found")).toBeNull();
  });

  test("the live vocabulary reaches the activity line", () => {
    /* `TodoWrite` has never once been emitted here; these are what arrive, and
       they fell through to `default` and printed their own bare tool names. */
    expect(
      describeTool("TaskCreate", { activeForm: "Proving TLS and the auth ladder" }),
    ).toBe("Proving TLS and the auth ladder");
    expect(describeTool("TaskUpdate", { taskId: "1", status: "in_progress" })).toBe(
      "planning",
    );
    expect(describeTool("TaskList", {})).toBe("checking the plan");
    expect(describeTool("TaskStop", { task_id: "b6ea0g7u5" })).toBe("stopping a job");
    expect(describeTool("TaskOutput", { task_id: "b4lq9y6zq" })).toBe(
      "checking on a job",
    );
  });

  test("a subagent is delegation under either name", () => {
    expect(
      describeTool("Agent", { subagent_type: "Explore", description: "Find 3D view axis labels" }),
    ).toBe("delegating: Find 3D view axis labels");
    expect(describeTool("Task", { description: "Find 3D view axis labels" })).toBe(
      "delegating: Find 3D view axis labels",
    );
  });
});
