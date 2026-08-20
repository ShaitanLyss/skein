/* What kills a parked HTTP request when the client is Bun?
 *
 * `ask.rs` parks a `tools/call` for ten minutes, and the reported symptom is a
 * card abandoned at just under five with `is_error: true, "The operation timed
 * out."` — a sentence that is *not* in the CLI's own JavaScript. It is in the
 * Bun runtime strings inside `claude.exe`, which is a Bun single-file
 * executable, so the clock that fires is Bun's `fetch` and no
 * `MCP_TOOL_TIMEOUT`, no per-server `timeout` field and nothing else the CLI
 * parses can move it.
 *
 * This probe costs nothing and asks the only two questions that decide the fix:
 *
 *   - silent park: when does Bun's own fetch give up, and saying what
 *   - streamed park: does a response whose *headers* arrive at once and which
 *     then dribbles a byte every 20s outlive that clock
 *
 * If the second survives, the fix is for `ask.rs` to answer a `tools/call` as
 * `text/event-stream` and keep it fed — which is also what MCP's own spec says
 * a long-running call should look like, and what would let the server send the
 * progress notifications the CLI's *idle* watchdog wants.
 *
 *   bun tools/probe-park.ts          # 330s, past the suspected 300s clock
 *   bun tools/probe-park.ts 60       # quicker, for wiring changes
 */

const PARK_FOR = Number(Bun.argv[2] ?? 330) * 1000;
/** Well inside any plausible idle window, and coarse enough to read. */
const FEED_EVERY = 20_000;

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`.padStart(8);

/** Both endpoints hold the request for `PARK_FOR`. Only one of them speaks
 *  while it does. */
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  /* Bun.serve's own default is 10s and it applies to a response already being
     streamed — which killed the streamed arm at 12s the first time this ran and
     had nothing to do with the client. 0 disables it; ask.rs is tiny_http and
     has no such clock. */
  idleTimeout: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    console.log(at(), `server ← POST ${path}`);
    req.signal.addEventListener("abort", () =>
      console.log(at(), `server !! ${path} aborted by client — ${req.signal.reason}`),
    );

    if (path === "/silent") {
      /* Exactly ask.rs: nothing at all until the answer exists. */
      await Bun.sleep(PARK_FOR);
      console.log(at(), "server → /silent answering");
      return Response.json({ jsonrpc: "2.0", id: 1, result: { parked: PARK_FOR } });
    }

    /* Headers immediately, then a keep-alive comment every FEED_EVERY, then the
       real payload as the last event — the shape an SSE tools/call reply has. */
    const body = new ReadableStream({
      async start(c) {
        const enc = new TextEncoder();
        const until = Date.now() + PARK_FOR;
        let fed = 0;
        while (Date.now() < until) {
          await Bun.sleep(Math.min(FEED_EVERY, until - Date.now()));
          if (Date.now() >= until) break;
          fed += 1;
          try {
            c.enqueue(
              enc.encode(
                `event: message\ndata: ${JSON.stringify({
                  jsonrpc: "2.0",
                  method: "notifications/progress",
                  params: { progressToken: 1, progress: fed },
                })}\n\n`,
              ),
            );
          } catch (e) {
            console.log(at(), `server !! /streamed enqueue failed after ${fed} feeds — ${e}`);
            return;
          }
        }
        console.log(at(), `server → /streamed answering after ${fed} feeds`);
        c.enqueue(
          enc.encode(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { parked: PARK_FOR, feeds: fed },
            })}\n\n`,
          ),
        );
        c.close();
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  },
});

const base = `http://127.0.0.1:${server.port}`;
console.log(at(), `parking both for ${(PARK_FOR / 1000).toFixed(0)}s at ${base}`);

/** The client side, as the MCP transport does it: a POST with a JSON-RPC body,
 *  no signal of our own, so whatever fires is Bun's own. */
async function park(path: string, read: (r: Response) => Promise<string>) {
  const started = Date.now();
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(2)}s`;
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
    });
    console.log(at(), `client ${path} headers after ${elapsed()} — ${res.status}`);
    const text = await read(res);
    console.log(at(), `client ${path} DONE after ${elapsed()} — ${text.slice(0, 160)}`);
  } catch (e: any) {
    console.log(
      at(),
      `client ${path} THREW after ${elapsed()} — ${e?.name}: ${e?.message}` +
        (e?.cause ? ` (cause ${e.cause})` : ""),
    );
  }
}

await Promise.all([
  park("/silent", (r) => r.text()),
  /* Read to the end, the way a transport consuming an SSE reply would. */
  park("/streamed", async (r) => {
    let last = "";
    const dec = new TextDecoder();
    for await (const chunk of r.body!) last = dec.decode(chunk as Uint8Array, { stream: true });
    return last;
  }),
]);

server.stop(true);
