//! The hooks Skein hands its cards, and the filter mode that serves them.
//!
//! One hook so far, and it exists to undo a bug in the tool it is handed to.
//!
//! # The Bash tool halves runs of backslashes
//!
//! Measured 2026-08-21 against claude 2.1.233 on Windows, by comparing three
//! points for the same tool call: what the API emitted (the transcript record),
//! what a `PreToolUse` hook was handed, and what arrived on disk. Something
//! between the tool call and the shell puts the `command` string through one
//! left-to-right `\\` → `\` pass. A heredoc of known runs:
//!
//! ```text
//! emitted  1  2  3  4  5  6
//! arrived  1  1  2  2  3  3        i.e. ceil(n/2)
//! ```
//!
//! **It is not the shell**, and that is the part that cost four sessions a
//! workaround each. Every one of them wrote a correctly *quoted* heredoc
//! (`<<'EOF'`), which does no backslash processing whatsoever, and blamed the
//! heredoc anyway — the collapse also hits single-quoted arguments and one-line
//! commands, so bash never had the chance. Nor is it a JSON or C unescape:
//! `\n`, `\"`, `\$`, `` \` `` and a lone backslash all arrive intact.
//!
//! There is one exception, and it is why `compensate` scans runs instead of
//! calling `.replace("\\\\", "\\")`: **a run immediately followed by `"` is
//! passed through whole.** That is what made
//! `awk '{ gsub(/\\/,"\\") }'` arrive as `gsub(/\/,"\\")` — the first pair
//! halved, the second, sitting against a quote, not. Measured: runs of 1, 2, 3
//! and 4 before a `"` all survive; before `'`, before a letter, and at end of
//! line they halve. A single quote does not protect, so `"` is the whole of the
//! rule.
//!
//! Why it is worth carrying code for: the failure is silent. The command
//! succeeds, the file is written, and the damage surfaces later as a path with
//! one backslash where two were meant —
//! `new Database(APPDATA + "\\dev.skein.studio\\skein.db")` reached disk as
//! `"\dev…"` and only announced itself as `SQLITE_CANTOPEN`. Four sessions
//! across three repositories hit it between 2026-08-11 and 2026-08-21, each
//! diagnosed it as the heredoc, each reached for the Write tool instead, and
//! none of them left a note.
//!
//! # Why the compensator is in this binary
//!
//! A `PreToolUse` hook fires on *every* Bash call of every card, so its startup
//! cost is a tax on the whole wall: this is ~5ms, a Python script measured ~50ms
//! and PowerShell 5.1 is upwards of 200ms. It also removes the question of what
//! is installed — a machine that has just downloaded Skein need not also have an
//! interpreter, which is the entire point of the fix travelling with the app.
//!
//! The hook is handed over in the `--settings` layer `supervisor` already passes,
//! so **nothing outside Skein is written**. The cost of that choice, chosen
//! deliberately: a `claude` run from a terminal on the same machine still eats
//! backslashes. Fixing that would mean Skein editing `~/.claude/settings.json`,
//! and this is not an app that writes to the user's global config — see
//! `accounts.rs`, which goes out of its way to hold none of it.
//!
//! The two layers were measured not to compound, which is what makes the split
//! safe rather than a trap: with a compensating hook in *both* the user's
//! settings and the flag layer, the result was one doubling, not two. Hooks from
//! different sources are handed the original input, so the last `updatedInput`
//! wins rather than chaining. If they had chained, every backslash on a machine
//! with a global hook installed would have quadrupled.
//!
//! # When to take this out
//!
//! The day the Bash tool stops halving backslashes, this starts *adding* them.
//! `compensate` is exercised by `cargo test` against a model of the collapse,
//! which cannot see an upstream fix — only a live probe can. The check is one
//! throwaway session; `.claude/rules/hooks.md` spells it out.

use std::io::Read;

/// The argument that turns this binary into a hook filter instead of an app.
///
/// Deliberately not a bare `--hook`: the string appears in the argv of every
/// card's `claude`, and the next person to read it there deserves to know which
/// hook without opening this file.
pub const FLAG: &str = "--bash-hook";

/// Double every run of backslashes the Bash tool will halve, and leave the ones
/// it will not.
///
/// The exact inverse of the measured collapse: an unprotected run of n becomes
/// 2n, which arrives as `ceil(2n / 2)` = n, for every n. A run against a `"` is
/// left alone because it arrives whole already. Doubling never changes which
/// character follows a run, so the two cases cannot interfere with each other.
///
/// A run at the very end of the string is doubled, with the rest: nothing
/// follows it, so it is not against a quote. The case is unobservable in
/// practice — a command whose last character is a backslash is a line
/// continuation at end of input, which bash rejects before any of this matters.
pub fn compensate(command: &str) -> String {
    let bytes = command.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] != b'\\' {
            /* Copied as a byte rather than a char. `\` is ASCII and every
               continuation byte of a multi-byte sequence is >= 0x80, so a byte
               scan cannot split a character, and the only bytes this ever
               duplicates are ASCII backslashes. */
            out.push(bytes[i]);
            i += 1;
            continue;
        }

        let start = i;
        while i < bytes.len() && bytes[i] == b'\\' {
            i += 1;
        }
        let run = &bytes[start..i];

        out.extend_from_slice(run);
        if bytes.get(i) != Some(&b'"') {
            out.extend_from_slice(run);
        }
    }

    /* Infallible by construction, per the note above; `from_utf8_lossy` would
       quietly corrupt a command rather than saying so, and a panic here would
       be a card unable to run any shell command at all. */
    String::from_utf8(out).unwrap_or_else(|_| command.to_string())
}

/// Serve the hook if that is what we were started for. Returns whether it was.
///
/// **Fails open, always.** Unreadable stdin, unparseable JSON, an input shape
/// that is not what a `PreToolUse` payload should be: print nothing and exit 0,
/// which leaves the original command untouched. The bug this compensates for is
/// silent and occasional; a filter that refused a call it could not parse would
/// be a card that cannot run shell commands, which is neither.
///
/// Called from `main` before anything else, so a hook invocation never opens the
/// store, never creates a window and never joins the wall. Nothing between here
/// and `run()` may be given side effects without moving this check above them.
pub fn intercept() -> bool {
    if !std::env::args().skip(1).any(|a| a == FLAG) {
        return false;
    }

    let mut raw = String::new();
    if std::io::stdin().read_to_string(&mut raw).is_err() {
        return true;
    }

    if let Some(out) = rewrite(&raw) {
        print!("{out}");
    }
    true
}

/// The pure half of `intercept`: a hook payload in, the reply to print out, or
/// `None` for "say nothing", which is how a hook declines to change anything.
fn rewrite(raw: &str) -> Option<String> {
    let payload: serde_json::Value = serde_json::from_str(raw).ok()?;
    let mut input = payload.get("tool_input")?.as_object()?.clone();
    let command = input.get("command")?.as_str()?;

    /* The overwhelming majority of commands contain no backslash at all. Saying
       nothing is cheaper than handing back an identical input for the CLI's
       schema validator to check, and it keeps the hook off the permission
       machinery's books for every such call. */
    if !command.contains('\\') {
        return None;
    }

    let fixed = compensate(command);
    if fixed == command {
        return None;
    }

    input.insert("command".into(), serde_json::Value::String(fixed));
    Some(
        serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "updatedInput": input,
            }
        })
        .to_string(),
    )
}

/// The `--settings` layer every card is spawned with.
///
/// Inline JSON rather than a file: there is nothing to write, nothing to clean
/// up, and nothing for a half-installed machine to be missing. `--settings` is
/// the flag tier, which merges over the user's own settings rather than
/// replacing them — a card keeps the model, effort and plugins configured on the
/// machine.
///
/// The hook is given in the **exec form** (`command` plus `args`), which spawns
/// the executable directly with no shell in between. That is not tidiness: the
/// shell form would put an installation path through a shell parser, and a path
/// containing a space, a `$` or a quote is exactly the class of bug this whole
/// module exists to compensate for. Verified present in 2.1.233 before being
/// relied on — a build that ignored `args` would run this binary with no
/// arguments, which is to say it would open a second Skein for every shell
/// command a card ran.
pub fn settings(chat: bool) -> String {
    let mut root = serde_json::Map::new();

    /* The permissions a chat card is granted, and the whole of them. Moved here
       from `supervisor::CHAT_SETTINGS` when the settings layer stopped being a
       chat-only argument; the reasoning is its, and still holds.

       `--tools` decides *which* tools exist; this decides whether the two that
       do are allowed to run. Both are needed, and the second is easy to miss
       because its absence looks like the model choosing not to search: probed
       against 2.1.233 with `--tools WebSearch,WebFetch` and no permission
       argument at all, a plain "search the web for X" came back refused. With
       this it answers.

       Deliberately an allow rule rather than `--dangerously-skip-permissions`,
       which would also work — with no file or shell tool in the process there is
       nothing for a bypass to unlock. It is spelled out anyway so that the one
       card on the wall that is *provably* harmless is not also the one carrying
       the most dangerous flag Skein knows, where the next person to read the
       argv has to reconstruct why that is fine. */
    if chat {
        root.insert(
            "permissions".into(),
            serde_json::json!({ "allow": ["WebSearch", "WebFetch"] }),
        );
    }

    /* No exe, no hook — and a chat card still gets its permissions. The cards
       run uncompensated, which is where they were before this existed. */
    if let Ok(exe) = std::env::current_exe() {
        root.insert(
            "hooks".into(),
            serde_json::json!({
                "PreToolUse": [{
                    "matcher": "Bash",
                    "hooks": [{
                        "type": "command",
                        "command": exe.to_string_lossy(),
                        "args": [FLAG],
                        "timeout": 10,
                    }],
                }],
            }),
        );
    }

    serde_json::Value::Object(root).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the Bash tool was measured to do, so the test can assert a
    /// round-trip rather than a hard-coded expectation of `compensate`.
    /// `ceil(n/2)` per run, except a run against a `"`, which is left whole.
    fn collapse(s: &str) -> String {
        let bytes = s.as_bytes();
        let mut out: Vec<u8> = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] != b'\\' {
                out.push(bytes[i]);
                i += 1;
                continue;
            }
            let start = i;
            while i < bytes.len() && bytes[i] == b'\\' {
                i += 1;
            }
            let n = i - start;
            let keep = if bytes.get(i) == Some(&b'"') {
                n
            } else {
                n.div_ceil(2)
            };
            out.extend(std::iter::repeat_n(b'\\', keep));
        }
        String::from_utf8(out).unwrap()
    }

    /// The runs measured directly out of a heredoc, as a table so a regression
    /// names the length that broke.
    #[test]
    fn collapse_model_matches_what_was_measured() {
        for (emitted, arrived) in [(1, 1), (2, 1), (3, 2), (4, 2), (5, 3), (6, 3)] {
            let s = "\\".repeat(emitted);
            assert_eq!(
                collapse(&format!("x={s}")),
                format!("x={}", "\\".repeat(arrived)),
                "a run of {emitted} should arrive as {arrived}"
            );
        }
    }

    /// The exception, at every length it was measured at.
    #[test]
    fn a_run_against_a_quote_survives_whole() {
        for n in 1..=4 {
            let s = format!("{}\"", "\\".repeat(n));
            assert_eq!(collapse(&s), s, "a run of {n} before a quote must survive");
            assert_eq!(compensate(&s), s, "and must therefore not be doubled");
        }
    }

    #[test]
    fn a_single_quote_does_not_protect() {
        assert_eq!(collapse("a\\\\'"), "a\\'");
    }

    #[test]
    fn compensation_round_trips() {
        let cases = [
            // the real failures, out of the transcripts that found this
            r#"const db = new Database(process.env.APPDATA + "\\dev.skein.studio\\skein.db");"#,
            r#"awk '{ n=gsub(/\\/,"\\"); print n }' f"#,
            // ordinary shell backslashes, which must come out unchanged
            r"grep -n 'foo\.ts$' file",
            r"find . -name '*.ts' -exec grep -l x {} \;",
            r#"printf "%s\n" hi"#,
            r"echo 'C:\\Users\\flori' > /tmp/p",
            r"sed -i 's/a/b/' x && echo done",
            // nothing to do at all
            "git status --porcelain",
            "",
        ];

        for c in cases {
            assert_eq!(
                collapse(&compensate(c)),
                c,
                "should arrive exactly as written: {c:?}"
            );
        }
    }

    /// The bug is real: without compensation most of those are corrupted. If
    /// this ever fails, the Bash tool has been fixed and this module should go.
    #[test]
    fn the_cases_are_actually_broken_without_it() {
        let broken = [
            r#"const db = new Database(process.env.APPDATA + "\\dev.skein.studio\\skein.db");"#,
            r"echo 'C:\\Users\\flori' > /tmp/p",
        ];
        for c in broken {
            assert_ne!(collapse(c), c, "expected {c:?} to be corrupted uncompensated");
        }
    }

    #[test]
    fn utf8_survives_the_byte_scan() {
        let s = "echo 'caf\u{e9} \u{2014} \u{1f600}' && ls C:\\\\tmp";
        let out = compensate(s);
        assert!(out.contains('\u{2014}') && out.contains('\u{1f600}'));
        assert_eq!(collapse(&out), s);
    }

    #[test]
    fn rewrite_preserves_the_rest_of_the_input() {
        let raw = r#"{"tool_name":"Bash","tool_input":{"command":"echo 'a\\b'","description":"keep","timeout":5}}"#;
        let out = rewrite(raw).expect("a command with backslashes should be rewritten");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let upd = &v["hookSpecificOutput"]["updatedInput"];
        assert_eq!(upd["description"], "keep");
        assert_eq!(upd["timeout"], 5);
        assert_eq!(v["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(collapse(upd["command"].as_str().unwrap()), r"echo 'a\b'");
    }

    /// Every one of these leaves the command alone, which is the whole of the
    /// fail-open promise.
    #[test]
    fn nothing_is_said_when_there_is_nothing_to_say() {
        for raw in [
            "",
            "not json",
            "{}",
            r#"{"tool_input":null}"#,
            r#"{"tool_input":{}}"#,
            r#"{"tool_input":{"command":42}}"#,
            // no backslash anywhere
            r#"{"tool_input":{"command":"git status"}}"#,
            // a lone run against a quote needs no change
            r#"{"tool_input":{"command":"echo \"a\\\\\"\""}}"#,
        ] {
            assert!(rewrite(raw).is_none(), "should have declined: {raw:?}");
        }
    }

    #[test]
    fn settings_carry_the_hook_in_exec_form() {
        let v: serde_json::Value = serde_json::from_str(&settings(false)).unwrap();
        let h = &v["hooks"]["PreToolUse"][0];
        assert_eq!(h["matcher"], "Bash");
        assert_eq!(h["hooks"][0]["type"], "command");
        assert_eq!(h["hooks"][0]["args"][0], FLAG);
        assert!(v.get("permissions").is_none(), "a project card gets no allow list");

        let chat: serde_json::Value = serde_json::from_str(&settings(true)).unwrap();
        assert_eq!(chat["permissions"]["allow"][0], "WebSearch");
        assert!(chat["hooks"]["PreToolUse"][0]["matcher"] == "Bash");
    }
}
