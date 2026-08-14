/* How long will the CLI wait for a parked MCP tool call?
 *
 * `ask.rs` parks a `tools/call` for up to ten minutes on the argument that the
 * agent is then genuinely *stopped* rather than idle. That argument is only
 * worth anything if the client is still listening when the answer arrives — and
 * the reported symptom is that it is not: the question is drawn, an option is
 * clicked well inside ten minutes, and the agent says the tool timed out.
 *
 * So this stands up a server that behaves exactly like `ask.rs` — plain JSON-RPC
 * over POST, no SSE — parks the call, and answers it *late*. What it is here to
 * read is the client's side of that:
 *
 *   - at what elapsed time does the CLI give up on the call
 *   - does it abort the HTTP request (something Rust could see) or go quiet
 *   - does it send `notifications/cancelled`
 *   - what does the tool_result the model reads actually say
 *   - does an answer written after that reach the model at all
 *
 *   bun tools/probe-ask.ts                 # answer at 90s, default timeouts
 *   bun tools/probe-ask.ts 30              # answer at 30s
 *   bun tools/probe-ask.ts 90 900000       # answer at 90s, MCP_TOOL_TIMEOUT=15m
 *
 * Costs one real (short) turn.
 */

const CWD = process.cwd();
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

/** When the "user" clicks an option, in seconds. The symptom is an answer well
 *  inside `ANSWER_TIMEOUT` that lands too late anyway. */
const ANSWER_AT = Number(Bun.argv[2] ?? 90) * 1000;
/** Optional MCP_TOOL_TIMEOUT for the child, in ms — the candidate fix. */
const TOOL_TIMEOUT = Bun.argv[3];

const CONV = crypto.randomUUID();
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`.padStart(7);

let parkedAt = 0;
let abortedAt = 0;
let answeredAt = 0;

/* ── the server, mirroring ask.rs ──────────────────────────────────────── */

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    if (req.method !== "POST") {
      console.log(at(), `http ${req.method} ${new URL(req.url).pathname} → 405`);
      return new Response(null, { status: 405 });
    }
    const rpc = await req.json().catch(() => null);
    if (!rpc) return new Response(null, { status: 400 });

    const method = rpc.method ?? "";
    const hasId = rpc.id !== undefined;
    console.log(at(), `rpc ← ${method}${hasId ? ` (id ${rpc.id})` : " (notification)"}`);
    if (method.startsWith("notifications/")) {
      console.log(at(), `     params: ${JSON.stringify(rpc.params ?? {})}`);
    }

    const json = (body: unknown) => Response.json(body);

    if (!hasId) return new Response(null, { status: 202 });

    switch (method) {
      case "initialize":
        return json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            protocolVersion: rpc.params?.protocolVersion ?? "2025-06-18",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "skein-probe", version: "0.0.0" },
          },
        });

      case "tools/list":
        return json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            tools: [
              {
                name: "ask_user",
                description:
                  "Ask the human a question and wait for their answer. Use this " +
                  "whenever you need a decision only they can make.",
                inputSchema: {
                  type: "object",
                  properties: {
                    question: { type: "string" },
                    options: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: { label: { type: "string" }, detail: { type: "string" } },
                        required: ["label"],
                      },
                    },
                  },
                  required: ["question"],
                },
              },
            ],
          },
        });

      case "ping":
        return json({ jsonrpc: "2.0", id: rpc.id, result: {} });

      case "tools/call": {
        parkedAt = Date.now();
        console.log(at(), `parked: ${JSON.stringify(rpc.params?.arguments ?? {})}`);
        console.log(at(), `        answering in ${(ANSWER_AT / 1000).toFixed(0)}s`);

        /* The datum ask.rs cannot currently see: does the client drop the
           connection when it gives up, or leave it hanging? */
        req.signal.addEventListener("abort", () => {
          abortedAt = Date.now();
          console.log(
            at(),
            `!! client aborted the parked request after ` +
              `${((abortedAt - parkedAt) / 1000).toFixed(2)}s — ${req.signal.reason}`,
          );
        });

        await Bun.sleep(ANSWER_AT);
        answeredAt = Date.now();
        console.log(at(), "→ answering the parked call (as a click would)");
        return json({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { content: [{ type: "text", text: "PROBE-ANSWER: pick blue." }] },
        });
      }

      default:
        return json({
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32601, message: `no method ${method}` },
        });
    }
  },
});

const url = `http://127.0.0.1:${server.port}/mcp/${CONV}`;
console.log(at(), `ask endpoint: ${url}`);
if (TOOL_TIMEOUT) console.log(at(), `MCP_TOOL_TIMEOUT=${TOOL_TIMEOUT}`);

/* ── the child, spawned exactly as supervisor.rs spawns one ────────────── */

const proc = Bun.spawn(
  [
    CLAUDE,
    ...ARGV,
    "--session-id", CONV,
    "--mcp-config", JSON.stringify({ mcpServers: { skein: { type: "http", url } } }),
    "--append-system-prompt",
    "When you need a decision that only the user can make, call the `ask_user` " +
      "tool rather than ending your turn with a question. It keeps your turn open " +
      "and resumes the moment they answer. Give it `options` whenever the answer " +
      "is a choice between alternatives.",
  ],
  {
    cwd: CWD,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: TOOL_TIMEOUT ? { ...process.env, MCP_TOOL_TIMEOUT: TOOL_TIMEOUT } : process.env,
  },
);

const write = (o: unknown) => {
  console.log(at(), "→", JSON.stringify(o).slice(0, 160));
  proc.stdin.write(JSON.stringify(o) + "\n");
  proc.stdin.flush();
};

(async () => {
  const dec = new TextDecoder();
  for await (const chunk of proc.stderr) {
    const s = dec.decode(chunk).trim();
    if (s) console.log(at(), "stderr:", s.slice(0, 400));
  }
})();

write({
  type: "user",
  message: {
    role: "user",
    content: [
      {
        type: "text",
        text:
          "Call the ask_user tool right now, with the question 'red or blue?' and " +
          "the options red and blue. Do not do anything else first, and do not " +
          "answer it yourself. When it returns, say in one line exactly what it " +
          "returned.",
      },
    ],
  },
});

/* Long enough to outlive the answer and see what follows it. */
const deadline = setTimeout(() => proc.kill(), ANSWER_AT + 180_000);

const dec = new TextDecoder();
let buf = "";
let deltas = 0;

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

    /* A tool_result comes back inside a user message, and its text is the whole
       point of the probe — the model reads that and nothing else. */
    const blocks = ev.message?.content;
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (b.type === "tool_result") {
          console.log(
            at(),
            `← TOOL_RESULT is_error=${b.is_error === true} ${JSON.stringify(b.content).slice(0, 600)}`,
          );
        }
      }
    }

    if (ev.type === "result") console.log(at(), "←", JSON.stringify(ev).slice(0, 800));
    else console.log(at(), "←", JSON.stringify(ev).slice(0, 300));

    if (ev.type === "result") setTimeout(() => proc.kill(), 1000);
  }
}

clearTimeout(deadline);
console.log(at(), `stdout closed · exit ${await proc.exited}`);
console.log(
  at(),
  `summary: parked ${parkedAt ? "yes" : "no"} · ` +
    `aborted ${abortedAt ? `${((abortedAt - parkedAt) / 1000).toFixed(2)}s in` : "never"} · ` +
    `answered ${answeredAt ? `${((answeredAt - parkedAt) / 1000).toFixed(2)}s in` : "never"}`,
);
server.stop(true);
