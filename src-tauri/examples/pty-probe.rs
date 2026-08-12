//! Does ConPTY work on this machine? `cargo run --example pty-probe`
//!
//! The counterpart to `tools/probe-context.ts`, one layer down: spawn with the
//! exact shapes `servers.rs` and `actions.rs` use, isolate one variable per
//! variant, and print what actually happens.
//!
//! Run 2026-08-12 on Windows 11 26200 against portable-pty 0.9.0 — the newest
//! published — every pty variant answered:
//!
//! ```text
//! std cmd /C call git --version   code=Some(0)     out="git version 2.55.0.windows.3"
//! pty cmd /C ver (one string)     code=3221225794  out="<ESC>[6n"
//! pty cmd /C call git --version   HUNG
//! pty git --version (no shell)    HUNG
//! pty default prog                HUNG
//! pty cmd /C ver + cwd + env      HUNG
//! ```
//!
//! `3221225794` is `0xC0000142`, STATUS_DLL_INIT_FAILED: the child was created
//! and died before running a line of its own code. Since it happens to `git.exe`
//! with no shell in the way, and to the default program, it is ConPTY and not
//! the argv or the quoting. portable-pty's `psuedocon.rs` spawns with
//! `STARTF_USESTDHANDLES` and all three std handles set to
//! `INVALID_HANDLE_VALUE`, which is the shape that build appears to reject.
//!
//! Two consequences, and the second is not fixed:
//!
//! - `actions.rs` runs its commands through plain pipes instead. It says so, and
//!   why, at the top of the file.
//! - **`servers.rs` is on the broken path.** Every dev server group on this
//!   machine will fail the same way until either Windows or portable-pty moves.
//!   Re-run this probe to find out whether it still does.

use portable_pty::{CommandBuilder, PtySize};
use std::io::Read;
use std::sync::mpsc;
use std::time::Duration;

fn run(label: &str, build: fn() -> CommandBuilder) {
    let pty = portable_pty::native_pty_system()
        .openpty(PtySize {
            rows: 40,
            cols: 160,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut child = match pty.slave.spawn_command(build()) {
        Ok(c) => c,
        Err(e) => {
            println!("{label:<32} spawn error: {e}");
            return;
        }
    };
    drop(pty.slave);

    /* Read into a channel rather than to EOF: on Windows the read only ends
       when the last master handle goes, so a `read_to_end` before the drop
       below is a deadlock — which is its own way of failing this probe. */
    let mut reader = pty.master.try_clone_reader().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut all = Vec::new();
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || all.len() > 4000 {
                break;
            }
            all.extend_from_slice(&buf[..n]);
            let _ = tx.send(String::from_utf8_lossy(&all).into_owned());
        }
        let _ = tx.send(String::from_utf8_lossy(&all).into_owned());
    });

    let code = child.wait().map(|s| s.exit_code()).unwrap_or(9999);
    let mut out = String::new();
    while let Ok(s) = rx.recv_timeout(Duration::from_millis(700)) {
        out = s;
    }
    drop(pty.master);
    println!(
        "{label:<32} code={code:<12} out={:?}",
        out.replace('\u{1b}', "<ESC>")
    );
}

/// Each case on its own thread: a variant that hangs must not take the probe
/// with it, since "it hung" is a result worth printing.
fn one(label: &'static str, build: fn() -> CommandBuilder) {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        run(label, build);
        let _ = tx.send(());
    });
    if rx.recv_timeout(Duration::from_secs(8)).is_err() {
        println!("{label:<32} HUNG");
    }
}

fn main() {
    /* The control: ordinary process creation, same command, no pty. */
    match std::process::Command::new("cmd")
        .args(["/C", "call", "git", "--version"])
        .output()
    {
        Ok(o) => println!(
            "{:<32} code={:?} out={:?}",
            "std cmd /C call git --version",
            o.status.code(),
            String::from_utf8_lossy(&o.stdout).trim()
        ),
        Err(e) => println!("std spawn error: {e}"),
    }

    /* Exactly what servers.rs builds. */
    one("pty cmd /C ver (one string)", || {
        let mut c = CommandBuilder::new("cmd");
        c.args(["/C", "ver"]);
        c
    });
    /* Exactly what actions.rs would build. */
    one("pty cmd /C call git --version", || {
        let mut c = CommandBuilder::new("cmd");
        c.args(["/C", "call", "git", "--version"]);
        c
    });
    /* No shell at all, to rule out cmd and the quoting. */
    one("pty git --version (no shell)", || CommandBuilder::new("git.exe"));
    /* portable-pty's own default, to rule out our CommandBuilder use. */
    one("pty default prog", CommandBuilder::new_default_prog);
    /* And with the cwd and env servers.rs sets. */
    one("pty cmd /C ver + cwd + env", || {
        let mut c = CommandBuilder::new("cmd");
        c.args(["/C", "ver"]);
        c.cwd(r"C:\atelier\skein");
        c.env("FORCE_COLOR", "1");
        c.env("TERM", "xterm-256color");
        c
    });
}
