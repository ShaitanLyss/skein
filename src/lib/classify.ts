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

export function urgencyFor(ending: Ending, idleSeconds: number): Tier {
  if (ending === "error") return "fail";
  if (ending === "asked") return "ask";
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
    case "TodoWrite":
      return "planning";
    case "AskUserQuestion":
      return "asked you a question";
    case "ExitPlanMode":
      return "wants the plan approved";
    default:
      return name;
  }
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
