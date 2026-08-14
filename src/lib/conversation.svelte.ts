/* The state of one conversation, folded from the claude stream-json event feed.
 *
 * Everything the wall shows is derived here. No polling, no terminal scraping —
 * every field below is a fold over events that `claude -p --output-format
 * stream-json` already emits. Classification lives in ./classify.ts so it can
 * be tested against real output without a Svelte compiler in the way. */

import {
  ASK_TOOLS,
  basename,
  clip,
  contextWindowFor,
  describeTool,
  endingFor,
  isStopNote,
  sameModel,
  textOf,
  urgencyFor,
  type Ending,
  type Tier,
} from "./classify";

export type { Ending, Tier };

export type Line = {
  /** `you` is a turn *you* opened — see the `user` case in `ingest`. */
  kind: "you" | "text" | "tool" | "error" | "meta";
  text: string;
  /** Only ever set on a `you` line, and only while its fate is unsettled:
   *  `pending` is drawn but not yet acknowledged by the process, `failed` never
   *  reached one. Absent is the normal case — the wire echoed it back. */
  state?: "pending" | "failed";
};

export type AskOption = { label: string; detail?: string | null };

/** One subagent the card has convened.
 *
 * `--forward-subagent-text` re-emits a subagent's text and thinking as messages
 * carrying `parent_tool_use_id`, so each thought arrives already addressed to
 * the card that spawned it. There is nothing to correlate — we just route. */
export type Seat = {
  /** The parent's tool_use id — the only thing tying a thought to a seat. */
  id: string;
  persona: string;
  state: "spawning" | "thinking" | "done";
  thought: string;
  verdict: string | null;
};

export type PendingAsk = {
  askId: string;
  question: string;
  options: AskOption[];
  since: number;
};

/** A one-second tick. Urgency decays with neglect, so the wall has to know
 *  what time it is — but only one timer does, not one per card. */
export const clock = $state({ t: Date.now() });

/* One timer, however many times HMR re-evaluates this module. The handle has to
   live on `window` for the same reason the control surface's generation counter
   does: a module-scoped variable is re-created by the very reload it is meant to
   guard against, so each generation would start its own count and leave the
   previous timer ticking a clock that nothing reads. */
const TIMER = "__skeinClockTimer";
{
  const w = window as unknown as Record<string, ReturnType<typeof setInterval>>;
  clearInterval(w[TIMER]);
  w[TIMER] = setInterval(() => (clock.t = Date.now()), 1000);
}

const MAX_LINES = 300;

export class Conversation {
  readonly id: string;
  /** The `claude` session this card is currently pointed at — what `--resume`
   *  and `--session-id` take, and what names the transcript on disk.
   *
   *  Equal to `id` for the whole of a card's life until it is cleared, which is
   *  why everything used to use `id` for both. They are different things
   *  though: `id` is *this card* — its placement, its turns, its file touches
   *  all key on it and must survive — while the session is the conversation the
   *  card is holding, and clearing swaps that for a fresh one without the card
   *  moving or being replaced. */
  sessionId = $state("");
  readonly cwd: string;
  readonly project: string;
  readonly projectId: string;
  /** The app quit or crashed while this was mid-turn. That turn did not
   *  survive, and the card says so rather than pretending it finished. */
  interrupted = $state(false);

  title = $state("untitled");
  /** No process behind this card yet. Drawn hollow — an absence, not a status. */
  dormant = $state(true);
  /** The process behind this card went away on its own, in this session.
   *
   *  This is what separates a crash from a card restored off disk. Both are
   *  dormant and both can be carrying `ending: "error"`, but only one of them is
   *  news: a card that failed three days ago is history the wall already shows,
   *  and announcing it as though it just happened is a false alarm. */
  died = $state(false);
  /** We are about to kill this child on purpose, so its exit is not news.
   *
   *  Killing a process on Windows gives it a non-zero exit code, and
   *  `markExited` reads one of those as a crash — so clearing a card raced its
   *  own teardown and stamped "process exited with code 1" and a rust ending on
   *  the fresh session that had just replaced it. The flag is set before the
   *  kill and cleared by whichever exit arrives, so the ordering does not
   *  matter. Not used by `close`, where the card leaves the wall anyway. */
  retiring = $state(false);
  /** True between the first event of a turn and its `result`. */
  working = $state(false);
  /** How the last turn ended. Null until one has. */
  ending = $state<Ending | null>(null);

  /** Has this conversation ever completed a turn?
   *
   *  Decides resume vs fresh start when waking. A card that was opened but
   *  never spoken to has no transcript on disk, so `--resume` would fail — it
   *  needs `--session-id` instead, exactly as if it were new. */
  everSpoke = $state(false);
  activity = $state("dormant");

  /** When the current rest began — the clock urgency decays against. */
  restingSince = $state<number | null>(null);

  /** A question the agent is *blocked* on, via our own ask_user MCP tool.
   *  Unlike every other tier this is not an inference: the turn is genuinely
   *  parked and nothing will happen until it is answered. */
  pendingAsk = $state<PendingAsk | null>(null);

  /** Subagents this card has convened, in the order they were spawned. */
  seats = $state<Seat[]>([]);

  /* context — the ring */
  ctxTokens = $state(0);
  contextWindow = $state(200_000);
  ctx = $derived(Math.min(1, this.ctxTokens / this.contextWindow));

  /** The window `system/init` declared, which is the only place the tier is
   *  visible. Null until init has arrived (or a row was restored). */
  #declaredWindow: number | null = null;

  /* transcript */
  lines = $state<Line[]>([]);
  /** Text arriving token-by-token, before the block closes. */
  streaming = $state("");

  /** Everything said before this card had a process to listen to, folded from
   *  the transcript on disk (see ./history.ts).
   *
   *  Kept apart from `lines` rather than prepended to it, for two reasons: the
   *  live fold stays exactly what the stream said, and the two can be read from
   *  once each. Loading happens once per Conversation *instance* — a card that
   *  is woken keeps appending to the same file it was read from, so re-reading
   *  after a turn would show every live line twice. A restart makes a fresh
   *  instance, which reads the file whole again, live lines and all. */
  history = $state<Line[]>([]);
  historyState = $state<"unread" | "loading" | "ready" | "none" | "error">(
    "unread",
  );
  /** The transcript was longer than what is shown — by bytes or by lines. */
  historyPartial = $state(false);

  /* bookkeeping */
  model = $state<string | undefined>(undefined);
  costUsd = $state(0);
  turns = $state(0);
  lastError = $state<string | null>(null);

  /** Text blocks seen in the current turn, used to classify how it ended. */
  #turnText: string[] = [];
  #sawAskTool = false;

  /** Set when this conversation lives in its own git worktree. The card shows
   *  it, because "which tree am I editing" is the thing you most need to know
   *  when several agents share one repo. */
  readonly worktree: string | null;

  constructor(
    id: string,
    cwd: string,
    projectId = "",
    worktree: string | null = null,
  ) {
    this.id = id;
    this.sessionId = id;
    this.cwd = cwd;
    this.projectId = projectId;
    this.worktree = worktree;
    const base = basename(cwd) || cwd;
    this.project = worktree ? `${base} · ${worktree}` : base;
  }

  /** Rebuild a card from its database row, with no process behind it.
   *
   *  This is what makes lazy restore feel instant: the wall is fully painted —
   *  title, project, position, and the context it reached — before a single
   *  `claude` has been spawned. A card at 88% can warn you before you ever wake
   *  the session it belongs to. */
  static restore(row: {
    id: string;
    agent_session_id?: string | null;
    cwd: string;
    project_id: string;
    title: string;
    model: string | null;
    interrupted: boolean;
    last_ctx_frac: number;
    last_ending: string | null;
    worktree?: string | null;
  }): Conversation {
    const c = new Conversation(
      row.id,
      row.cwd,
      row.project_id,
      row.worktree ?? null,
    );
    /* The column has been written since v1 and read by nobody until clearing
       gave the two ids a reason to differ. A row from before then holds its own
       id, so the fallback is belt and braces rather than a migration. */
    c.sessionId = row.agent_session_id || row.id;
    c.title = row.title || "untitled";
    c.model = row.model ?? undefined;
    c.contextWindow = contextWindowFor(c.model);
    /* A row written before we knew about the tier suffix says 200k when the
       session was really 1M. `system/init` corrects it the moment it wakes. */
    if (c.model) c.#declaredWindow = c.contextWindow;
    c.ctxTokens = Math.round(row.last_ctx_frac * c.contextWindow);
    c.interrupted = row.interrupted;
    c.dormant = true;
    c.everSpoke = row.last_ending !== null;
    c.ending = (row.last_ending as Ending | null) ?? "ok";
    c.activity = row.interrupted ? "interrupted" : "dormant";
    return c;
  }

  idleSeconds = $derived(
    this.restingSince === null
      ? 0
      : Math.floor((clock.t - this.restingSince) / 1000),
  );

  /** The card's colour. Derived, never assigned — so a card that nobody
   *  touches warms on its own as it is neglected.
   *
   *  A parked question outranks everything, including `working`: the turn is
   *  technically still open, but nothing is happening and won't until you
   *  answer. That is the loudest thing a card can be. */
  tier = $derived<Tier>(
    this.pendingAsk
      ? "ask"
      : this.working
        ? "work"
        : this.ending
          ? urgencyFor(this.ending, this.idleSeconds)
          : "rest",
  );

  /** Create or update a seat. Seats are keyed by the parent's tool_use id,
   *  which is the only identity a forwarded subagent message carries. */
  #seat(id: string, patch: Partial<Omit<Seat, "id">>) {
    const i = this.seats.findIndex((s) => s.id === id);
    if (i < 0) {
      this.seats = [
        ...this.seats,
        {
          id,
          persona: patch.persona ?? "seat",
          state: patch.state ?? "spawning",
          thought: patch.thought ?? "",
          verdict: patch.verdict ?? null,
        },
      ];
      return;
    }
    this.seats[i] = { ...this.seats[i], ...patch };
  }

  /** The subagent finished — its bubble collapses to one line of verdict. */
  #closeSeat(id: string, result: string) {
    this.#seat(id, { state: "done", verdict: clip(result, 90) });
  }

  /** Adopt a model id, and with it the size of the ring.
   *
   *  `declared` marks the id from `system/init` — the only one that carries the
   *  window tier. A per-message id naming the same model tells us nothing new
   *  and must not narrow the window: taking it at face value is what made a 1M
   *  session read 46% when it was really at 9%. A per-message id naming a
   *  *different* model is a real change (a fallback model took the request) and
   *  is adopted whole. */
  #adoptModel(model: string, declared: boolean) {
    if (!declared && this.#declaredWindow !== null && sameModel(model, this.model)) {
      return;
    }
    this.model = model;
    this.contextWindow = contextWindowFor(model);
    if (declared) this.#declaredWindow = this.contextWindow;
  }

  #push(kind: Line["kind"], text: string, state?: Line["state"]) {
    this.lines.push(state ? { kind, text, state } : { kind, text });
    if (this.lines.length > MAX_LINES) {
      this.lines = this.lines.slice(-MAX_LINES);
    }
  }

  /* ── your half of the conversation ─────────────────────────────────────
   *
   * A prompt is on the wall the instant you send it, and the wire's echo
   * (`--replay-user-messages`) then *claims* that line rather than adding a
   * second copy of it.
   *
   * It used to be the echo alone that put your words in the transcript, on the
   * argument that nothing should be drawn the agent had not received. The
   * argument was right about honesty and wrong about where to spend it: waking
   * a dormant card spawns a process and resumes a session before the prompt can
   * even be written, so what you got for it was a transcript that swallowed
   * what you typed for a second or more, with the draft already cleared. The
   * honesty is kept instead by saying which it is — a pending line is marked as
   * pending and a send that fails says so, rather than being distinguished by
   * not existing. */

  /** Draw a prompt as sent, before anything has carried it. */
  echo(text: string) {
    this.#push("you", text, "pending");
    /* The turn starts when you send, which is the same rule the echo used to
       apply — only now it applies from the gesture rather than from the
       acknowledgement. `echoFailed` takes it back if nothing ever left. */
    if (!this.working) this.#beginTurn();
    this.activity = this.dormant ? "waking…" : "sending…";
  }

  /** The first drawn-but-unacknowledged copy of a prompt.
   *
   *  Oldest first, because delivery is sequential: with the same words sent
   *  twice, the echo and any failure both belong to the earlier of them. */
  #echoOf(text: string): Line | undefined {
    const want = text.trim();
    return this.lines.find(
      (l) => l.kind === "you" && l.state === "pending" && l.text.trim() === want,
    );
  }

  /** The process has our words — the line stands as an ordinary one. */
  #claimEcho(text: string): boolean {
    const line = this.#echoOf(text);
    if (!line) return false;
    line.state = undefined;
    return true;
  }

  /** Anything still pending when the process speaks has plainly arrived, even
   *  if its echo did not match character for character. Proof of receipt is
   *  proof of receipt, and a mark left up after the answer has come back would
   *  be reporting a doubt nothing holds. */
  #settleEchoes() {
    for (const l of this.lines) {
      if (l.kind === "you" && l.state === "pending") l.state = undefined;
    }
  }

  /** Nothing carried it: the line says so and stays where it was written, so
   *  what you typed is still there to copy out of. */
  echoFailed(text: string, why: string) {
    const line = this.#echoOf(text);
    if (line) line.state = "failed";
    /* The turn `echo` opened never began — unless something else in it has
       already spoken, in which case a failed send is a second prompt into a
       card that is genuinely busy and `working` is still the truth. */
    if (!this.streaming && this.#turnText.length === 0) {
      this.working = false;
      this.restingSince ??= Date.now();
    }
    this.activity = why;
  }

  #beginTurn() {
    this.#turnText = [];
    this.#sawAskTool = false;
    this.streaming = "";
    this.restingSince = null;
    this.working = true;
  }

  /** Fold one raw event off the wire into card state. */
  ingest(ev: any) {
    switch (ev?.type) {
      case "system":
        if (ev.subtype === "init") {
          this.dormant = false;
          /* A process has announced itself, so whatever happened to the last
             one is no longer the current state of this card. */
          this.died = false;
          if (ev.model) this.#adoptModel(ev.model, true);
          this.activity = "ready";
          if (!this.working) this.restingSince ??= Date.now();
        }
        break;

      /* token-by-token, the thing that makes a card feel alive */
      case "stream_event": {
        const e = ev.event;
        if (e?.type === "content_block_start") {
          const b = e.content_block;
          if (b?.type === "tool_use") {
            if (!this.working) this.#beginTurn();
            this.activity = describeTool(b.name, b.input);
          } else if (b?.type === "thinking") {
            if (!this.working) this.#beginTurn();
            this.activity = "thinking";
          }
        } else if (e?.type === "content_block_delta") {
          const d = e.delta;
          if (d?.type === "text_delta" && typeof d.text === "string") {
            if (!this.working) this.#beginTurn();
            if (!this.streaming) this.activity = "responding";
            this.streaming += d.text;
          } else if (d?.type === "thinking_delta") {
            /* Thinking dominates the deltas on a reasoning model — a probe run
               showed 8 thinking_delta to 1 text_delta. Without this a card sits
               visibly frozen for the first seconds of every turn. */
            if (!this.working) this.#beginTurn();
            this.activity = "thinking";
          }
        }
        break;
      }

      case "assistant": {
        /* A forwarded subagent message is tagged with the parent tool call that
           spawned it. It belongs to a seat, not to the card's own transcript. */
        if (ev.parent_tool_use_id) {
          const said = textOf(ev.message?.content);
          if (said) {
            this.#seat(ev.parent_tool_use_id, {
              state: "thinking",
              thought: clip(said, 220),
            });
          }
          break;
        }

        if (!this.working) this.#beginTurn();
        this.streaming = "";
        /* It is answering us, so it has us. */
        this.#settleEchoes();

        for (const block of ev.message?.content ?? []) {
          if (block.type === "text" && block.text?.trim()) {
            this.#turnText.push(block.text);
            this.#push("text", block.text);
          } else if (block.type === "tool_use") {
            if (ASK_TOOLS.has(block.name)) this.#sawAskTool = true;
            const desc = describeTool(block.name, block.input);
            this.activity = desc;
            this.#push("tool", desc);
            /* A Task call is a seat being taken. It appears dim the moment the
               call lands and brightens when the subagent starts speaking. */
            if (block.name === "Task" && block.id) {
              this.#seat(block.id, {
                persona:
                  block.input?.subagent_type ??
                  clip(block.input?.description ?? "seat", 16),
                state: "spawning",
              });
            }
          }
        }

        /* Context occupancy is the LAST assistant message's usage. Do NOT
           substitute `result.usage` — it sums every iteration of the turn (a
           probe showed cache_read 51,140 across the turn versus 29,128 for the
           final request), so it climbs past the window and pegs the ring. */
        const u = ev.message?.usage;
        if (u) {
          this.ctxTokens =
            (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0) +
            (u.output_tokens ?? 0);
        }
        if (ev.message?.model) this.#adoptModel(ev.message.model, false);
        break;
      }

      /* the turn closed — this is where the ending is decided */
      case "result": {
        this.streaming = "";
        this.working = false;
        this.turns += 1;
        this.everSpoke = true;
        /* A turn that completed is a turn whose prompt arrived, whatever the
           echo looked like — an errored turn reaches here without an
           `assistant` message to have settled it. */
        this.#settleEchoes();
        /* The arc dissolves back into the card, leaving one line behind. */
        if (this.seats.length) {
          this.#push("meta", `${this.seats.length} seats · synthesised`);
          this.seats = [];
        }
        this.restingSince = Date.now();
        if (typeof ev.total_cost_usd === "number") this.costUsd = ev.total_cost_usd;

        const { ending, detail } = endingFor(
          ev,
          this.#turnText.join("\n"),
          this.#sawAskTool,
        );
        this.ending = ending;

        if (ending === "error") {
          this.lastError = String(detail);
          this.activity = clip(String(detail), 44);
          this.#push("error", String(detail));
        } else if (ending === "stopped") {
          /* The line saying so is already in the transcript — the CLI's own
             note arrived just above this event — so there is nothing to push. */
          this.activity = "stopped";
          /* A parked question cannot outlive the turn it was asked in. The
             thread holding the MCP call in ask.rs times out on its own; what
             matters on the wall is that the card stops claiming to be waiting
             on an answer that would now have nothing to resume. */
          this.pendingAsk = null;
        } else if (ending === "asked") {
          this.activity = "asked you";
        } else if (ending === "question") {
          this.activity = "ended on a question";
        } else {
          this.activity = "at rest";
        }
        break;
      }

      /* Two very different things arrive as `user` messages.

         Your own words come back first: `--replay-user-messages` re-emits what
         we wrote to stdin, flagged `isReplay`. That echo is the acknowledgement
         that a prompt landed — it claims the line `echo` already drew rather
         than appending a second one. A prompt with no line waiting for it is
         one this window did not send (a terminal appending to the same
         session), and is pushed as it always was.

         Tool results arrive the same way. One whose tool_use_id matches a seat
         is that subagent reporting in. */
      case "user": {
        if (!ev.parent_tool_use_id) {
          const said = textOf(ev.message?.content);
          if (said) {
            /* A stop lands here too, as a `user` message the CLI wrote itself.
               It is a note about the conversation rather than anything you
               typed, and pushing it as `you` would put words in your mouth —
               and, worse, open a turn (below) a moment before the aborted
               `result` closes it. */
            if (isStopNote(said)) {
              this.#push("meta", "stopped");
              break;
            }
            if (!this.#claimEcho(said)) this.#push("you", said);
            /* The turn starts the moment your words land, not seconds later
               when the first token comes back. */
            if (!this.working) this.#beginTurn();
            this.activity = "thinking";
            break;
          }
        }

        for (const b of ev.message?.content ?? []) {
          if (b.type !== "tool_result" || !b.tool_use_id) continue;
          if (!this.seats.some((s) => s.id === b.tool_use_id)) continue;
          this.#closeSeat(b.tool_use_id, textOf(b.content) || "returned");
        }
        break;
      }

      /* The CLI's receipt for a `control_request` — today that means an
         interrupt. Named rather than left to fall through, because it says
         only that the message was *taken*: what the turn did about it arrives
         a moment later as an aborted `result`, and that is the event the card
         actually folds. */
      case "control_response":
        break;

      /* Shape isn't documented and it fired once in an otherwise nominal run,
         so this stays quiet unless it clearly isn't business as usual. */
      case "rate_limit_event": {
        const status = ev.rate_limit?.status ?? ev.status;
        if (typeof status === "string" && !/^(ok|allowed|nominal)$/i.test(status)) {
          this.#push("meta", `rate limit: ${status}`);
        }
        break;
      }

      default:
        break;
    }
  }

  /** Point this card at a fresh session, in place.
   *
   *  Everything the old session was is dropped — its words, its context, its
   *  cost, its name — because the model can no longer see any of it, and a
   *  transcript showing what the agent has forgotten is the one lie this wall
   *  must not tell. What is deliberately *not* dropped is the card: its id, its
   *  position, its project and its worktree are all untouched, so clearing
   *  costs you nothing you arranged.
   *
   *  Nothing is destroyed. The old session's transcript stays exactly where
   *  Claude Code wrote it, so it can be put back on the wall from `adopt a
   *  recorded session…` — which is why this is not a danger item.
   *
   *  `everSpoke` going false is what makes the next send spawn with
   *  `--session-id <new>` rather than `--resume`: there is no transcript to
   *  resume yet, and resuming an id that has never been written is an error. */
  clear(sessionId: string) {
    this.sessionId = sessionId;
    this.lines = [];
    this.history = [];
    this.streaming = "";
    /* Not "unread": we know this session has no transcript, having just minted
       its id, so there is nothing for the loader to go and find. */
    this.historyState = "none";
    this.historyPartial = false;
    this.seats = [];
    this.pendingAsk = null;
    this.ctxTokens = 0;
    this.costUsd = 0;
    this.turns = 0;
    this.ending = null;
    this.everSpoke = false;
    this.interrupted = false;
    this.died = false;
    this.working = false;
    this.lastError = null;
    this.restingSince = null;
    /* So the first prompt names the card again, as it does for a new one. The
       model and its window are kept: which model this card talks to is a fact
       about the card, and the ring should read 0% of the same size rather than
       fall back to 200k until `system/init` arrives. */
    this.title = "untitled";
    this.dormant = true;
    this.activity = "cleared — will wake on send";
    /* One line, so an empty panel is an answer rather than a question. */
    this.#push("meta", "cleared · a fresh session, in the same place");
  }

  /** stdout closed — the process is gone. */
  markExited(code: number | null) {
    /* A kill we asked for. Say nothing: the card has already been given its new
       state and an exit code from `close_conversation` describes the process we
       deliberately ended, not anything that went wrong. */
    if (this.retiring) {
      this.retiring = false;
      this.dormant = true;
      this.working = false;
      this.streaming = "";
      return;
    }
    this.dormant = true;
    this.working = false;
    this.streaming = "";
    /* A prompt still marked pending here did leave — `echoFailed` is what marks
       one that did not, and a send that failed is never followed by an exit. So
       the mark comes off rather than turning into "not sent", which would be a
       lie about a prompt this process took and then died holding. What happened
       is the line below. */
    this.#settleEchoes();
    if (code !== 0 && code !== null) {
      this.died = true;
      this.ending = "error";
      this.lastError = `process exited ${code}`;
      this.activity = `exited ${code}`;
      this.#push("error", `process exited with code ${code}`);
    } else {
      this.activity = "dormant";
    }
  }

  noteStderr(line: string) {
    this.#push("error", line);
  }
}
