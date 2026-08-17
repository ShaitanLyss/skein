---
paths:
  - "src/lib/commands.ts"
  - "test/commands.test.ts"
---

# Slash commands, and clearing a card

### Slash commands, and clearing a card

The dock reads `/`-prefixed drafts as commands. `commands.ts` is pure and owns the
vocabulary and what a half-typed draft matches; `App.svelte` holds the palette's state and
one arm per command — the same split as `menu.ts` and `ContextMenu.svelte`. Adding a command
is one entry in `COMMANDS` and one arm in `runCommand`.

- **Skein reads only its own names, and this is a safety property rather than a
  simplification.** `claude` has slash commands of its own — the built-ins and everything in
  `.claude/commands/` — and they work in `--print` mode, so a prompt beginning with a slash
  is ordinary traffic. `/commit` is the project's command and has to reach the agent unread.
  An unknown name therefore matches nothing, opens no palette, and is sent as the prompt it
  is; swallowing it would silently break every custom command anybody has written, and the
  failure would look like the agent ignoring them.
- **The palette is for choosing, so it closes at the first space.** Left open while
  arguments are typed it would sit there claiming a choice is still to be made. Enter runs
  the lit entry (`/cle` + Enter clears, as in the CLI), Tab completes without running, Escape
  dismisses and *keeps the text* — a draft starting with a slash is a perfectly ordinary
  thing to say to an agent, and that is the way to say it.
- **A command reaches as far as a prompt does and costs the same modifier.** Clearing five
  gathered cards at once must not be easier than talking to them.

#### The CLI's own commands, offered but not taken

`/compact`, `/model` and `/effort` are in the palette and **Skein carries out none of them**.
`by: "cli"` marks them: the palette offers them, completes them, and then sends the text you
typed as the prompt it always was. So the vocabulary grew without this file taking custody of
a single one — the rule above is extended rather than bent, and `resolveCommand` still
answers only for `/clear`.

Probed 2026-08-14 against claude 2.1.232 with `tools/probe-commands.ts`, spawning with
Skein's exact argv and sending each as a `user` message on stdin:

```text
/compact       system/status "compacting", a status carrying compact_result,
               then a fresh system/init and a result
/model sonnet  result.result "Set model to Sonnet 5 for this session only"
/effort high   result.result "Set effort level to high (this session only): …"
/rewind        result.result "/rewind isn't available in this environment."
```

The same probe asked the *other* route and got `Unsupported control request subtype` for
`compact`, `rewind` and `set_effort`. `set_model` **is** on that route and succeeds — and is
deliberately not used: sending the text leaves a line in the transcript saying what you did,
where a control message changes the model with nothing to show for it. (The dispatcher's full
union, read out of the binary: `set_permission_mode`, `set_max_thinking_tokens`,
`mcp_oauth_callback_url`, `interrupt`, `set_color`, `mcp_status`, `mcp_reconnect`,
`file_suggestions`, `get_usage`, `initialize`, `get_context_usage`, `mcp_authenticate`,
`read_file`, `set_model`, `rename_session`.)

- **A command with a fixed set of values keeps the palette up past the space, and that is
  the closing rule holding rather than breaking.** The rule exists because the palette is for
  choosing; `/model` alone is not a thing that can be run, so the choosing is *not* over at
  the space and the values are offered (`typingChoice`, `matchChoices`). `/compact`, whose
  argument is prose, closes it exactly as everything did before. Past the second space it
  closes for the original reason.
- **Enter on such a command shows the values rather than running anything**, which is also
  what Tab does — at that row the two keys agree, because there is nothing yet to disagree
  about. `completionFor` gives it its trailing space for the same reason, or completing
  would strand you on a name that cannot be sent.
- **`cliCommand` recognises them without intercepting them.** Nothing is swallowed on the
  strength of it; it answers the two places the difference shows. A card is named after the
  first thing you *say*, and `/model sonnet` is not said to the agent — so `#deliver` does
  not name a card from one, and the card face withholds the same draft while you type it.
  Those two must agree or the face previews a name the send never gives it.
- **The values are the aliases the binary actually takes**, `opus[1m]` and `sonnet[1m]`
  included — the ones that earn their place on this wall in particular, since the context
  ring is drawn against the window tier and switching is the gesture for a card running out
  of room. `opusplan` is left off: it is plan mode's upgrade model, and every card here
  spawns with permissions bypassed.
- **A locally-answered turn has to be *drawn*, or the gesture looks like it failed.** The
  whole reply is one line in `result.result` and the only `assistant` message is a
  `<synthetic>` one with empty content, so the card showed the prompt, nothing after it, and
  settled at rest. `classify.ts::localAnswer` reads it, keyed on `num_turns === 0` — which
  counts round trips to a model, so zero means nothing was asked of one. Pushed as `meta`:
  it is the CLI talking about the conversation, the same voice as the stop note and the
  resume note. Deliberately not consulted for an errored turn, where `endingFor` already
  reads `result.result` as the detail and drawing it twice would print one sentence as both
  a note and a fault.
- **`<synthetic>` must not be read as a model or as occupancy, and it was.** That message
  carries an all-zero `usage`, and `contextWindowFor("<synthetic>")` is 200k — so a 1M card
  quietly lost two thirds of its ring, began calling its model `<synthetic>`, and then had
  the ring dropped to nothing by the zero usage. Every local command emits one, and so does
  a turn refused for rate limits, which is how it was found. Anything it actually said is
  still drawn; only the arithmetic skips it.
- **A compaction is the one local command that takes real time, and the one that says least
  about itself.** Probed end to end with `tools/probe-compact.ts` (claude 2.1.232, Skein's
  exact argv). A manual `/compact` over a four-turn context took **65 seconds** and put
  **exactly two events** on the wire:

  ```text
   44.96s  system/status  status:"compacting"
  110.08s  system/status  status:null, compact_result:"success"
  110.09s  result         num_turns:0, all-zero usage
  ```

  Nothing between them. No deltas, no `compact_boundary`, no summary — the probe also watched
  the whole *next* turn, which carried only `system/init`, `status:"requesting"`, the replayed
  prompt and an ordinary answer. **The boundary and the summary are written to the session
  file and never reach stdout on this path**, which is why `history.ts` is where both are read.

  So there is nothing to draw but the wait itself. `status:"compacting"` is folded narrowly,
  since `status` also carries `requesting` on every ordinary turn where the deltas arriving
  underneath are the better account.

- **The progress bar the TUI shows cannot be mirrored, and it is worth knowing exactly why**
  rather than concluding it twice. Two internal event types feed it — `compact_progress`,
  whose payload is phases (`hooks_start` → "Running PreCompact hooks…", `compact_start`,
  `compact_end`), and `response_length`, which drives the climbing token counter. Both are in
  `dav`/`pav`, the set the SDK path filters out of its message stream, and `compact_progress`
  is routed straight to `onCompactEvent`, which *is* the TUI status line. The animation is a
  shimmer sweep over "Compacting conversation…" plus an elapsed clock off `compactingStartTime`
  — not a determinate bar over known work. Of those, elapsed is the only part derivable here,
  and it is what the card counts.

- **A manual `/compact` writes four `user` records to the session file and marks one.** Only
  the caveat carries `isMeta`; `<command-name>`/`<command-message>`/`<command-args>` and
  `<local-command-stdout>` carry nothing at all — see `.claude/rules/panel.md`.
- **`/rewind` is not offered**, because the CLI refuses it in this environment — see the
  probe above. The binary does carry a hidden `--rewind-files <user-message-id>` flag
  ("Restore files to state at the specified user message and exit", requires `--resume`),
  which is a real headless route to the *file* half of it; nothing here uses it yet.

`/clear` is the first one, also on a card's right-click menu. There is no way to ask a
running `claude -p` to forget its context — the CLI's own `/clear` is a TUI gesture and never
reaches the stream — so the honest equivalent is to end the process and point the card at a
fresh session id.

- **The card and the session it holds are different things, and only now do they differ.**
  `conversation.id` is *the card* — its placement, its turns, its file touches all key on it
  and must survive — while `sessionId` is what `--session-id` / `--resume` take and what
  names the transcript on disk. They were the same value everywhere until clearing, which is
  why `Skein` used `c.id` for `read_transcript`, `read_ai_title` and `copy resume command`;
  all three are `c.sessionId` now, and getting one wrong means reading a file that is not
  this card's.
- **No migration.** `agent_session_id` has been in the schema since v1, is written by
  `record_conversation` and `import_row`, and is already returned by `load_studio` — it had
  simply never had a reason to differ from `id` and so was read by nobody.
- **`clear_conversation` is its own command rather than more parameters on
  `update_conversation`**, whose every column is COALESCEd so an absent argument leaves the
  old value alone. Clearing needs the opposite for three of them, and `last_ending` back to
  NULL is the whole point: the front end reads NULL as "never spoke", which is what makes the
  next spawn use `--session-id` rather than `--resume` against a transcript that does not
  exist yet.
- **`retiring` is set before the kill.** Killing a child on Windows gives it a non-zero exit
  code and `markExited` reads one of those as a crash, so clearing raced its own teardown and
  stamped "process exited with code 1" and a rust ending onto the fresh session that had just
  replaced it. The flag is cleared by whichever exit arrives, so the ordering does not matter;
  it is only set when there is a child to kill, or a later genuine crash would go unreported.
  `close` does not need it — that card leaves the wall.
- **Nothing is destroyed, which is why it is not a danger item.** The old transcript stays
  where Claude Code wrote it, so `adopt a recorded session…` puts it back on the wall as its
  own card. That makes `importable()` filter by `sessionId` rather than `id`: keyed on `id` a
  cleared card's own fresh session would be offered for adoption while it is standing there,
  and the session it was cleared away from would not be.
- **Offered only when there is something to clear** (`everSpoke || working`), not when there
  are lines on screen — a cleared card still carries its own "cleared" note, which would leave
  the item offered forever on a card with nothing left to clear. `working` earns its place:
  abandoning a first turn that is going wrong is exactly when this is wanted.

The control surface has a `clear` op, and `snapshot` carries each card's `sessionId` (the
only way to see from outside that a clear repointed it), the palette's current `commands`,
and its `choices` — reported apart, because the two stages are never both up and an empty
`commands` is otherwise a palette that is down and one that has moved on to the values.

