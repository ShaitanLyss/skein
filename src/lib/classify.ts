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

/** Skein's own question, as the CLI names an MCP tool: `mcp__<server>__<tool>`,
 *  and the server key is `skein` in the `--mcp-config` `supervisor.rs` passes.
 *
 *  Deliberately **not** in `ASK_TOOLS`. That set decides the `asked` ending,
 *  which is for a turn that stopped on a question — and this one does the
 *  opposite: it parks mid-turn and resumes in place the moment you reply, so a
 *  card whose question you answered would settle amber and stay there. What the
 *  name is for is naming the call in the transcript, and finding the reply the
 *  CLI recorded against it. */
export const SKEIN_ASK_TOOL = "mcp__skein__ask_user";

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
    /* Skein's own, which fell through to `default` and drew the raw
       `mcp__skein__ask_user` on the card and in the transcript — directly above
       the answer the panel now keeps under it. */
    case SKEIN_ASK_TOOL: {
      const n = Array.isArray(input?.questions) ? input.questions.length : 0;
      return n > 1 ? `asked you ${n} things` : "asked you a question";
    }
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

/* ── compaction ──────────────────────────────────────────────────────────
 *
 * Folding a full context is the one thing on this wire that takes *minutes*
 * and reports almost nothing while it does. Read out of the 2.1.232 binary and
 * checked against the compactions in this machine's transcripts, the whole
 * account of one is four events:
 *
 *   system/status           status:"compacting"                     it began
 *   system/compact_boundary compact_metadata{pre_tokens,post_tokens,…}  numbers
 *   user                    isSynthetic:true, the summary       what survived
 *   system/status           status:null, compact_result:"success"   it is over
 *
 * and then a fresh `system/init` and a `result`. There is no progress on it:
 * the status enum in the binary is `compacting | requesting | null`, the CLI's
 * own TUI draws nothing but "Compacting conversation…" for the duration, and a
 * real manual compaction in `C--atelier-caravan` reported `durationMs: 187669`
 * — three minutes of one word. So the only honest account of the *wait* is how
 * long it has been, and the account of the *result* is the two token counts and
 * the ring falling; both are drawn rather than the word alone. */

/** What a compaction cost and what it saved. */
export type CompactStat = {
  /** Tokens in context before, and after. `post` is 0 when unreported. */
  pre: number;
  post: number;
  /** How long the fold took, ms. 0 when unreported. */
  ms: number;
  /** `manual` for `/compact`, `auto` when the window filled. */
  trigger: string;
};

/** Read a compaction boundary, from either of the two forms it comes in.
 *
 * The same event is spelled twice over — `compact_metadata` with snake_case
 * fields on the wire (`qEf` in the binary), `compactMetadata` with camelCase in
 * the session file — the same split `system/init` and an `assistant` message
 * make of a model id. Both are taken here so that the live fold and the
 * transcript fold can share one reading and cannot drift. */
export function compactStat(ev: any): CompactStat | null {
  const m = ev?.compact_metadata ?? ev?.compactMetadata;
  if (!m || typeof m !== "object") return null;
  const num = (a: unknown, b: unknown) =>
    typeof a === "number" ? a : typeof b === "number" ? b : 0;
  return {
    pre: num(m.pre_tokens, m.preTokens),
    post: num(m.post_tokens, m.postTokens),
    ms: num(m.duration_ms, m.durationMs),
    trigger: typeof m.trigger === "string" ? m.trigger : "",
  };
}

const kTokens = (n: number): string => (n > 0 ? `${Math.round(n / 1000)}k` : "?");

/** What the compaction is labelled with — the cap on the folded summary, and
 *  the note left behind when there is no summary to fold it into.
 *
 *  The two counts are the whole point: they say the fold worked and how much
 *  room it bought, which is what you went to `/compact` for. The duration is
 *  carried when the boundary reports one, because a three-minute wait you have
 *  just sat through deserves to be named rather than silently forgotten. */
export function compactNote(stat: CompactStat): string {
  const took =
    stat.ms >= 1000 ? ` · ${spanOf(Math.round(stat.ms / 1000))}` : "";
  return `context compacted · ${kTokens(stat.pre)} → ${kTokens(stat.post)}${took}`;
}

/** A duration in the wall's own shorthand — `47s`, `3m 8s`, `1h 4m`.
 *
 *  Coarse above the minute on purpose: this is a thing that happened, read
 *  once, not a timer being watched. */
export function spanOf(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  if (t < 60) return `${t}s`;
  if (t < 3600) {
    const s = t % 60;
    return s ? `${Math.floor(t / 60)}m ${s}s` : `${Math.floor(t / 60)}m`;
  }
  const m = Math.floor((t % 3600) / 60);
  return m ? `${Math.floor(t / 3600)}h ${m}m` : `${Math.floor(t / 3600)}h`;
}

/** The one fixed sentence a compaction summary opens with.
 *
 * It has to be recognised live, and matching on a flag is not available there:
 * the wire's `user` message carries only `isSynthetic`, which is equally true
 * of every other note Claude Code injects, while the `isCompactSummary` that
 * would answer exactly is written to the session file and dropped on the way to
 * stdout (`qEf`'s `user` case names `isSynthetic` and nothing else). The
 * preamble is one string in the binary, is the same for a manual `/compact` and
 * an automatic fold, and reads identically on the wire and on disk — so both
 * folds can ask the same question of the same words.
 *
 * The stakes if it is not asked: the summaries on this machine run 16k–25k
 * characters, and pushed as a `you` line that is a wall of text you appear to
 * have typed — the same failure `isStopNote` and `parseTaskNotification` exist
 * to prevent, at a hundred times the size. */
export function isCompactSummary(text: string): boolean {
  return /^this session is being continued from a previous conversation/i.test(
    text.trim(),
  );
}

/** A skill's whole text, injected into the conversation as though it were said.
 *
 * Invoking a skill does not hand the agent a *result* — it hands it the skill,
 * by putting the file's entire contents into the conversation as a `user`
 * message. Probed 2026-08-18 against claude 2.1.232 with `tools/probe-skill.ts`,
 * spawning with Skein's exact argv; the three records a `Skill` call writes are
 *
 * ```text
 *   tool_result   "Launching skill: design-review"
 *   isSynthetic   "Base directory for this skill: …\design-review\n\n# Collaborative…"
 * ```
 *
 * and the same call on disk writes the body as `isMeta: true` instead. So the
 * two halves of the panel had opposite bugs: `history.ts` drops every `isMeta`
 * record and never drew it at all, while live it fell through to `you` — the
 * whole of a skill as words you appear to have typed. The one on this machine's
 * transcripts that started this runs to 698,364 characters.
 *
 * The same failure as `isStopNote`, `parseTaskNotification` and
 * `isCompactSummary`, and the same fix — except that this one must be readable
 * afterwards, since a skill is the instructions the rest of the card is
 * following. So it folds rather than being dropped, the way the compaction
 * summary does, and the name is the cap: `Base directory` is a path and its last
 * segment is the skill's own directory, which is what the skill is called.
 *
 * Matched on the first line rather than on `isSynthetic` because that field is
 * the wire's alone — nothing on disk carries it — and the panel has to read the
 * same after a restart as it did live. Anchored to the start for the usual
 * reason: a skill *quoted* in an answer is prose, and prose does not fold.
 *
 * `name` is empty when the path is not one — the fold still happens, since what
 * makes it necessary is the size rather than the name. */
export function skillBody(text: string): { name: string } | null {
  const m = /^Base directory for this skill:[ \t]*([^\r\n]*)/.exec(
    text.trimStart(),
  );
  if (!m) return null;
  /* Trailing separators trimmed off first, or a path written with one hands
     back the empty segment after it as the name. */
  const dir = m[1].trim().replace(/[\\/]+$/, "");
  return { name: dir ? basename(dir) : "" };
}

/** A local command as the session file records it, folded into what to draw.
 *
 * Running `/compact` writes *four* `user` records, and only one of them is
 * marked. Taken from a real manual compaction (`tools/probe-compact.ts`, claude
 * 2.1.232):
 *
 * ```text
 *   isMeta:true   <local-command-caveat>Caveat: The messages below were…
 *   (unmarked)    <command-name>/compact</command-name>
 *                 <command-message>compact</command-message>
 *                 <command-args></command-args>
 *   (unmarked)    <local-command-stdout>Compacted </local-command-stdout>
 * ```
 *
 * The caveat carries `isMeta` and is dropped with the rest of the injected
 * context. The other two carry nothing at all, so they were pushed as `you`
 * lines — a block of XML you appear to have typed, and the reason a compacted
 * card read as though somebody had said the word "compact" into it. 61
 * `<command-name>` blocks and 21 `<local-command-stdout>` blocks across this
 * machine's transcripts, every one of them drawn that way.
 *
 * The same failure as `isStopNote` and `parseTaskNotification`, and the same
 * fix: these are the CLI talking *about* the conversation, so they are `meta`.
 * They are not dropped, because running a command is a real thing that happened
 * and the transcript is the record of it — the name is what you did, and the
 * stdout is what it said back.
 *
 * Live this never arrives: the wire replays only what was written to stdin,
 * which is the plain text `/compact`, and the probe watched a whole compaction
 * and the turn after it without one appearing. It is a session-file shape, so
 * `history.ts` is where it is read.
 *
 * `null` means *this is not a local command*; an empty `text` means it is one
 * with nothing worth drawing. Conflating the two is a trap rather than a
 * nicety: a command that printed nothing would fall through to being pushed as
 * speech, which is the whole bug, restricted to the quietest commands. */
export function localCommand(text: string): { kind: Line; text: string } | null {
  const t = text.trim();
  const stdout = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/.exec(t);
  if (stdout) {
    /* A command that printed nothing is a command whose own name, pushed just
       above, has already said everything there is. */
    return { kind: "meta", text: stdout[1].trim() };
  }
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(t);
  if (!name) return null;
  /* The name and its arguments, which is how you would say what you ran.
     `command-message` is the same name without its slash and is dropped —
     drawing it is what put a bare "compact" in the transcript. */
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim() ?? "";
  const named = name[1].trim();
  return { kind: "meta", text: named ? (args ? `${named} ${args}` : named) : "" };
}

/* Named apart from `Line` in conversation.svelte.ts, which imports *from* here
   — the dependency only goes one way, so the kind is spelled out rather than
   imported back. */
type Line = "meta";

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

/** A turn that broke on the way *out* — the request never reached a model.
 *
 * The one error class worth trying again by itself, and it is narrow on
 * purpose. The API answers `400` with "The request body is not valid JSON:
 * unexpected end of data: line 1 column 429454 (char 429453)": the conversation
 * was serialised and the body arrived truncated. Nothing was asked of a model,
 * so nothing was done — no file written, no command run, no tokens spent on an
 * answer — which is what makes re-sending safe here and not safe for errors in
 * general. A card is spawned with `--dangerously-skip-permissions`, so "retry
 * the last thing you said" is otherwise the most dangerous reflex this app
 * could have.
 *
 * Both halves are required. A bare 400 is the API refusing the *content* of a
 * request — a parameter out of range, a model that does not exist — and those
 * are deterministic: retrying one is a loop that ends when the allowance does.
 * It is the invalid-JSON wording that says the body was mangled in transit
 * rather than wrong on its face.
 *
 * Observed 2026-08-18, in this repo's own session, three times: two consecutive
 * failures at column 429453 and 429489 — near-identical bodies, so near-identical
 * conversations — and then a third attempt with the same conversation that went
 * through. That is the whole argument for the shape of the heal. A truncation
 * that repeats at the same size and then stops is transport, not a poisoned
 * record; if it were the latter no number of retries would help and the repair
 * would have to be a fresh session, which costs the card its context. Retrying
 * costs a second. */
export function wasMalformedRequest(result: any): boolean {
  const said = [result?.api_error_status, result?.result, result?.error]
    .map((v) => (typeof v === "string" ? v : ""))
    .join(" ")
    .toLowerCase();
  if (!said.includes("400")) return false;
  return said.includes("not valid json") || said.includes("unexpected end of data");
}

/** How many times a card will try a malformed turn again before it gives up and
 *  goes rust.
 *
 *  Two, because the failure above took two before it cleared and a bound that
 *  cannot survive the case it was written for is decoration. Not more: every
 *  attempt is a whole conversation back over the wire, the wall can have twenty
 *  cards on it, and an unbounded retry on a wall that big is how an allowance
 *  disappears while nobody is watching it. */
export const MAX_HEALS = 2;

/** How long to wait before attempt `n`.
 *
 *  Backed off rather than immediate, and the reason is the wall rather than the
 *  API: a card that fails and re-sends inside the same tick reads as a card
 *  that did nothing at all, and the note saying it is trying again would flash
 *  past unread. A second is long enough to see. The step to four is for the
 *  case where something upstream is briefly unwell and hammering it is rude. */
export function healDelayMs(attempt: number): number {
  return attempt <= 1 ? 1_000 : 4_000;
}

/** What the transcript says when a card is about to try again.
 *
 *  Said out loud, and counted, because the alternative is a card that quietly
 *  re-sends your prompt. Skein spawns with `--dangerously-skip-permissions`;
 *  the one thing an app like that owes you is that nothing it does on its own
 *  is invisible afterwards. The count is in the line so a transcript read back
 *  cold says how much of the bill was retries. */
export function healNote(attempt: number): string {
  return `the request was cut short on the way out — sending it again (${attempt} of ${MAX_HEALS})`;
}

/** And what it says when they are spent. The card goes rust either way — this
 *  is so the rust has an account behind it rather than one bare 400. */
export function healGaveUpNote(): string {
  return `cut short ${MAX_HEALS} more times — leaving it, the conversation may be too large to send`;
}
