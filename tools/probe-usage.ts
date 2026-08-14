/* What the usage widget would say, computed here instead of in the app.
 *
 * `usage.rs` cannot be run on a machine with no MSVC toolchain (see CLAUDE.md),
 * and the pure module's tests are all synthetic. So this walks the real
 * transcripts under the same rules Rust does — dedup by `message.id` +
 * `requestId`, five-minute buckets, drop synthetic models — and hands the result
 * to the real `usage.ts`. It proves two things a unit test cannot: that the
 * rules match the files as they actually are, and that the numbers that come
 * out are the size a person would expect.
 *
 *   bun tools/probe-usage.ts
 *   bun tools/probe-usage.ts --raw     # the dedup's effect, spelled out
 *
 * Read-only. It opens no process and writes nothing. */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BLOCK_MS,
  HOUR,
  WEEK_MS,
  amount,
  blocks,
  count,
  leaders,
  left,
  money,
  readings,
  say,
  shortModel,
  sum,
  rateFor,
  type Measure,
  type Slice,
} from "../src/lib/usage";

const BUCKET_MS = 5 * 60 * 1000;
const KEEP_MS = 8 * 24 * HOUR;
const raw = process.argv.includes("--raw");

const root = join(homedir(), ".claude", "projects");
const now = Date.now();
const cutoff = now - KEEP_MS;

type Key = string;
const totals = new Map<Key, Slice>();
const seen = new Set<string>();
let lines = 0;
let assistants = 0;
let counted = 0;
let dropped = 0;
let filesRead = 0;
let filesSkipped = 0;
let bytes = 0;

function bucketOf(at: number, model: string): Slice {
  const at5 = at - (at % BUCKET_MS);
  const key = `${at5}|${model}`;
  let s = totals.get(key);
  if (!s) {
    s = { at: at5, model, input: 0, output: 0, cacheRead: 0, write5m: 0, write1h: 0 };
    totals.set(key, s);
  }
  return s;
}

/* The same recursive walk `usage.rs::transcripts` makes, and for the same
   reason: subagent transcripts live a level below the session that spawned
   them (`<slug>/<session>/subagents/agent-*.jsonl`) and a two-level walk
   silently misses every Task-tool turn. */
async function transcripts(dir: string, depth = 0): Promise<string[]> {
  if (depth > 5) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await transcripts(p, depth + 1)));
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

{
  for (const path of await transcripts(root)) {
    const meta = await stat(path);
    /* The same skip Rust makes on a file it has never opened: nothing modified
       before the window can hold anything inside it. */
    if (meta.mtimeMs < cutoff) {
      filesSkipped++;
      continue;
    }
    filesRead++;
    bytes += meta.size;

    const text = await readFile(path, "utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      lines++;
      if (!line.includes('"type":"assistant"')) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec?.type !== "assistant") continue;
      const usage = rec.message?.usage;
      if (!usage) continue;
      const at = Date.parse(rec.timestamp ?? "");
      if (!Number.isFinite(at) || at < cutoff) continue;
      const model: string = rec.message?.model ?? "";
      if (!model || model.startsWith("<")) continue;
      assistants++;

      const key = `${rec.message?.id ?? rec.uuid ?? ""}|${rec.requestId ?? ""}`;
      if (seen.has(key)) {
        dropped++;
        if (!raw) continue;
      } else {
        seen.add(key);
      }
      counted++;

      const s = bucketOf(at, model);
      const c = usage.cache_creation;
      const w5 = c?.ephemeral_5m_input_tokens ?? 0;
      const w1 = c?.ephemeral_1h_input_tokens ?? 0;
      s.input += usage.input_tokens ?? 0;
      s.output += usage.output_tokens ?? 0;
      s.cacheRead += usage.cache_read_input_tokens ?? 0;
      if (w5 + w1 > 0) {
        s.write5m += w5;
        s.write1h += w1;
      } else {
        s.write5m += usage.cache_creation_input_tokens ?? 0;
      }
    }
  }
}

const slices = [...totals.values()].sort((a, b) => a.at - b.at);

console.log(`\n  ${raw ? "WITHOUT DEDUP — every record counted" : "as the widget reads it"}`);
console.log(`  ${"─".repeat(58)}`);
console.log(`  files read              ${filesRead} (${(bytes / 1e6).toFixed(1)} MB)`);
console.log(`  files skipped, too old  ${filesSkipped}`);
console.log(`  lines scanned           ${lines.toLocaleString()}`);
console.log(`  assistant records       ${assistants.toLocaleString()}`);
console.log(`  requests counted        ${counted.toLocaleString()}`);
console.log(
  `  duplicate blocks        ${dropped.toLocaleString()}` +
    (assistants ? `  (${((dropped / assistants) * 100).toFixed(0)}% of records)` : ""),
);
console.log(`  buckets                 ${slices.length.toLocaleString()}`);

const all = sum(slices, cutoff, now + 1);
console.log(`\n  the whole ${(KEEP_MS / 24 / HOUR).toFixed(0)} days`);
console.log(`  ${"─".repeat(58)}`);
for (const [k, v] of [
  ["input", all.input],
  ["output", all.output],
  ["cache read", all.cacheRead],
  ["cache write 5m", all.write5m],
  ["cache write 1h", all.write1h],
] as const) {
  console.log(`  ${k.padEnd(22)} ${count(v).padStart(8)}`);
}
console.log(`  ${"cost".padEnd(22)} ${money(all.usd).padStart(8)}`);
if (all.unpriced > 0) {
  console.log(`  ${"unpriced tokens".padEnd(22)} ${count(all.unpriced).padStart(8)}`);
}

/* Where the money actually goes, kind by kind. This is the answer to "does the
   cost take cache into account" and the reason it has to: cache is the large
   majority of the bill, so a reading that skipped it would not be slightly low,
   it would be an order of magnitude out. Each kind is re-priced here from the
   same rate table `usage.ts` uses, so a disagreement between this and the `cost`
   line above would mean the two had drifted. */
const week = sum(slices, now - WEEK_MS, now + 1);
const kinds = [
  ["input", week.input, (r: number) => r],
  ["output", week.output, (_r: number, o: number) => o],
  ["cache read", week.cacheRead, (r: number) => r * 0.1],
  ["cache write 5m", week.write5m, (r: number) => r * 1.25],
  ["cache write 1h", week.write1h, (r: number) => r * 2],
] as const;
/* One blended input rate for the week, so the split adds up to the same total
   even on a wall that used more than one model. */
const blend = (() => {
  let tok = 0;
  let usd = 0;
  for (const l of leaders(slices, now - WEEK_MS, now + 1, "tokens")) {
    const rate = rateFor(l.model);
    if (!rate) continue;
    tok += l.amount;
    usd += l.amount * rate.input;
  }
  return tok ? usd / tok : 0;
})();
const outBlend = (() => {
  let tok = 0;
  let usd = 0;
  for (const l of leaders(slices, now - WEEK_MS, now + 1, "tokens")) {
    const rate = rateFor(l.model);
    if (!rate) continue;
    tok += l.amount;
    usd += l.amount * rate.output;
  }
  return tok ? usd / tok : 0;
})();

console.log(`\n  past 7 days — where the ${money(week.usd)} goes`);
console.log(`  ${"─".repeat(58)}`);
let cache = 0;
for (const [name, tok, per] of kinds) {
  const usd = (tok * per(blend, outBlend)) / 1e6;
  if (name.startsWith("cache")) cache += usd;
  const pct = week.usd ? ((usd / week.usd) * 100).toFixed(1) : "0.0";
  console.log(
    `  ${name.padEnd(16)} ${count(tok).padStart(7)} tok  ${money(usd).padStart(7)}  ${pct.padStart(5)}%`,
  );
}
console.log(`  ${"─".repeat(58)}`);
console.log(
  `  cache, all three kinds:  ${money(cache)}` +
    (week.usd ? `  = ${((cache / week.usd) * 100).toFixed(0)}% of the bill` : ""),
);

/* The reading itself, at both measures — the thing the face draws. */
for (const measure of ["cost", "tokens"] as Measure[]) {
  const r = readings(slices, now, measure);
  console.log(`\n  as the face draws it — ${measure}`);
  console.log(`  ${"─".repeat(58)}`);
  for (const row of [r.block, r.week]) {
    const n = say(amount(row.totals, measure), measure);
    const against = row.against
      ? `${(row.frac * 100).toFixed(0)}% of ${row.against.said} (${say(row.against.amount, measure)})`
      : "nothing to compare against";
    console.log(`  ${row.said.padEnd(18)} ${n.padStart(8)}   ${against}`);
  }
  console.log(
    `  ${"rolls over".padEnd(18)} ${(r.block.resetsIn === null ? "rested" : left(r.block.resetsIn)).padStart(8)}`,
  );
}

console.log(`\n  where the week went`);
console.log(`  ${"─".repeat(58)}`);
for (const l of leaders(slices, now - WEEK_MS, now + 1, "cost")) {
  const pct = ((l.amount / (readings(slices, now, "cost").week.totals.usd || 1)) * 100).toFixed(0);
  console.log(`  ${shortModel(l.model).padEnd(22)} ${money(l.amount).padStart(8)}  ${pct}%`);
}

const bs = blocks(slices).filter((b) => b.from >= now - WEEK_MS);
console.log(`\n  ${bs.length} five-hour blocks in the past week`);
console.log(`  ${"─".repeat(58)}`);
for (const b of bs.slice(-8)) {
  const t = sum(slices, b.from, b.to);
  const open = b.to > now ? " ← open" : "";
  console.log(
    `  ${new Date(b.from).toISOString().slice(0, 16).replace("T", " ")}` +
      `  ${money(t.usd).padStart(7)}  ${count(t.tokens).padStart(7)}${open}`,
  );
}
console.log(`\n  (a block is ${BLOCK_MS / HOUR} hours from the hour it opened)\n`);
