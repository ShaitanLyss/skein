//! The pure half of a repair: what counts as unsendable, and what to put in
//! its place.
//!
//! Split from the file handling next door so it can be exercised without a
//! home directory or an `AppHandle`. That is not tidiness — on a machine with
//! no MSVC toolchain `cargo test` cannot run at all (`.claude/rules/build.md`,
//! the `0xC0000139` note), and a scratch crate that includes just this file is
//! the only way the assertions below get run there.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;

/// A U+FFFD or two is somebody *discussing* one; a screenful is binary.
///
/// The replacement character is legal in prose and this repair rewrites another
/// program's file, so the benefit of the doubt goes to leaving text alone. NUL
/// gets no such latitude — see `contaminated`.
const FFFD_TOLERANCE: usize = 3;

/// What a repair took out, for the card to say and the note to name.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct RepairReport {
    /// Records that carried contamination.
    pub records: usize,
    /// Characters removed from the conversation.
    pub chars_removed: usize,
    /// NUL and other C0 control characters found.
    pub nuls: usize,
    /// Characters the CLI had already stood in for, because they would not
    /// decode as UTF-8 when it captured them.
    pub undecodable: usize,
    /// The commands whose output carried it. Named in the note so the agent
    /// can decide whether it needs to run one again differently.
    pub commands: Vec<String>,
    /// Where the untouched original is, until the conversation has moved on.
    pub backup: String,
}

/// NULs and C0 controls, then already-replaced undecodable characters.
///
/// Tab, newline and carriage return are ordinary text and are not counted —
/// every tool result on the wall is full of them.
fn bad_counts(s: &str) -> (usize, usize) {
    let mut control = 0usize;
    let mut undecodable = 0usize;
    for c in s.chars() {
        let n = c as u32;
        if c == '\u{FFFD}' {
            undecodable += 1;
        } else if n == 0x7f || (n < 0x20 && c != '\t' && c != '\n' && c != '\r') {
            control += 1;
        }
    }
    (control, undecodable)
}

/// Is this string carrying something that cannot be sent?
///
/// One control character is enough, because there is no honest way for a NUL to
/// be in a conversation — nothing types one and nothing means one. Undecodable
/// characters need `FFFD_TOLERANCE` of them, since unlike NUL they have a
/// legitimate use: a message about encodings may well contain one.
fn contaminated(s: &str) -> bool {
    let (control, undecodable) = bad_counts(s);
    control > 0 || undecodable >= FFFD_TOLERANCE
}

/// The same string with the unsendable characters gone.
///
/// Used for the conversation's *prose* — an assistant message, a prompt —
/// where the text is the thing worth keeping and the stray character is not.
/// Tool results are handled the other way round; see `note_for`.
fn stripped(s: &str) -> String {
    s.chars()
        .filter(|c| {
            let n = *c as u32;
            !(*c == '\u{FFFD}' || n == 0x7f || (n < 0x20 && *c != '\t' && *c != '\n' && *c != '\r'))
        })
        .collect()
}

/// What stands in the conversation where the tool output used to be.
///
/// Addressed to the agent rather than to the reader, and it is the whole reason
/// this is a repair and not a refusal: an agent that finds its `grep` output
/// silently missing will run it again the same way. One that reads why will
/// not.
fn note_for(chars: usize, nuls: usize, undecodable: usize, command: Option<&str>) -> String {
    let mut note = format!(
        "[skein removed {chars} characters of binary output from this tool result — \
         {nuls} NUL characters and {undecodable} bytes that would not decode. They made \
         every request in this conversation unsendable, so the API rejected the whole \
         turn rather than this one result."
    );
    if let Some(cmd) = command {
        note.push_str(&format!(" The command was: {cmd}."));
    }
    note.push_str(
        " Re-run it in a way that cannot emit binary — grep without -a, or pipe through \
         `strings` — if you still need what it said.]",
    );
    note
}

/// Short form, for the second and later contaminated strings in one result.
const BRIEF_NOTE: &str = "[skein removed further binary output from this tool result.]";

/// Whether a record's own `message.content` is a tool result, and whose.
fn tool_use_id_of(record: &Value) -> Option<String> {
    let content = record.get("message")?.get("content")?.as_array()?;
    for block in content {
        if block.get("type").and_then(Value::as_str) == Some("tool_result") {
            if let Some(id) = block.get("tool_use_id").and_then(Value::as_str) {
                return Some(id.to_string());
            }
        }
    }
    None
}

/// Remember what each `tool_use` asked for, so a later result can name it.
///
/// The command is the useful half — `tool_use` carries `input.command` for
/// Bash, and for everything else the compact input is closer to a description
/// than the tool's name alone would be.
fn learn_tool_uses(record: &Value, names: &mut HashMap<String, String>) {
    let Some(content) = record
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return;
    };
    for block in content {
        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let Some(id) = block.get("id").and_then(Value::as_str) else {
            continue;
        };
        let input = block.get("input");
        let said = input
            .and_then(|i| i.get("command"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| input.map(|i| i.to_string()))
            .unwrap_or_default();
        let name = block
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("a tool");
        let mut summary = if said.is_empty() {
            name.to_string()
        } else {
            format!("{name} {said}")
        };
        /* A command long enough to be worth truncating is long enough that its
           first line is what identifies it. */
        if summary.chars().count() > 300 {
            summary = summary.chars().take(300).collect::<String>() + "…";
        }
        names.insert(id.to_string(), summary);
    }
}

/// Replace every contaminated string under `v` with the note. Returns how many
/// it replaced.
fn replace_contaminated(
    v: &mut Value,
    command: Option<&str>,
    report: &mut RepairReport,
    replaced_here: &mut usize,
) {
    match v {
        Value::String(s) => {
            if !contaminated(s) {
                return;
            }
            let (nuls, undecodable) = bad_counts(s);
            report.chars_removed += s.chars().count();
            report.nuls += nuls;
            report.undecodable += undecodable;
            *s = if *replaced_here == 0 {
                note_for(s.chars().count(), nuls, undecodable, command)
            } else {
                BRIEF_NOTE.to_string()
            };
            *replaced_here += 1;
        }
        Value::Array(items) => {
            for item in items {
                replace_contaminated(item, command, report, replaced_here);
            }
        }
        Value::Object(map) => {
            for (_, item) in map.iter_mut() {
                replace_contaminated(item, command, report, replaced_here);
            }
        }
        _ => {}
    }
}

/// Take the unsendable characters out of every remaining string, in place.
///
/// This runs after the tool results have been dealt with, and catches the rest:
/// an assistant message that quoted a byte, a prompt pasted out of a terminal.
/// It strips rather than replaces, because prose is worth keeping.
fn strip_everything_else(v: &mut Value, report: &mut RepairReport) -> bool {
    match v {
        Value::String(s) => {
            if !contaminated(s) {
                return false;
            }
            let (nuls, undecodable) = bad_counts(s);
            let clean = stripped(s);
            report.chars_removed += s.chars().count() - clean.chars().count();
            report.nuls += nuls;
            report.undecodable += undecodable;
            *s = clean;
            true
        }
        Value::Array(items) => {
            let mut hit = false;
            for item in items {
                hit |= strip_everything_else(item, report);
            }
            hit
        }
        Value::Object(map) => {
            let mut hit = false;
            for (_, item) in map.iter_mut() {
                hit |= strip_everything_else(item, report);
            }
            hit
        }
        _ => false,
    }
}

/// Repair one record. `None` if there was nothing wrong with it.
///
/// Unparseable lines come back `None` untouched, deliberately: a line this
/// cannot read is a line it must not rewrite, and the file belongs to something
/// else.
fn repair_record(
    line: &str,
    names: &mut HashMap<String, String>,
    report: &mut RepairReport,
) -> Option<String> {
    let mut record: Value = serde_json::from_str(line).ok()?;
    learn_tool_uses(&record, names);

    let before = RepairReport {
        chars_removed: report.chars_removed,
        ..Default::default()
    };
    let command = tool_use_id_of(&record).and_then(|id| names.get(&id).cloned());

    let mut replaced_here = 0usize;
    if let Some(content) = record
        .get_mut("message")
        .and_then(|m| m.get_mut("content"))
        .and_then(Value::as_array_mut)
    {
        for block in content {
            if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                replace_contaminated(block, command.as_deref(), report, &mut replaced_here);
            }
        }
    }
    /* Claude Code writes the result twice — once as the API block above and
       once as its own richer `toolUseResult` — and a repair that cleaned only
       one of them would leave the conversation exactly as unsendable as it
       found it. */
    if let Some(extra) = record.get_mut("toolUseResult") {
        replace_contaminated(extra, command.as_deref(), report, &mut replaced_here);
    }

    let stripped_any = strip_everything_else(&mut record, report);

    if replaced_here == 0 && !stripped_any {
        return None;
    }
    if let Some(cmd) = command {
        if !report.commands.contains(&cmd) {
            report.commands.push(cmd);
        }
    }
    report.records += 1;
    let _ = before;
    serde_json::to_string(&record).ok()
}

/// Repair a whole transcript in memory. Returns the new text, or `None` when
/// there was nothing to do.
///
/// Separated from the file handling so the interesting half is testable without
/// a home directory — `cargo test` cannot run on a no-MSVC machine, but the
/// assertions are worth having where it can.
pub(crate) fn repair_text(text: &str) -> Option<(String, RepairReport)> {
    let mut names: HashMap<String, String> = HashMap::new();
    let mut report = RepairReport::default();
    let mut out = String::with_capacity(text.len());
    let mut touched = false;

    for line in text.split_inclusive('\n') {
        let (body, eol) = match line.strip_suffix('\n') {
            Some(b) => (b, "\n"),
            None => (line, ""),
        };
        if body.trim().is_empty() {
            out.push_str(line);
            continue;
        }
        match repair_record(body, &mut names, &mut report) {
            Some(fixed) => {
                touched = true;
                out.push_str(&fixed);
                out.push_str(eol);
            }
            None => out.push_str(line),
        }
    }

    touched.then_some((out, report))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shape the real one had: a Bash `tool_use`, then its result carrying
    /// NULs and replacement characters, written twice as the CLI writes it.
    fn poisoned() -> String {
        let junk = "Paste\u{0}\u{0}\u{1c}code\u{FFFD}\u{FFFD}\u{FFFD}here";
        let use_line = serde_json::json!({
            "type": "assistant",
            "message": { "content": [{
                "type": "tool_use",
                "id": "toolu_01AM",
                "name": "Bash",
                "input": { "command": "grep -aoE \"(Paste|paste)\" claude.exe" }
            }]}
        });
        let result_line = serde_json::json!({
            "type": "user",
            "message": { "content": [{
                "type": "tool_result",
                "tool_use_id": "toolu_01AM",
                "content": junk
            }]},
            "toolUseResult": { "stdout": junk, "stderr": "" }
        });
        format!("{use_line}\n{result_line}\n")
    }

    #[test]
    fn a_clean_transcript_is_left_alone() {
        let clean = "{\"type\":\"user\",\"message\":{\"content\":\"hello\"}}\n";
        assert!(repair_text(clean).is_none(), "nothing to repair, so no rewrite");
    }

    #[test]
    fn binary_in_a_tool_result_is_taken_out_and_accounted_for() {
        let (fixed, report) = repair_text(&poisoned()).expect("this one needed repair");
        assert!(!fixed.contains('\u{0}'), "no NUL survives");
        assert!(!fixed.contains('\u{FFFD}'), "no undecodable character survives");
        assert_eq!(report.records, 1, "one record carried it");
        assert_eq!(report.nuls, 6, "three control characters, in both copies");
        assert_eq!(report.undecodable, 6, "three replacement characters, in both copies");
    }

    #[test]
    fn the_note_names_the_command_so_the_agent_can_judge_it() {
        let (fixed, report) = repair_text(&poisoned()).unwrap();
        assert!(
            fixed.contains("grep -aoE"),
            "the note says which command produced it: {fixed}"
        );
        assert!(fixed.contains("skein removed"), "and that skein did the removing");
        assert_eq!(report.commands.len(), 1);
    }

    #[test]
    fn both_copies_of_the_result_are_cleaned() {
        /* The API block and `toolUseResult` are the same output written twice.
           Cleaning one leaves the conversation exactly as unsendable. */
        let (fixed, _) = repair_text(&poisoned()).unwrap();
        let record: Value = fixed.lines().nth(1).map(serde_json::from_str).unwrap().unwrap();
        let extra = record["toolUseResult"]["stdout"].as_str().unwrap();
        assert!(extra.contains("skein removed"), "toolUseResult was cleaned too");
    }

    #[test]
    fn a_line_that_will_not_parse_is_not_rewritten() {
        let broken = "{not json at all\n";
        assert!(repair_text(broken).is_none(), "a line this cannot read, it must not touch");
    }

    #[test]
    fn prose_keeps_its_text_and_loses_only_the_bad_character() {
        let line = serde_json::json!({
            "type": "assistant",
            "message": { "content": [{ "type": "text", "text": "before\u{0}after" }] }
        })
        .to_string();
        let (fixed, _) = repair_text(&format!("{line}\n")).unwrap();
        assert!(
            fixed.contains("beforeafter"),
            "an assistant message is stripped, not replaced: {fixed}"
        );
    }

    #[test]
    fn a_message_mentioning_one_replacement_character_is_not_touched() {
        /* U+FFFD has an honest use and this rewrites somebody else's file, so
           the benefit of the doubt goes to leaving text alone. NUL gets none. */
        let line = serde_json::json!({
            "type": "assistant",
            "message": { "content": [{ "type": "text", "text": "the char is \u{FFFD}, see?" }] }
        })
        .to_string();
        assert!(repair_text(&format!("{line}\n")).is_none());
    }
}
