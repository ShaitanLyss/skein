/* The state of one conversation, folded from the claude stream-json event feed.
 *
 * Everything the wall shows is derived here. No polling, no terminal scraping —
 * every field below is a fold over events that `claude -p --output-format
 * stream-json` already emits. Classification lives in ./classify.ts so it can
 * be tested against real output without a Svelte compiler in the way. */

import {
  ASK_TOOLS,
  backgroundKind,
  basename,
  clip,
  compactNote,
  compactStat,
  contextWindowFor,
  describeTool,
  endingFor,
  isCompactSummary,
  isStopNote,
  jobLabel,
  localAnswer,
  parseTaskNotification,
  sameModel,
  spanOf,
  startedJob,
  taskNumberOf,
  textOf,
  urgencyFor,
  type Ending,
  type JobKind,
  type TaskNote,
  type Tier,
} from "./classify";
import {
  compactEstimate,
  compactFill,
  compactLate,
  normalizeSeen,
  recordCompaction,
  type Compaction,
} from "./compaction";
import { UNNAMED } from "./naming";
import { answerNote } from "./asking";
import type { Answers, AskQuestion } from "./asking";

export type { Ending, Tier };

/** What a card is, as opposed to what state it is in.
 *
 * `project` is every card there has ever been: a working tree with the machine
 * at its disposal. `chat` is one opened outside any project, which can search
 * the web and reach nothing else — the capability lives in the argv
 * (`supervisor.rs::chat_argv`) and this is only what the wall calls it. */
export type ConvKind = "project" | "chat";

export type Line = {
  /** `you` is a turn *you* opened — see the `user` case in `ingest`.
   *
   *  `answer` is the other thing you say into a conversation and the only one
   *  that opens no turn: the reply to a parked `ask_user`, kept under the call
   *  that asked it. It is not `you` — that register is a prompt, and the rails
   *  list every one of them as a place in the conversation to travel back to,
   *  which an answer to a question you were asked is not. *
   *  `summary` is the block of text a compaction carried forward. It arrives as
   *  a `user` message — the CLI handing the model everything it must not forget
   *  — and it is neither yours nor the agent's, so it is neither `you` nor
   *  `text`. It is the one line kind that is folded away by default: they run
   *  16k–25k characters here, and a round you want to read is on the far side
   *  of it. */
  kind: "you" | "text" | "tool" | "error" | "meta" | "answer" | "summary";
  text: string;
  /** The cap a folded line wears. Only ever set on a `summary`, where it is
   *  what the compaction cost and saved — the numbers arrive one event before
   *  the words they belong to. Absent when no boundary reported them. */
  note?: string;
  /** Only ever set on a `you` line, and only while its fate is unsettled:
   *  `pending` is drawn but not yet acknowledged by the process, `failed` never
   *  reached one. Absent is the normal case — the wire echoed it back. */
  state?: "pending" | "failed";
  /** Bookkeeping rather than drawing: this line was written by `echo` and the
   *  wire has not echoed it back yet, so it is still the line a replay claims.
   *  Separate from `state` because the two stopped being the same question —
   *  see `#settleEchoes`. */
  awaited?: true;
};

/* The ask vocabulary lives in ./asking.ts, which is pure and normalizes the raw
   tool-call arguments on every read. Re-exported here because `AskOption` was
   this file's before questions became plural, and half the wall imports it. */
export type { AskOption, AskQuestion } from "./asking";

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

/** One piece of work the agent started that outlives the turn that started it.
 *
 * Keyed on the tool_use id, which is the only identity the call, the receipt
 * and the completion notification all share — the same bargain `Seat` makes,
 * and for the same reason: there is nothing to correlate, only to route.
 *
 * Settled jobs are *removed* rather than kept with a state, so `busy` is a
 * question about the list's contents rather than about each entry's history.
 * What a job did is said once, in the transcript, by the CLI's own summary. */
export type Job = {
  toolId: string;
  /** The CLI's id, once a receipt names one — what `TaskOutput` and `TaskStop`
   *  take. Null for a subagent, whose receipt carries nothing quotable. */
  taskId: string | null;
  kind: JobKind;
  label: string;
  /** `starting` is provisional — registered from the call, before the receipt
   *  has confirmed the thing actually went to the background. */
  state: "starting" | "running";
  since: number;
};

/** One item of the agent's own plan, folded from `TaskCreate`/`TaskUpdate`.
 *
 * The plan is the best single account of a long turn there is: it is what the
 * agent means to do, in its own words, with its own idea of how far along it
 * is — where the activity line can only ever report the last tool call. */
export type PlanTask = {
  /** The number the CLI assigned, which is what `TaskUpdate` names. */
  n: string;
  subject: string;
  /** The gerund written to be displayed while this item is the one in hand. */
  activeForm: string;
  status: string;
};

export type PendingAsk = {
  askId: string;
  /** Every decision this one call is parked on, in the order to ask them.
   *  Always at least one — `normalizeAsk` guarantees it, because a card blocked
   *  with nothing on screen could never be unblocked. */
  questions: AskQuestion[];
  /** One slot per question; `null` until answered. Held here rather than in
   *  `Ask.svelte` so that clicking away to another card and coming back does
   *  not throw away the answers already given — the panel draws whichever card
   *  is blocked, so its own state would not survive the switch. */
  answers: Answers;
  /** Questions the call carried past `MAX_QUESTIONS`. Drawn, because an agent
   *  that asked six things and got five answers will guess at the sixth. */
  dropped: number;
  since: number;
};

/** A one-second tick. Urgency decays with neglect, so the wall has to know
 *  what time it is — but only one timer does, not one per card.
 *
 * **It advances by exactly one second, and that is load-bearing.** This was a
 * plain `setInterval(…, 1000)` reading `Date.now()`, and a countdown on the wall
 * would every so often drop two seconds at once — 4:31 to 4:29 — which reads as
 * a timer that has lost count. Nothing was wrong with the arithmetic:
 * `setInterval` is a *minimum* delay and each tick lands a few milliseconds
 * late, the lateness accumulates because the next one is scheduled from when the
 * last one ran, and every reading on this wall is a `Math.floor` of something
 * linear in `t`. Once the accumulated drift carries `t` across a whole-second
 * boundary the floor skips one, and it goes on doing it about every couple of
 * hundred ticks forever. Every instrument reading this clock had the same skip;
 * a countdown is only where it is legible, because you are watching one number.
 *
 * So two changes, and each fixes half of it:
 *
 *  - **The next tick is scheduled from the wall clock, not from this one.**
 *    A self-correcting `setTimeout` aimed just past the coming second boundary,
 *    so lateness is spent rather than banked and the error cannot grow.
 *  - **`t` is snapped to the boundary it landed on.** That is what makes the
 *    step exactly 1000ms rather than merely close to it, so `floor` of anything
 *    derived from `t` moves by exactly one per tick whatever phase it is at.
 *    `Math.round` rather than `Math.floor` so a timer that fires a hair *early*
 *    names the second it was aiming at instead of the one before.
 *
 * The snap costs nothing that matters: everything reading this clock reads it to
 * a second, and the half-second it may shift a written epoch by (`start`,
 * `bank`) cannot change an elapsed — both sides of that subtraction are the same
 * `now`. A tick delayed by much more than a second — the machine slept, the
 * webview was throttled — jumps by however long that really was, which is the
 * honest answer and the one the old code gave too. */
export const clock = $state({ t: Date.now() });

/** How far past the boundary to aim. Enough that a timer firing a shade early
 *  still lands in the second it meant, small enough to be invisible. */
const OVERSHOOT = 4;

/* One timer, however many times HMR re-evaluates this module. The handle has to
   live on `window` for the same reason the control surface's generation counter
   does: a module-scoped variable is re-created by the very reload it is meant to
   guard against, so each generation would start its own count and leave the
   previous timer ticking a clock that nothing reads. Clearing the pending
   timeout stops the whole chain, since each link only exists once the one before
   it has run. */
const TIMER = "__skeinClockTimer";
{
  const w = window as unknown as Record<string, ReturnType<typeof setTimeout>>;
  clearTimeout(w[TIMER]);
  const beat = () => {
    const now = Date.now();
    const t = Math.round(now / 1000) * 1000;
    clock.t = t;
    /* Aimed from the boundary just named rather than from `now`, so a tick that
       arrived late spends the lateness and one that arrived a hair early does
       not name the same second twice. */
    w[TIMER] = setTimeout(beat, Math.max(1, t + 1000 + OVERSHOOT - now));
  };
  const start = Date.now();
  w[TIMER] = setTimeout(beat, 1000 - (start % 1000) + OVERSHOOT);
}

/** What compactions have actually cost on this machine, newest last.
 *
 *  Wall-wide rather than per-card: a fold's cost is a property of this machine
 *  and this network, and a card that has never compacted should still get the
 *  benefit of the eleven that have. localStorage rather than SQLite for the
 *  reason the viewport is there — per-machine, disposable, and not a thing you
 *  *made*. Losing it costs one slightly-wrong bar.
 *
 *  Module-level, so the file is read once for the whole wall instead of once
 *  per card. `compaction.ts` holds all the arithmetic and is pure; this is only
 *  where it is kept. */
const SEEN_KEY = "skein.compactions";
let seenCompactions: Compaction[] = (() => {
  try {
    return normalizeSeen(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "null"));
  } catch {
    return [];
  }
})();

function rememberCompaction(next: Compaction) {
  const grown = recordCompaction(seenCompactions, next);
  /* `recordCompaction` refuses a measurement it does not believe, and returns
     the list it was given. Nothing to write in that case. */
  if (grown === seenCompactions) return;
  seenCompactions = grown;
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(grown));
  } catch {
    /* A full or disabled store costs the calibration and nothing else. */
  }
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

  title = $state(UNNAMED);
  /** You named this one yourself, so nothing else may rename it.
   *
   *  The three stages a title arrives in (see `naming.ts`) are all things that
   *  happen *to* a card — the sentinel, the cut of your first prompt, then
   *  Claude Code's generated title, which replaces whatever was there every
   *  time a turn settles. That last one is what makes this a flag rather than
   *  just a write: `/rename` without it holds for exactly one turn and then the
   *  card quietly takes its old name back, which reads as the rename having
   *  failed some time after it visibly worked.
   *
   *  Persisted, because the thing it protects against happens on the next turn
   *  of the next launch as readily as this one. Cleared by `clear`, along with
   *  the title it was protecting. */
  namedByHand = $state(false);
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

  /** Has this conversation ever completed a turn? (`last_ending IS NOT NULL`.)
   *
   *  Deliberately *not* what decides resume vs fresh start when waking, though
   *  it used to be: a turn finishing and a transcript existing are different
   *  facts, and a card killed part-way through its first turn has the second
   *  without the first. `spawn_conversation` asks the disk instead. What this
   *  still answers is the questions it is actually about — whether there is
   *  anything to clear, and whether a blank panel means a fresh sheet or pages
   *  that are simply not here. */
  everSpoke = $state(false);
  activity = $state("dormant");

  /** When the fold of a full context started, if one is running.
   *
   *  A compaction is the one thing on this wire with no progress on it at all —
   *  one status event at each end and minutes of silence between (a real
   *  manual one here took 3m 08s) — so the card said `compacting` and then sat
   *  perfectly still, which is what a card that has hung looks like. Held so
   *  the wait can count itself out loud; see `doing`. */
  compactingSince = $state<number | null>(null);

  /** What this fold was predicted to take, in seconds, decided once when it
   *  began.
   *
   *  Once, deliberately: the estimate is a function of the occupancy at the
   *  start, and `ctxTokens` is about to be rewritten by the fold itself — so a
   *  live `$derived` would watch its own denominator collapse and the bar would
   *  leap backwards at the moment of success. It is also what makes the bar
   *  monotonic, which is the least a bar owes you. */
  compactEstimateS = $state(0);

  /** When the current rest began — the clock urgency decays against. */
  restingSince = $state<number | null>(null);

  /** Put by on purpose: kept on the wall, kept out of what is waiting.
   *
   *  Amber on this wall means *nobody has been back to this in a while*, which
   *  is a fair thing to say about a card you forgot and a false one about a
   *  card you parked — half-finished work you mean to return to, or a session
   *  held open for the context in it. Left as they were, those cards warm on
   *  the same clock as everything else and then take their turn in the waiting
   *  cycle, so the cycle stops being a list of things that want you.
   *
   *  It suppresses the *decay*, not the card: it is still on the wall, still
   *  resumable, still holding its transcript and its place, and speaking to it
   *  picks it straight back up (`Skein.#deliver`). Persisted, because the
   *  waiting cycle is the same on the next launch and because a card set aside
   *  must not be roused (`rousing.ts`). */
  aside = $state(false);

  /** A question the agent is *blocked* on, via our own ask_user MCP tool.
   *  Unlike every other tier this is not an inference: the turn is genuinely
   *  parked and nothing will happen until it is answered. */
  pendingAsk = $state<PendingAsk | null>(null);

  /** Subagents this card has convened, in the order they were spawned. */
  seats = $state<Seat[]>([]);

  /** Background work this card started that is still running.
   *
   *  Deliberately not persisted, and a restored card therefore has none. Skein
   *  only ever learns that a job finished by being *told* — the notification
   *  comes down the same stream as everything else — so a job it did not watch
   *  start is one it could never watch end, and a count restored off disk would
   *  be a number that only ever grew. */
  jobs = $state<Job[]>([]);

  /** The agent's own plan for the turn, in the order the items were created. */
  plan = $state<PlanTask[]>([]);

  /** Is there background work in flight?
   *
   *  This is the second half of what `working` used to answer alone. `working`
   *  still means exactly what it meant — a turn is open — and everything that
   *  reads it (rousing, delivery, the interrupt) still wants that question. But
   *  the *card's colour* is asking something broader: is this card busy. An
   *  agent that backgrounded a thirteen-minute snapshot run and said "I'll
   *  commit once the suite is green" has ended its turn and has not finished
   *  its work, and it will be woken by the notification rather than by you. */
  busy = $derived(this.jobs.length > 0);

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
  /** The session's running total, as `result.total_cost_usd` reports it — not
   *  the last turn's. See `lastTurn` for that. */
  costUsd = $state(0);
  turns = $state(0);
  lastError = $state<string | null>(null);

  /** What the turn that just settled actually spent, read off `result.usage`.
   *
   *  This is the one place `result.usage` is the right number and the ring is
   *  not: it sums every iteration of the turn, which is why `ctxTokens` must
   *  never come from it (see the `assistant` arm) and exactly why a *turn* row
   *  must. The four counts are kept apart because their prices differ by more
   *  than an order of magnitude — a cache read is 0.1x input, a cache write
   *  1.25x — so any total that adds them is a number nobody can act on.
   *
   *  `usd` is a delta, not a reading. `total_cost_usd` is cumulative over the
   *  session, so the turn's own cost is the step it took; `#costAtLastTurn`
   *  holds the previous value to subtract. Clamped at zero because a cleared
   *  card keeps its `Conversation` and starts a fresh session whose total
   *  begins again below the old one. */
  lastTurn = $state({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0, usd: 0 });
  #costAtLastTurn = 0;

  /** Text blocks seen in the current turn, used to classify how it ended. */
  #turnText: string[] = [];
  #sawAskTool = false;

  /** `TaskCreate` calls whose receipt has not yet named their number. */
  #creating = new Map<string, { subject: string; activeForm: string }>();

  /** Set when this conversation lives in its own git worktree. The card shows
   *  it, because "which tree am I editing" is the thing you most need to know
   *  when several agents share one repo. */
  readonly worktree: string | null;

  /** What this card *is*. A `chat` card was opened outside any project and is
   *  spawned with no tools but the two web ones (`supervisor.rs::chat_argv`),
   *  so it can look things up and can reach nothing on this machine.
   *
   *  Read-only, like `worktree`: it is decided when the card is made, the store
   *  is what remembers it, and the argv is built from the store rather than
   *  from this — so a card cannot talk its way into a fuller toolset by having
   *  this field changed. */
  readonly kind: ConvKind;

  constructor(
    id: string,
    cwd: string,
    projectId = "",
    worktree: string | null = null,
    kind: ConvKind = "project",
  ) {
    this.id = id;
    this.sessionId = id;
    this.cwd = cwd;
    this.projectId = projectId;
    this.worktree = worktree;
    this.kind = kind;
    const base = basename(cwd) || cwd;
    /* Not the basename for a chat card. Its cwd is a folder of Skein's own that
       happens to be called `chat`, and drawing that would be the card claiming
       a project it does not have — the day the folder is renamed, every chat
       card on the wall would relabel itself. */
    this.project =
      kind === "chat" ? "chat" : worktree ? `${base} · ${worktree}` : base;
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
    aside?: boolean;
    kind?: string | null;
    named_by_hand?: boolean;
  }): Conversation {
    const c = new Conversation(
      row.id,
      row.cwd,
      row.project_id,
      row.worktree ?? null,
      /* Anything but `chat` is a project card, including a row from before the
         column existed and a value from a build newer than this one. The
         unknown case has to fall to the *narrower* reading of the card and the
         *fuller* toolset it already had, never the other way round: a chat card
         drawn as a project card is a mislabel, a project card silently spawned
         as chat is a card that has quietly lost its tools. */
      row.kind === "chat" ? "chat" : "project",
    );
    /* The column has been written since v1 and read by nobody until clearing
       gave the two ids a reason to differ. A row from before then holds its own
       id, so the fallback is belt and braces rather than a migration. */
    c.sessionId = row.agent_session_id || row.id;
    c.title = row.title || UNNAMED;
    /* A row from before the column existed defaults to false, which is the
       truth about it: no card was ever named by hand before there was a way
       to do it. */
    c.namedByHand = row.named_by_hand ?? false;
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
    c.aside = row.aside ?? false;
    c.activity = row.interrupted ? "interrupted" : "dormant";
    return c;
  }

  idleSeconds = $derived(
    this.restingSince === null
      ? 0
      : Math.floor((clock.t - this.restingSince) / 1000),
  );

  /** The activity line, which is `activity` plus the one wait that has to count
   *  itself.
   *
   *  Everywhere else the word is enough, because something under it is moving:
   *  deltas arrive, tool calls land, the plan advances. A compaction has none of
   *  that — the wire says `compacting` and then says nothing for minutes — so
   *  the word alone is indistinguishable from a card that has stopped. The
   *  clock is the existing one-second tick every card already reads for
   *  neglect, so this costs no timer.
   *
   *  Both readers of the activity line go through here (the card's label and the
   *  panel's live edge) rather than one of them appending the count, or the wall
   *  and the panel would disagree about how long you had been waiting. */
  /** How long this fold has been going, in seconds. Zero when none is. */
  compactingFor = $derived(
    this.compactingSince === null
      ? 0
      : Math.max(0, (clock.t - this.compactingSince) / 1000),
  );

  doing = $derived.by(() => {
    if (this.compactingSince === null) return this.activity;
    const line = `${this.activity} · ${spanOf(this.compactingFor)}`;
    /* Said in words, because a bar that has been nearly full for a minute and a
       half has stopped telling you anything — worse, it is telling you the
       wrong thing, since what is actually true at that point is that the
       prediction was wrong rather than that the fold is nearly done. */
    return compactLate(this.compactingFor, this.compactEstimateS)
      ? `${line} · longer than usual`
      : line;
  });

  /** How full to draw the bar, 0–1, or null when there is no bar to draw.
   *
   *  It never reaches 1 on its own — see `compactFill`. The only thing that
   *  fills it is the fold actually ending, which is drawn by the bar going
   *  away rather than by it completing. */
  compactFrac = $derived(
    this.compactingSince === null
      ? null
      : compactFill(this.compactingFor, this.compactEstimateS),
  );

  /** The card's colour. Derived, never assigned — so a card that nobody
   *  touches warms on its own as it is neglected.
   *
   *  A parked question outranks everything, including `working`: the turn is
   *  technically still open, but nothing is happening and won't until you
   *  answer. That is the loudest thing a card can be.
   *
   *  `aside` goes in here rather than being filtered out at each of the places
   *  that read a tier, so that the cycle, the dock's count, the peek and the
   *  card's own colour cannot disagree about it — a card left out of the
   *  waiting list while still blooming amber would be the wall arguing with
   *  itself. `urgencyFor` decides what it does and does not silence. */
  /*  `busy` sits *below* a broken turn and above everything else. A turn that
   *  errored is news and rust is the colour that says so, and letting a
   *  background job paint over it would be the one case where celadon means
   *  "fine" on a card that is not. `working` stays on top of both, unchanged: a
   *  turn underway is the current state of the card whatever the last one did. */
  tier = $derived<Tier>(
    this.pendingAsk
      ? "ask"
      : this.working
        ? "work"
        : this.ending === "error"
          ? "fail"
          : this.busy
            ? "work"
            : this.ending
              ? urgencyFor(this.ending, this.idleSeconds, this.aside)
              : "rest",
  );

  /** How far the plan has got. Both counted here so the card cannot draw a
   *  denominator from one reading and a numerator from another. */
  planDone = $derived(this.plan.filter((t) => t.status === "completed").length);

  /** What to say on a card whose turn has ended but whose work has not. */
  #jobsLine(): string {
    const [first] = this.jobs;
    if (!first) return "at rest";
    return this.jobs.length === 1
      ? `running · ${first.label}`
      : `${this.jobs.length} jobs running`;
  }

  /** The plan item in hand, if the agent has said which. */
  #planLine(): string | null {
    const active = this.plan.find((t) => t.status === "in_progress");
    return active?.activeForm || active?.subject || null;
  }

  #job(toolId: string, patch: Omit<Job, "toolId">) {
    const i = this.jobs.findIndex((j) => j.toolId === toolId);
    if (i < 0) this.jobs = [...this.jobs, { toolId, ...patch }];
    else this.jobs[i] = { ...this.jobs[i], ...patch };
  }

  #dropJob(toolId: string) {
    this.jobs = this.jobs.filter((j) => j.toolId !== toolId);
  }

  /** A job reported in. The CLI's summary is already the sentence worth
   *  drawing, and it is `meta` because it is the CLI talking about the
   *  conversation — the register the stop note and the resume note are in.
   *
   *  Matched on the tool_use id, then on the CLI's own job id. A notification
   *  naming neither is still drawn: it is a job started before this window was
   *  watching, or one whose receipt was missed, and the news is worth more than
   *  the bookkeeping. What it must not do is guess which job it was and drop
   *  one at random — a card would then report the wrong thing as finished and
   *  go on holding a count for something that had. */
  #settleJob(note: TaskNote, summary: string) {
    const hit = this.jobs.find(
      (j) =>
        (note.toolId && j.toolId === note.toolId) ||
        (note.taskId && j.taskId === note.taskId),
    );
    if (hit) {
      this.#dropJob(hit.toolId);
      /* A backgrounded subagent holds a seat as well as a job, and this is the
         only thing that ever closes it — its tool_result was a launch receipt,
         not an answer. */
      if (this.seats.some((s) => s.id === hit.toolId)) {
        this.#closeSeat(hit.toolId, summary);
      }
    }
    this.#push("meta", summary);
    /* Nothing is warming while a job runs, so the neglect clock has to start
       when the last one lands rather than back when the turn ended — otherwise
       a card whose job ran twenty minutes blooms amber the instant it finishes,
       for a wait nobody was subject to. A turn opening in response resets this
       again through `#beginTurn`, which is the ordinary case. */
    if (!this.working && !this.busy) {
      this.restingSince = Date.now();
      this.activity = clip(summary, 44);
    } else if (!this.working) {
      this.activity = this.#jobsLine();
    }
  }

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

  #push(kind: Line["kind"], text: string, state?: Line["state"], note?: string) {
    const line: Line = { kind, text };
    if (state) line.state = state;
    if (note) line.note = note;
    this.lines.push(line);
    if (this.lines.length > MAX_LINES) {
      this.lines = this.lines.slice(-MAX_LINES);
    }
  }

  /** What the last `compact_boundary` said it cost, waiting for the summary it
   *  labels. The numbers and the words are two events apart and the cap wants
   *  both, so the first is held until the second arrives. */
  #compacted: string | null = null;

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
    this.lines[this.lines.length - 1]!.awaited = true;
    /* The turn starts when you send, which is the same rule the echo used to
       apply — only now it applies from the gesture rather than from the
       acknowledgement. `echoFailed` takes it back if nothing ever left. */
    if (!this.working) this.#beginTurn();
    this.activity = this.dormant ? "waking…" : "sending…";
  }

  /** The oldest copy of a prompt still answering to `held`.
   *
   *  Oldest first, because delivery is sequential: with the same words sent
   *  twice, the echo and any failure both belong to the earlier of them. The
   *  predicate is passed in because a claim and a failure no longer ask the
   *  same question of a line — see `#settleEchoes`. */
  #echoOf(text: string, held: (l: Line) => boolean): Line | undefined {
    const want = text.trim();
    return this.lines.find(
      (l) => l.kind === "you" && held(l) && l.text.trim() === want,
    );
  }

  /** The process has our words — the line stands as an ordinary one, and the
   *  books are closed on it. */
  #claimEcho(text: string): boolean {
    const line = this.#echoOf(text, (l) => l.awaited === true);
    if (!line) return false;
    line.state = undefined;
    line.awaited = undefined;
    return true;
  }

  /** Anything still pending when the process speaks has plainly arrived, even
   *  if its echo did not match character for character. Proof of receipt is
   *  proof of receipt, and a mark left up after the answer has come back would
   *  be reporting a doubt nothing holds.
   *
   *  But being answered does not say *which* prompt was answered, and that is
   *  where this drew your words twice. Send into a card that is already working
   *  and the CLI queues the prompt behind the running turn; that turn goes on
   *  speaking, every message of it settled the line waiting below — and when the
   *  queued prompt was finally taken up minutes later, its replay found nothing
   *  pending to claim and pushed a second copy of what you had typed, right
   *  under the tool call it had been waiting on. So settling takes the *doubt*
   *  off the line and nothing more: `awaited` stays, and the echo still has its
   *  line to claim whenever it comes. */
  #settleEchoes() {
    for (const l of this.lines) {
      if (l.kind === "you" && l.state === "pending") l.state = undefined;
    }
  }

  /** Nothing more will come down this stream, so nothing still awaited ever
   *  will be. Left claimable, those lines would be claimed by the next send of
   *  the same words — which would then draw nothing at all. */
  #forgetEchoes() {
    for (const l of this.lines) if (l.awaited) l.awaited = undefined;
  }

  /** Nothing carried it: the line says so and stays where it was written, so
   *  what you typed is still there to copy out of. Matched on what is *drawn* —
   *  a send that failed is one still marked pending, never an older copy of the
   *  same words that has been answered and is merely waiting on its echo. */
  echoFailed(text: string, why: string) {
    const line = this.#echoOf(text, (l) => l.state === "pending");
    if (line) {
      line.state = "failed";
      line.awaited = undefined;
    }
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

  /** What the running fold was holding when it began.
   *
   *  Kept apart from `ctxTokens`, which the fold is about to rewrite: the
   *  measurement being recorded is "a fold of *this much* took this long", and
   *  reading the occupancy afterwards would file every one of them under ten
   *  thousand tokens and teach the estimate that compactions are free. */
  #compactTokens = 0;

  /** The fold is over. Learn from it if it actually finished.
   *
   *  Every path that ends one comes through here, so there is a single place
   *  that can forget to clear the count or teach the estimate a lie. `record`
   *  is false where the fold did not finish so much as stop — a process that
   *  died mid-summarisation took as long as it took, and that is not a
   *  measurement of anything. */
  #endCompaction(record: boolean) {
    if (this.compactingSince === null) return;
    const seconds = (Date.now() - this.compactingSince) / 1000;
    this.compactingSince = null;
    this.compactEstimateS = 0;
    if (record) rememberCompaction({ tokens: this.#compactTokens, seconds });
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
        } else if (ev.subtype === "status") {
          if (ev.status === "compacting") {
            /* Folding a full context is the one local command that takes real
               time — it is a summarisation of everything said so far — and it
               is the only account of itself on the wire until the boundary
               lands. Narrow on purpose: `status` also carries `requesting` on
               every ordinary turn, where the deltas arriving underneath are the
               better account and this would only overwrite them. */
            if (!this.working) this.#beginTurn();
            /* `??=` rather than `=`: a second `compacting` status must not
               restart the count on a wait you have already been sitting
               through — nor re-predict it, which would move a bar that has
               already been drawn. */
            if (this.compactingSince === null) {
              this.compactingSince = Date.now();
              /* Predicted from what this fold is holding, against what folds
                 have actually cost here. Both taken now because `ctxTokens` is
                 about to be rewritten by the fold itself. */
              this.#compactTokens = this.ctxTokens;
              this.compactEstimateS = compactEstimate(seenCompactions, this.ctxTokens);
            }
            this.activity = "compacting";
          } else if (typeof ev.compact_result === "string") {
            /* The other end of it. `status` is null here — the CLI saying it is
               no longer doing anything in particular — and the result rides
               along beside it. Success needs nothing said: the boundary has
               already dropped the ring and captioned the summary. A failure
               needs everything said, or a card sits there having spent three
               minutes and a fold that did not happen, looking exactly like one
               that succeeded. */
            /* A fold that failed is still a fold that took that long, and the
               next bar is better for knowing — the wait is the same work
               either way, and it is the wait being predicted. */
            this.#endCompaction(true);
            if (ev.compact_result !== "success") {
              const why =
                typeof ev.compact_error === "string" && ev.compact_error.trim()
                  ? ev.compact_error.trim()
                  : "the compaction failed";
              this.activity = clip(why, 44);
              this.#push("error", why);
            }
          }
        } else if (ev.subtype === "compact_boundary") {
          /* It is done, and this is the only event that carries numbers.
             `compact_metadata` on the wire, `compactMetadata` in the session
             file — `compactStat` reads both, so this and `history.ts` caption
             the same compaction identically. */
          this.#endCompaction(true);
          const stat = compactStat(ev);
          if (stat) {
            /* The ring is where a compaction is visible at a glance, and it was
               the last thing to hear about one. Occupancy is the last
               `assistant` message's usage and a compaction produces no
               assistant message at all — so a card that went into `/compact` at
               98% came out of it still drawn at 98%, rust and apparently no
               better off, until the *next* turn happened to answer. This is
               that answer, arriving at the moment it is true. */
            if (stat.post > 0) this.ctxTokens = stat.post;
            this.#compacted = compactNote(stat);
          }
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
        /* It is answering us, so it has us — though not necessarily the prompt
           still waiting below, which may be queued behind this very turn. The
           mark comes off; the claim does not. */
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
            /* A subagent call is a seat being taken. It appears dim the moment
               the call lands and brightens when the subagent starts speaking.
               `Agent` is the live name — see `describeTool`; keying on `Task`
               alone meant no seat was ever taken here and the only ones that
               appeared were minted by the forwarded-message fallback below,
               which has no persona to give them. */
            if ((block.name === "Agent" || block.name === "Task") && block.id) {
              this.#seat(block.id, {
                persona:
                  block.input?.subagent_type ??
                  clip(block.input?.description ?? "seat", 16),
                state: "spawning",
              });
            }
            /* Provisional: the call says it *means* to background something,
               and the receipt a moment later says whether it did. */
            const kind = backgroundKind(block.name, block.input);
            if (kind && block.id) {
              this.#job(block.id, {
                taskId: null,
                kind,
                label: jobLabel(block.name, block.input),
                state: "starting",
                since: Date.now(),
              });
            }
            if (block.name === "TaskCreate" && block.id) {
              /* Held until the receipt names its number — an item with no
                 number could never be matched to the update that completes it. */
              this.#creating.set(block.id, {
                subject: clip(block.input?.subject ?? "", 80),
                activeForm: clip(block.input?.activeForm ?? "", 60),
              });
            }
            if (block.name === "TaskUpdate") {
              const n = String(block.input?.taskId ?? "");
              const status = String(block.input?.status ?? "");
              const i = this.plan.findIndex((t) => t.n === n);
              if (i >= 0) {
                this.plan[i] = { ...this.plan[i], status };
                /* The plan's own words beat the bare verb: `TaskUpdate` carries
                   an id and a status and nothing anybody would want to read. */
                const line = this.#planLine();
                if (line) this.activity = clip(line, 44);
              }
            }
          }
        }

        /* A message the CLI wrote itself rather than one a model produced. It
           is stamped `<synthetic>` and carries an all-zero `usage`, and both of
           the readings below have to skip it — neither used to.
           `contextWindowFor("<synthetic>")` is 200k, so a 1M card quietly lost
           two thirds of its ring and began calling its model `<synthetic>`; the
           zero usage then read as an empty context and dropped the ring to
           nothing. Probed 2026-08-14 against claude 2.1.232 with
           `tools/probe-commands.ts`: every locally-answered slash command emits
           one of these, and so does a turn refused for rate limits — which is
           how it was found. Anything it actually *said* is drawn above; it is
           only the arithmetic that must not take it for the model's own. */
        if (ev.message?.model === "<synthetic>") break;

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
        /* Belt and braces: the turn is over, so whatever the status events did
           or did not say, nothing is compacting any more. A producer that never
           sent the closing status would otherwise leave a card at rest counting
           a fold that finished — and its duration is a real measurement, since
           the turn ending is the fold ending on that path. */
        this.#endCompaction(true);
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

        /* The ledger. `result.usage` is the turn summed — see `lastTurn`. It
           is read before `costUsd` is advanced, since the turn's cost is the
           step the session total just took. */
        const tu = ev.usage;
        this.lastTurn = {
          in: tu?.input_tokens ?? 0,
          out: tu?.output_tokens ?? 0,
          cacheRead: tu?.cache_read_input_tokens ?? 0,
          cacheWrite: tu?.cache_creation_input_tokens ?? 0,
          usd:
            typeof ev.total_cost_usd === "number"
              ? Math.max(0, ev.total_cost_usd - this.#costAtLastTurn)
              : 0,
        };
        if (typeof ev.total_cost_usd === "number") {
          this.costUsd = ev.total_cost_usd;
          this.#costAtLastTurn = ev.total_cost_usd;
        }

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
          /* A turn the CLI answered by itself — `/compact`, `/model`,
             `/effort`. Its whole reply is this one line, and no `assistant`
             message carried it, so without this the card shows the prompt and
             then nothing and the gesture looks like it failed. `meta`, because
             it is the CLI talking about the conversation rather than the agent
             speaking in it — the same voice the stop note and the resume note
             are written in. */
          const said = localAnswer(ev);
          if (said) {
            this.#push("meta", said);
            this.activity = clip(said, 44);
          } else {
            /* "at rest" is a claim about the card, not about the turn, and a
               card with a `pytest -n 6` still fanning out underneath it is not
               resting. The turn did finish — that part was always true. */
            this.activity = this.busy ? this.#jobsLine() : "at rest";
          }
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
            /* A background job reporting in, which is the CLI talking about the
               conversation rather than words anybody typed — the same shape and
               the same hazard as the stop note above. Without this the raw
               `<task-notification>` XML was pushed as a `you` line and then
               opened a turn on itself.

               No turn is begun here on purpose. The agent usually is woken by
               this and the first event of that turn opens it through the arms
               that already do so; opening one here would strand the card
               `working` forever on the occasions when nothing responds. */
            const note = parseTaskNotification(said);
            if (note) {
              this.#settleJob(note, note.summary);
              break;
            }
            /* And the summary a compaction carried forward, which is the same
               shape and the same hazard at a hundred times the size: the CLI
               addressing the model with everything it must not forget, arriving
               as a `user` message, and drawn as one it is twenty thousand
               characters you appear to have typed with the round you were
               reading pushed off the top of the panel.

               It is worth keeping — it is the whole account of what this card
               used to know — so it is a fold rather than a clip: captioned with
               what the compaction cost, closed by default, and yours to open.
               Its own kind, so nothing can mistake it for either voice.

               No turn is opened on it, unlike an ordinary prompt. The turn the
               compaction runs in is already open (`status: "compacting"` began
               it) and the `result` behind this closes it. */
            if (isCompactSummary(said)) {
              this.#push("summary", said, undefined, this.#compacted ?? undefined);
              this.#compacted = null;
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
          const said = textOf(b.content);

          /* The receipt for a job we registered provisionally. Either it names
             what was started, or the call ran inline after all and the job goes
             — which is the only way to tell an `Agent` that backgrounded from
             one that did not. */
          const pending = this.jobs.find((j) => j.toolId === b.tool_use_id);
          let launched = false;
          if (pending && pending.state === "starting") {
            const { started, taskId } = startedJob(said);
            launched = started;
            if (started) {
              this.#job(b.tool_use_id, {
                taskId,
                kind: pending.kind,
                label: pending.label,
                state: "running",
                since: pending.since,
              });
              if (!this.working) this.activity = this.#jobsLine();
            } else {
              this.#dropJob(b.tool_use_id);
            }
          }

          /* A plan item's number, which is what every later update names. */
          const creating = this.#creating.get(b.tool_use_id);
          if (creating) {
            this.#creating.delete(b.tool_use_id);
            const n = taskNumberOf(said);
            if (n && !this.plan.some((t) => t.n === n)) {
              this.plan = [...this.plan, { n, ...creating, status: "pending" }];
            }
          }

          /* A subagent's seat closes on the subagent's *answer*. A background
             one answers here with a launch receipt instead — so closing on any
             tool_result would collapse the seat the instant it was taken, and
             write the receipt's own "internal metadata, never quote this"
             text into the verdict the wall then draws. It stays open until the
             notification settles the job. */
          if (!launched && this.seats.some((s) => s.id === b.tool_use_id)) {
            this.#closeSeat(b.tool_use_id, said || "returned");
          }
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
    this.jobs = [];
    this.plan = [];
    this.#creating.clear();
    this.pendingAsk = null;
    this.ctxTokens = 0;
    this.costUsd = 0;
    /* The fresh session's `total_cost_usd` starts from zero again, so a
       baseline left at the old session's total would make the first turn after
       a clear read as free (the clamp in the `result` arm) and every turn after
       it read low. */
    this.#costAtLastTurn = 0;
    this.lastTurn = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
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
    this.title = UNNAMED;
    /* And the name you gave goes with the name — a flag that outlived the title
       it was protecting would leave the card refusing every generated title for
       a session it has nothing to do with. */
    this.namedByHand = false;
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
    /* Whatever was in flight, this card can no longer be told how it ended: the
       notification would have come down the stream that just closed. Holding a
       count nothing can ever decrement would leave the card permanently busy —
       and permanently celadon — so the jobs go with the process. Said out loud
       below rather than silently, since the work itself may well still be
       running: these are grandchildren of `claude`, not of Skein. */
    const orphaned = this.jobs.length;
    this.jobs = [];
    this.#creating.clear();
    /* A fold whose process is gone is not a fold still running, and a count
       nothing can stop would tick on a dead card for the rest of the session —
       the same reason the jobs go. Not recorded: a summarisation that died
       part-way took as long as it took, and that is a measurement of the crash
       rather than of the work. */
    this.#endCompaction(false);
    if (this.retiring) {
      this.retiring = false;
      this.dormant = true;
      this.working = false;
      this.streaming = "";
      this.#forgetEchoes();
      return;
    }
    this.dormant = true;
    this.working = false;
    this.streaming = "";
    if (orphaned) {
      this.#push(
        "meta",
        orphaned === 1
          ? "a background job was left running — its outcome is no longer being reported here"
          : `${orphaned} background jobs were left running — their outcomes are no longer being reported here`,
      );
    }
    /* A prompt still marked pending here did leave — `echoFailed` is what marks
       one that did not, and a send that failed is never followed by an exit. So
       the mark comes off rather than turning into "not sent", which would be a
       lie about a prompt this process took and then died holding. What happened
       is the line below. */
    this.#settleEchoes();
    this.#forgetEchoes();
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

  /** Say something about the conversation, in the conversation.
   *
   *  A meta line is the register the panel already has for things that happened
   *  *to* a card rather than in it — `cleared`, `stopped`, a run of seats
   *  dissolving. The one use so far is the note above a resumed card's prompt:
   *  a `you` line nobody typed has to arrive introduced, or the transcript is
   *  quietly putting words in your mouth. */
  note(text: string) {
    this.#push("meta", text);
  }

  /** What you answered a parked question with, kept under the call that asked.
   *
   *  The panel used to say only that the agent had asked: the question lived in
   *  the dock, was answered there, and went — so the transcript carried a tool
   *  call and then, some seconds later, an agent acting on a decision recorded
   *  nowhere. Reading a card back, yours was the one half of that exchange
   *  missing.
   *
   *  It goes through `answerNote` rather than being pushed raw, so this line and
   *  the one `foldTranscript` writes off the same reply are the same line. */
  answered(sent: string) {
    const note = answerNote(sent);
    if (note) this.#push(note.kind, note.text);
  }

  noteStderr(line: string) {
    this.#push("error", line);
  }
}
