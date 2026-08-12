//! Dev server groups — the part that retires the three PowerShells.
//!
//! The hard problem here is not starting things, it is stopping them. A dev
//! server is `npm run dev` spawning node spawning esbuild; killing the process
//! you spawned leaves the grandchildren alive, still holding port 5173, and the
//! next start fails for reasons that look nothing like the cause.
//!
//! So every server goes into a Windows job object with KILL_ON_JOB_CLOSE.
//! Dropping the handle takes the whole tree down, including anything it
//! spawned after we stopped looking.

use std::collections::HashMap;
use std::io::Read;
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::store::{ServerGroup, ServerSpec};

/* ── Windows job objects ──────────────────────────────────────────────── */

#[cfg(windows)]
pub(crate) mod jobs {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    /// Dropping this kills every process assigned to it, and everything they
    /// spawned. That is the entire point.
    pub struct Job(HANDLE);

    // The handle is only ever touched through this type, and only closed once.
    unsafe impl Send for Job {}

    impl Job {
        pub fn new() -> Option<Job> {
            unsafe {
                let h = CreateJobObjectW(None, None).ok()?;
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    h,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .ok()?;
                Some(Job(h))
            }
        }

        pub fn assign(&self, pid: u32) -> bool {
            unsafe {
                let Ok(p) = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid) else {
                    return false;
                };
                let ok = AssignProcessToJobObject(self.0, p).is_ok();
                let _ = CloseHandle(p);
                ok
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}

#[cfg(not(windows))]
pub(crate) mod jobs {
    pub struct Job;
    impl Job {
        pub fn new() -> Option<Job> {
            Some(Job)
        }
        pub fn assign(&self, _pid: u32) -> bool {
            true
        }
    }
}

/* ── runtime state ────────────────────────────────────────────────────── */

/// A dev server running under a real pseudo-terminal.
///
/// This is the one place in Skein where a PTY earns its weight: conversation
/// output is structured JSON and wants our own rendering, but a dev server's
/// output genuinely *is* a terminal — colour, carriage returns, progress lines.
/// Piping it makes vite and cargo drop all of that and print flat text.
struct PtyServer {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    _job: Option<jobs::Job>,
}

struct RunningGroup {
    servers: Vec<PtyServer>,
}

/// Private field: the running map is only ever touched from this module, and
/// exposing it would leak the private RunningGroup type.
#[derive(Default)]
pub struct Servers(Mutex<HashMap<String, RunningGroup>>);

#[derive(Clone, Serialize)]
struct ServerLog {
    group_id: String,
    label: String,
    line: String,
    stderr: bool,
}

#[derive(Clone, Serialize)]
struct ServerState {
    group_id: String,
    label: String,
    /// "starting" | "up" | "down" | "exited"
    state: String,
    code: Option<i32>,
}

#[derive(Clone, Serialize)]
pub struct PortReport {
    pub port: u16,
    pub listening: bool,
}

fn port_open(port: u16) -> bool {
    TcpStream::connect_timeout(
        &SocketAddrV4::new(Ipv4Addr::LOCALHOST, port).into(),
        Duration::from_millis(180),
    )
    .is_ok()
}

/// Is anything already holding these ports? Surfaced before a start so a stale
/// listener reads as "port 5173 is taken" rather than a wall of npm output.
#[tauri::command]
pub fn probe_ports(ports: Vec<u16>) -> Vec<PortReport> {
    ports
        .into_iter()
        .map(|port| PortReport {
            port,
            listening: port_open(port),
        })
        .collect()
}

/// A line this long is a program that has lost the plot. Flush it rather than
/// grow a buffer without bound waiting for a terminator that may never come.
const MAX_LINE: usize = 8 * 1024;

/// Feed a PTY's output to `emit`, one display line at a time.
///
/// Deliberately not `BufReader::lines()`. That waits for `\n`, and a terminal
/// program's most interesting output often hasn't got one: vite, cargo and npm
/// redraw a progress line by returning to the start of it with a bare `\r`.
/// Waiting for a newline holds the whole build back and then dumps it in one
/// go — which is exactly the flat piped output the PTY is here to avoid.
///
/// So both terminators end a line, and the two consequences of that are handled
/// rather than left to surprise us: a `\r\n` pair must not also emit an empty
/// line, and neither must a bare `\r` redraw. A blank line from a real `\n` is
/// kept, because vertical space is real information in build output — it is what
/// separates vite's banner from its warnings.
///
/// Bytes are accumulated and decoded per line, so a multi-byte character split
/// across two reads survives, and invalid UTF-8 degrades to a replacement
/// character instead of killing the pump.
///
/// Returns when the stream ends. A read error counts as ended: on Windows the
/// PTY master reports the child's exit that way rather than as a clean EOF.
pub(crate) fn pump_lines<R: Read>(reader: &mut R, mut emit: impl FnMut(String)) {
    /// Decode what has accumulated and reset the buffer for the next line.
    fn take_line(line: &mut Vec<u8>) -> String {
        let text = String::from_utf8_lossy(line).into_owned();
        line.clear();
        text
    }

    let mut buf = [0u8; 4096];
    let mut line: Vec<u8> = Vec::with_capacity(256);
    /* Whether the byte just seen was a `\r`, so the `\n` completing a CRLF can
       be recognised as punctuation rather than as another line. */
    let mut after_cr = false;

    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for &byte in &buf[..n] {
            match byte {
                b'\r' => {
                    /* A redraw of an empty line is not a line. */
                    if !line.is_empty() {
                        emit(take_line(&mut line));
                    }
                    after_cr = true;
                }
                /* The `\n` of a `\r\n`: that line has already gone out. */
                b'\n' if after_cr => after_cr = false,
                b'\n' => emit(take_line(&mut line)),
                _ => {
                    after_cr = false;
                    line.push(byte);
                    if line.len() >= MAX_LINE {
                        emit(take_line(&mut line));
                    }
                }
            }
        }
    }

    /* Whatever the process left unterminated — usually its last word before it
       exited, which is the line you most want to see. */
    if !line.is_empty() {
        emit(take_line(&mut line));
    }
}

fn spawn_one(
    app: &AppHandle,
    group_id: &str,
    spec: &ServerSpec,
    cwd: &str,
) -> Result<PtyServer, String> {
    use portable_pty::{CommandBuilder, PtySize};

    let pty = portable_pty::native_pty_system()
        .openpty(PtySize {
            rows: 40,
            cols: 140,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("open pty for {}: {e}", spec.label))?;

    /* Shell out, because a dev server command is written for a shell:
       `npm run dev`, `cargo watch -x run`, chained &&. */
    #[cfg(windows)]
    let mut cmd = {
        let mut c = CommandBuilder::new("cmd");
        c.args(["/C", &spec.command]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = CommandBuilder::new("sh");
        c.args(["-c", &spec.command]);
        c
    };
    cmd.cwd(spec.cwd.as_deref().unwrap_or(cwd));
    /* Tell the toolchain it is talking to a terminal, so it keeps its colour. */
    cmd.env("FORCE_COLOR", "1");
    cmd.env("TERM", "xterm-256color");

    let child = pty
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("start {}: {e}", spec.label))?;
    drop(pty.slave);

    let job = jobs::Job::new();
    if let (Some(j), Some(pid)) = (&job, child.process_id()) {
        j.assign(pid);
    }

    let mut reader = pty
        .master
        .try_clone_reader()
        .map_err(|e| format!("read {}: {e}", spec.label))?;

    {
        let app = app.clone();
        let group_id = group_id.to_string();
        let label = spec.label.clone();
        std::thread::spawn(move || {
            pump_lines(&mut reader, |text| {
                let _ = app.emit(
                    "server:log",
                    ServerLog {
                        group_id: group_id.clone(),
                        label: label.clone(),
                        line: text,
                        stderr: false,
                    },
                );
            });
        });
    }

    Ok(PtyServer {
        child,
        _job: job,
    })
}

#[tauri::command]
pub fn start_group(
    app: AppHandle,
    servers: State<'_, Servers>,
    group: ServerGroup,
    cwd: String,
) -> Result<(), String> {
    /* Inline rather than calling stop_group — State isn't cloneable, and a
       restart must fully release the old tree before the new one binds ports. */
    if let Some(mut old) = servers.0.lock().unwrap().remove(&group.id) {
        for s in old.servers.iter_mut() {
            let _ = s.child.kill();
            let _ = s.child.wait();
        }
        old.servers.clear();
    }

    let mut running = Vec::new();
    for spec in &group.servers {
        let _ = app.emit(
            "server:state",
            ServerState {
                group_id: group.id.clone(),
                label: spec.label.clone(),
                state: "starting".into(),
                code: None,
            },
        );
        match spawn_one(&app, &group.id, spec, &cwd) {
            Ok(s) => running.push(s),
            Err(e) => {
                let _ = app.emit(
                    "server:state",
                    ServerState {
                        group_id: group.id.clone(),
                        label: spec.label.clone(),
                        state: "exited".into(),
                        code: None,
                    },
                );
                let _ = app.emit(
                    "server:log",
                    ServerLog {
                        group_id: group.id.clone(),
                        label: spec.label.clone(),
                        line: e,
                        stderr: true,
                    },
                );
            }
        }
    }

    servers
        .0
        .lock()
        .unwrap()
        .insert(group.id.clone(), RunningGroup { servers: running });

    /* Ports come up asynchronously, so report health shortly after rather than
       claiming "up" the instant a process exists. */
    let app2 = app.clone();
    let group2 = group.clone();
    std::thread::spawn(move || {
        for _ in 0..40 {
            std::thread::sleep(Duration::from_millis(500));
            let mut all_known = true;
            for spec in &group2.servers {
                let Some(port) = spec.port else {
                    continue;
                };
                let up = port_open(port);
                if !up {
                    all_known = false;
                }
                let _ = app2.emit(
                    "server:state",
                    ServerState {
                        group_id: group2.id.clone(),
                        label: spec.label.clone(),
                        state: if up { "up".into() } else { "starting".into() },
                        code: None,
                    },
                );
            }
            if all_known {
                break;
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn stop_group(servers: State<'_, Servers>, group_id: String) -> Result<(), String> {
    if let Some(mut g) = servers.0.lock().unwrap().remove(&group_id) {
        for s in g.servers.iter_mut() {
            let _ = s.child.kill();
            let _ = s.child.wait();
        }
        /* Dropping each job object takes down anything the children spawned. */
        g.servers.clear();
    }
    Ok(())
}

#[tauri::command]
pub fn group_running(servers: State<'_, Servers>, group_id: String) -> bool {
    servers.0.lock().unwrap().contains_key(&group_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Hands out its bytes in fixed-size pieces, so a `\r\n` pair or a
    /// multi-byte character can land across two reads the way a real PTY splits
    /// them. A chunk of 1 is the meanest schedule there is.
    struct Chunked<'a> {
        data: &'a [u8],
        chunk: usize,
    }

    impl Read for Chunked<'_> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let n = self.data.len().min(self.chunk).min(buf.len());
            buf[..n].copy_from_slice(&self.data[..n]);
            self.data = &self.data[n..];
            Ok(n)
        }
    }

    fn pump(data: &[u8], chunk: usize) -> Vec<String> {
        let mut out = Vec::new();
        let mut reader = Chunked { data, chunk };
        pump_lines(&mut reader, |line| out.push(line));
        out
    }

    #[test]
    fn crlf_does_not_leave_a_phantom_blank_line_between_every_line() {
        // cmd.exe /C, which is how every server on Windows is started.
        assert_eq!(pump(b"first\r\nsecond\r\n", 4096), ["first", "second"]);
        // And the same when the pair is split across two reads.
        assert_eq!(pump(b"first\r\nsecond\r\n", 6), ["first", "second"]);
        assert_eq!(pump(b"first\r\nsecond\r\n", 1), ["first", "second"]);
    }

    #[test]
    fn a_progress_redraw_arrives_as_it_happens_rather_than_after_the_build() {
        /* The whole reason this is not BufReader::lines(): none of these have a
           newline, and a build that only prints progress would show nothing. */
        assert_eq!(
            pump(b"10%\r50%\r100%\r\ndone\n", 4096),
            ["10%", "50%", "100%", "done"]
        );
    }

    #[test]
    fn a_blank_line_from_a_real_newline_is_kept() {
        // Vertical space separates vite's banner from what follows it.
        assert_eq!(pump(b"\nVITE ready\n\nwarn\n", 4096), ["", "VITE ready", "", "warn"]);
    }

    #[test]
    fn the_last_line_survives_a_process_that_exits_without_a_newline() {
        assert_eq!(pump(b"listening on 5173", 4096), ["listening on 5173"]);
        assert_eq!(pump(b"a\nb", 4096), ["a", "b"]);
    }

    #[test]
    fn nothing_is_emitted_for_an_empty_stream() {
        assert!(pump(b"", 4096).is_empty());
        // A bare redraw of nothing is punctuation, not a line.
        assert!(pump(b"\r", 4096).is_empty());
        assert!(pump(b"\r\r\r", 4096).is_empty());
    }

    #[test]
    fn a_character_split_across_two_reads_is_not_mangled() {
        // vite's arrow is three bytes; a chunk of 1 splits every one of them.
        let out = pump("  ➜  Local: http://localhost:5173/\n".as_bytes(), 1);
        assert_eq!(out, ["  ➜  Local: http://localhost:5173/"]);
    }

    #[test]
    fn invalid_utf8_degrades_instead_of_killing_the_pump() {
        let out = pump(b"ok\xffthen\nnext\n", 4096);
        assert_eq!(out.len(), 2, "the pump stopped at the bad byte");
        assert!(out[0].starts_with("ok") && out[0].ends_with("then"));
        assert_eq!(out[1], "next", "output after the bad byte was lost");
    }

    #[test]
    fn a_runaway_line_is_flushed_rather_than_buffered_without_bound() {
        let flood = vec![b'x'; MAX_LINE * 2 + 10];
        let out = pump(&flood, 4096);
        assert!(out.len() >= 2, "a line with no terminator grew unbounded");
        assert!(out.iter().all(|l| l.len() <= MAX_LINE));
        // Nothing is dropped on the way — it is split, not truncated.
        assert_eq!(out.concat().len(), flood.len());
    }
}

impl Servers {
    /// Every server dies with the app — no orphan holding 5173 after a crash.
    pub fn shutdown(&self) {
        let mut map = self.0.lock().unwrap();
        for (_, mut g) in map.drain() {
            for s in g.servers.iter_mut() {
                let _ = s.child.kill();
                let _ = s.child.wait();
            }
        }
    }
}
