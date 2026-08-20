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
 * ignoring them.
 *
 * `by` is how that rule survived the second batch of commands. `/clear` and
 * `/rename` are Skein's: there is nothing on the wire that does either — a card
 * is this window's idea and so is what it is called — so this window does them
 * itself. `/compact`, `/model` and `/effort` are the *CLI's*, and Skein does not
 * carry them out at all — it offers them, completes them, and then sends the
 * text you typed as the prompt it always was. So the palette became a way to
 * *find* the commands the agent already answers, without this file taking
 * custody of a single one of them.
 *
 * `/resume` is Skein's for the same reason `/clear` is, and the probe below is
 * why rather than the argument being made twice: the CLI's own `/resume` is a
 * picker drawn by its TUI and it refuses the request outright down this pipe,
 * exactly as `/rewind` does. Sending it would put "isn't available in this
 * environment" in the transcript of a card that has a perfectly good way to do
 * the thing — the sessions on disk are already read here, for the adoption
 * panel — so this window answers it.
 *
 * Probed 2026-08-14 against claude 2.1.232 with `tools/probe-commands.ts`,
 * spawning with Skein's exact argv and sending each as a `user` message:
 *
 *   /compact       system/status "compacting", then a status carrying
 *                  compact_result, then a fresh system/init and a result
 *   /model sonnet  result.result "Set model to Sonnet 5 for this session only"
 *   /effort high   result.result "Set effort level to high (this session only)…"
 *   /rewind        result.result "/rewind isn't available in this environment."
 *   /resume        result.result "/resume isn't available in this environment."
 *
 * The same probe asked the other route — a `control_request` on stdin — and got
 * `Unsupported control request subtype` for `compact`, `rewind` and `set_effort`.
 * `set_model` *is* on that route and succeeds, and is deliberately not used:
 * sending the text puts a line in the transcript saying what you did, where a
 * control message changes the model with nothing to show for it. */

/** One of a command's fixed values, offered the way the commands are. */
export type Choice = {
  /** Typed after the name. */
  value: string;
  /** One line, lowercase, in the dock's voice. */
  summary: string;
};

export type Command = {
  /** Typed after the slash. Lowercase, no spaces. */
  name: string;
  /** One line, lowercase, in the dock's voice. */
  summary: string;
  /** What it will actually do, shown on the highlighted entry only. */
  detail: string;
  /** Does it act on the cards the dock is pointed at?
   *
   *  True for every command that was here first, and the flag existed as the
   *  literal `true` because of it. `/resume` is the first one that acts on the
   *  *wall* instead — it opens the catalogue of sessions on disk, which is the
   *  same catalogue whatever card you happen to be looking at. So it is not
   *  refused on an empty gathering, and it does not cost the reach modifier: a
   *  gesture that reaches nothing cannot reach five things, and charging
   *  Ctrl+Enter for it would be friction scaled to a number that is always
   *  one. */
  needsCard: boolean;
  /** Who carries it out: this window, or the `claude` at the other end of
   *  stdin. A `cli` command is sent as the prompt it is; Skein only helps you
   *  type it, and never intercepts it. */
  by: "skein" | "cli";
  /** The values it takes, when they are a fixed set. A command with choices is
   *  incomplete until it has one, so Enter on it opens the values rather than
   *  running anything. */
  choices?: Choice[];
  /** It puts something up to choose from rather than doing a thing.
   *
   *  Only for the dock to draw with: the palette's ellipsis is the menus' own
   *  convention for a gesture that opens something further, and it is the whole
   *  of what tells you `/resume` is about to offer you a list rather than resume
   *  something. Deliberately not derived from `needsCard` — a command that acts
   *  on no card is not thereby one that opens a panel, and reading one off the
   *  other would make the ellipsis appear on the next such command by accident.
   *  `choices` implies it and does not need it: those values are drawn by this
   *  same palette, one stage on. */
  opens?: boolean;
  /** It takes the rest of the line, as prose. The other half of `choices` and
   *  never both: one is a set to pick from and the other is something only you
   *  can supply, so the palette offers the values for the first and closes at
   *  the space for the second.
   *
   *  A command without it is exact and whole — `/clear the deck` is a sentence
   *  and goes to the agent. Incomplete without it, the same way `/model` is:
   *  `/rename` alone names nothing. */
  takesText?: boolean;
};

/* The models `--model` takes as aliases, read out of the 2.1.232 binary
   (`opus`, `opus[1m]`, `sonnet`, `sonnet[1m]`, `haiku`, `fable`, `opusplan`).
   The `[1m]` pair earn their place on this wall in particular: the context ring
   is drawn against the window tier, and switching to one is the gesture for a
   card that is running out of room. `opusplan` is left off — it is plan mode's
   upgrade model, and every card here spawns with permissions bypassed. */
const MODELS: Choice[] = [
  { value: "opus", summary: "the most capable, 200k of room" },
  { value: "opus[1m]", summary: "the same model with a million tokens of room" },
  { value: "sonnet", summary: "quicker and cheaper, 200k of room" },
  { value: "sonnet[1m]", summary: "quicker, with a million tokens of room" },
  { value: "haiku", summary: "fastest and cheapest — for small, mechanical work" },
  { value: "fable", summary: "the newest family" },
];

/* `--effort <level>` names these five, and the CLI's own answer describes the
   level it set ("Comprehensive implementation with extensive testing and
   documentation" for high). The summaries here say what you are buying rather
   than repeat the level's name back. */
const EFFORTS: Choice[] = [
  { value: "low", summary: "answer briefly, and stop" },
  { value: "medium", summary: "the usual amount of thinking" },
  { value: "high", summary: "think it through, test it, write it down" },
  { value: "xhigh", summary: "more of that, and slower" },
  { value: "max", summary: "everything it has" },
];

/* Adding a command is one entry here plus one arm where the dock runs them —
   or no arm at all, if it is the CLI's. Keep the summaries short enough to read
   at a glance and the details honest about what is lost. */
export const COMMANDS: Command[] = [
  {
    name: "compact",
    summary: "fold this context into a summary",
    detail:
      "the agent keeps a summary of what has happened and drops the rest — the transcript on this wall is untouched",
    needsCard: true,
    by: "cli",
  },
  {
    name: "model",
    summary: "change which model this card talks to",
    detail: "this session only, taking effect on the next turn",
    needsCard: true,
    by: "cli",
    choices: MODELS,
  },
  {
    name: "effort",
    summary: "how hard to think about it",
    detail: "this session only, taking effect on the next turn",
    needsCard: true,
    by: "cli",
    choices: EFFORTS,
  },
  {
    name: "rename",
    summary: "call this card something else",
    detail:
      "the name you give it stands — Claude Code's generated title stops replacing it",
    needsCard: true,
    by: "skein",
    takesText: true,
  },
  {
    name: "clear",
    summary: "start this card fresh",
    detail:
      "a new session in the same place — the old one stays on disk and can be adopted back",
    needsCard: true,
    by: "skein",
  },
  {
    name: "resume",
    summary: "put a recorded session back on the wall",
    detail:
      "every conversation Claude Code has on disk here — closed cards, cleared ones, and anything a terminal started — offered as a card to adopt",
    needsCard: false,
    by: "skein",
    opens: true,
  },
];

/** The name being typed, while it is still only a name.
 *
 *  Null once there is a space, because by then the choosing of a *name* is
 *  over. What happens after that space is `typingChoice`'s question. */
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

/** The named command, exactly.
 *
 *  Case-folded, since the palette completes in lowercase but nothing stops you
 *  typing it yourself. */
function byName(name: string): Command | null {
  const want = name.trim().toLowerCase();
  return COMMANDS.find((c) => c.name === want) ?? null;
}

/** A command whose name is settled and whose *value* is being typed.
 *
 *  This is the one place the "palette closes at the first space" rule bends,
 *  and it bends rather than breaks: that rule is there because the palette is
 *  for choosing, and a command left picking over free text would be claiming a
 *  choice is still to be made. A command with a fixed set of values has not
 *  finished being chosen at the space — `/model` alone is not a thing that can
 *  be run — so the palette stays up and offers the values. `/compact`, whose
 *  argument is prose, closes it as everything did before.
 *
 *  Null past the second space, for the original reason: by then the value has
 *  been picked too. */
export function typingChoice(
  draft: string,
): { cmd: Command; part: string } | null {
  const m = /^\/([a-z0-9-]+) ([^\s]*)$/i.exec(draft);
  if (!m) return null;
  const cmd = byName(m[1]);
  if (!cmd?.choices) return null;
  return { cmd, part: m[2].toLowerCase() };
}

/** What the palette should offer once a command with values is named. */
export function matchChoices(draft: string): Choice[] {
  const at = typingChoice(draft);
  if (!at) return [];
  const all = at.cmd.choices ?? [];
  if (!at.part) return [...all];
  const starts = all.filter((c) => c.value.startsWith(at.part));
  const rest = all.filter(
    (c) => !c.value.startsWith(at.part) && c.value.includes(at.part),
  );
  return [...starts, ...rest];
}

/** A Skein command and what it was given. */
export type Resolved = {
  cmd: Command;
  /** Whitespace-trimmed, empty for a command that takes nothing. */
  arg: string;
};

/** The Skein command this draft *is*, if any — the test `send` applies before
 *  handing a prompt to the agent.
 *
 *  Exact and whole unless the command says otherwise: `/clear` is ours,
 *  `/clearing` is not, and `/clear the deck` is not either — reading `/clear`
 *  out of that would throw away the rest of what was typed. A `takesText`
 *  command inverts exactly that clause and nothing else, so `/rename the auth
 *  work` is ours and carries its argument, while a bare `/rename` is not: it
 *  names nothing, and a command that cannot be carried out must fall through
 *  rather than be swallowed.
 *
 *  Only ever a `skein` command, and that is the point rather than a filter: a
 *  `cli` command has nothing here to run, because carrying it out *is* sending
 *  it, so it must fall through to the ordinary prompt path exactly as
 *  `/commit` does.
 *
 *  The name and the argument come out of one parse rather than two, so nothing
 *  can decide this is `/rename` and then disagree about where the name starts. */
export function resolveCommand(draft: string): Resolved | null {
  /* Anchored rather than trimmed at the front, because leading whitespace says
     prose: a line beginning with a space is a sentence that happens to contain
     a slash. Trailing whitespace is nothing of the kind, hence `\s*$` — a
     `/clear ` is the command with a stray space after it. */
  const m = /^\/([a-z0-9-]+)(?:\s+([\s\S]+?))?\s*$/i.exec(draft);
  if (!m) return null;
  const cmd = byName(m[1]);
  if (cmd?.by !== "skein") return null;
  /* Trimmed rather than trusted to the pattern, which gets this wrong on its
     own: the lazy group hands back a single space for `/rename    `, and an
     argument of one space is a command that resolves, swallows the draft and
     renames nothing — where the rule is that anything Skein cannot carry out
     falls through to the agent as the words it is. */
  const arg = (m[2] ?? "").trim();
  if (cmd.takesText) return arg ? { cmd, arg } : null;
  return arg ? null : { cmd, arg: "" };
}

/** Is this prompt one of the CLI's own commands rather than something said?
 *
 *  Nothing is intercepted on the strength of this — the text goes out either
 *  way. It answers the two questions where the *difference* shows: an unnamed
 *  card must not end up called `compact`, and the card face must not preview
 *  that name while you type it. A card is named after the first thing you say
 *  to the agent, and `/model sonnet` is not said to the agent at all.
 *
 *  Tolerant of an argument, unlike `resolveCommand`, since that is the shape
 *  every one of these has. */
export function cliCommand(text: string): Command | null {
  const m = /^\/([a-z0-9-]+)(\s|$)/i.exec(text.trim());
  if (!m) return null;
  const cmd = byName(m[1]);
  return cmd?.by === "cli" ? cmd : null;
}

/** What Tab puts in the field: the whole name, ready for Enter.
 *
 *  A command that takes a value gets its space too, so completing it opens the
 *  values rather than leaving you at a name that cannot be run — and one that
 *  takes prose gets it for the same reason, with the cursor where the writing
 *  starts instead of against the name. */
export function completionFor(cmd: Command): string {
  return cmd.choices || cmd.takesText ? `/${cmd.name} ` : `/${cmd.name}`;
}

/** The whole line, name and value — what Tab puts in the field at the second
 *  stage, and what Enter sends. */
export function completionForChoice(cmd: Command, choice: Choice): string {
  return `/${cmd.name} ${choice.value}`;
}
