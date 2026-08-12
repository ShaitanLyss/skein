/* Drives the real `claude` binary with Skein's exact flags and runs the actual
 * events through the actual classifier. Slow (real API turns) and excluded from
 * the default `bun test` run — see package.json.
 *
 * This is the test that proves the four-tier detector works on real output
 * rather than on output I imagined. */

import { expect, test, describe } from "bun:test";
import { endingFor, type Ending } from "../src/lib/classify";

const CWD = "C:\\atelier\\skein";
const TURN_MS = 180_000;

/** The exact argv supervisor.rs builds. Kept in sync by hand — if this drifts,
 *  the test stops testing what ships. */
function argv(sessionId: string, extra: string[] = []) {
  return [
    "claude",
    "--print",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--replay-user-messages",
    "--forward-subagent-text",
    "--dangerously-skip-permissions",
    "--session-id", sessionId,
    ...extra,
  ];
}

type Outcome = {
  ending: Ending;
  detail: string | null;
  text: string;
  tools: string[];
  sawThinkingDelta: boolean;
  sawTextDelta: boolean;
  ctxTokens: number;
};

async function runTurn(prompt: string, extra: string[] = []): Promise<Outcome> {
  const proc = Bun.spawn(argv(crypto.randomUUID(), extra), {
    cwd: CWD,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  let stderrText = "";
  void (async () => {
    const r = proc.stderr.getReader();
    const d = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        stderrText += d.decode(value, { stream: true });
      }
    } catch {}
  })();

  proc.stdin.write(
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: prompt }] },
    }) + "\n",
  );
  proc.stdin.flush();

  const turnText: string[] = [];
  const tools: string[] = [];
  let sawAskTool = false;
  let sawThinkingDelta = false;
  let sawTextDelta = false;
  let ctxTokens = 0;
  let result: any = null;

  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = setTimeout(() => proc.kill(), TURN_MS - 5_000);

  outer: for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) {
      if (!l.trim()) continue;
      let ev: any;
      try { ev = JSON.parse(l); } catch { continue; }

      if (ev.type === "stream_event") {
        const d = ev.event?.delta;
        if (d?.type === "thinking_delta") sawThinkingDelta = true;
        if (d?.type === "text_delta") sawTextDelta = true;
      }
      if (ev.type === "assistant") {
        for (const b of ev.message?.content ?? []) {
          if (b.type === "text" && b.text?.trim()) turnText.push(b.text);
          if (b.type === "tool_use") {
            tools.push(b.name);
            if (b.name === "AskUserQuestion" || b.name === "ExitPlanMode") sawAskTool = true;
          }
        }
        const u = ev.message?.usage;
        if (u) {
          ctxTokens =
            (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0) +
            (u.output_tokens ?? 0);
        }
      }
      if (ev.type === "result") { result = ev; break outer; }
    }
  }
  clearTimeout(deadline);
  proc.kill();

  if (!result) {
    throw new Error(`no result event. stderr:\n${stderrText.slice(0, 800)}`);
  }

  const text = turnText.join("\n");
  const { ending, detail } = endingFor(result, text, sawAskTool);
  return { ending, detail, text, tools, sawThinkingDelta, sawTextDelta, ctxTokens };
}

describe("the detector, against real turns", () => {
  test(
    "a statement ending ⇒ 'ok'",
    async () => {
      const o = await runTurn(
        "Reply with exactly the word: done. No punctuation, no question, nothing else.",
      );
      console.log("  text:", JSON.stringify(o.text.slice(0, 120)));
      expect(o.ending).toBe("ok");
    },
    TURN_MS,
  );

  test(
    "a question ending ⇒ 'question'",
    async () => {
      const o = await runTurn(
        "Ask me exactly one short question about this repository, and make the " +
          "question the very last thing in your reply. Do not answer it yourself.",
      );
      console.log("  text:", JSON.stringify(o.text.slice(-120)));
      expect(o.ending).toBe("question");
    },
    TURN_MS,
  );

  test(
    "an API failure ⇒ 'error'",
    async () => {
      const o = await runTurn("hi", ["--model", "claude-does-not-exist-9"]);
      console.log("  detail:", o.detail);
      expect(o.ending).toBe("error");
    },
    TURN_MS,
  );

  test(
    "a tool-using turn reports real work and real context",
    async () => {
      const o = await runTurn(
        "Read package.json and reply with just the version. Be terse.",
      );
      console.log(
        "  tools:", o.tools.join(", "),
        "| ctx:", o.ctxTokens,
        "| thinking:", o.sawThinkingDelta,
        "| text:", o.sawTextDelta,
      );
      expect(o.tools).toContain("Read");
      // The ring must have something real to draw, and it must be sane.
      expect(o.ctxTokens).toBeGreaterThan(1000);
      expect(o.ctxTokens).toBeLessThan(200_000);
    },
    TURN_MS,
  );
});
