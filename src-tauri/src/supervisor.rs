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
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
/// Keep spawned children from flashing a console window on Windows.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct Conv {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct Supervisor(pub Mutex<HashMap<String, Conv>>);

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
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn spawn_conversation(
    app: AppHandle,
    sup: State<'_, Supervisor>,
    id: String,
    session_id: Option<String>,
    cwd: String,
    model: Option<String>,
    resume: Option<bool>,
    worktree: Option<String>,
) -> Result<(), String> {
    if sup.0.lock().unwrap().contains_key(&id) {
        return Err(format!("conversation {id} is already open"));
    }
    let session = session_id.as_deref().filter(|s| !s.is_empty()).unwrap_or(&id);

    let mut cmd = Command::new("claude");
    cmd.current_dir(&cwd)
        .arg("--print")
        .args(["--input-format", "stream-json"])
        .args(["--output-format", "stream-json"])
        .arg("--verbose")
        .arg("--include-partial-messages")
        .arg("--replay-user-messages")
        .arg("--forward-subagent-text")
        .arg("--dangerously-skip-permissions");

    if resume.unwrap_or(false) {
        cmd.args(["--resume", session]);
    } else {
        cmd.args(["--session-id", session]);
        /* Only on a fresh spawn: `--worktree` *creates* one, so passing it
           while resuming would try to branch a session that already lives in
           its own tree. */
        if let Some(name) = worktree.as_deref().filter(|n| !n.trim().is_empty()) {
            cmd.args(["--worktree", name]);
        }
    }
    if let Some(m) = model {
        cmd.args(["--model", &m]);
    }

    /* Hand the agent a way to ask us something. The URL carries the
       conversation id, so a call arrives already addressed to a card. */
    let ask_port = app.state::<crate::ask::Asks>().port();
    if ask_port != 0 {
        let cfg = serde_json::json!({
            "mcpServers": {
                "skein": { "type": "http", "url": format!("http://127.0.0.1:{ask_port}/mcp/{id}") }
            }
        });
        cmd.args(["--mcp-config", &cfg.to_string()]);
        cmd.args([
            "--append-system-prompt",
            "When you need a decision that only the user can make, call the \
             `ask_user` tool rather than ending your turn with a question. It \
             keeps your turn open and resumes the moment they answer. Give it \
             `options` whenever the answer is a choice between alternatives.",
        ]);
    }

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start claude in {cwd}: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout on child")?;
    let stderr = child.stderr.take().ok_or("no stderr on child")?;
    let stdin = child.stdin.take().ok_or("no stdin on child")?;

    // stdout: one JSON object per line. Anything unparseable is surfaced rather
    // than swallowed — a silent drop here would be very hard to debug later.
    {
        let app = app.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<serde_json::Value>(&line) {
                    Ok(event) => {
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

    sup.0.lock().unwrap().insert(id, Conv { child, stdin });
    Ok(())
}

/// Send one user turn. The wire format is the same envelope the Agent SDK uses.
#[tauri::command]
pub fn send_prompt(sup: State<'_, Supervisor>, id: String, text: String) -> Result<(), String> {
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
        .map_err(|e| format!("flush claude stdin: {e}"))
}

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
fn transcript_path(app: &AppHandle, cwd: &str, session_id: &str) -> Result<PathBuf, String> {
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
#[tauri::command]
pub fn read_transcript(
    app: AppHandle,
    cwd: String,
    session_id: String,
    max_bytes: Option<u64>,
) -> Result<Option<Transcript>, String> {
    /* Enough for any transcript on this machine, and a bound rather than a
       promise: 8 MB of NDJSON folds to a few thousand lines, of which the front
       end keeps the last few hundred. */
    const DEFAULT_CAP: u64 = 8 * 1024 * 1024;
    let cap = max_bytes.unwrap_or(DEFAULT_CAP).max(1);

    let path = transcript_path(&app, &cwd, &session_id)?;
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
#[tauri::command]
pub fn read_ai_title(
    app: AppHandle,
    cwd: String,
    session_id: String,
) -> Result<Option<String>, String> {
    let path = transcript_path(&app, &cwd, &session_id)?;

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
        let _ = conv.child.kill();
        let _ = conv.child.wait();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::transcript_dir_name;

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
        Conv { child, stdin }
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
    fn reap(&self, id: &str) -> Option<i32> {
        let mut conv = self.0.lock().unwrap().remove(id)?;
        conv.child.wait().ok().and_then(|status| status.code())
    }

    /// Children die with the app. Nothing is left editing a repo unwatched.
    ///
    /// Returns the ids that were actually running, because they are the only ones
    /// that lost a turn — see `store::mark_interrupted`.
    pub fn shutdown(&self) -> Vec<String> {
        let mut map = self.0.lock().unwrap();
        let mut running = Vec::with_capacity(map.len());
        for (id, mut conv) in map.drain() {
            let _ = conv.child.kill();
            let _ = conv.child.wait();
            running.push(id);
        }
        running
    }
}
