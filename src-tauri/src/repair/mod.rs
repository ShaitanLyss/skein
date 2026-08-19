//! Making a conversation sendable again after a tool call poisoned it.
//!
//! A tool that reads a binary file as text puts bytes into the transcript that
//! no amount of retrying will get past the API, and from that moment every
//! message in that session carries them: the whole conversation goes back over
//! the wire each turn, so one bad tool result breaks every request after it.
//! The card looks like it is failing intermittently. It is not — it is failing
//! identically, forever.
//!
//! Found 2026-08-19 in `~/.claude/projects/C--Users-lyss-delprat-workbench/
//! 97d45f01-…jsonl`. The agent ran `grep -aoE "(Paste|paste)[^"]{0,70}"
//! claude.exe` to learn how the CLI words its login prompt — `-a` is "treat
//! this binary as text" — and the 11,340-character result carried **1,112 NUL
//! characters and 100 undecodable bytes**. Three sends of that conversation,
//! three `400 … unexpected end of data`, and `HEAL_BUDGET` spent on retries
//! that could not have worked. Note what the file did *not* contain: the
//! transcript is valid UTF-8 and holds no raw NUL, because the CLI sanitises
//! at capture — the undecodable bytes are already U+FFFD on disk and the NULs
//! are written as JSON escapes. So the poison is in the *characters* the
//! conversation holds, not in the file encoding, and a repair that only fixed
//! the bytes would find nothing wrong.
//!
//! What this does about it is what `classify.ts`'s heal could not: take the
//! bad characters out and say so *in the conversation*, in place of the data,
//! so the agent reads why its tool output is missing at exactly the point it
//! would otherwise be confused by the gap.
//!
//! The original is kept beside the repaired file until the conversation has
//! visibly moved on — see `discard_repair_backup`. Rewriting another program's
//! working file is the most invasive thing in this app that is not a spawn, and
//! a repair that guessed wrong should cost a rename to undo rather than a
//! session.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Manager};

mod text;
pub(crate) use text::{repair_text, RepairReport};

/// What the untouched original is called while it is kept.
///
/// Deliberately not `.bak`: this sits in a directory Claude Code owns and
/// enumerates, and a suffix with Skein's name on it says whose it is and who
/// should clean it up.
const BACKUP_SUFFIX: &str = ".skein-bak";

/// A backup nothing came back to collect is swept after this long.
///
/// `discard_repair_backup` is the ordinary path and runs a turn or two after
/// the repair. This is for the exit that does not run it — Skein killed, the
/// card closed, the wall torn down — because the alternative is a directory
/// that accumulates a copy of every repaired session forever.
const SWEEP_AFTER: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Where Claude Code keeps this session, and where the backup goes beside it.
fn paths(app: &AppHandle, cwd: &str, session_id: &str) -> Result<(PathBuf, PathBuf), String> {
    let live = crate::supervisor::transcript_path(app, cwd, session_id)?;
    let mut backup = live.clone().into_os_string();
    backup.push(BACKUP_SUFFIX);
    Ok((live, PathBuf::from(backup)))
}

/// Take the unsendable characters out of a session, keeping the original.
///
/// `Ok(None)` means the transcript was clean, which is the common answer and
/// not a failure: most `400 … unexpected end of data` really are the transport
/// hiccup the heal was written for, and this only claims the ones that are not.
///
/// Off the main thread via `crate::off_main` — a session is megabytes and this
/// parses every record of it, which on the main thread would stop the wall
/// painting for as long as it took. See the note on `off_main` in `lib.rs`.
#[tauri::command]
pub async fn repair_session(
    app: AppHandle,
    cwd: String,
    session_id: String,
) -> Result<Option<RepairReport>, String> {
    crate::off_main(move || repair_on_disk(&app, &cwd, &session_id)).await?
}

fn repair_on_disk(
    app: &AppHandle,
    cwd: &str,
    session_id: &str,
) -> Result<Option<RepairReport>, String> {
    let (live, backup) = paths(app, cwd, session_id)?;
    // A card that has never been spoken to has no transcript. Normal.
    let Ok(raw) = fs::read(&live) else {
        return Ok(None);
    };
    /* Lossy on purpose. The file has been valid UTF-8 every time it has been
       looked at, because the CLI sanitises when it captures — but this is a
       repair, and a repair that refuses to open a damaged file is no use on the
       day the assumption stops holding. Anything that would not decode becomes
       U+FFFD here and is then removed by the same pass that removes the ones
       the CLI wrote. */
    let text = String::from_utf8_lossy(&raw);
    let Some((fixed, mut report)) = repair_text(&text) else {
        return Ok(None);
    };

    fs::write(&backup, &raw).map_err(|e| format!("could not keep the original: {e}"))?;
    /* Written beside the file and renamed over it, so a crash mid-write leaves
       the session either untouched or repaired and never half of each. The
       temporary carries the session's name because this directory is one Claude
       Code enumerates, and a stray `tmp` in it should say whose it is. */
    let staged = live.with_extension("jsonl.skein-tmp");
    fs::write(&staged, fixed.as_bytes()).map_err(|e| format!("could not stage repair: {e}"))?;
    fs::rename(&staged, &live).map_err(|e| format!("could not put the repair in place: {e}"))?;

    report.backup = backup.to_string_lossy().to_string();
    Ok(Some(report))
}

/// Throw away the kept original, once the conversation has visibly moved on.
///
/// The front end calls this a turn or two after a repair rather than straight
/// away: a repair that broke the session shows up as the *next* turn failing,
/// and until a turn has succeeded there is nothing to say the repair was right.
/// Two turns of an agent working normally on a conversation is that evidence.
#[tauri::command]
pub async fn discard_repair_backup(
    app: AppHandle,
    cwd: String,
    session_id: String,
) -> Result<bool, String> {
    crate::off_main(move || {
        let (_, backup) = paths(&app, &cwd, &session_id)?;
        match fs::remove_file(&backup) {
            Ok(()) => Ok(true),
            // Already gone is the answer this wanted, not a failure.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(format!("could not discard the backup: {e}")),
        }
    })
    .await?
}

/// Collect backups nothing came back for.
///
/// Runs at startup. `discard_repair_backup` is the ordinary path and covers the
/// case where the app stayed up long enough to see the repair work; this is for
/// the exits that skip it, and it is the same argument as the job objects in
/// `supervisor.rs` — the promise "Skein cleans up after itself" is worth only
/// what runs when Skein does not get to finish.
#[tauri::command]
pub async fn sweep_repair_backups(app: AppHandle) -> Result<usize, String> {
    crate::off_main(move || {
        let home = app
            .path()
            .home_dir()
            .map_err(|e| format!("no home dir: {e}"))?;
        Ok(sweep_under(&home.join(".claude").join("projects")))
    })
    .await?
}

fn sweep_under(root: &Path) -> usize {
    let Ok(projects) = fs::read_dir(root) else {
        return 0;
    };
    let mut swept = 0usize;
    let now = SystemTime::now();
    for project in projects.flatten() {
        let Ok(files) = fs::read_dir(project.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if !path
                .to_string_lossy()
                .ends_with(BACKUP_SUFFIX)
            {
                continue;
            }
            let old = file
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| now.duration_since(t).ok())
                .is_some_and(|age| age > SWEEP_AFTER);
            if old && fs::remove_file(&path).is_ok() {
                swept += 1;
            }
        }
    }
    swept
}
