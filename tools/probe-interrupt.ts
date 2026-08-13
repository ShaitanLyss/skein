/* Can a turn be stopped, and what does stopping one look like on the wire?
 *
 * Claude Code's own Esc is a TUI keybinding, but the stream-json *input* format
 * carries a second kind of message besides `user`: a `control_request`. The
 * binary's dispatcher accepts exactly this set on stdin —
 *
 *   interrupt, set_permission_mode, set_model, set_max_thinking_tokens,
 *   set_color, mcp_toggle, message_rated
 *
 * — and the SDK's own `query.interrupt()` sends `{subtype:"interrupt"}` and
 * reads `still_queued` off the success response. That is the whole feature; this
 * probe is here to answer what Skein has to *fold* afterwards: which events
 * arrive, in what order, and how the `result` describes a turn somebody stopped.
 *
 *   bun tools/probe-interrupt.ts            # interrupt a long turn
 *   bun tools/probe-interrupt.ts idle       # interrupt with nothing running
 *
 * Costs one real (short) turn.
 */

const CWD = "C:\\atelier\\skein";
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

const mode = Bun.argv[2] ?? "busy";
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`.padStart(7);

const proc = Bun.spawn([CLAUDE, ...ARGV, "--session-id", crypto.randomUUID()], {
  cwd: CWD,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

const write = (o: unknown) => {
  console.log(at(), "→", JSON.stringify(o));
  proc.stdin.write(JSON.stringify(o) + "\n");
  proc.stdin.flush();
};

/* stderr, in case an unaccepted control message is complained about there
   rather than answered on the stream. */
(async () => {
  const dec = new TextDecoder();
  for await (const chunk of proc.stderr) {
    const s = dec.decode(chunk).trim();
    if (s) console.log(at(), "stderr:", s);
  }
})();

if (mode !== "idle") {
  write({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text:
            "Count from 1 to 400, one number per line, with a short remark " +
            "after each. Do not stop early.",
        },
      ],
    },
  });
}

let interrupted = false;
let spokeAgain = false;
let deltas = 0;

const dec = new TextDecoder();
let buf = "";
const deadline = setTimeout(() => proc.kill(), 90_000);

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

    /* Deltas are the noise; count them and say when they stop. */
    if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") {
      deltas += 1;
      if (deltas % 50 === 0) console.log(at(), `← (${deltas} deltas)`);
    } else if (ev.type === "result") {
      /* The one event this probe exists to read, so it is never clipped. */
      console.log(at(), "←", JSON.stringify(ev));
    } else {
      console.log(at(), "←", JSON.stringify(ev).slice(0, 400));
    }

    /* Once it is plainly mid-answer, stop it. `cancel_queued` is advertised as
       a capability (`interrupt_cancel_queued_v1`); ask for it and see whether
       the response carries `cancelled` or ignores the field. */
    if (!interrupted && (mode === "idle" || deltas > 20)) {
      interrupted = true;
      write({
        type: "control_request",
        request_id: `interrupt-${crypto.randomUUID()}`,
        request: { subtype: "interrupt", cancel_queued: true },
      });
    }

    /* The question after "does it stop" is "is the card still usable" — an
       interrupt that leaves the process wedged would be worse than none. */
    if (ev.type === "result") {
      if (!spokeAgain) {
        spokeAgain = true;
        console.log(at(), "result reached — sending a second prompt");
        write({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: "In one word: are you still there?" }],
          },
        });
      } else {
        console.log(at(), "second turn completed — the process survived");
        setTimeout(() => proc.kill(), 500);
      }
    }
  }
}

clearTimeout(deadline);
console.log(at(), `stdout closed · ${deltas} deltas · exit ${await proc.exited}`);
