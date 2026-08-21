//! How far a running workflow has got, read off its own journal.
//!
//! The `Workflow` tool hands back a receipt and then says nothing for a quarter
//! of an hour. Its agents run on a stream this app never sees — no phase, no
//! start, no answer arrives on the wire — so a card with one running had no way
//! to report anything but *that* it was running. See `.claude/rules/turns.md`.
//!
//! What the runtime does leave on disk is a journal, one line per event, in the
//! run's own transcript directory (the receipt names it in full):
//!
//! ```text
//! {"type":"started","key":"v2:a5c5fe32…","agentId":"a16bc8af7b57d3e79"}
//! {"type":"result","key":"v2:a5c5fe32…","agentId":"a16bc8af7b57d3e79","result":{…}}
//! ```
//!
//! Read across all six runs and 52 agents on this machine (2026-08-21) those are
//! the only two record types and `type`, `key`, `agentId`, `result` the only four
//! keys. **There is no phase and no label anywhere in it** — which decides what
//! the wall may draw: how many agents are out and how many are back, and not one
//! word about which phase they belong to. The script's `meta.phases` is still
//! only a list of intentions.
//!
//! ### Polling, and why this one is allowed
//!
//! "Nothing polls" is a rule about honesty as much as cost: every card state is
//! a fold over events that arrived, so the wall can never show a reading the
//! stream did not justify. This is the second deliberate exception, and it is the
//! same exception the performance sampler already is — *nothing emits an event
//! when a workflow agent finishes*, so there is no fold to be had. The bound is
//! the same too: the front end asks only while a workflow job is live, and stops
//! the instant the last one settles (`crowds.svelte.ts`).
//!
//! And it is `async`, which is not optional. A `#[tauri::command]` without it
//! runs inline on the thread that drains the event loop, so a slow read would
//! stop *every card on the wall* from being painted for as long as it took —
//! the same trap `azdo_runs` fell into. `crate::off_main` is the pool built for
//! work that parks a thread.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// What one run's journal says. Deliberately two counts and nothing else: they
/// are the whole of what is in the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Progress {
    /// Agents the runtime has spawned.
    pub out: usize,
    /// Of those, how many have returned a result.
    pub back: usize,
}

/// One reading per directory asked about, in the order asked.
///
/// `None` for a run with no journal yet — which is the ordinary first second of
/// every workflow, not an error, and must read as "nothing to say" rather than
/// as zero agents. A directory that cannot be read at all answers the same way:
/// a card is not helped by an error where a count belongs, and the receipt that
/// named the directory is still proof the run started.
#[tauri::command]
pub async fn workflow_progress(dirs: Vec<String>) -> Result<Vec<Option<Progress>>, String> {
    crate::off_main(move || dirs.iter().map(|d| read_journal(Path::new(d))).collect()).await
}

fn journal_in(dir: &Path) -> PathBuf {
    dir.join("journal.jsonl")
}

/// Count the two record types in a journal.
///
/// Read line by line and never held whole: a journal is mostly `result` payloads
/// and an agent's return value runs to fifteen thousand characters, so this file
/// reaches megabytes on a large run and is being appended to while we read it.
fn read_journal(dir: &Path) -> Option<Progress> {
    let file = std::fs::File::open(journal_in(dir)).ok()?;
    let mut out = 0usize;
    let mut back = 0usize;
    for line in BufReader::new(file).lines() {
        /* A line that will not decode is the tail of the file being written as
           we read it. Skipped rather than fatal — the next tick sees it whole. */
        let Ok(line) = line else { continue };
        match record_type(&line) {
            Some("started") => out += 1,
            Some("result") => back += 1,
            _ => {}
        }
    }
    Some(Progress { out, back })
}

/// The `type` of one journal line, by the cheapest sound method.
///
/// **Not a substring search.** A `result` record embeds whatever the agent
/// returned, and an agent that reviewed this very file would put the literal
/// text `"type":"started"` inside its own result — so counting occurrences would
/// have the run go backwards. The writer emits `type` first in all 81 records
/// measured, so the prefix settles it without touching the payload; anything
/// else falls through to a real parse, which is correct at the cost of a
/// megabyte of JSON on a line whose shape has changed. Being *right* when the
/// format moves matters more here than being fast, because the failure mode of
/// the fast path alone is a silent zero — a workflow that looks like it never
/// started an agent.
fn record_type(line: &str) -> Option<&'static str> {
    let s = line.trim_start();
    if s.starts_with(r#"{"type":"started""#) {
        return Some("started");
    }
    if s.starts_with(r#"{"type":"result""#) {
        return Some("result");
    }
    match serde_json::from_str::<serde_json::Value>(s).ok()?.get("type")?.as_str()? {
        "started" => Some("started"),
        "result" => Some("result"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A run directory with a journal in it. `std::env::temp_dir` and a uuid,
    /// which is what every other test in this crate does — there is no
    /// `tempfile` dev-dependency and one file per test is not the reason to
    /// add one. Left behind on purpose: a failing test's journal is the first
    /// thing you would want to read.
    fn run(lines: &[&str]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("volery-wf-{}", crate::store::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut f = std::fs::File::create(journal_in(&dir)).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        dir
    }

    /// Verbatim shapes, from `wf_9157cd8c-f79` on this machine.
    const STARTED: &str = r#"{"type":"started","key":"v2:a5c5fe32","agentId":"a16bc8af7b57d3e79"}"#;
    const RESULT: &str =
        r#"{"type":"result","key":"v2:a5c5fe32","agentId":"a16bc8af7b57d3e79","result":{"findings":[]}}"#;

    #[test]
    fn four_out_and_two_back() {
        let p = run(&[STARTED, STARTED, STARTED, STARTED, RESULT, RESULT]);
        assert_eq!(read_journal(&p), Some(Progress { out: 4, back: 2 }));
    }

    #[test]
    fn no_journal_yet_is_nothing_to_say_and_not_zero() {
        let dir = std::env::temp_dir().join(format!("volery-wf-{}", crate::store::uuid_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_journal(&dir), None);
        /* And an empty journal *is* zero: the run has one and has started
           nobody, which is a reading rather than an absence. */
        assert_eq!(read_journal(&run(&[])), Some(Progress { out: 0, back: 0 }));
    }

    /// The bug the prefix check exists to prevent: an agent whose own result
    /// quotes a journal line. Counting substrings makes such a run go backwards.
    #[test]
    fn a_result_quoting_a_journal_line_counts_once() {
        let sneaky = r#"{"type":"result","agentId":"a1","result":{"note":"the file holds {\"type\":\"started\"} lines"}}"#;
        let p = run(&[STARTED, sneaky]);
        assert_eq!(read_journal(&p), Some(Progress { out: 1, back: 1 }));
    }

    /// A journal being appended to while it is read ends in half a line.
    #[test]
    fn a_half_written_tail_is_skipped_rather_than_fatal() {
        let p = run(&[STARTED, RESULT]);
        let mut f = std::fs::OpenOptions::new().append(true).open(journal_in(&p)).unwrap();
        write!(f, "{{\"type\":\"resu").unwrap();
        assert_eq!(read_journal(&p), Some(Progress { out: 1, back: 1 }));
    }

    /// The fallback. Same records with the keys in another order: the prefix
    /// misses and the parse has to carry it, or the day the writer reorders its
    /// fields every workflow reads as one that never started an agent.
    #[test]
    fn a_reordered_record_still_counts() {
        let p = run(&[
            r#"{"agentId":"a1","type":"started","key":"v2:x"}"#,
            r#"{"agentId":"a1","key":"v2:x","type":"result","result":{}}"#,
        ]);
        assert_eq!(read_journal(&p), Some(Progress { out: 1, back: 1 }));
    }

    #[test]
    fn anything_else_in_the_file_is_ignored() {
        let p = run(&[STARTED, "", "not json at all", r#"{"type":"phase","title":"Audit"}"#]);
        assert_eq!(read_journal(&p), Some(Progress { out: 1, back: 0 }));
    }
}
