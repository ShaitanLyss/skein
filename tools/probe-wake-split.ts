/* Is the never-dequeued task-notification a `--print`-mode thing, or does the
 * CLI do it everywhere?
 *
 * Splits every transcript carrying a `<task-notification>` by whether Skein
 * spawned it — `conversation.agent_session_id` in Skein's own store is the
 * transcript's filename — and reports the queue outcome for each side.
 *
 * If Skein-spawned sessions never dequeue and the others do, the difference is
 * how Skein spawns `claude`. If neither side ever dequeues, it is the CLI's
 * behaviour everywhere and Skein is not the cause.
 *
 * Caveat this cannot get around: the store holds each card's CURRENT session
 * id, so a card that was cleared, or a session Skein has since forgotten, reads
 * as "not Skein" here. The Skein column is therefore a floor, and the
 * comparison only means something if the "other" column is large.
 *
 *   bun tools/probe-wake-split.ts
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

const db = new Database(STORE, { readonly: true });
const skeinIds = new Set<string>(
  db
    .query("select agent_session_id from conversation where agent_session_id is not null")
    .all()
    .map((r: any) => String(r.agent_session_id).toLowerCase()),
);
console.log(`skein knows ${skeinIds.size} session ids`);

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

type Tally = {
  files: number;
  enqueue: number;
  dequeue: number;
  remove: number;
  notifRecords: number;
  woke: number;
};
const blank = (): Tally => ({
  files: 0,
  enqueue: 0,
  dequeue: 0,
  remove: 0,
  notifRecords: 0,
  woke: 0,
});
const mine = blank();
const other = blank();

for (const file of walk(ROOT)) {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (!raw.includes("task-notification")) continue;

  const id = basename(file, ".jsonl").toLowerCase();
  const t = skeinIds.has(id) ? mine : other;
  t.files++;

  const lines = raw.split("\n").filter(Boolean);
  let prevWasNotif = false;
  for (const line of lines) {
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }

    if (rec?.type === "queue-operation") {
      const isNotif = String(rec.content ?? "").includes("task-notification");
      if (!isNotif) continue;
      if (rec.operation === "enqueue") t.enqueue++;
      else if (rec.operation === "dequeue") t.dequeue++;
      else if (rec.operation === "remove") t.remove++;
      continue;
    }

    // Did an assistant turn actually follow a notification record?
    if (prevWasNotif && rec?.type === "assistant") t.woke++;

    const c = rec?.message?.content;
    const text =
      typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c.map((b: any) => b?.text ?? "").join(" ")
          : "";
    prevWasNotif = rec?.type === "user" && text.includes("task-notification");
    if (prevWasNotif) t.notifRecords++;
  }
}

function show(name: string, t: Tally) {
  const pct = t.notifRecords ? ((t.woke / t.notifRecords) * 100).toFixed(0) : "-";
  console.log("");
  console.log(`--- ${name} ---`);
  console.log(`  transcripts               ${t.files}`);
  console.log(`  notification enqueue      ${t.enqueue}`);
  console.log(`  notification dequeue      ${t.dequeue}`);
  console.log(`  notification remove       ${t.remove}`);
  console.log(`  notification records      ${t.notifRecords}`);
  console.log(`  ...followed by a turn     ${t.woke}  (${pct}%)`);
}

show("SKEIN-SPAWNED", mine);
show("EVERYTHING ELSE", other);
