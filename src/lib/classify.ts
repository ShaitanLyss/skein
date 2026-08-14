/* Pure classification. No runes, no I/O — so it can be tested against real
 * `claude` output without a browser or a Svelte compiler in the way.
 *
 * This file is also where nearly all Claude-specific knowledge lives (tool
 * names, model ids, event vocabulary). If a second agent backend ever matters,
 * this is the file that gets an interface. */

/** How a turn ended. Immutable once decided — this is a fact about the turn. */
export type Ending =
  | "ok" // finished clean, nothing pending
  | "question" // last line was a question left in prose
  | "asked" // a structured ask via tool (see ASK_TOOLS)
  | "stopped" // you stopped it mid-turn (see `wasStopped`)
  | "error"; // crashed, errored, rate-limited

/** What the card looks like right now. Urgency, not history. */
export type Tier =
  | "work" // celadon — streaming, alive
  | "ask" // amber   — full bloom, wants you now
  | "soft" // amber ½ — warming, has been waiting
  | "rest" // muted   — finished clean, recently
  | "fail"; // rust    — broken

/* ── Urgency ──────────────────────────────────────────────────────────────
 *
 * `AskUserQuestion` and `ExitPlanMode` do NOT exist in headless mode — probed
 * against claude 2.1.227: they are absent from the session tool list, and
 * `--tools` silently drops them when named explicitly. So the "asked" ending is
 * currently unreachable, and amber would be a colour nothing could ever use.
 *
 * Instead, amber means *this has been waiting too long*. Urgency is one hue
 * moving in intensity, and what it measures is neglect — which is the actual
 * failure mode: an agent that finished four minutes ago and went quiet.
 *
 * A question left hanging escalates faster than a clean finish, because
 * somebody is explicitly waiting on an answer. */
export const QUESTION_BLOOM_S = 120; // an unanswered question: loud after 2m
export const CLEAN_WARM_S = 300; // a clean finish: warms after 5m
export const CLEAN_BLOOM_S = 900; // ...and is loud after 15m

/** @param aside this card has been set aside — see `Conversation.aside`.
 *
 *  Urgency here *is* the clock: what warms a card is nothing but how long you
 *  have left it. So a card you put by deliberately would warm to amber for
 *  doing exactly what you asked of it, and then take its turn in the waiting
 *  cycle — which is the one place on this wall where being ignored is the
 *  point. Setting a card aside says stop counting; this is where the counting
 *  stops, so that everything reading the tier — the cycle, the dock's count,
 *  the peek, the card's own colour — stops together.
 *
 *  It is checked *after* the two endings that are events rather than neglect.
 *  A crash and a structured ask are things that happened, not time passing, and
 *  a card that broke in the middle of the turn you walked away from still has
 *  to be able to say so. In practice a card set aside is a card with no process
 *  doing anything, so those arms are about the one you set aside mid-turn. */
export function urgencyFor(
  ending: Ending,
  idleSeconds: number,
  aside = false,
): Tier {
  if (ending === "error") return "fail";
  if (ending === "asked") return "ask";
  if (aside) return "rest";
  if (ending === "question") {
    return idleSeconds >= QUESTION_BLOOM_S ? "ask" : "soft";
  }
  /* `stopped` falls through here with `ok`, deliberately. Nothing went wrong —
     you ended the turn yourself — so it is not rust and not a question anybody
     is waiting on. But a card you stopped is exactly as easy to walk away
     from as one that finished, so it warms on the same clock. */
  if (idleSeconds >= CLEAN_BLOOM_S) return "ask";
  if (idleSeconds >= CLEAN_WARM_S) return "soft";
  return "rest";
}

/** Tools that would constitute a real, structured ask. Retained deliberately:
 *  the detection costs nothing and starts working the day they become
 *  available in headless mode. */
export const ASK_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

export function basename(p: unknown): string {
  if (typeof p !== "string") return "";
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** The prose in a message's content.
 *
 * `content` is either a bare string or a list of blocks, on both the user and
 * the assistant side, and tool results nest the same shape again. Anything that
 * is not a text block — tool_use, tool_result, thinking — is not prose and is
 * dropped. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n")
    .trim();
}

export function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
}

/** Turn a tool call into the one line of prose that goes under the title.
 *
 * `input` is empty at `content_block_start` — arguments stream in afterwards as
 * `input_json_delta` — so every case degrades to a bare verb. The activity line
 * reads "reading a file" the instant the call begins and sharpens to "reading
 * package.json" when the full block lands.
 *
 * The tool list is per-session and includes whatever MCP servers and plugins
 * the user has loaded, so unknown names fall through to the bare tool name
 * rather than being dropped. */
export function describeTool(name: string, input: any): string {
  const arg = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v : null;

  const path = arg(input?.file_path);
  switch (name) {
    case "Read":
      return path ? `reading ${basename(path)}` : "reading a file";
    case "Edit":
      return path ? `editing ${basename(path)}` : "editing a file";
    case "Write":
      return path ? `writing ${basename(path)}` : "writing a file";
    case "NotebookEdit": {
      const nb = arg(input?.notebook_path);
      return nb ? `editing ${basename(nb)}` : "editing a notebook";
    }
    case "Bash":
    case "PowerShell": {
      const c = arg(input?.command);
      return c ? clip(c, 46) : "running a command";
    }
    case "Glob": {
      const p = arg(input?.pattern);
      return p ? `finding ${clip(p, 28)}` : "finding files";
    }
    case "Grep": {
      const p = arg(input?.pattern);
      return p ? `searching for ${clip(p, 26)}` : "searching";
    }
    /* `Agent` is the live name for the subagent tool; `Task` is what the same
       tool was called in older builds. Nothing on this machine has ever emitted
       `Task` — 0 uses against 192 `Agent` calls across all 496 transcripts,
       read 2026-08-14 — and keying on `Task` alone is what left the whole seat
       machinery in `conversation.svelte.ts` dead code from the day it shipped.
       Both are matched, because the old name costs one line. */
    case "Agent":
    case "Task": {
      const d = arg(input?.description);
      return d ? `delegating: ${clip(d, 30)}` : "delegating";
    }
    case "Skill": {
      const s = arg(input?.skill);
      return s ? `running /${clip(s, 26)}` : "running a skill";
    }
    case "WebFetch": {
      const u = arg(input?.url);
      return u ? `fetching ${clip(u, 34)}` : "fetching a page";
    }
    case "WebSearch":
      return "searching the web";
    /* The plan. `TodoWrite` is the old single-call shape and is used *nowhere*
       here — 0 across all 496 transcripts — while the live vocabulary is one
       call per change: 150 `TaskCreate` and 209 `TaskUpdate`, read 2026-08-14.
       So the one name this file knew was the one name that never arrives, and
       every plan update fell through to `default` and printed the bare string
       `TaskUpdate` on the card. */
    case "TodoWrite":
      return "planning";
    case "TaskCreate": {
      /* `activeForm` is the gerund the model writes for exactly this line —
         "Proving TLS and the auth ladder". Nothing else has to be composed. */
      const a = arg(input?.activeForm) ?? arg(input?.subject);
      return a ? clip(a, 40) : "planning";
    }
    case "TaskUpdate":
      /* Carries an id and a status and no words at all, so the words have to
         come from the folded plan — see `Conversation.#planLine`. */
      return "planning";
    case "TaskList":
    case "TaskGet":
      return "checking the plan";
    case "TaskOutput":
    case "BashOutput":
      return "checking on a job";
    case "TaskStop":
    case "KillShell":
      return "stopping a job";
    case "Monitor": {
      const d = arg(input?.description);
      return d ? `watching ${clip(d, 32)}` : "watching for something";
    }
    case "SendMessage":
      return "messaging an agent";
    case "AskUserQuestion":
      return "asked you a question";
    case "ExitPlanMode":
      return "wants the plan approved";
    default:
      return name;
  }
}

/* ── Work that outlives a turn ────────────────────────────────────────────
 *
 * Every other state on this wall is a fold over one turn: it opens on the first
 * event and closes on the `result`. Background work breaks that, and it is the
 * one thing on the wire that the fold had no concept of at all.
 *
 * A `Bash` carrying `run_in_background`, an `Agent` (which backgrounds by
 * default in this build) and a `Monitor` all return *immediately* — the tool
 * result is a receipt naming a job id, not an answer — and the turn then
 * settles clean. So the card went `rest` and started warming on the neglect
 * clock while `pytest -n 6` fanned out to twelve processes underneath it.
 * Observed 2026-08-14 with two such trees live under `skein.exe`.
 *
 * Completion arrives much later as a `<task-notification>` on a `user` message,
 * which is the CLI talking about the conversation rather than anything anybody
 * typed — the same register as the stop note, and the same hazard: read as
 * speech it becomes a wall of XML the transcript attributes to you.
 *
 * Counts below are from this machine's 496 transcripts, read 2026-08-14. */

/** What kind of thing was put in the background. Not cosmetic: an agent's
 *  receipt names no job id (see `startedJob`), so the three cannot share one
 *  parser. */
export type JobKind = "command" | "agent" | "watch";

/** Would this call put something in the background?
 *
 *  Answered from the *call*, so a job is on the card the moment the tool_use
 *  block lands rather than a round trip later. It is provisional by nature —
 *  `Agent` can be told to run inline, and only its receipt says which it did —
 *  so the caller registers a job here and `startedJob` confirms or drops it. */
export function backgroundKind(name: string, input: any): JobKind | null {
  if (name === "Bash" || name === "PowerShell") {
    return input?.run_in_background === true ? "command" : null;
  }
  /* Both names, for the reason `describeTool` matches both. */
  if (name === "Agent" || name === "Task") {
    /* Default true in this build — the tool description says subagents run in
       the background unless `run_in_background: false` is passed. */
    return input?.run_in_background === false ? null : "agent";
  }
  if (name === "Monitor") return "watch";
  return null;
}

/** What to call a job on the card. The `description` field is written to be
 *  read by a person, so it is preferred over the command wherever it exists. */
export function jobLabel(name: string, input: any): string {
  const d = input?.description;
  if (typeof d === "string" && d.trim()) return clip(d, 40);
  const c = input?.command;
  if (typeof c === "string" && c.trim()) return clip(c, 40);
  const p = input?.prompt;
  if (typeof p === "string" && p.trim()) return clip(p, 40);
  return name === "Agent" || name === "Task" ? "a subagent" : "a job";
}

/** Did this tool result actually start something, and what is its id?
 *
 *  Three receipts, verbatim from the transcripts:
 *
 *    Command running in background with ID: btuqox9zy. Output is being …
 *    Monitor started (task bc4v3btv8, timeout 1800000ms). You will be …
 *    Async agent launched successfully. (This tool result is internal …
 *
 *  `started` is the answer that matters — a `false` means the call ran inline
 *  after all and the provisional job must be dropped, which is the only way to
 *  tell an `Agent` that backgrounded from one that did not.
 *
 *  An agent's receipt carries an `agentId` and **explicitly instructs that it
 *  never be repeated to the user**, so it is deliberately not extracted. It is
 *  not needed: a job is keyed on the tool_use id, which is what the completion
 *  notification quotes back. */
export function startedJob(resultText: string): { started: boolean; taskId: string | null } {
  const bg = /\brunning in background with ID:\s*([A-Za-z0-9_-]+)/i.exec(resultText);
  if (bg) return { started: true, taskId: bg[1] };
  const mon = /\bMonitor started\s*\(task\s+([A-Za-z0-9_-]+)/i.exec(resultText);
  if (mon) return { started: true, taskId: mon[1] };
  if (/\bAsync agent launched successfully\b/i.test(resultText)) {
    return { started: true, taskId: null };
  }
  return { started: false, taskId: null };
}

/** How a background job ended. */
export type JobEnd = "done" | "failed" | "killed";

export type TaskNote = {
  taskId: string | null;
  /** The call that started it — the only id shared by the tool_use, the
   *  receipt and this notification, and therefore what jobs are keyed on. */
  toolId: string | null;
  end: JobEnd;
  /** The CLI's own sentence, which is already the line worth drawing:
   *  `Background command "Wait for LCD test results" completed (exit code 0)`. */
  summary: string;
};

/** Is this `user` message the CLI reporting a background job, rather than
 *  anything anybody said?
 *
 *  It arrives as a bare string on a `user` record with no `isMeta` to sort it
 *  out by — exactly the shape `isStopNote` exists for, and the same failure if
 *  it is missed: both folds pushed the raw XML as a `you` line and then opened
 *  a turn on it. */
export function isTaskNotification(text: string): boolean {
  return /^<task-notification>[\s\S]*<\/task-notification>$/.test(text.trim());
}

export function parseTaskNotification(text: string): TaskNote | null {
  if (!isTaskNotification(text)) return null;
  const field = (tag: string): string | null => {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
    return m ? m[1].trim() || null : null;
  };
  const status = (field("status") ?? "").toLowerCase();
  const summary = field("summary") ?? "";
  /* `completed` and `killed` are the two seen on this machine. The exit code
     rides in the summary rather than in a field of its own, and a command that
     completed non-zero is a job that failed — a background test run that came
     back red must not read as done. */
  const code = /\(exit code (\d+)\)/.exec(summary);
  let end: JobEnd;
  if (status === "completed") end = code && code[1] !== "0" ? "failed" : "done";
  else if (/^(killed|stopped|cancelled|canceled)$/.test(status)) end = "killed";
  else if (status === "" ) end = "done";
  else end = "failed";
  return {
    taskId: field("task-id"),
    toolId: field("tool-use-id"),
    end,
    summary: summary || `a background job ${status || "finished"}`,
  };
}

/** The number the CLI gave a freshly created plan item.
 *
 *  `TaskCreate` answers `Task #1 created successfully: <subject>`, and that
 *  number is what every later `TaskUpdate` names. Without it the plan cannot be
 *  kept in step, since the update carries an id and a status and nothing else. */
export function taskNumberOf(resultText: string): string | null {
  const m = /\bTask #(\d+) created successfully\b/i.exec(resultText);
  return m ? m[1] : null;
}

/** A model id tells us how much room the conversation actually has.
 *
 * Only the id from `system/init` carries the window tier — see `sameModel`. */
export function contextWindowFor(model: string | undefined): number {
  if (!model) return 200_000;
  return /\[1m\]|-1m\b/.test(model) ? 1_000_000 : 200_000;
}

/** The window a session must have had, given what it actually occupied.
 *
 * For a conversation read off disk there is no `system/init` to ask: a
 * transcript records only the bare per-message id, so the tier is not in the
 * file at all. But occupancy is, and it rules things out — a request that
 * carried 443k tokens cannot have been made against a 200k window. Inference
 * only ever widens, which is the safe direction: the alternative is a card
 * imported at 443k drawing a full ring and reading as about to run out.
 *
 * The moment such a card wakes, `system/init` states the tier and
 * `#adoptModel` replaces this guess with the fact. */
export function windowForObserved(
  model: string | undefined,
  tokens: number,
): number {
  const known = contextWindowFor(model);
  return tokens > known ? 1_000_000 : known;
}

/** A model id with its window tier stripped.
 *
 * The wire reports two different ids for one session. `system/init` gives the
 * *configured* model, tier and all — `claude-opus-5[1m]`. Every `assistant`
 * message then reports the bare API name the request actually went to —
 * `claude-opus-5` — because `[1m]` is Claude Code's own notation for the beta
 * window, not part of the model's name. Probed against 2.1.227. */
export function baseModel(model: string | undefined): string {
  if (!model) return "";
  return model.replace(/\[[^\]]*\]\s*$/, "").replace(/-1m$/, "");
}

/** Are these two ids the same model, differing only in window tier?
 *
 * This is what stops a 1M session from being reported as a 200k one: the
 * per-message id is not a *narrower* model, it is the *same* model with the
 * tier suffix dropped, and it must never be allowed to shrink the ring. */
export function sameModel(a: string | undefined, b: string | undefined): boolean {
  const x = baseModel(a);
  return x !== "" && x === baseModel(b);
}

/** Did this turn end on a question?
 *
 * Looks at the last non-empty line so a closing question survives being
 * followed by a bulleted list, and tolerates trailing quotes and brackets. */
export function endsOnQuestion(text: string): boolean {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return false;
  return /\?["'`)\]*_]*\s*$/.test(last);
}

/** The note Claude Code writes into the conversation when a turn is stopped.
 *
 * It is the CLI talking *about* the conversation, not words anybody said in
 * it — so both folds have to know it on sight, or a stop appears in the
 * transcript as a prompt you typed. It arrives twice over: as a `user` message
 * on the wire, moments after the interrupt, and as a `user` record in the
 * session file, which is what a restored card reads.
 *
 * Two wordings on this machine's transcripts — `[Request interrupted by user]`
 * when the answer was being written, and `[Request interrupted by user for tool
 * use]` when a tool call was in flight. Matched by shape rather than by the two
 * exact strings, since the tail is plainly a reason and reasons get added. */
export function isStopNote(text: string): boolean {
  return /^\[request interrupted by user\b[^\]]*\]$/i.test(text.trim());
}

/** Did somebody stop this turn, or did it break?
 *
 * Nothing else in the `result` event separates the two: a stopped turn arrives
 * wearing every mark of a failed one — `is_error: true`, `subtype:
 * "error_during_execution"`, an `errors` array — and taking those at face value
 * paints a card rust for a thing you did on purpose.
 *
 * `terminal_reason` is the field that says so. Probed against claude 2.1.229
 * (`tools/probe-interrupt.ts`): interrupting mid-answer gives
 * `aborted_streaming`, against `completed` for a clean turn. `aborted_tools` is
 * the other member of that family in the binary — an interrupt landing while a
 * tool call is in flight, which is also what the second wording of the stop
 * note describes. Prefix-matched so a third `aborted_*` reads as stopped rather
 * than as a crash. */
export function wasStopped(result: any): boolean {
  const reason = result?.terminal_reason;
  return typeof reason === "string" && reason.startsWith("aborted");
}

/** The CLI's own answer to a turn no model ever saw.
 *
 * `/compact`, `/model` and `/effort` are answered by the binary itself: the
 * whole reply is one line in `result.result` ("Set model to Sonnet 5 for this
 * session only"), and the only `assistant` message is a `<synthetic>` one with
 * empty content. So a card that ran one showed the prompt, nothing after it,
 * and settled at rest — the gesture appeared to do nothing at all.
 *
 * `num_turns` is what separates this from an ordinary turn, and it is exact
 * rather than a heuristic: it counts the round trips to a model, so zero means
 * nothing was asked of one. Probed 2026-08-14 against claude 2.1.232
 * (`tools/probe-commands.ts`) — every local command answered with `num_turns:
 * 0`, `duration_api_ms: 0` and an all-zero `usage`, where the rate-limited turn
 * beside them still reported 1.
 *
 * Deliberately not consulted for an *errored* turn: `endingFor` already reads
 * `result.result` as the detail there, and drawing it twice would put the same
 * sentence in the transcript as both a note and a fault. */
export function localAnswer(result: any): string | null {
  if (result?.num_turns !== 0) return null;
  const said = result?.result;
  return typeof said === "string" && said.trim() ? said.trim() : null;
}

/** Decide how a turn ended, from the `result` event and the turn's text. */
export function endingFor(
  result: any,
  turnText: string,
  sawAskTool: boolean,
): { ending: Ending; detail: string | null } {
  /* Ahead of the error test, and that is the whole point of it. */
  if (wasStopped(result)) return { ending: "stopped", detail: null };
  if (
    result?.is_error ||
    result?.api_error_status ||
    (result?.subtype && result.subtype !== "success")
  ) {
    return {
      ending: "error",
      detail:
        result?.api_error_status ??
        result?.result ??
        result?.subtype ??
        "unknown error",
    };
  }
  if (sawAskTool) return { ending: "asked", detail: null };
  if (endsOnQuestion(turnText)) return { ending: "question", detail: null };
  return { ending: "ok", detail: null };
}
