/* Skein's own slash commands: what exists, and what a half-typed draft means.
 *
 * Pure, so the vocabulary can be tested without a dock in the way — the
 * component turns a chosen command into calls, and never decides what a draft
 * matches. Same split as ./menu.ts.
 *
 * The load-bearing rule here is what this file does *not* claim. `claude` has
 * slash commands of its own — the ones in `.claude/commands/`, and the built-ins
 * — and they work in `--print` mode, so a prompt beginning with `/` is perfectly
 * ordinary traffic. Skein therefore intercepts only the names it knows and lets
 * everything else through verbatim: `/commit` is the project's command and must
 * reach the agent unread. Swallowing unknown commands would silently break every
 * custom command anybody has written, and the failure would look like the agent
 * ignoring them. */

export type Command = {
  /** Typed after the slash. Lowercase, no spaces. */
  name: string;
  /** One line, lowercase, in the dock's voice. */
  summary: string;
  /** What it will actually do, shown on the highlighted entry only. */
  detail: string;
  /** Needs something to act on — every command so far does. */
  needsCard: true;
};

/* Adding a command is one entry here plus one arm where the dock runs them.
   Keep the summaries short enough to read at a glance and the details honest
   about what is lost. */
export const COMMANDS: Command[] = [
  {
    name: "clear",
    summary: "start this card fresh",
    detail:
      "a new session in the same place — the old one stays on disk and can be adopted back",
    needsCard: true,
  },
];

/** Does this draft even look like a command? Leading whitespace says no: a
 *  line that begins with a space is prose that happens to contain a slash. */
const SLASH = /^\/([a-z][a-z0-9-]*)?/i;

/** The name being typed, while it is still only a name.
 *
 *  Null once there is a space, because by then the choosing is over — the
 *  palette is for picking a command, not for hovering over one you have already
 *  picked and are now writing arguments for. */
export function typingName(draft: string): string | null {
  const m = /^\/([a-z0-9-]*)$/i.exec(draft);
  return m ? m[1].toLowerCase() : null;
}

/** What the palette should offer for this draft, in the order to show it.
 *
 *  Empty for anything that is not a bare slash-name — which is also how an
 *  unknown command disappears quietly: `/commit` matches nothing here, no
 *  palette opens, and Enter sends it to the agent like any other prompt. */
export function matchCommands(draft: string): Command[] {
  const name = typingName(draft);
  if (name === null) return [];
  if (!name) return [...COMMANDS];
  const starts = COMMANDS.filter((c) => c.name.startsWith(name));
  /* Prefix first, then anything merely containing it, so `/ear` still finds
     `clear` without letting it outrank a real prefix match. */
  const rest = COMMANDS.filter(
    (c) => !c.name.startsWith(name) && c.name.includes(name),
  );
  return [...starts, ...rest];
}

/** The Skein command this draft *is*, if any — the test `send` applies before
 *  handing a prompt to the agent.
 *
 *  Exact and whole: `/clear` is ours, `/clearing` is not, and `/clear the deck`
 *  is not either. No command takes arguments yet, and one that did would need
 *  to say so here rather than have this quietly ignore the tail. */
export function resolveCommand(draft: string): Command | null {
  const m = SLASH.exec(draft);
  if (!m) return null;
  const name = draft.slice(1).trim().toLowerCase();
  return COMMANDS.find((c) => c.name === name) ?? null;
}

/** What Tab puts in the field: the whole name, ready for Enter. */
export function completionFor(cmd: Command): string {
  return `/${cmd.name}`;
}
