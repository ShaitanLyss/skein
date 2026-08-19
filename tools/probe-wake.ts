/* Does a background job's completion wake the agent by itself?
 *
 * Reads this machine's own transcripts rather than spawning anything.
 *
 * THE MEASUREMENT THIS GETS WRONG IF DONE NAIVELY. Notifications arrive in
 * BATCHES — three jobs land together and the CLI writes three `user` records in
 * the same second — and the transcript is also full of bookkeeping records
 * (`ai-title`, `mode`, `last-prompt`, `file-history-snapshot`, `attachment`,
 * `queue-operation`) that sit between anything and anything. So "did an
 * assistant record immediately follow this notification" answers NO for every
 * notification but the last in its batch, and NO again whenever a title got
 * written in between. The first version of this probe did exactly that and
 * reported ~50% of notifications waking nobody, which is not true.
 *
 * What is asked here instead: collapse a run of consecutive notifications into
 * one event, skip the bookkeeping, and look at the first record that is
 * actually a turn or a prompt.
 *
 *   woken     — an assistant turn follows, with nothing typed in between
 *   prompted  — a typed prompt got there first, so we cannot claim it woke
 *   silent    — neither, within the window
 *
 *   bun tools/probe-wake.ts             # every project
 *   bun tools/probe-wake.ts rise        # one project substring
 */

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { Database } from "bun:sqlite";

const STORE =
  "C:/Users/lyss.delprat/AppData/Roaming/dev.skein.studio/skein.db";
const ROOT = join(
  process.env.USERPROFILE ?? process.env.HOME ?? ".",
  ".claude",
  "projects",
);
const filter = process.argv[2]?.toLowerCase() ?? "";

/** How long after a batch we still credit a turn to it. */
const WINDOW_S = 300;

/* Records the CLI writes for its own bookkeeping. None of them is speech and
   none is a prompt, so none may end the search for what answered. */
const SKIP = new Set([
  "ai-title",
  "mode",
  "last-prompt",
  "file-history-snapshot",
  "attachment",
  "queue-operation",
  "system",
]);

let skeinIds = new Set<string>();
try {
  const db = new Database(STORE, { readonly: true });
  skeinIds = new Set(
    db
      .query("select agent_session_id from conversation where agent_session_id is not null")
      .all()
      .map((r: any) => String(r.agent_session_id).toLowerCase()),
  );
} catch {
  /* no store on this machine — the MCP witness below still splits them */
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (e.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function textOf(msg: any): string {
  const c = msg?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b: any) => (typeof b === "string" ? b : (b?.text ?? b?.content ?? "")))
      .map((x: any) => (typeof x === "string" ? x : JSON.stringify(x)))
      .join(" ");
  }
  return "";
}

/** Is this user record something a person actually typed? */
function isTyped(rec: any, text: string): boolean {
  if (rec?.type !== "user") return false;
  if (text.includes("task-notification")) return false;
  if (rec?.isMeta) return false;
  const c = rec?.message?.content;
  if (Array.isArray(c) && c.some((b: any) => b?.type === "tool_result")) return false;
  if (text.includes("Request interrupted by user")) return false;
  return text.trim().length > 0;
}

type Tally = { files: number; batches: number; woken: number; prompted: number; silent: number; delays: number[] };
const blank = (): Tally => ({ files: 0, batches: 0, woken: 0, prompted: 0, silent: 0, delays: [] });
const mine = blank();
const other = blank();

for (const file of walk(ROOT)) {
  if (filter && !file.toLowerCase().includes(filter)) continue;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (!raw.includes("task-notification")) continue;

  const id = basename(file, ".jsonl").toLowerCase();
  const t = skeinIds.has(id) || raw.includes("mcp__skein__") ? mine : other;
  t.files++;

  const recs = raw
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map((r: any) => {
      const text = textOf(r.message);
      return {
        raw: r,
        kind: r.type as string,
        ts: Date.parse(r.timestamp ?? "") || 0,
        notif: r.type === "user" && text.includes("task-notification"),
        typed: isTyped(r, text),
      };
    });

  for (let i = 0; i < recs.length; i++) {
    if (!recs[i].notif) continue;
    /* Collapse the batch: three jobs landing together are one event, and only
       the last of them could ever have an answer immediately after it. */
    let end = i;
    while (end + 1 < recs.length && recs[end + 1].notif) end++;
    const at = recs[end].ts;
    t.batches++;

    let verdict: "woken" | "prompted" | "silent" = "silent";
    for (let j = end + 1; j < recs.length; j++) {
      const r = recs[j];
      if (SKIP.has(r.kind)) continue;
      if (r.notif) continue;
      if (at && r.ts && (r.ts - at) / 1000 > WINDOW_S) break;
      if (r.kind === "assistant") {
        verdict = "woken";
        if (at && r.ts) t.delays.push((r.ts - at) / 1000);
        break;
      }
      if (r.typed) {
        verdict = "prompted";
        break;
      }
      /* tool_result and other user records are part of a turn already under
         way; keep looking rather than calling it silent. */
    }
    t[verdict]++;
    i = end;
  }
}

function show(name: string, t: Tally) {
  const pct = (n: number) => (t.batches ? ((n / t.batches) * 100).toFixed(0) + "%" : "-");
  const d = [...t.delays].sort((a, b) => a - b);
  console.log("");
  console.log(`--- ${name} ---`);
  console.log(`  transcripts            ${t.files}`);
  console.log(`  notification batches   ${t.batches}`);
  console.log(`  woken on its own       ${t.woken}  (${pct(t.woken)})`);
  console.log(`  a prompt got there 1st ${t.prompted}  (${pct(t.prompted)})`);
  console.log(`  silent                 ${t.silent}  (${pct(t.silent)})`);
  if (d.length) {
    console.log(`  wake delay  median ${d[Math.floor(d.length / 2)].toFixed(1)}s  max ${d[d.length - 1].toFixed(0)}s`);
  }
}

show("SKEIN-SPAWNED", mine);
show("TERMINAL", other);
