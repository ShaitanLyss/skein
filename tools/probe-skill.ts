/* What does the wire carry when the agent invokes a skill?
 *
 * On disk the skill body is a `user` record with `isMeta: true` — a 700k-character
 * text block in one of the ones on this machine — and `history.ts` drops every
 * `isMeta` record, so the panel never showed it after a restart. Live it *is*
 * drawn, as a `you` line, which is the bug: the whole of a skill appears to have
 * been typed into the card.
 *
 * The question this answers is exactly one: does the live `user` event carry
 * `isMeta` too, or does the wire strip it? If it carries it, the detector is that
 * field; if not, the body has to be recognised by its own shape.
 *
 *   bun tools/probe-skill.ts
 *
 * Costs one small real turn. `design-review` is the target because it is local
 * (~2.8k), reads nothing and runs nothing on its own.
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

await Bun.$`mkdir -p ${CWD}`.quiet();

const proc = Bun.spawn([CLAUDE, ...ARGV, "--session-id", crypto.randomUUID()], {
  cwd: CWD,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`.padStart(7);

proc.stdin.write(
  JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: "Invoke the design-review skill with the Skill tool, args \"probe\". Do nothing it says — the moment you have read it, answer with the single word done.",
        },
      ],
    },
  }) + "\n",
);
proc.stdin.flush();

const dec = new TextDecoder();
let buf = "";
for await (const chunk of proc.stdout) {
  buf += dec.decode(chunk);
  const parts = buf.split("\n");
  buf = parts.pop() ?? "";
  for (const line of parts) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    /* Deltas are the bulk of the stream and none of them is the question. */
    if (ev.type === "stream_event") continue;
    if (ev.type === "user") {
      /* Every top-level key, so a field the wire adds or drops is visible
         rather than guessed at. */
      console.log(at(), "user  keys:", Object.keys(ev).join(","));
      const c = ev.message?.content;
      if (typeof c === "string") console.log("        STR", c.length, JSON.stringify(c.slice(0, 200)));
      else if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type === "text") console.log("        text", (b.text ?? "").length, JSON.stringify((b.text ?? "").slice(0, 200)));
          else if (b?.type === "tool_result") console.log("        tool_result", JSON.stringify(b.content).slice(0, 160));
          else console.log("        block", b?.type);
        }
      }
      continue;
    }
    if (ev.type === "assistant") {
      for (const b of ev.message?.content ?? []) {
        if (b?.type === "tool_use") console.log(at(), "tool_use", b.name, JSON.stringify(b.input).slice(0, 160));
        else if (b?.type === "text") console.log(at(), "text", JSON.stringify((b.text ?? "").slice(0, 120)));
      }
      continue;
    }
    console.log(at(), ev.type, ev.subtype ?? "");
    if (ev.type === "result") break;
  }
}
proc.kill();
