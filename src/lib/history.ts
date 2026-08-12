/* The conversation as it exists on disk, folded into the same lines the live
 * stream produces.
 *
 * Why this file has to exist at all: `--resume` does not replay anything. Probed
 * against claude 2.1.228 by resuming a two-turn session with
 * `--output-format stream-json` — the wire carried `system/init`, the new
 * prompt, and the new answer, and nothing else. The history was in the model's
 * context (it answered from it) but never on stdout. The TUI shows scrollback
 * because it reads `~/.claude/projects/<slug>/<session>.jsonl` and renders it
 * locally, so Skein reads the same file.
 *
 * The transcript vocabulary is *not* the wire vocabulary, which is the whole
 * difficulty. Counted across the 97 transcripts on this machine (~84 MB):
 *
 *   assistant 13355 · user 7624 · ai-title 1936 · last-prompt 1918 · mode 1866
 *   attachment 1552 · permission-mode 1230 · file-history-snapshot 748
 *   system/turn_duration 707 · queue-operation 595 · file-history-delta 583
 *   system/away_summary 178 · system/local_command 71 · agent-name 58
 *   frame-link 7 · custom-title 7 · system/compact_boundary 5
 *
 * Only `user`, `assistant` and `compact_boundary` say anything a reader wants;
 * the rest is editor bookkeeping the TUI does not draw either.
 *
 * Pure on purpose — no runes, no invoke — so it is testable against real
 * transcripts. The `Line` import is type-only and erased at build, so nothing
 * from a `.svelte.ts` module is pulled in at runtime. */

import { clip, describeTool, textOf } from "./classify";
import type { Line } from "./conversation.svelte";

/** Enough scrollback to be worth having without folding a 4 MB transcript into
 *  the DOM. The live fold keeps 300; history keeps a little more because it is
 *  the part you scroll back through rather than watch. */
export const HISTORY_MAX_LINES = 400;

export type History = {
  lines: Line[];
  /** Lines folded and then dropped off the front to respect the cap. */
  dropped: number;
  /** The reader handed us a tail rather than the whole file. */
  partial: boolean;
};

/** Drop the tail of `history` that the live stream has already shown.
 *
 * Reading now happens as the wall loads rather than on a click, which opens a
 * narrow race: wake a card while its file is still being read, and the turn you
 * just started can reach the transcript before the read does — so the same
 * prompt arrives twice, once off disk and once off the wire. The wire is the
 * authority for anything it carried, so history is cut at the first line the
 * live fold also has. */
export function trimOverlap(history: Line[], live: Line[]): Line[] {
  const first = live[0];
  if (!first) return history;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].kind === first.kind && history[i].text === first.text) {
      return history.slice(0, i);
    }
  }
  return history;
}

const tokens = (n: unknown): string =>
  typeof n === "number" && n > 0 ? `${Math.round(n / 1000)}k` : "?";

/** Fold a transcript's NDJSON into transcript lines.
 *
 * Mirrors `Conversation.ingest` deliberately: same four line kinds, same
 * `describeTool` prose, thinking dropped, tool results dropped. History that
 * renders differently from live text would put a visible seam in the middle of
 * one column of speech the moment a card wakes. */
export function foldTranscript(
  text: string,
  opts: { max?: number; partial?: boolean } = {},
): History {
  const max = opts.max ?? HISTORY_MAX_LINES;
  const lines: Line[] = [];
  const push = (kind: Line["kind"], t: string) => {
    if (t.trim()) lines.push({ kind, text: t });
  };

  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(raw);
    } catch {
      /* A transcript is appended to while we read it, so the last line is
         routinely half-written. Not worth surfacing. */
      continue;
    }

    /* A subagent's own turns. The live card collapses these into seats and
       leaves one line behind when the arc closes, so replaying them here would
       show a card's history as mostly other agents talking. */
    if (rec.isSidechain === true) continue;

    /* `isMeta` is context Claude Code injected, not anything anybody said:
       local-command caveats, skill preambles, "Continue from where you left
       off.", image dimension notes. Sampled 12 of the 59 on this machine and
       every one was injected. The TUI does not draw them either. */
    if (rec.isMeta === true) continue;

    switch (rec.type) {
      case "user": {
        /* Compaction rewrites the conversation as a summary addressed to the
           agent. Showing it whole would drop a wall of text in the middle of
           the column; showing nothing would silently lose the discontinuity —
           so it is marked, and clipped. */
        if (rec.isCompactSummary === true) {
          push("meta", `earlier turns summarised — ${clip(textOf(rec.message?.content), 240)}`);
          break;
        }
        /* Two shapes, both real: the TUI writes a bare string (877 records
           here) and the SDK — which is how Skein speaks — writes a text block
           (67). `textOf` already takes both, and returns "" for the tool-result
           records that make up the bulk of the `user` type. */
        push("you", textOf(rec.message?.content));
        break;
      }

      case "assistant": {
        for (const block of rec.message?.content ?? []) {
          if (block?.type === "text") push("text", block.text ?? "");
          else if (block?.type === "tool_use") {
            push("tool", describeTool(block.name, block.input));
          }
          /* thinking blocks are dropped, as they are live */
        }
        break;
      }

      case "system": {
        if (rec.subtype !== "compact_boundary") break;
        const m = rec.compactMetadata;
        push(
          "meta",
          `context compacted · ${tokens(m?.preTokens)} → ${tokens(m?.postTokens)}`,
        );
        break;
      }

      default:
        break;
    }
  }

  const dropped = Math.max(0, lines.length - max);
  return {
    lines: dropped ? lines.slice(-max) : lines,
    dropped,
    partial: opts.partial ?? false,
  };
}
