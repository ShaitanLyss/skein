/* When may a session be resumed, and what happens when we get it wrong?
 *
 * Skein used to decide `--resume` vs `--session-id` from `everSpoke`, which is
 * really "did a turn ever *finish*" (`last_ending IS NOT NULL`). That is not the
 * same question, and a card killed part-way through its first turn is where the
 * two part company: it has a transcript on disk and a NULL ending, so the next
 * wake spawned with `--session-id` against an id the CLI already knew, and the
 * child died on the spot. `spawn_conversation` asks the disk now, and this probe
 * is why that one condition is enough.
 *
 * It costs no tokens: every spawn here is given an empty stdin and killed, so no
 * turn is ever taken.
 *
 *   bun tools/probe-resume.ts
 *
 * 1. Does a spawn that is never spoken to create a transcript file at all?
 *    (If it did, "the file exists" could not mean "there is something to
 *    resume". Probed 2026-08-14 against 2.1.232: it does not.)
 * 2. What does `--resume` do against an id with no file? (exit 1, "No
 *    conversation found with session ID: …", and a `result` event.)
 * 3. What exactly does the collision say? (exit 1, "Error: Session ID … is
 *    already in use." on stderr, and nothing whatever on stdout.)
 *
 * Step 4 is skipped on a machine where step 1 wrote no file, which is the point
 * of it — to collide by hand, point `--session-id` at a session that has one.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CWD = join(process.cwd(), ".scratch", "resume-probe");
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

/** Claude Code's own naming: every non-ASCII-alphanumeric character folds to a
 *  dash. Mirrors `transcript_dir_name` in supervisor.rs. */
const slug = (p: string) =>
  Array.from(p, (ch) => (/[a-zA-Z0-9]/.test(ch) ? ch : "-")).join("");

const fileFor = (id: string) =>
  join(homedir(), ".claude", "projects", slug(CWD), `${id}.jsonl`);

mkdirSync(CWD, { recursive: true });

type Run = { code: number | null; out: string; err: string };

/** Spawn, hold an empty stdin open for `ms`, kill, and report what was said. */
async function run(args: string[], ms: number): Promise<Run> {
  const proc = Bun.spawn([CLAUDE, ...ARGV, ...args], {
    cwd: CWD,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const done = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exited = proc.exited;
  const timer = new Promise<void>((r) => setTimeout(r, ms));
  /* Whichever comes first: the child giving up, or our patience. */
  await Promise.race([exited, timer]);
  proc.kill();
  const [out, err] = await done;
  const code = await exited;
  return { code, out, err };
}

const show = (label: string, r: Run) => {
  console.log(`\n── ${label}`);
  console.log(`   exit ${r.code}`);
  for (const line of r.err.trim().split("\n").filter(Boolean).slice(0, 6))
    console.log(`   stderr: ${line.slice(0, 200)}`);
  for (const line of r.out.trim().split("\n").filter(Boolean).slice(0, 3))
    console.log(`   stdout: ${line.slice(0, 200)}`);
};

const report = (id: string) => {
  const f = fileFor(id);
  if (!existsSync(f)) return console.log(`   file: absent (${f})`);
  const body = readFileSync(f, "utf8");
  console.log(`   file: ${statSync(f).size} bytes, ${body.trim().split("\n").filter(Boolean).length} records`);
  for (const line of body.trim().split("\n").filter(Boolean).slice(0, 4))
    console.log(`     ${line.slice(0, 160)}`);
};

/* 1 — spawned, never spoken to. */
const quiet = crypto.randomUUID();
console.log(`\n=== 1. spawn with --session-id ${quiet}, say nothing ===`);
show("spawn", await run(["--session-id", quiet], 8000));
report(quiet);

/* 2 — resume that same id, whether or not it got a file. */
console.log(`\n=== 2. --resume ${quiet} (never spoke) ===`);
show("resume", await run(["--resume", quiet], 8000));

/* 3 — resume an id with no file anywhere. */
const nothing = crypto.randomUUID();
console.log(`\n=== 3. --resume ${nothing} (no such session) ===`);
show("resume", await run(["--resume", nothing], 8000));

/* 4 — the collision itself: --session-id against an id the CLI knows. Only
       run when step 1 actually produced a file to collide with. */
if (existsSync(fileFor(quiet))) {
  console.log(`\n=== 4. --session-id ${quiet} again (the collision) ===`);
  show("respawn", await run(["--session-id", quiet], 8000));
} else {
  console.log("\n=== 4. skipped — step 1 wrote no file to collide with ===");
}
