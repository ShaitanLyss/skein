/* What does a conversation cost before it has said anything?
 *
 * Spawns `claude` with Skein's exact argv, sends one word, and reads the usage
 * off the FIRST assistant message — which is the whole prompt: system prompt,
 * tool schemas, MCP tool schemas, skill listings, CLAUDE.md, memory. That
 * number is what the ring on the card draws, so this is the ring's own
 * measurement, taken by hand.
 *
 * Variants isolate one suspect each, so the answer is "MCP costs N", not "it's
 * big".
 *
 *   bun tools/probe-context.ts                 # every variant
 *   bun tools/probe-context.ts lean no-tools   # just these
 */

const CWD = "C:\\atelier\\skein";
/* Bun.spawn does not always resolve a bare name from a Git Bash PATH. */
const CLAUDE = Bun.which("claude") ?? "claude";

/** Skein's shipped flags, minus the ones a variant wants to change. */
const BASE = [
  "--print",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--forward-subagent-text",
  "--dangerously-skip-permissions",
];

const ASK_PROMPT =
  "When you need a decision that only the user can make, call the `ask_user` " +
  "tool rather than ending your turn with a question.";

type Probe = {
  name: string;
  extra: string[];
};

const PROBES: Probe[] = [
  /* As shipped today: the user's global MCP servers load, all skills load. */
  { name: "as-shipped", extra: ["--append-system-prompt", ASK_PROMPT] },

  /* One suspect at a time. */
  { name: "strict-mcp", extra: ["--append-system-prompt", ASK_PROMPT, "--strict-mcp-config"] },
  { name: "no-skills", extra: ["--append-system-prompt", ASK_PROMPT, "--disable-slash-commands"] },
  { name: "no-settings", extra: ["--append-system-prompt", ASK_PROMPT, "--setting-sources", ""] },

  /* Everything Skein does not need, off at once. */
  {
    name: "lean",
    extra: [
      "--append-system-prompt", ASK_PROMPT,
      "--strict-mcp-config",
      "--disable-slash-commands",
    ],
  },

  /* Where the floor actually is: no tools at all is the system prompt on its
     own, and a coding-only set says what the rest of the schemas cost. */
  { name: "no-tools", extra: ["--tools", ""] },
  {
    name: "coding-tools",
    extra: [
      "--append-system-prompt", ASK_PROMPT,
      "--tools", "Bash,Read,Write,Edit,Glob,Grep,Task,TodoWrite,WebFetch,WebSearch,Skill",
    ],
  },
];

type Usage = Record<string, any>;

async function probe(p: Probe): Promise<{ usage: Usage; total: number; tools: number; slash: number }> {
  const argv = [CLAUDE, ...BASE, "--session-id", crypto.randomUUID(), ...p.extra];
  const proc = Bun.spawn(argv, { cwd: CWD, stdin: "pipe", stdout: "pipe", stderr: "pipe" });

  proc.stdin.write(
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    }) + "\n",
  );
  proc.stdin.flush();

  let usage: Usage | null = null;
  let tools = 0;
  let slash = 0;
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = setTimeout(() => proc.kill(), 120_000);

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
      if (ev.type === "system" && ev.subtype === "init") {
        tools = ev.tools?.length ?? 0;
        slash = ev.slash_commands?.length ?? 0;
      }
      if (ev.type === "assistant" && ev.message?.usage) {
        usage = ev.message.usage;
        break outer;
      }
    }
  }
  clearTimeout(deadline);
  proc.kill();

  if (!usage) throw new Error(`${p.name}: no assistant message`);
  const total =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
  return { usage, total, tools, slash };
}

const only = new Set(Bun.argv.slice(2));
const rows: { name: string; total: number; tools: number; slash: number }[] = [];
for (const p of PROBES) {
  if (only.size && !only.has(p.name)) continue;
  try {
    const r = await probe(p);
    rows.push({ name: p.name, total: r.total, tools: r.tools, slash: r.slash });
    console.log(
      p.name.padEnd(14),
      String(r.total).padStart(7), "tok",
      `(${(r.total / 2000).toFixed(1)}% of 200k)`,
      "| tools:", String(r.tools).padStart(3),
      "| skills:", String(r.slash).padStart(3),
      "|", JSON.stringify(r.usage),
    );
  } catch (e) {
    console.log(p.name.padEnd(14), "FAILED:", String(e).slice(0, 200));
  }
}

const base = rows.find((r) => r.name === "as-shipped");
if (base) {
  console.log("\ndeltas against as-shipped:");
  for (const r of rows) {
    if (r === base) continue;
    console.log(
      "  ", r.name.padEnd(14),
      (r.total - base.total).toLocaleString().padStart(9), "tok",
      `(${(((r.total - base.total) / base.total) * 100).toFixed(0)}%)`,
    );
  }
}
