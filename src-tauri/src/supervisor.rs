//! Owns the `claude` child processes.
//!
//! One conversation is one long-lived `claude -p` process speaking NDJSON over
//! stdin and stdout. There is no terminal emulator anywhere on this path: the
//! child emits structured events, and the front end renders them as its own
//! design rather than as somebody else's TUI.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
/// Keep spawned children from flashing a console window on Windows.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The permissions a chat card is granted, and the whole of them.
///
/// `--tools` decides *which* tools exist; this decides whether the two that do
/// are allowed to run. Both are needed, and the second is easy to miss because
/// its absence looks like the model choosing not to search: probed against
/// 2.1.233 with `--tools WebSearch,WebFetch` and no permission argument at all,
/// a plain "search the web for X" came back refused. With this it answers.
///
/// Deliberately an allow rule rather than `--dangerously-skip-permissions`,
/// which would also work — with no file or shell tool in the process there is
/// nothing for a bypass to unlock. It is spelled out anyway so that the one
/// card on the wall that is *provably* harmless is not also the one carrying
/// the most dangerous flag Skein knows, where the next person to read the argv
/// has to reconstruct why that is fine.
const CHAT_SETTINGS: &str = r#"{"permissions":{"allow":["WebSearch","WebFetch"]}}"#;

/// Take the machine away from a card, leaving it the web.
///
/// Probed against claude 2.1.233 on 2026-08-16, spawning with Skein's argv:
///
/// ```text
/// --tools WebSearch,WebFetch, then asked to:
///   read a file, with --dangerously-skip-permissions as well  → no tool for it
///   run a shell command, likewise                             → no tool for it
///   WebFetch file:///C:/…/secret.txt                          → refused
///   WebFetch http://127.0.0.1:8899/ (a live local server)     → refused
///   search the web                                            → answers
/// ```
///
/// Three things that are not obvious and cost an afternoon each:
///
/// - **`--tools ""` does not disable tools.** The CLI's own help says it does.
///   The flag is variadic, the empty argument is swallowed, and what comes back
///   is the full default set — `Read Edit Write Glob Grep PowerShell Bash`. The
///   tools are always named explicitly here for that reason.
/// - **`--tools` filters the built-in set only; MCP tools pass straight
///   through.** That is what keeps `ask_user` working on a chat card, which is
///   the one capability it genuinely wants. It also means every *other* MCP
///   server the user has configured would arrive with whatever reach it has, so
///   `--strict-mcp-config` pins the card to the one server Skein passes.
/// - **There is no `Agent` in the filtered set**, so there is no subagent to
///   come back holding a fuller toolset than its parent.
///
/// What this is not: a sandbox. The process still runs as you, with your rights
/// — what is true is that the model has no route to them, not that the route
/// has been closed. A hook, a plugin or a later flag that reintroduces a tool
/// moves this boundary without touching this function.
fn chat_argv(cmd: &mut Command) {
    cmd.args(["--tools", "WebSearch,WebFetch"])
        .args(["--settings", CHAT_SETTINGS])
        .arg("--strict-mcp-config");
}

/// What the CLI prefixes an MCP tool with: the server name Skein passes in
/// `ask::mcp_config`. Nothing about a card can call `board`; the name is
/// `mcp__skein__board`.
const MCP_PREFIX: &str = "mcp__skein__";

/// The `--append-system-prompt` every card is spawned with.
///
/// Two paragraphs, and the second only where it is usable. Every word here is
/// paid for on every spawn of every card, so the roster half is kept to what the
/// tool descriptions cannot say and is left off a chat card, which `relay.rs`
/// refuses both tools to anyway — telling it about them would be an instruction
/// to try something it will be told it may not do.
///
/// **The tools are named as the agent must call them.** This read `ask_user`,
/// `board`, `post` for most of its life, and not one of those is a name any card
/// can use — so the one paragraph guaranteed to be in front of every agent spent
/// its length naming five identifiers that resolve to nothing. It is the worst
/// shape a wrong instruction can take, because it reads as correct to whoever
/// wrote it and fails silently for the agent: the tools were *there*, they were
/// described, and the card was pointed at names for them that did not exist.
/// `the_prompt_names_only_tools_the_server_advertises` is the guard, and it asks
/// `ask::dispatch` rather than a list kept here — a renamed tool has to break
/// this rather than quietly strand a sentence.
///
/// And it is short because it is allowed to be: `ask::mcp_config` sets
/// `alwaysLoad`, so each of these arrives with its own description attached
/// rather than as a bare name behind a `ToolSearch` step. That is where the
/// reasoning lives — why reading the board is free where a `send` costs the
/// other agent a turn, why a notice wants `paths`, why `unpost` is nobody else's
/// job — and re-stating it here would be the same words paid for twice, in the
/// copy that can silently drift out of step with the schema. **If `alwaysLoad`
/// ever comes off, this paragraph is the whole of what a card knows** and has to
/// grow back to carry it.
fn append_prompt(chat: bool) -> String {
    let mut prompt = format!(
        "When you need a decision that only the user can make, call \
         `{MCP_PREFIX}ask_user` rather than ending your turn with a question. It \
         keeps your turn open and resumes the moment they answer. Give it \
         `options` whenever the answer is a choice between alternatives."
    );
    if !chat {
        prompt.push_str(&format!(
            "\n\nOther Claude Code conversations may be working on this wall \
             beside you, sometimes in the same repository. Before starting \
             anything substantial, read `{MCP_PREFIX}board` — the standing \
             notices about what the others are holding. It costs nobody a turn. \
             `{MCP_PREFIX}post` puts your own notice up when you take on \
             something others build on, and `{MCP_PREFIX}unpost` takes it down \
             the moment it stops being true. `{MCP_PREFIX}list` says who else is \
             here and `{MCP_PREFIX}send` puts a message in one card's hands — \
             which costs that agent a turn, so read the board first."
        ));
    }
    prompt
}

pub struct Conv {
    child: Child,
    stdin: ChildStdin,
    /// The job object holding this card's whole process tree.
    ///
    /// `child.kill()` is `TerminateProcess` and it reaches exactly one process:
    /// the `claude.exe` itself. But a card is never one process. Each one spawns
    /// a `cmd.exe` → `node.exe` pair per stdio MCP server, a `conhost.exe`, and
    /// a `bash.exe` for every Bash tool call it makes — and those outlive the
    /// agent that started them whenever they are backgrounded or simply hang.
    /// Measured on this machine on 2026-08-19: one Skein up since the previous
    /// evening carried 80 descendants for 6 cards, among them a `bash → bash →
    /// bash → bun` chain sixteen hours old under a card that had long since
    /// finished with it.
    ///
    /// So killing the child orphaned the rest, `close_conversation` reclaimed
    /// nothing, and `shutdown` left the whole lot running after the app was
    /// gone — which is how the count only ever went up across a day. Dropping
    /// this takes the tree down (`KILL_ON_JOB_CLOSE`), and it is the same
    /// bargain `servers.rs`, `bang.rs`, `shell.rs` and `actions.rs` each already
    /// struck; this was the one spawn in the app that had not.
    ///
    /// The deliberate exception stays deliberate: `actions::launch_detached`
    /// spawns from *Skein*, not from a card, so an editor still outlives the
    /// wall. What changes is that an editor a card opened through its own Bash
    /// tool now dies with that card, which is the same promise the doc comment
    /// on `shutdown` has always made.
    job: Option<crate::servers::jobs::Job>,
    /// Whether a turn is open on this child right now.
    ///
    /// The one thing the supervisor needs to know about the *conversation*
    /// rather than about the process: a card that lost a turn when the app went
    /// away is sent a resume prompt at the next launch, and having a process is
    /// not the same fact as being mid-turn. Shared with the reader thread, which
    /// is the only place the answer changes on its own.
    ///
    /// It is also written through to the row as it changes (`store::set_mid_turn`),
    /// which is what makes the flag survive a crash — see there.
    turn: Arc<AtomicBool>,
}

/// `.0` is the live children; `.1` says the app is on its way out.
///
/// The second exists for one race with one consequence. A reader thread clears
/// the row's mid-turn mark when its stream ends, because a child that died with
/// a turn open is a card standing on the wall saying so — you can see it, and
/// resuming it tomorrow would spend money on a failure already reported. But
/// `shutdown` ends every stream too, by killing them, and *that* is exactly the
/// case the mark is for. So the flag is raised before the first kill and the
/// reader threads read it on their way out.
#[derive(Default)]
pub struct Supervisor(pub Mutex<HashMap<String, Conv>>, AtomicBool);

#[derive(Clone, Serialize)]
struct ConvEvent {
    id: String,
    event: serde_json::Value,
}

#[derive(Clone, Serialize)]
struct ConvLine {
    id: String,
    line: String,
}

#[derive(Clone, Serialize)]
struct ConvExit {
    id: String,
    code: Option<i32>,
}

/// Start a conversation. `id` is a UUID minted by the front end and handed to
/// `--session-id`, so our record and the on-disk transcript are correlated from
/// birth — which is what makes `--resume` work later without a lookup table.
///
/// `session_id` separates the two for the one case where they differ: a cleared
/// card keeps its `id` — its placement, its turns, its file touches all key on
/// it — while pointing at a fresh session. Everything else here stays keyed by
/// `id`, including the supervisor map, the emitted events and the ask URL, so
/// only the argv the CLI reads is affected. Absent, it is the id, which is the
/// whole of a card's life until somebody clears it.
///
/// **Whether to resume is asked of the disk, not of the caller.** It is one
/// question — is there a transcript for this session — and the file either is
/// there or is not, so a flag passed down from the front end could only ever be
/// a second, staler answer to it. It was one: `resume: conv.everSpoke`, which
/// is `last_ending IS NOT NULL`, meaning *did a turn ever finish*. A card killed
/// part-way through its first turn has a transcript and no ending, so it came
/// back wanting `--session-id` against an id the CLI already knew, and the child
/// died on the spot — the exact case rousing wakes first, since an interrupted
/// card is the one with work standing still.
///
/// Probed against claude 2.1.232 with `tools/probe-resume.ts`, spawning with
/// Skein's exact argv:
///
/// ```text
/// --session-id <fresh>, never spoken to  → no transcript file is written at all
/// --resume <that same id>                → exit 1, "No conversation found with
///                                          session ID: …", plus a result event
/// --session-id <id with a transcript>    → exit 1, "Error: Session ID … is
///                                          already in use.", and nothing at all
///                                          on stdout
/// ```
///
/// The first line is what makes the file the whole answer: a spawn that was
/// never spoken to leaves nothing behind, so the file existing means something
/// was said and can be resumed. It corrects the other direction too — a row
/// claiming an ending whose transcript has since been deleted now starts fresh
/// instead of dying on the second message above.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn spawn_conversation(
    app: AppHandle,
    sup: State<'_, Supervisor>,
    id: String,
    session_id: Option<String>,
    cwd: String,
    model: Option<String>,
    worktree: Option<String>,
    account_label: Option<String>,
) -> Result<(), String> {
    if sup.0.lock().unwrap().contains_key(&id) {
        return Err(format!("conversation {id} is already open"));
    }
    let session = session_id.as_deref().filter(|s| !s.is_empty()).unwrap_or(&id);

    /* Asked of the store, never of the caller — see `store::kind_of`. `wake`
       and `open` both reach this line and only one of them would have
       remembered to pass it. */
    let chat = crate::store::kind_of(&app.state::<crate::store::Store>(), &id) == "chat";

    /* The path `claude.rs` verified, not the bare name. On a machine where the
       CLI is installed but never made it onto PATH, the bare name fails every
       spawn on the wall with a message about a missing program, for a binary
       sitting in plain sight in ~/.local/bin. Worked out once and cached. */
    let program = {
        let home = app.path().home_dir().map_err(|e| format!("no home dir: {e}"))?;
        crate::claude::program(&home)
    };
    let mut cmd = Command::new(&program);
    cmd.current_dir(&cwd)
        .arg("--print")
        .args(["--input-format", "stream-json"])
        .args(["--output-format", "stream-json"])
        .arg("--verbose")
        .arg("--include-partial-messages")
        .arg("--replay-user-messages")
        .arg("--forward-subagent-text");

    if chat {
        chat_argv(&mut cmd);
    } else {
        cmd.arg("--dangerously-skip-permissions");
    }

    /* Which subscription this card spends. `CLAUDE_SECURESTORAGE_CONFIG_DIR`
       selects the credential store and *only* the store — `CLAUDE_CONFIG_DIR`
       is untouched, so the transcript still lands in the shared config
       directory and the `--resume` an account swap is built on works exactly as
       before. Probed 2026-08-20 against claude 2.1.235: an empty store dir
       reports `loggedIn: false, authMethod: "none"`, so there is no quiet
       fall-through to the global sign-in; a store holding a credential reports
       `authMethod: "claude.ai"` with the account's own email and plan; and a
       real turn ran under one while writing its transcript to the usual place.

       Per-process, so two cards can be on two accounts at the same moment, and
       the store's own refresh is the CLI's business rather than ours — which is
       the half `CLAUDE_CODE_OAUTH_TOKEN` could not do, since a token put in the
       environment carries no refresh token and cannot heal when it expires.

       This was that token, and the reason it changed is in `accounts.rs`: a
       `setup-token` credential is scoped `user:inference` alone, so the
       allowance endpoint refused it and a card's account could never be
       measured. See `.claude/rules/accounts.md`.

       None means the account Claude Code is signed in as, which is every card
       that existed before accounts did and every wall with none registered.

       A label whose store holds no credential is a hard failure rather than a
       silent fall-through to the signed-in account: falling through would spend
       the wrong subscription — quietly, and precisely the one being held in
       reserve. */
    if let Some(label) = account_label.as_deref().filter(|s| !s.is_empty()) {
        if !crate::accounts::signed_in(&app, label) {
            return Err(format!(
                "'{label}' is not signed in — sign in to it in the accounts panel"
            ));
        }
        let dir = crate::accounts::store_dir(&app, label)?;
        cmd.env("CLAUDE_SECURESTORAGE_CONFIG_DIR", &dir);
        /* Cleared rather than left alone: the CLI reads this ahead of any
           store, so one inherited from Skein's own environment would quietly
           outrank the account this card was put on. */
        cmd.env_remove("CLAUDE_CODE_OAUTH_TOKEN");
    }

    /* A path we cannot even build is one we cannot find a transcript at, which
       is the same answer as there not being one: start fresh. */
    let resume = transcript_path(&app, &cwd, session).is_ok_and(|p| p.exists());
    if resume {
        cmd.args(["--resume", session]);
    } else {
        cmd.args(["--session-id", session]);
        /* Only on a fresh spawn: `--worktree` *creates* one, so passing it
           while resuming would try to branch a session that already lives in
           its own tree. And never for a chat card, whose cwd is a folder of
           Skein's own — branching it would put a git tree somewhere nobody
           asked for one, for an agent with no tool to edit it. */
        if !chat {
            if let Some(name) = worktree.as_deref().filter(|n| !n.trim().is_empty()) {
                cmd.args(["--worktree", name]);
            }
        }
    }
    if let Some(m) = model {
        cmd.args(["--model", &m]);
    }

    /* Hand the agent a way to ask us something. The URL carries the
       conversation id, so a call arrives already addressed to a card. */
    let ask_port = app.state::<crate::ask::Asks>().port();
    if ask_port != 0 {
        let cfg = crate::ask::mcp_config(ask_port, &id);
        cmd.args(["--mcp-config", &cfg.to_string()]);
        /* Or the CLI abandons the parked call after one minute and the click
           lands on a request nobody is reading. This moves the *hard* deadline
           only; the config above carries the same number again for the idle
           watchdog, which no variable here reaches — see ask::mcp_config. */
        cmd.env("MCP_TOOL_TIMEOUT", crate::ask::client_timeout_ms().to_string());
        cmd.args(["--append-system-prompt", &append_prompt(chat)]);
    }

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start claude in {cwd}: {e}"))?;

    /* Before anything is taken off the child, so the tree is enclosed from its
       first breath — an MCP server spawned between here and the insert below
       would otherwise be outside the job for the rest of its life. */
    let job = crate::servers::jobs::Job::new();
    if let Some(j) = &job {
        j.assign(child.id());
    }

    let stdout = child.stdout.take().ok_or("no stdout on child")?;
    let stderr = child.stderr.take().ok_or("no stderr on child")?;
    let stdin = child.stdin.take().ok_or("no stdin on child")?;

    let turn = Arc::new(AtomicBool::new(false));

    // stdout: one JSON object per line. Anything unparseable is surfaced rather
    // than swallowed — a silent drop here would be very hard to debug later.
    {
        let app = app.clone();
        let id = id.clone();
        let turn = turn.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<serde_json::Value>(&line) {
                    Ok(event) => {
                        /* Read before the value is handed over, since the emit
                           takes it. Cheap next to the parse above and the hop
                           into the webview below. */
                        if let Some(open) = event
                            .get("type")
                            .and_then(|t| t.as_str())
                            .and_then(turn_mark)
                        {
                            /* Only when it actually changes: `stream_event`
                               arrives thousands of times a turn and every one
                               of them says "open", while the row only wants
                               telling at the two boundaries. */
                            if turn.swap(open, Ordering::Relaxed) != open {
                                persist_turn(&app, &id, open);
                            }
                        }
                        let _ = app.emit(
                            "conv:event",
                            ConvEvent {
                                id: id.clone(),
                                event,
                            },
                        );
                    }
                    Err(_) => {
                        let _ = app.emit(
                            "conv:stderr",
                            ConvLine {
                                id: id.clone(),
                                line,
                            },
                        );
                    }
                }
            }
            /* stdout closing is the reliable signal that the child is finished,
               so this is where it gets reaped. Two things depend on that:

               1. The id has to leave the map, or `spawn_conversation` keeps
                  answering "already open" for a process that is dead. `wake`
                  reads that as "it is awake after all", clears `dormant`, and
                  the next `send_prompt` writes into a closed pipe — for good.
                  A card whose agent crashed could never be revived, only closed.

               2. The exit code only exists once somebody waits. Emitting `None`
                  here meant `markExited` always took its clean-exit branch, so a
                  `claude` that died on its own reported as "dormant" and the
                  reason sat unread in the stderr lines. */
            /* The stream is over, so no turn is open on it any more — a child
               that died holding one is gone rather than interrupted, and the
               card is about to say so through `markExited`. The row is told the
               same thing, so tomorrow's launch does not resume a turn whose
               failure you were shown today.
               Unless the app is the one ending the stream, which is the whole
               case the mark exists for: killing every child is how quitting
               works, and a clear here would undo the flag on the way out. */
            turn.store(false, Ordering::Relaxed);
            if !app.state::<Supervisor>().going_away() {
                persist_turn(&app, &id, false);
            }
            let code = app.state::<Supervisor>().reap(&id);
            let _ = app.emit("conv:exit", ConvExit { id, code });
        });
    }

    {
        let app = app.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                let _ = app.emit(
                    "conv:stderr",
                    ConvLine {
                        id: id.clone(),
                        line,
                    },
                );
            }
        });
    }

    sup.0.lock().unwrap().insert(id.clone(), Conv { child, stdin, turn, job });

    /* Its post. Asked for here rather than at either call site for the reason
       `kind` is read here: `wake` and `open` both reach this line and only one
       of them would have remembered. Before anything else can be written to the
       card, so a wake caused by a prompt you typed still reads what it was told
       while it slept first — which is the order the two actually happened in. */
    crate::relay::drain_inbox(&app, &id);
    Ok(())
}

/// What one event off the wire says about whether a turn is open on this child.
///
/// `Some(true)` a turn is running, `Some(false)` it has settled, `None` this
/// event says nothing either way. It is the whole of the wire vocabulary Rust
/// knows — `classify.ts` owns the rest and should go on owning it — and it is
/// here rather than there because both places that read the answer are here: the
/// row is written as the turn turns over (`persist_turn`), on a thread that has
/// no webview to ask, and the answer is wanted again at `ExitRequested`, when
/// there is no round trip left to make.
///
/// `system` is deliberately absent: `system/init` arrives on every spawn,
/// including the ones rousing makes with nothing to say, and a spawn is not a
/// turn. Speech is what opens one, whoever started it — a prompt of yours, the
/// rousing queue's, or the `<task-notification>` the CLI injects when a
/// background job lands, which wakes the agent with no `send_prompt` anywhere
/// near it — measured, 48 times in 53, at a median of ten seconds. The
/// exception is the notification a *restart* produces, reconciling tasks it
/// found orphaned, which wakes nobody; see `turns.md`, "told, and not
/// stirring".
fn turn_mark(kind: &str) -> Option<bool> {
    match kind {
        "result" => Some(false),
        "assistant" | "user" | "stream_event" => Some(true),
        _ => None,
    }
}

/// Write the turn mark through to the card's row.
///
/// The flag used to be worked out at `ExitRequested` and written once, which
/// made it mean "the app was asked to close mid-turn" rather than "this turn was
/// lost" — and a crash asks nothing. So the wall came back from the one exit
/// that really does lose work with nothing to resume. Written here, the row is
/// already true before anything goes wrong; see `store::set_mid_turn`.
///
/// Best-effort by design. This runs on a reader thread and on the send path, and
/// a card whose mark did not land is a resume prompt not offered — never a wrong
/// one sent — so there is nothing here worth failing a turn over.
fn persist_turn(app: &AppHandle, id: &str, open: bool) {
    if let Some(store) = app.try_state::<crate::store::Store>() {
        if let Ok(conn) = store.0.lock() {
            crate::store::set_mid_turn(&conn, id, open);
        }
    }
    /* The one place both boundaries of a turn already go through, which is why
       the relay's chain mark is cleared from here rather than from the reader
       thread — a second site watching for the same transition is a second site
       to get the `stream_event` storm wrong. */
    if !open {
        crate::relay::turn_closed(app, id);
    }
}

/// Put a message into a card's stdin without it being something you typed.
///
/// `send_prompt` minus the echo, and the difference is the whole point: the
/// pending/claimed machinery in `Conversation.echo` exists to say whether the
/// process has got *your* draft yet, and there is no draft here. What arrives
/// back is a plain `user` replay with nothing waiting to claim it, which the
/// front end already handles — it is the "a prompt this window did not send"
/// path, and `relay::RELAY_MARK` is what tells it whose.
///
/// Errs when the card has no process. That is not a failure: it is the answer
/// `do_send` turns into a queued row, so a dormant card is written to rather
/// than woken.
pub fn deliver(app: &AppHandle, id: &str, text: &str) -> Result<(), String> {
    {
        let sup = app.state::<Supervisor>();
        let mut map = sup.0.lock().unwrap();
        let conv = map.get_mut(id).ok_or("that card is dormant")?;
        let msg = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
        });
        writeln!(conv.stdin, "{msg}").map_err(|e| format!("write to claude stdin: {e}"))?;
        conv.stdin.flush().map_err(|e| format!("flush claude stdin: {e}"))?;
        conv.turn.store(true, Ordering::Relaxed);
    }
    /* Outside the map's lock, per the note in `send_prompt`. */
    persist_turn(app, id, true);
    Ok(())
}

/// Send one user turn. The wire format is the same envelope the Agent SDK uses.
#[tauri::command]
pub fn send_prompt(
    app: AppHandle,
    sup: State<'_, Supervisor>,
    id: String,
    text: String,
) -> Result<(), String> {
    {
        let mut map = sup.0.lock().unwrap();
        let conv = map
            .get_mut(&id)
            .ok_or_else(|| format!("no open conversation {id}"))?;

        let msg = serde_json::json!({
            "type": "user",
            "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
        });

        writeln!(conv.stdin, "{msg}").map_err(|e| format!("write to claude stdin: {e}"))?;
        conv.stdin
            .flush()
            .map_err(|e| format!("flush claude stdin: {e}"))?;
        /* Marked here rather than waiting for the echo to come back: a prompt
           that is on the wire and unanswered when the app closes is exactly a
           lost turn, and the window between the write and the first event is
           where a quit that feels instantaneous lands. */
        conv.turn.store(true, Ordering::Relaxed);
    }
    /* Outside the map's lock, which is the only ordering rule the two mutexes
       have: nothing takes the store's lock and then the supervisor's, so nothing
       here can be half of a cycle. */
    persist_turn(&app, &id, true);
    Ok(())
}

/// Stop the turn a conversation is in the middle of, without ending it.
///
/// The stdin that carries prompts carries a second kind of message: a
/// `control_request`. The CLI accepts a small set of subtypes on it — the
/// binary's dispatcher lists `interrupt`, `set_model`, `set_permission_mode`,
/// `set_max_thinking_tokens`, `set_color`, `mcp_toggle`, `message_rated` — and
/// `interrupt` is the same one the Agent SDK's `query.interrupt()` sends.
///
/// Probed against claude 2.1.229 with `tools/probe-interrupt.ts`, which spawns
/// with Skein's exact argv. Writing the line below produced, inside 20ms:
///
/// ```text
/// control_response  subtype success, {still_queued: [], cancelled: []}
/// assistant         the half-written answer, as far as it had got
/// user              "[Request interrupted by user]"
/// result            is_error true, terminal_reason "aborted_streaming"
/// ```
///
/// and then the child stayed up and answered the next prompt normally. That is
/// the whole point: this is not `close_conversation` with a nicer name. The
/// process, the session and the context all survive — only the turn ends.
///
/// `cancel_queued` is deliberately not asked for, though the CLI advertises it
/// (`interrupt_cancel_queued_v1`). Stopping means stopping what is *running*: a
/// prompt already written to stdin behind it is one you sent and are owed an
/// answer to, and the transcript is marking it unacknowledged until it lands.
/// Cancelling it here would settle that mark with nothing to settle it with.
#[tauri::command]
pub fn interrupt_conversation(sup: State<'_, Supervisor>, id: String) -> Result<(), String> {
    let mut map = sup.0.lock().unwrap();
    let conv = map
        .get_mut(&id)
        .ok_or_else(|| format!("no open conversation {id}"))?;

    /* Nothing here correlates the receipt, but two interrupts in flight under
       one id would make the pair on the wire unreadable to anything that did. */
    let n = INTERRUPTS.fetch_add(1, Ordering::Relaxed);
    let msg = serde_json::json!({
        "type": "control_request",
        "request_id": format!("skein-interrupt-{n}"),
        "request": { "subtype": "interrupt" }
    });

    writeln!(conv.stdin, "{msg}").map_err(|e| format!("write to claude stdin: {e}"))?;
    conv.stdin
        .flush()
        .map_err(|e| format!("flush claude stdin: {e}"))
}

static INTERRUPTS: AtomicU64 = AtomicU64::new(0);

/// How Claude Code names a transcript directory: every character that is not
/// ASCII alphanumeric becomes a dash. `C:\atelier\skein` → `C--atelier-skein`.
///
/// It is *not* only the separators, which is what this used to assume. Probed
/// against claude 2.1.228 by spawning in three directories and reading back the
/// name it created under `~/.claude/projects`:
///
/// ```text
/// slug_probe a.b+c → slug-probe-a-b-c     (_, space, ., + all fold)
/// café_naïve-Ω9    → caf--na-ve--9        (non-ASCII folds too)
/// emoji🌿probe     → emoji--probe         (one emoji, two dashes)
/// ```
///
/// So it is `is_ascii_alphanumeric`, not `is_alphanumeric` — the latter would
/// keep the `é` and miss the directory entirely. And the replacement runs per
/// UTF-16 code unit, so an astral char yields two dashes rather than one.
///
/// The dot is the one that bit: `C:\atelier\skein\.scratch\wall` resolved to a
/// path that does not exist, `read_ai_title` read that as "no transcript yet"
/// — its normal, silent case — and every conversation under a dotted directory
/// went permanently untitled.
pub(crate) fn transcript_dir_name(cwd: &str) -> String {
    let mut out = String::with_capacity(cwd.len());
    for c in cwd.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                out.push('-');
            }
        }
    }
    out
}

/// Where Claude Code keeps this session's transcript.
///
/// Note which way this is used: to *read* a session we already know the id of.
/// Going the other way — deciding which sessions exist — must not decode this
/// name, because the encoding is lossy (`.scratch` and `-scratch` collide). Ask
/// the records instead; every one of them carries its own `cwd`.
pub(crate) fn transcript_path(app: &AppHandle, cwd: &str, session_id: &str) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home dir: {e}"))?;
    Ok(home
        .join(".claude")
        .join("projects")
        .join(transcript_dir_name(cwd))
        .join(format!("{session_id}.jsonl")))
}

/// The conversation as Claude Code recorded it, for the front end to fold.
#[derive(Serialize)]
pub struct Transcript {
    text: String,
    /// Bytes skipped off the front because the file was over the cap. Non-zero
    /// means the reader handed back a tail, and the card should say so.
    dropped_bytes: u64,
}

/// Read a session's transcript off disk.
///
/// This is the only way to see anything that happened before Skein attached:
/// `--resume` replays nothing onto the stream. Probed against claude 2.1.228 —
/// resuming a two-turn session with `--output-format stream-json` produced
/// `system/init`, the new prompt and the new answer, and no historical
/// messages at all. The model had the history (it answered from it); stdout
/// never carried it. The TUI's scrollback is this file, rendered locally.
///
/// The tail is what matters when a transcript is large — the biggest here is
/// 4 MB — so an over-cap file is read from the end, and the partial line the
/// seek lands in the middle of is discarded.
///
/// Off the main thread, via `crate::off_main`: up to eight megabytes read and
/// folded, and every rouse on the wall asks for one. On the main thread a wall
/// coming back was a stall per card, each one holding up the paint of the rest.
#[tauri::command]
pub async fn read_transcript(
    app: AppHandle,
    cwd: String,
    session_id: String,
    max_bytes: Option<u64>,
) -> Result<Option<Transcript>, String> {
    crate::off_main(move || transcript_of(&app, cwd, session_id, max_bytes)).await?
}

/// The read itself, apart from the command that carries it.
fn transcript_of(
    app: &AppHandle,
    cwd: String,
    session_id: String,
    max_bytes: Option<u64>,
) -> Result<Option<Transcript>, String> {
    /* Enough for any transcript on this machine, and a bound rather than a
       promise: 8 MB of NDJSON folds to a few thousand lines, of which the front
       end keeps the last few hundred. */
    const DEFAULT_CAP: u64 = 8 * 1024 * 1024;
    let cap = max_bytes.unwrap_or(DEFAULT_CAP).max(1);

    let path = transcript_path(app, &cwd, &session_id)?;
    // A card that was never spoken to has no transcript. Normal, not an error.
    let Ok(mut file) = File::open(&path) else {
        return Ok(None);
    };
    let len = file
        .metadata()
        .map_err(|e| format!("stat transcript: {e}"))?
        .len();

    let dropped_bytes = len.saturating_sub(cap);
    if dropped_bytes > 0 {
        file.seek(SeekFrom::Start(dropped_bytes))
            .map_err(|e| format!("seek transcript: {e}"))?;
    }
    let mut buf = Vec::with_capacity(len.min(cap) as usize);
    file.read_to_end(&mut buf)
        .map_err(|e| format!("read transcript: {e}"))?;

    /* Lossy on purpose: seeking to a byte offset can land inside a multi-byte
       char, and that char is in the partial line we are about to drop anyway. */
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if dropped_bytes > 0 {
        match text.find('\n') {
            Some(i) => text.drain(..=i),
            None => text.drain(..),
        };
    }

    Ok(Some(Transcript {
        text,
        dropped_bytes,
    }))
}

/// The title Claude Code generated for this session.
///
/// It is written to the transcript file but *not* emitted on the stream — the
/// event types on the wire are system / stream_event / assistant / user /
/// result / rate_limit_event, and `ai-title` is not among them. So the only way
/// to get a real name onto a card is to read it off disk.
///
/// Off the main thread, via `crate::off_main`: this reads the whole transcript
/// into memory — the comment below says multi-megabyte, and means it — and the
/// wall asks it once per card while naming them.
#[tauri::command]
pub async fn read_ai_title(
    app: AppHandle,
    cwd: String,
    session_id: String,
) -> Result<Option<String>, String> {
    crate::off_main(move || ai_title_of(&app, cwd, session_id)).await?
}

/// The read itself, apart from the command that carries it.
fn ai_title_of(
    app: &AppHandle,
    cwd: String,
    session_id: String,
) -> Result<Option<String>, String> {
    let path = transcript_path(app, &cwd, &session_id)?;

    let Ok(text) = std::fs::read_to_string(&path) else {
        // No transcript yet is normal, not an error.
        return Ok(None);
    };

    /* The record repeats as the title is refined, so the last one wins. A
       cheap substring test first keeps this from parsing every line of a
       multi-megabyte transcript. */
    let mut found = None;
    for line in text.lines() {
        if !line.contains("\"ai-title\"") {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if v.get("type").and_then(|t| t.as_str()) == Some("ai-title") {
                if let Some(t) = v.get("aiTitle").and_then(|t| t.as_str()) {
                    if !t.trim().is_empty() {
                        found = Some(t.to_string());
                    }
                }
            }
        }
    }
    Ok(found)
}

#[tauri::command]
pub fn close_conversation(sup: State<'_, Supervisor>, id: String) -> Result<(), String> {
    if let Some(mut conv) = sup.0.lock().unwrap().remove(&id) {
        /* The job first, so the whole tree goes at once rather than the agent
           dying and its servers and shells being orphaned in the gap. The kill
           below is then a no-op on Windows and the whole of it where no job
           could be made at all; the `wait` reaps the handle either way. */
        drop(conv.job.take());
        let _ = conv.child.kill();
        let _ = conv.child.wait();
    }
    Ok(())
}

/// Should the wall skip rousing its restored cards on load?
///
/// Set `SKEIN_NO_WAKE=1` and every card is painted and read for exactly as
/// before, and none of them is given a process until you speak to it — the
/// behaviour the wall had before rousing existed. Two reasons it has to be
/// reachable:
///
/// - a second Skein against the same store would otherwise resume every session
///   in the workspace a second time, appending to transcripts the first instance
///   is also holding. `SKEIN_NO_SERVERS` already exists for that pairing and
///   this is the same argument one layer up.
/// - a card that was interrupted is *sent a prompt*, which spends money and
///   starts an agent editing a repo. There has to be a way to open the wall and
///   look at it without that happening.
///
/// Advisory in exactly the way `servers_quiet` is: the flag means "don't do this
/// for me on load", not "these may not run", so every card still wakes the
/// moment it is spoken to.
#[tauri::command]
pub fn wake_quiet() -> bool {
    crate::servers::quiet(std::env::var("SKEIN_NO_WAKE").ok().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::transcript_dir_name;

    /// Every backticked `mcp__skein__…` in the appended prompt, in order.
    fn named_tools(prompt: &str) -> Vec<String> {
        prompt
            .split('`')
            .skip(1)
            .step_by(2)
            .filter_map(|t| t.strip_prefix(MCP_PREFIX))
            .map(str::to_string)
            .collect()
    }

    /// What a card can actually call, asked of the server rather than listed
    /// here — so renaming a tool breaks this test instead of quietly stranding a
    /// sentence in the one paragraph every agent reads.
    fn advertised() -> Vec<String> {
        let r = crate::ask::dispatch(&serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "tools/list"
        }));
        let crate::ask::Dispatch::Reply(v) = r else { panic!("expected a reply") };
        v["result"]["tools"]
            .as_array()
            .expect("a list of tools")
            .iter()
            .map(|t| t["name"].as_str().expect("a name").to_string())
            .collect()
    }

    /// The bug this guards is silent from both ends: the tools are there and
    /// described, and the prompt points the card at names for them that do not
    /// exist. Nothing errors — the agent simply never calls them, which is
    /// indistinguishable from it choosing not to.
    #[test]
    fn the_prompt_names_only_tools_the_server_advertises() {
        let known = advertised();
        for chat in [false, true] {
            for tool in named_tools(&append_prompt(chat)) {
                assert!(
                    known.contains(&tool),
                    "the prompt names `{MCP_PREFIX}{tool}`, which tools/list does not \
                     advertise (chat={chat}); it advertises {known:?}"
                );
            }
        }
    }

    /// The other direction, and the actual regression: a bare `board` or
    /// `ask_user` in backticks is the name this prompt carried for most of its
    /// life and the one thing no card can call.
    #[test]
    fn no_tool_is_named_without_its_server_prefix() {
        let known = advertised();
        for chat in [false, true] {
            let prompt = append_prompt(chat);
            for tick in prompt.split('`').skip(1).step_by(2) {
                assert!(
                    !known.iter().any(|k| k == tick),
                    "`{tick}` is a tool name without `{MCP_PREFIX}` in front of it \
                     (chat={chat}), so nothing can call it"
                );
            }
        }
    }

    /// A chat card is refused the roster and the board by `relay.rs` and
    /// `board.rs`, so naming them would be an instruction to try what it will be
    /// told it may not do. `ask_user` is the one tool it does keep.
    #[test]
    fn a_chat_card_is_told_only_about_the_question() {
        let chat = append_prompt(true);
        assert_eq!(named_tools(&chat), vec!["ask_user"]);
        let project = append_prompt(false);
        for tool in ["ask_user", "board", "post", "unpost", "list", "send"] {
            assert!(
                named_tools(&project).iter().any(|t| t == tool),
                "a project card is not told about `{MCP_PREFIX}{tool}`"
            );
        }
    }

    /// A child that exits with a known code, so reaping can be tested without a
    /// `claude` on the machine.
    #[cfg(windows)]
    fn dying_child(code: i32) -> Conv {
        let mut child = Command::new("cmd")
            .args(["/C", &format!("exit {code}")])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn cmd");
        let stdin = child.stdin.take().expect("piped stdin");
        Conv { child, stdin, turn: Arc::new(AtomicBool::new(false)), job: None }
    }

    /// A child that will sit there until it is killed, so shutdown has something
    /// to drain that has not already gone away on its own.
    #[cfg(windows)]
    fn waiting_child(mid_turn: bool) -> Conv {
        let mut child = Command::new("cmd")
            // `more` reads stdin to EOF, and we are holding the write end.
            .args(["/C", "more"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn cmd");
        let stdin = child.stdin.take().expect("piped stdin");
        Conv { child, stdin, turn: Arc::new(AtomicBool::new(mid_turn)), job: None }
    }

    /// The bug this covers: shutdown returned every live child, and rousing
    /// gives every card on the wall one. So a clean quit flagged the whole wall
    /// interrupted and the next launch sent every card a resume prompt — cards
    /// at rest included.
    #[cfg(windows)]
    #[test]
    fn shutdown_reports_only_the_cards_that_were_mid_turn() {
        let sup = Supervisor::default();
        sup.0.lock().unwrap().insert("resting".into(), waiting_child(false));
        sup.0.lock().unwrap().insert("working".into(), waiting_child(true));

        let lost = sup.shutdown();

        assert_eq!(lost, vec!["working".to_string()]);
        assert!(
            sup.0.lock().unwrap().is_empty(),
            "shutdown has to drain the map whatever it reports"
        );
    }

    /// A card carrying something `child.kill()` cannot reach. `cmd /C ping`
    /// runs the ping as a process of its own, so it is a *grandchild* of the
    /// test and killing the `cmd` leaves it up — which is the shape a real card
    /// has: an MCP server's `cmd → node`, a `bash.exe` per Bash tool call, a
    /// backgrounded test run.
    ///
    /// The grandchild's pid is asked of the **job** rather than printed by the
    /// parent. It used to come out of a `powershell -Command "… Start-Process
    /// -PassThru; Write-Output $p.Id; [Console]::In.ReadToEnd()"`, which on this
    /// machine prints a pid and on the release runner handed back a closed pipe
    /// — so v0.4.0 failed at `parse::<u32>("")` inside the fixture, naming
    /// nothing about job objects and telling us nothing about the bug the test
    /// exists for. **A fixture that can fail for reasons of its own reports
    /// somebody else's weather.** `Job::pids` needs no cooperation from the
    /// child at all, since the kernel already knows what is in the job — and the
    /// ping is picked out of that list by its **image**, since the job holds the
    /// `cmd` we spawned and the `conhost.exe` the console dragged in with it as
    /// well.
    #[cfg(windows)]
    fn child_with_a_grandchild() -> (Conv, u32) {
        let mut child = Command::new("cmd")
            .args(["/C", "ping", "-n", "300", "127.0.0.1"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("spawn cmd");

        let job = crate::servers::jobs::Job::new().expect("a job object");
        assert!(
            job.assign(child.id()),
            "the card's own process never joined the job, so there is nothing to test"
        );

        let parent = child.id();
        /* Polled for by *image*, not as "the pid that is not the parent". A
           console process drags a `conhost.exe` along with it and conhost joins
           the job like anything else the parent starts, so the first stranger in
           the list is as likely to be that as the ping — which is what the
           re-cut of v0.4.0 caught, one round trip after the fixture stopped
           asking powershell. Five seconds is a runner having a bad morning;
           past that it is a hang, and saying so beats waiting. */
        let mut found = None;
        for _ in 0..100 {
            found = job
                .pids()
                .into_iter()
                .find(|p| *p != parent && row(*p).to_lowercase().contains("ping.exe"));
            if found.is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        /* Name what the job actually held. The whole point of this fixture is
           that when it goes wrong it says something about job objects. */
        let grandchild = found.unwrap_or_else(|| {
            let held: Vec<String> = job.pids().iter().map(|p| row(*p).trim().to_string()).collect();
            panic!("no ping under the cmd — the job held {held:?}")
        });

        let stdin = child.stdin.take().expect("piped stdin");
        (
            Conv { child, stdin, turn: Arc::new(AtomicBool::new(false)), job: Some(job) },
            grandchild,
        )
    }

    /// What `tasklist` says about a pid: its row, or nothing if it is gone.
    /// Both questions the grandchild test asks come off this one shell-out —
    /// whether a process is alive, and which image it is running.
    #[cfg(windows)]
    fn row(pid: u32) -> String {
        let out = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .expect("tasklist");
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        /* A filter that matches nothing still prints a sentence — "INFO: No
           tasks are running which match the specified criteria." — so an
           answer counts as one only if the pid is in it. */
        if text.contains(&pid.to_string()) {
            text
        } else {
            String::new()
        }
    }

    #[cfg(windows)]
    fn alive(pid: u32) -> bool {
        !row(pid).is_empty()
    }

    /// The bug this covers: a card is never one process, and `child.kill()` is
    /// `TerminateProcess` — it reaches the `claude.exe` and nothing under it.
    /// So closing a card orphaned its MCP servers, its shells and whatever it
    /// had backgrounded, and quitting the app left the whole day's worth of
    /// them running with no window to see them from. Measured on 2026-08-19: 80
    /// descendants under one Skein for 6 cards, the oldest sixteen hours old.
    ///
    /// `shutdown` rather than `close_conversation` because it needs no
    /// `AppHandle`; both take the same path through the job.
    #[cfg(windows)]
    #[test]
    fn quitting_takes_a_card_s_grandchildren_with_it() {
        let sup = Supervisor::default();
        let (conv, grandchild) = child_with_a_grandchild();
        sup.0.lock().unwrap().insert("card".into(), conv);

        assert!(alive(grandchild), "the grandchild should have started");

        sup.shutdown();

        /* The kill is delivered by the kernel as the job's last handle closes,
           so it is prompt rather than instant. */
        let mut gone = false;
        for _ in 0..50 {
            if !alive(grandchild) {
                gone = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(
            gone,
            "pid {grandchild} outlived the card that started it — the job object is not holding the tree"
        );
    }

    /// A reader thread clears the row's mid-turn mark when its stream ends — a
    /// child that died holding a turn is a card saying so on the wall, and
    /// resuming it tomorrow spends money on a failure already shown. Quitting
    /// ends every stream the same way, so without this the kill would race the
    /// cards the mark exists for and clear exactly the ones worth keeping.
    #[test]
    fn shutdown_says_so_before_it_kills_anything() {
        let sup = Supervisor::default();
        assert!(!sup.going_away(), "a running app is not going anywhere");

        sup.shutdown();

        assert!(sup.going_away());
    }

    /// A turn opens on speech and closes on the result, and a spawn is neither.
    #[test]
    fn a_turn_opens_on_speech_and_closes_on_the_result() {
        assert_eq!(turn_mark("assistant"), Some(true));
        assert_eq!(turn_mark("user"), Some(true));
        assert_eq!(turn_mark("stream_event"), Some(true));
        assert_eq!(turn_mark("result"), Some(false));
        /* `system/init` arrives on every spawn, rousing's included — a card
           given its process back has said nothing and lost nothing. */
        assert_eq!(turn_mark("system"), None);
        assert_eq!(turn_mark("control_response"), None);
    }

    /// The bug this covers: nothing used to remove a finished child, so the id
    /// stayed in the map and `spawn_conversation` answered "already open"
    /// forever. `wake` believed it, and the next prompt went into a dead pipe.
    #[cfg(windows)]
    #[test]
    fn reaping_frees_the_id_and_reports_how_the_child_died() {
        let sup = Supervisor::default();
        sup.0.lock().unwrap().insert("c1".into(), dying_child(3));

        assert_eq!(sup.reap("c1"), Some(3), "the exit code never reached the card");
        assert!(
            !sup.0.lock().unwrap().contains_key("c1"),
            "a dead child kept its id, so the card could never be woken again"
        );
    }

    /// A deliberate close already removed and waited for the child, so there is
    /// nothing left to report — and nothing to panic about either.
    #[test]
    fn reaping_something_already_closed_is_quiet() {
        let sup = Supervisor::default();
        assert_eq!(sup.reap("never-existed"), None);
    }

    #[test]
    fn transcript_dir_matches_claude_codes_own_naming() {
        // Verified against the real directories on disk.
        assert_eq!(transcript_dir_name("C:\\atelier"), "C--atelier");
        assert_eq!(transcript_dir_name("C:\\atelier\\caravan"), "C--atelier-caravan");
        assert_eq!(
            transcript_dir_name("C:\\Users\\flori\\codes\\rise"),
            "C--Users-flori-codes-rise"
        );
    }

    #[test]
    fn forward_slashes_encode_the_same_way() {
        assert_eq!(transcript_dir_name("C:/atelier/skein"), "C--atelier-skein");
    }

    #[test]
    fn case_is_preserved() {
        // C--Users-... keeps its capital U on disk.
        assert_eq!(transcript_dir_name("C:\\Users"), "C--Users");
    }

    /// The bug: only separators folded, so `.scratch` kept its dot, the path
    /// missed, and every card under it stayed untitled. All three expectations
    /// are directory names claude 2.1.228 actually created — see the doc comment
    /// on `transcript_dir_name` for the probe.
    #[test]
    fn every_non_alphanumeric_folds_to_a_dash() {
        assert_eq!(
            transcript_dir_name("C:\\atelier\\skein\\.scratch\\wall"),
            "C--atelier-skein--scratch-wall"
        );
        assert_eq!(transcript_dir_name("slug_probe a.b+c"), "slug-probe-a-b-c");
        assert_eq!(transcript_dir_name("café_naïve-Ω9"), "caf--na-ve--9");
    }

    /// Replacement is per UTF-16 code unit, as in the JS that does it upstream,
    /// so a char outside the BMP is two dashes. `char`-wise mapping gives one.
    #[test]
    fn an_astral_char_folds_to_two_dashes() {
        assert_eq!(transcript_dir_name("emoji\u{1F33F}probe"), "emoji--probe");
    }
}

impl Supervisor {
    /// Take a finished conversation out of the map and collect its exit code.
    ///
    /// Called from the stdout reader once the stream ends. Returning `None` when
    /// the id is absent is the normal case for a deliberate close: the command
    /// already removed and waited for the child, so there is nothing to report
    /// and the card is on its way off the wall anyway. A code therefore only
    /// ever appears when the child went away on its own — which is exactly when
    /// the card needs to say so.
    /* A child that went away on its own still leaves its tree behind, so the
       job is swept here too — by `conv` being dropped at the end of the
       function, once the code has been read off it. */
    fn reap(&self, id: &str) -> Option<i32> {
        let mut conv = self.0.lock().unwrap().remove(id)?;
        conv.child.wait().ok().and_then(|status| status.code())
    }

    /// Whether the app is shutting down, asked by the reader threads as their
    /// streams end. See the note on the field.
    fn going_away(&self) -> bool {
        self.1.load(Ordering::Relaxed)
    }

    /// Which live process belongs to which conversation.
    ///
    /// The performance widget's whole reason for being inside Skein: a machine
    /// running six cards has six `claude.exe` in Task Manager and no way to tell
    /// which is which. The mapping is only meaningful while the child is alive,
    /// so it is read fresh on every sample rather than kept anywhere.
    pub fn pids(&self) -> HashMap<u32, String> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .map(|(id, conv)| (conv.child.id(), id.clone()))
            .collect()
    }

    /// Whether this card has a process, and whether a turn is open on it.
    ///
    /// The two halves of what `relay.rs` calls a card's state, and the two the
    /// database cannot answer: a row says what a card *is*, and only the map
    /// says whether anything is running. Read together under one lock, because
    /// asked separately they can disagree — a card that exits between the two
    /// questions reads as dormant and mid-turn at once.
    pub fn liveness(&self, id: &str) -> (bool, bool) {
        match self.0.lock().unwrap().get(id) {
            Some(conv) => (true, conv.turn.load(Ordering::Relaxed)),
            None => (false, false),
        }
    }

    /// Every process each card owns, pid → conversation id.
    ///
    /// `pids` answers with the `claude` process alone, which is all the
    /// performance meter needs in order to *recognise* a card and hang the rest
    /// off it by ancestry. This answers with the whole tree, which is what
    /// listing and reaping need, and the difference is not convenience: see
    /// `jobs::Job::pids` for why the parent map goes blind on exactly the
    /// processes worth finding.
    ///
    /// Only conversations. Dev servers and project runs hold jobs of their own
    /// and already have a visible stop apiece; a card's tree was the one with
    /// no way in.
    pub fn owned_pids(&self) -> HashMap<u32, String> {
        let mut out = HashMap::new();
        for (id, conv) in self.0.lock().unwrap().iter() {
            if let Some(job) = &conv.job {
                for pid in job.pids() {
                    out.insert(pid, id.clone());
                }
            }
        }
        out
    }

    /// Children die with the app. Nothing is left editing a repo unwatched.
    ///
    /// Returns the ids that were **mid-turn**, because they are the only ones
    /// that lost anything — see `store::mark_interrupted`.
    ///
    /// It used to return every id in the map, on the reading that a live child
    /// is a card that was working. That was already loose and rousing made it
    /// false for the whole wall: every dormant card is given its process back at
    /// launch, so by the time you quit, *every* card has a child here, every one
    /// of them was flagged interrupted, and the next launch sent the whole wall
    /// a `resumePrompt` — money and an agent apiece for turns that had finished
    /// hours ago. A process is not a turn; `Conv::turn` is the turn.
    ///
    /// Read before the kill rather than after: killing closes stdout, and the
    /// reader thread clears the flag on its way out.
    ///
    /// Raising `going_away` before the first kill is the other half of that. A
    /// reader thread now clears the *row's* mark as well when its stream ends,
    /// and every stream here is about to end — without this, quitting mid-turn
    /// would race the very cards it is meant to flag.
    pub fn shutdown(&self) -> Vec<String> {
        self.1.store(true, Ordering::Relaxed);
        let mut map = self.0.lock().unwrap();
        let mut lost = Vec::new();
        for (id, mut conv) in map.drain() {
            if conv.turn.load(Ordering::Relaxed) {
                lost.push(id);
            }
            /* "Children die with the app" was only ever true of the `claude`
               process itself; everything it had started stayed up. */
            drop(conv.job.take());
            let _ = conv.child.kill();
            let _ = conv.child.wait();
        }
        lost
    }
}
