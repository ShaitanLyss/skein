/* Reading a group of dev servers out of what you typed.
 *
 * One command per line, with an optional trailing `:port` declaring what to
 * watch for. Pure, and out here rather than inside Servers.svelte, so the
 * parsing rules can be tested directly — the label rule in particular, which
 * decides how health and log lines are routed and used to be able to collide. */

export type ParsedSpec = {
  label: string;
  command: string;
  cwd: string | null;
  port: number | null;
};

/** The trailing `:5173` in `npm run dev :5173`. Whitespace before the colon is
 *  required, so `npm run dev:watch` stays a command and not a port. */
const TRAILING_PORT = /\s:(\d{2,5})\s*$/;

/** `npm run dev :5173` → one spec per non-empty line.
 *
 * A label is the last word of the command, which reads well (`dev`, `api`,
 * `watch`) and needs one guard: labels are the only identity a server has on the
 * wire, so `server:log` and `server:state` both route by them. Two commands
 * ending in the same word — `npm run dev :5173` and `bun run dev :3000` — would
 * share a single health entry and report each other's state, with both chips
 * turning green when only one of them was up. Duplicates get a number instead. */
export function parseSpecs(text: string): ParsedSpec[] {
  const taken = new Set<string>();

  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, i) => {
      const m = line.match(TRAILING_PORT);
      const port = m ? Number(m[1]) : null;
      const command = m ? line.slice(0, m.index).trim() : line;

      let label = command.split(/\s+/).slice(-1)[0] || `svc${i + 1}`;
      if (taken.has(label)) {
        let n = 2;
        while (taken.has(`${label}${n}`)) n += 1;
        label = `${label}${n}`;
      }
      taken.add(label);

      return { label, command, cwd: null, port };
    });
}
