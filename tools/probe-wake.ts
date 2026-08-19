/* Does a background job's completion wake the agent by itself?
 *
 * Reads this machine's own transcripts rather than spawning anything. Every
 * `<task-notification>` is a `user` record; the question is what sits
 * immediately BEFORE it:
 *
 *   - a real prompt you typed, moments earlier  -> the notification was
 *     PIGGYBACKED, i.e. it only got delivered because you spoke first, and
 *     the agent was never autonomous at all.
 *   - an assistant/result record from a while ago -> the CLI INJECTED it on
 *     its own and the agent genuinely woke up.
 *
 * and what sits immediately after (did a turn actually follow?).
 *
 *   bun tools/probe-wake.ts                       # every project
 *   bun tools/probe-wake.ts rise                  # one project substring
 */

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(
  process.env.USERPROFILE ?? process.env.HOME ?? ".",
  ".claude",
  "projects",
);

const filter = process.argv[2]?.toLowerCase() ?? "";

type Rec = {
  ts: number;
  kind: string;
  notif: boolean;
  typed: boolean;
  preview: string;
};

/** Every .jsonl under a project dir, recursively. */
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

/** Flatten a record's content to plain text, whatever shape it arrived in. */
function textOf(msg: any): string {
  const c = msg?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b: any) =>
        typeof b === "string" ? b : (b?.text ?? b?.content ?? ""),
      )
      .map((x: any) => (typeof x === "string" ? x : JSON.stringify(x)))
      .join(" ");
  }
  return "";
}

/** Is this user record something a human actually typed? */
function isTyped(rec: any, text: string): boolean {
  if (rec?.type !== "user") return false;
  if (text.includes("task-notification")) return false;
  if (rec?.isMeta) return false;
  const c = rec?.message?.content;
  // A tool_result is a user record too, and is not a prompt.
  if (Array.isArray(c) && c.some((b: any) => b?.type === "tool_result"))
    return false;
  if (text.includes("Request interrupted by user")) return false;
  return text.trim().length > 0;
}

const files = walk(ROOT).filter((f) =>
  filter ? f.toLowerCase().includes(filter) : true,
);

let piggybacked = 0;
let autonomous = 0;
let woke = 0;
let silent = 0;
const gaps: number[] = [];
const samples: string[] = [];

for (const file of files) {
  let lines: string[];
  try {
    lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    continue;
  }
  if (!lines.some((l) => l.includes("task-notification"))) continue;

  const recs: Rec[] = [];
  for (const line of lines) {
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const text = textOf(rec?.message);
    recs.push({
      ts: Date.parse(rec?.timestamp ?? "") || 0,
      kind: rec?.type ?? "?",
      notif: rec?.type === "user" && text.includes("task-notification"),
      typed: isTyped(rec, text),
      preview: text.replace(/\s+/g, " ").slice(0, 90),
    });
  }

  for (let i = 0; i < recs.length; i++) {
    if (!recs[i].notif) continue;
    const prev = recs[i - 1];
    const next = recs[i + 1];

    // Walk back past other notifications batched with this one.
    let p = i - 1;
    while (p >= 0 && recs[p].notif) p--;
    const before = recs[p];

    const gap = before && recs[i].ts && before.ts ? (recs[i].ts - before.ts) / 1000 : -1;
    if (gap >= 0) gaps.push(gap);

    if (before?.typed && gap >= 0 && gap < 120) {
      piggybacked++;
      if (samples.length < 8) {
        samples.push(
          `  PIGGYBACKED  +${gap.toFixed(1)}s after you typed: "${before.preview}"`,
        );
      }
    } else {
      autonomous++;
      if (samples.length < 8) {
        samples.push(
          `  AUTONOMOUS   +${gap.toFixed(1)}s after a ${before?.kind} record`,
        );
      }
    }

    if (next?.kind === "assistant") woke++;
    else silent++;
  }
}

const total = piggybacked + autonomous;
console.log(`files scanned          ${files.length}`);
console.log(`task-notifications     ${total}`);
console.log("");
console.log(`preceded by your typed prompt (<120s)   ${piggybacked}`);
console.log(`arrived on their own                    ${autonomous}`);
console.log("");
console.log(`followed by an assistant turn           ${woke}`);
console.log(`followed by nothing / not a turn        ${silent}`);

if (gaps.length) {
  const sorted = [...gaps].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  console.log("");
  console.log(`gap before notification  median ${med.toFixed(1)}s  max ${sorted[sorted.length - 1].toFixed(0)}s`);
}
console.log("");
console.log(samples.join("\n"));
