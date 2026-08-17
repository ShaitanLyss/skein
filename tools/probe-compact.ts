/* What does a compaction actually put on the wire?
 *
 * `tools/probe-commands.ts` established the four events either side of one —
 * `system/status "compacting"`, a `compact_boundary`, the summary as a `user`
 * message, and a closing status carrying `compact_result`. What it did not ask
 * is whether anything arrives *between* them, and that is the whole question:
 * the TUI draws a shimmering "Compacting conversation…" with a climbing token
 * counter beside it, so there is plainly progress to be had somewhere.
 *
 * Read out of the 2.1.232 binary, two of the three things feeding that counter
 * are UI-only. `compact_progress` (phases: hooks_start, compact_start,
 * compact_end) and `response_length` are both in the set the SDK path filters
 * out of its message stream — `dav`/`pav` — and `compact_progress` is routed
 * straight to `onCompactEvent`, which is the TUI's status line. Neither can be
 * seen from here.
 *
 * The one that might survive is `stream_event`. It is in the same filtered set,
 * but the print path re-emits it when `--include-partial-messages` is on
 * (`P && _t.type === "stream_event" && !Q5r(_t.event)`), and Skein passes that
 * flag. If the summarisation's own deltas go down that path, a compaction can
 * be drawn the way every other turn is — token by token — and Skein should draw
 * it that way rather than counting seconds.
 *
 * So: build enough context to be worth compacting, send `/compact`, and print
 * every event from the opening status to the closing one, with the deltas
 * counted and their running total in tokens.
 *
 *   bun tools/probe-compact.ts
 *
 * Costs a handful of small real turns and one real compaction — minutes, and
 * the compaction itself is the expensive part (a real one on this machine took
 * 3m 08s over a 340k context).
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

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`.padStart(8);

await Bun.$`mkdir -p ${CWD}`.quiet();

const proc = Bun.spawn([CLAUDE, ...ARGV, "--session-id", crypto.randomUUID()], {
  cwd: CWD,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

const say = (text: string) => {
  console.log(at(), "→", text.slice(0, 100));
  proc.stdin.write(
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    }) + "\n",
  );
  proc.stdin.flush();
};

(async () => {
  const dec = new TextDecoder();
  for await (const chunk of proc.stderr) {
    const s = dec.decode(chunk).trim();
    if (s) console.log(at(), "stderr:", s);
  }
})();

/* Context to compact. A compaction of nothing is refused outright
   (`compact_not_enough_messages` in the binary), and a compaction of three
   sentences is over before it has said anything — the shape is the same either
   way, but a fold with some work to do is the one worth watching. */
const WARMUP = [
  "In one sentence: what is a Tauri sidecar?",
  "In one sentence: what does --output-format stream-json change?",
  "In one sentence: when does the CLI decide to compact by itself?",
  "In two sentences: what is the difference between a job and a seat?",
];

let step = 0;
/** Everything seen between the opening status and the closing one. */
let inside = false;
/** Past the fold: log everything, since the question there is what arrives. */
let after = false;
let deltas = 0;
let deltaChars = 0;
const seen = new Map<string, number>();

function next() {
  if (step < WARMUP.length) {
    say(WARMUP[step++]);
    return;
  }
  if (step === WARMUP.length) {
    step++;
    console.log("");
    console.log(at(), "## /compact — everything from here to the closing status");
    console.log("");
    say("/compact");
    return;
  }
  if (step === WARMUP.length + 1) {
    step++;
    /* The fold itself carried nothing but its two statuses. The boundary and
       the summary are both in the session file, so if they reach the wire at
       all it is on the next turn — the CLI re-emitting the conversation it has
       just rebuilt. That is the question this second half exists to ask, and it
       decides where Skein can draw the summary from. */
    console.log("");
    console.log(at(), "## the first turn after the fold — everything, unfiltered");
    console.log("");
    after = true;
    say("In one word: are you still there?");
    return;
  }
  console.log("");
  console.log(at(), "— done");
  report();
  setTimeout(() => proc.kill(), 300);
}

function report() {
  console.log("");
  console.log("what arrived during the fold:");
  if (seen.size === 0) console.log("  (nothing at all)");
  for (const [k, n] of [...seen].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  ${k}`);
  }
  console.log("");
  console.log(
    deltas
      ? `  ${deltas} deltas, ~${Math.round(deltaChars / 4)} tokens — the fold CAN be drawn token by token`
      : "  no deltas — the summarisation does not stream to stdout, so elapsed is the only account",
  );
}

/** A short name for an event, since the interesting distinctions are nested. */
function nameOf(ev: any): string {
  if (ev.type === "stream_event") {
    const e = ev.event;
    const d = e?.delta?.type ?? e?.content_block?.type ?? "";
    return `stream_event/${e?.type}${d ? `:${d}` : ""}`;
  }
  if (ev.type === "system") return `system/${ev.subtype}${ev.status !== undefined ? `(status=${ev.status})` : ""}`;
  if (ev.type === "assistant") return `assistant(${ev.message?.model ?? "?"})`;
  if (ev.type === "user") return "user";
  return String(ev.type);
}

next();

const dec = new TextDecoder();
let buf = "";
const deadline = setTimeout(() => {
  console.log(at(), "!! gave up waiting");
  report();
  proc.kill();
}, 600_000);

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
      continue;
    }

    const isOpen =
      ev.type === "system" && ev.subtype === "status" && ev.status === "compacting";
    const isShut =
      ev.type === "system" && ev.subtype === "status" && ev.compact_result !== undefined;

    if (isOpen) inside = true;

    if (after && !inside) {
      /* The summary runs to tens of thousands of characters; what matters is
         which event carries it and what marks it, not the words. */
      const flat = JSON.stringify(ev);
      console.log(
        at(),
        "←",
        nameOf(ev).padEnd(34),
        flat.length > 500 ? `${flat.slice(0, 500)}… (${flat.length} chars)` : flat,
      );
      if (ev.type === "result") next();
      continue;
    }

    if (inside) {
      const name = nameOf(ev);
      seen.set(name, (seen.get(name) ?? 0) + 1);
      if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") {
        deltas++;
        const d = ev.event.delta;
        deltaChars += (d?.text ?? d?.thinking ?? d?.partial_json ?? "").length;
        /* One in twenty, or a three-minute fold is ten thousand lines. */
        if (deltas % 20 === 1) {
          console.log(
            at(),
            `←  ${name} · ${deltas} deltas, ~${Math.round(deltaChars / 4)} tokens`,
          );
        }
        continue;
      }
      /* The boundary is the one event carrying numbers; never clipped. */
      const whole = ev.type === "system" || ev.type === "result";
      console.log(at(), "←", whole ? JSON.stringify(ev) : JSON.stringify(ev).slice(0, 400));
    }

    if (isShut) inside = false;

    if (ev.type === "result") {
      if (step > WARMUP.length) {
        console.log(at(), "← result:", JSON.stringify(ev).slice(0, 400));
      }
      next();
    }
  }
}

clearTimeout(deadline);
console.log(at(), `stdout closed · exit ${await proc.exited}`);
