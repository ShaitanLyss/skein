/* What does the CLI do with `/compact`, `/model`, `/effort` and `/rewind` when
 * it is spawned the way Skein spawns it?
 *
 * Two questions, and they have different answers:
 *
 *   1. Which of these are *control requests* on stdin? The dispatcher's own
 *      subtype union, read out of the 2.1.232 binary, is
 *        set_permission_mode, set_max_thinking_tokens, mcp_oauth_callback_url,
 *        interrupt, set_color, mcp_status, mcp_reconnect, file_suggestions,
 *        get_usage, initialize, get_context_usage, mcp_authenticate, read_file,
 *        set_model, rename_session
 *      — so `set_model` is in and compact/effort/rewind are not. This probe
 *      confirms that from outside rather than trusting the strings.
 *
 *   2. Which of these work as a *prompt*, the way `/commit` does? Custom
 *      commands work in --print mode; the built-ins are a separate question and
 *      this is the one that answers it.
 *
 *   bun tools/probe-commands.ts             # the lot, in order
 *   bun tools/probe-commands.ts control     # only the control_requests
 *   bun tools/probe-commands.ts prompts     # only the slash prompts
 *
 * Costs a few small real turns.
 */

const CWD = new URL("../.scratch/probe", import.meta.url).pathname.slice(1);
const CLAUDE = Bun.which("claude") ?? "claude";

/** Skein's shipped flags, verbatim — the point is to probe what Skein spawns. */
const ARGV = [
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--forward-subagent-text",
  "--dangerously-skip-permissions",
];

const only = Bun.argv[2] ?? "all";
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`.padStart(7);

await Bun.$`mkdir -p ${CWD}`.quiet();

const proc = Bun.spawn([CLAUDE, ...ARGV, "--session-id", crypto.randomUUID()], {
  cwd: CWD,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

const write = (o: unknown) => {
  console.log(at(), "→", JSON.stringify(o).slice(0, 300));
  proc.stdin.write(JSON.stringify(o) + "\n");
  proc.stdin.flush();
};
const say = (text: string) =>
  write({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const control = (subtype: string, extra: Record<string, unknown> = {}) =>
  write({
    type: "control_request",
    request_id: `probe-${crypto.randomUUID()}`,
    request: { subtype, ...extra },
  });

(async () => {
  const dec = new TextDecoder();
  for await (const chunk of proc.stderr) {
    const s = dec.decode(chunk).trim();
    if (s) console.log(at(), "stderr:", s);
  }
})();

/* Each step is "do this, then wait for whatever settles it". A control request
   settles on its control_response; a prompt settles on its result. */
type Step = { note: string; run: () => void; settles: "control" | "result" };

const controlSteps: Step[] = [
  {
    note: "set_model — in the dispatcher's union, so this should succeed",
    run: () => control("set_model", { model: "sonnet" }),
    settles: "control",
  },
  {
    note: "set_max_thinking_tokens — the nearest thing to an effort dial on the wire",
    run: () => control("set_max_thinking_tokens", { max_thinking_tokens: 8000 }),
    settles: "control",
  },
  {
    note: "set_effort — a guess, and the answer is the point",
    run: () => control("set_effort", { effort: "high" }),
    settles: "control",
  },
  {
    note: "apply_flag_settings — the remote-control bridge takes effortLevel here",
    run: () => control("apply_flag_settings", { settings: { effortLevel: "high" } }),
    settles: "control",
  },
  {
    note: "get_settings — what does it say the effort is now?",
    run: () => control("get_settings", {}),
    settles: "control",
  },
  {
    note: "compact — not in the union; does it answer at all?",
    run: () => control("compact", {}),
    settles: "control",
  },
  {
    note: "rewind — likewise",
    run: () => control("rewind", {}),
    settles: "control",
  },
];

const promptSteps: Step[] = [
  { note: "an ordinary turn, so there is context to compact", run: () => say("Say hi in one word."), settles: "result" },
  { note: "/compact as a prompt", run: () => say("/compact"), settles: "result" },
  { note: "/model as a prompt", run: () => say("/model sonnet"), settles: "result" },
  { note: "/effort as a prompt", run: () => say("/effort high"), settles: "result" },
  { note: "/rewind as a prompt", run: () => say("/rewind"), settles: "result" },
  { note: "still alive?", run: () => say("In one word: are you still there?"), settles: "result" },
];

const steps =
  only === "control" ? controlSteps : only === "prompts" ? promptSteps : [...controlSteps, ...promptSteps];

let step = -1;
let deltas = 0;
function next() {
  step += 1;
  if (step >= steps.length) {
    console.log(at(), "— done");
    setTimeout(() => proc.kill(), 300);
    return;
  }
  deltas = 0;
  console.log("");
  console.log(at(), `## ${steps[step].note}`);
  steps[step].run();
}

/* A control_request that the dispatcher does not know may be answered with an
   error, or ignored entirely. Ignored is a real answer, so each control step
   gets a deadline rather than waiting forever. */
let timer: ReturnType<typeof setTimeout> | null = null;
function arm() {
  if (timer) clearTimeout(timer);
  if (step < 0 || step >= steps.length || steps[step].settles !== "control") return;
  timer = setTimeout(() => {
    console.log(at(), "!! no control_response — ignored");
    next();
  }, 8000);
}

next();
arm();

const dec = new TextDecoder();
let buf = "";
const deadline = setTimeout(() => proc.kill(), 300_000);

for await (const chunk of proc.stdout) {
  buf += dec.decode(chunk, { stream: true });
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const l of lines) {
    if (!l.trim()) continue;
    let ev: any;
    try {
      ev = JSON.parse(l);
    } catch {
      console.log(at(), "← unparseable:", l.slice(0, 200));
      continue;
    }

    if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") {
      deltas += 1;
      continue;
    }
    if (ev.type === "stream_event") continue;

    /* The two events the probe exists to read are never clipped. */
    const whole = ev.type === "result" || ev.type === "control_response";
    console.log(at(), "←", whole ? JSON.stringify(ev) : JSON.stringify(ev).slice(0, 500));

    const settles = step >= 0 && steps[step].settles;
    if (
      (settles === "control" && ev.type === "control_response") ||
      (settles === "result" && ev.type === "result")
    ) {
      if (deltas) console.log(at(), `   (${deltas} deltas)`);
      next();
      arm();
    }
  }
}

clearTimeout(deadline);
if (timer) clearTimeout(timer);
console.log(at(), `stdout closed · exit ${await proc.exited}`);
