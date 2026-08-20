/* Where does the thinking effort come from on the wire?
 *
 * The session file on disk carries `effort` as a top-level field on every
 * `assistant` record — but Skein never reads that file, it reads the
 * stream-json events. This asks whether the same field rides the wire, and
 * whether `system/init` states it up front the way it states the model.
 *
 *   bun tools/probe-effort.ts            # default effort
 *   bun tools/probe-effort.ts high       # spawned with --effort high
 */

const CWD = "C:\atelier\skein";
/* The bare name, resolved by the OS. `Bun.which` is what the older probes use
   and it hands back the absolute path to `claude.exe` — which spawned ENOENT
   here twice in a row on 2026-08-20 while the same path run from a shell was
   fine. Both forms worked a minute later, so it is a flake rather than a rule;
   the bare name is one fewer thing between the probe and the binary. */
const CLAUDE = "claude";

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

const level = Bun.argv[2];
const args = level ? [...BASE, "--effort", level] : BASE;

const child = Bun.spawn([CLAUDE, ...args], {
  cwd: CWD,
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

child.stdin.write(
  JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "say ok" }] },
  }) + "\n",
);
child.stdin.flush();

const seen = new Map<string, Set<string>>();
let printedInit = false;
let printedAssistant = false;

const dec = new TextDecoder();
let buf = "";
for await (const chunk of child.stdout) {
  buf += dec.decode(chunk);
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    const tag = ev.type === "system" ? `system/${ev.subtype}` : ev.type;
    if (!seen.has(tag)) seen.set(tag, new Set());
    for (const k of Object.keys(ev)) seen.get(tag)!.add(k);

    if (tag === "system/init" && !printedInit) {
      printedInit = true;
      console.log("\n--- system/init ---");
      console.log(JSON.stringify(ev, null, 2).slice(0, 3000));
    }
    if (ev.type === "assistant" && !printedAssistant) {
      printedAssistant = true;
      console.log("\n--- first assistant event (message body elided) ---");
      console.log(JSON.stringify({ ...ev, message: { ...ev.message, content: "…" } }, null, 2));
    }
    if (ev.type === "result") {
      console.log("\n--- result ---");
      console.log(JSON.stringify(ev, null, 2).slice(0, 2000));
    }
  }
}

console.log("\n--- top-level keys per event type ---");
for (const [tag, keys] of seen) console.log(tag.padEnd(22), [...keys].join(","));
child.kill();
