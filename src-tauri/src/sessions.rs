//! What Claude Code has already recorded, for conversations Skein never opened.
//!
//! A session started in the terminal is a `.jsonl` under
//! `~/.claude/projects/<slug>/`, and Skein can adopt one by doing nothing more
//! than writing a row that points at it: nothing is copied, nothing moves, and
//! the file stays the shared surface both front ends append to.
//!
//! Two things about this walk are deliberate.
//!
//! **Identity comes from inside the file, never from the directory name.** The
//! slug folds every non-alphanumeric character to a dash (see
//! `supervisor::transcript_dir_name`), so `.scratch` and `-scratch` land in the
//! same place and no decoding can tell them apart. Every record carries its own
//! `cwd` — 97 of 97 transcripts here — so the catalogue reads that instead.
//!
//! **At most three lines per file are parsed as JSON.** The 97 transcripts on
//! this machine are 84 MB and the largest is 4 MB, nearly all of it tool
//! results nobody is listing. Only the last `ai-title` and the last `assistant`
//! record say anything a picker shows, so the scan carries those two lines
//! forward as text and parses them once the file is done.

use std::fs::File;
use std::io::{BufRead, BufReader};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// A conversation on disk that no card points at yet.
#[derive(Serialize)]
pub struct Session {
    /// The session id, which is the filename — and what `--resume` takes.
    id: String,
    cwd: String,
    branch: Option<String>,
    title: Option<String>,
    /// The bare API name from the last answered message. It carries no window
    /// tier — see the note in `list_sessions`.
    model: Option<String>,
    /// What the last request actually occupied. Left as tokens rather than a
    /// fraction because the front end owns the window arithmetic.
    ctx_tokens: u64,
    /// ISO timestamps, exactly as recorded.
    born_at: Option<String>,
    last_at: Option<String>,
    bytes: u64,
}

/// Pull `"key":"value"` out of a line without parsing it.
///
/// Only used for fields whose values are plain ISO strings or paths — the point
/// is to avoid deserialising megabytes of tool output to learn a timestamp.
fn field(line: &str, key: &str) -> Option<String> {
    let pat = format!("\"{key}\":\"");
    let start = line.find(&pat)? + pat.len();
    let rest = &line[start..];
    let mut out = String::new();
    let mut chars = rest.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(out),
            '\\' => {
                /* Windows paths arrive as `C:\\atelier\\skein`. Nothing else
                   escaped appears in the fields read here. */
                let next = chars.next()?;
                out.push(if next == 'n' { '\n' } else { next });
            }
            _ => out.push(c),
        }
    }
    None
}

/// Every transcript Claude Code has written, newest activity first.
///
/// Deliberately says nothing about which of these Skein already knows: the
/// front end holds the wall and can answer that without a query. And it counts
/// no messages — deciding what is a prompt rather than injected context or a
/// subagent's turn is `history.ts`'s job, and duplicating those rules here
/// would give the two readers a chance to disagree.
#[tauri::command]
pub fn list_sessions(app: AppHandle) -> Result<Vec<Session>, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home dir: {e}"))?;
    let root = home.join(".claude").join("projects");

    let Ok(dirs) = std::fs::read_dir(&root) else {
        // No CLI sessions on this machine at all is an empty list, not a fault.
        return Ok(Vec::new());
    };

    let mut out: Vec<Session> = Vec::new();
    for dir in dirs.flatten() {
        if !dir.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let Ok(files) = std::fs::read_dir(dir.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(id) = path.file_stem().and_then(|s| s.to_str()).map(String::from) else {
                continue;
            };
            let bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
            let Ok(handle) = File::open(&path) else {
                continue;
            };

            let mut cwd: Option<String> = None;
            let mut branch: Option<String> = None;
            let mut born_at: Option<String> = None;
            let mut last_at: Option<String> = None;
            let mut last_title_line: Option<String> = None;
            let mut last_assistant_line: Option<String> = None;

            for line in BufReader::new(handle).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                if cwd.is_none() {
                    cwd = field(&line, "cwd");
                }
                if branch.is_none() {
                    branch = field(&line, "gitBranch").filter(|b| !b.is_empty());
                }
                if let Some(ts) = field(&line, "timestamp") {
                    born_at.get_or_insert_with(|| ts.clone());
                    last_at = Some(ts);
                }
                if line.contains("\"ai-title\"") {
                    last_title_line = Some(line.clone());
                }
                /* The usage test is what makes this the last *answered*
                   message: a refusal or an interrupted stream carries none. */
                if line.contains("\"type\":\"assistant\"") && line.contains("\"usage\"") {
                    last_assistant_line = Some(line);
                }
            }

            /* No cwd means nothing addressable; no assistant record means the
               session never got an answer and there is nothing to resume. Three
               of the 97 transcripts here are one or the other. */
            let (Some(cwd), Some(assistant)) = (cwd, last_assistant_line.as_ref()) else {
                continue;
            };

            let title = last_title_line
                .as_deref()
                .and_then(|l| serde_json::from_str::<serde_json::Value>(l).ok())
                .and_then(|v| {
                    v.get("aiTitle")
                        .and_then(|t| t.as_str())
                        .map(str::trim)
                        .filter(|t| !t.is_empty())
                        .map(String::from)
                });

            let mut model = None;
            let mut ctx_tokens = 0u64;
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(assistant) {
                let msg = v.get("message");
                /* The bare API name, with no window tier — `[1m]` reaches the
                   wire only on `system/init`, which is not written to the
                   transcript. An imported card therefore cannot know its window
                   until it wakes; `#adoptModel` settles it then. */
                model = msg
                    .and_then(|m| m.get("model"))
                    .and_then(|m| m.as_str())
                    .map(String::from);
                if let Some(u) = msg.and_then(|m| m.get("usage")) {
                    let n = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                    /* Matches the live fold exactly — and note it is this
                       message's usage, never a sum across the turn. */
                    ctx_tokens = n("input_tokens")
                        + n("cache_read_input_tokens")
                        + n("cache_creation_input_tokens")
                        + n("output_tokens");
                }
            }

            out.push(Session {
                id,
                cwd,
                branch,
                title,
                model,
                ctx_tokens,
                born_at,
                last_at,
                bytes,
            });
        }
    }

    out.sort_by(|a, b| b.last_at.cmp(&a.last_at));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::field;

    #[test]
    fn a_field_is_read_without_parsing_the_line() {
        let line = r#"{"type":"user","timestamp":"2026-08-11T05:38:38.213Z","cwd":"C:\\atelier\\caravan"}"#;
        assert_eq!(
            field(line, "timestamp"),
            Some("2026-08-11T05:38:38.213Z".into())
        );
        // The escaped separators have to survive, or nothing matches a project.
        assert_eq!(field(line, "cwd"), Some("C:\\atelier\\caravan".into()));
    }

    #[test]
    fn an_absent_field_is_absent_rather_than_wrong() {
        let line = r#"{"type":"queue-operation","operation":"enqueue"}"#;
        assert_eq!(field(line, "cwd"), None);
        assert_eq!(field(line, "timestamp"), None);
    }

    /// Tool output is full of text that looks like a field. Reading stops at the
    /// closing quote of the value, so a later mention cannot overwrite it.
    #[test]
    fn the_first_match_wins_and_stops_at_its_own_quote() {
        let line = r#"{"cwd":"C:\\atelier","content":"the \"cwd\":\"C:\\elsewhere\" was printed"}"#;
        assert_eq!(field(line, "cwd"), Some("C:\\atelier".into()));
    }
}
