//! What the studio's own processes are costing.
//!
//! A wall of concurrent agents is a wall of concurrent *processes*: every card
//! is a live `claude`, every dev server is a node tree, every build is a cargo
//! or a UBT. Alt-tabbing to Task Manager to find out which of them is eating
//! the machine, and then guessing which `claude.exe` is which card, is the sort
//! of question this app exists to answer on the wall instead.
//!
//! Two rules keep it honest, and they are the same two `project.rs` follows:
//!
//! - **This module answers in facts and never in verbs.** A row is a pid, a
//!   name, a cost and — where we know it — the *role* it plays here, as an
//!   opaque reference to a conversation, a server group or a run. Turning
//!   `role: "conversation", reference: "<uuid>"` into "the card that is fixing
//!   the parser" is the front end's job, because the front end is what knows
//!   the card's title.
//! - **It samples only when something is asking.** Nothing on this wall polls;
//!   a performance meter is the one honest exception, because there is no event
//!   a process emits when it starts using the CPU. So the `System` is built on
//!   the first call and the sampling stops dead when the last widget comes off
//!   the wall — the front end simply stops calling.
//!
//! CPU is measured as a delta between refreshes, so the first sample after a
//! quiet spell reads zero and the second is the real answer. That is a property
//! of every sampler of this kind, and the front end draws the second one.
//!
//! One thing to know before believing a low reading in development: WebView2
//! keeps **one browser process per user-data folder**, so a second Skein run
//! against the same `%APPDATA%` gets no webview children of its own — they are
//! all under the instance that started first, and the studio scope of the
//! second reads a few tens of megabytes while the first carries the gigabyte.
//! Probed 2026-08-13 with two instances up: `skein.exe` 52452 held
//! `msedgewebview2.exe` 9544 and its eight renderers, and 30792 held nothing.
//! Normal single-instance use attributes the lot, since the parent chain from
//! a renderer up to `skein.exe` is intact.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use sysinfo::{
    CpuRefreshKind, MemoryRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, RefreshKind,
    System,
};
use tauri::State;

use crate::actions::Runs;
use crate::servers::Servers;
use crate::supervisor::Supervisor;

/// The sampler, kept between calls because a CPU reading is a difference
/// between two of them. `None` until something asks: an app that never opens a
/// performance widget never enumerates a single process.
#[derive(Default)]
pub struct Meter(Mutex<Option<System>>);

#[derive(Debug, Serialize, Clone)]
pub struct Proc {
    pub pid: u32,
    pub ppid: Option<u32>,
    pub name: String,
    /// Percent of one core, so a busy four-thread build reads ~400 and the
    /// front end divides by `cores` when it wants a share of the machine.
    pub cpu: f32,
    /// Resident bytes.
    pub mem: u64,
    /// "studio" | "conversation" | "server" | "action" | "other"
    pub role: String,
    /// Whichever id that role is keyed by — a conversation id, a server group
    /// id, a run id. Meaningless here; the front end resolves it to a name.
    pub reference: Option<String>,
    /// Is this the process the role was recognised on, rather than something it
    /// spawned? `pnpm dev` is the server; the four node processes under it are
    /// the same server costing more than it looks.
    pub own: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct Sample {
    pub at: i64,
    /// Which scope produced this reading. One sample serves every widget on the
    /// wall, so a studio-scoped one has to be able to tell whether the totals it
    /// is holding are about the studio or about the machine.
    pub scope: String,
    pub cores: usize,
    /// The whole machine, 0–100.
    pub cpu: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    /// How many processes the scope actually held, before any cap.
    pub counted: usize,
    /// What the cap left out, so a capped list can still add up to the truth.
    pub other_cpu: f32,
    pub other_mem: u64,
    pub procs: Vec<Proc>,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Walk up the parent chain until something is recognised.
///
/// Bounded, and not only for tidiness: a pid is reused once its process is
/// reaped, so a stale parent id can in principle close a loop, and an unbounded
/// walk here would hang the sampler rather than mislabel one row.
fn ancestry(
    pid: Pid,
    parents: &HashMap<Pid, Pid>,
    known: &HashMap<Pid, (String, Option<String>)>,
) -> Option<(String, Option<String>, bool)> {
    if let Some((role, reference)) = known.get(&pid) {
        return Some((role.clone(), reference.clone(), true));
    }
    let mut at = pid;
    for _ in 0..16 {
        let Some(&up) = parents.get(&at) else { break };
        if up == at {
            break;
        }
        if let Some((role, reference)) = known.get(&up) {
            return Some((role.clone(), reference.clone(), false));
        }
        at = up;
    }
    None
}

/// One reading. `scope` is "skein" (this studio and everything it spawned) or
/// "machine" (every process, the way a task manager shows it).
#[tauri::command]
pub fn sample_performance(
    meter: State<'_, Meter>,
    sup: State<'_, Supervisor>,
    servers: State<'_, Servers>,
    runs: State<'_, Runs>,
    scope: Option<String>,
    limit: Option<usize>,
) -> Result<Sample, String> {
    let machine = scope.as_deref() == Some("machine");
    let cap = limit.unwrap_or(40).clamp(1, 400);

    let mut guard = meter.0.lock().map_err(|e| e.to_string())?;
    let sys = guard.get_or_insert_with(|| {
        System::new_with_specifics(
            RefreshKind::nothing()
                .with_memory(MemoryRefreshKind::nothing().with_ram())
                .with_cpu(CpuRefreshKind::nothing().with_cpu_usage()),
        )
    });

    sys.refresh_cpu_usage();
    sys.refresh_memory();
    /* Memory and CPU only. Enumerating command lines and open files on every
       tick is most of what makes a process listing expensive, and none of it is
       drawn. */
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_memory().with_cpu(),
    );

    /* What we know about our own children, keyed by pid. The three states are
       asked rather than guessed at: a `claude.exe` on the machine that this
       studio did not spawn is somebody else's terminal, and must not be labelled
       as one of our cards. */
    let mut known: HashMap<Pid, (String, Option<String>)> = HashMap::new();
    let me = Pid::from_u32(std::process::id());
    known.insert(me, ("studio".into(), None));
    for (pid, id) in sup.pids() {
        known.insert(Pid::from_u32(pid), ("conversation".into(), Some(id)));
    }
    for (pid, id) in servers.pids() {
        known.insert(Pid::from_u32(pid), ("server".into(), Some(id)));
    }
    for (pid, id) in runs.pids() {
        known.insert(Pid::from_u32(pid), ("action".into(), Some(id)));
    }

    let parents: HashMap<Pid, Pid> = sys
        .processes()
        .iter()
        .filter_map(|(pid, p)| p.parent().map(|up| (*pid, up)))
        .collect();

    let mut rows: Vec<Proc> = Vec::new();
    for (pid, p) in sys.processes() {
        let found = ancestry(*pid, &parents, &known);
        if found.is_none() && !machine {
            continue;
        }
        let (role, reference, own) = found.unwrap_or_else(|| ("other".into(), None, true));
        rows.push(Proc {
            pid: pid.as_u32(),
            ppid: p.parent().map(|up| up.as_u32()),
            name: p.name().to_string_lossy().to_string(),
            cpu: p.cpu_usage(),
            mem: p.memory(),
            role,
            reference,
            own,
        });
    }

    let counted = rows.len();
    /* Costliest first, and by CPU before memory: the question a wall of agents
       raises is "what is running", not "what is resident". A process that is
       recognised as one of ours outranks an anonymous one at the same cost, so
       capping the machine view never hides the studio's own work. */
    rows.sort_by(|a, b| {
        let ours = |r: &Proc| r.role != "other";
        ours(b)
            .cmp(&ours(a))
            .then(
                b.cpu
                    .partial_cmp(&a.cpu)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
            .then(b.mem.cmp(&a.mem))
    });
    let dropped = rows.split_off(rows.len().min(cap));

    Ok(Sample {
        at: now(),
        scope: if machine { "machine".into() } else { "skein".into() },
        cores: sys.cpus().len().max(1),
        cpu: sys.global_cpu_usage(),
        mem_used: sys.used_memory(),
        mem_total: sys.total_memory(),
        counted,
        other_cpu: dropped.iter().map(|r| r.cpu).sum(),
        other_mem: dropped.iter().map(|r| r.mem).sum(),
        procs: rows,
    })
}

/// Let the sampler go when the last widget comes off the wall. A `System` holds
/// a row per process on the machine, and there is no reason to keep several
/// thousand of them warm for a wall that has stopped asking.
#[tauri::command]
pub fn release_performance(meter: State<'_, Meter>) {
    if let Ok(mut guard) = meter.0.lock() {
        *guard = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pid(n: u32) -> Pid {
        Pid::from_u32(n)
    }

    /// A dev server is `pnpm dev` spawning node spawning esbuild. Only the first
    /// of those is in any of our maps, and a meter that showed the other two as
    /// anonymous strangers would understate the server by most of its cost.
    #[test]
    fn a_grandchild_inherits_the_role_of_whatever_spawned_it() {
        let mut known = HashMap::new();
        known.insert(pid(10), ("server".to_string(), Some("g1".to_string())));
        let parents = HashMap::from([(pid(11), pid(10)), (pid(12), pid(11))]);

        let (role, reference, own) = ancestry(pid(12), &parents, &known).unwrap();
        assert_eq!(role, "server");
        assert_eq!(reference.as_deref(), Some("g1"));
        assert!(!own, "a grandchild is not the process the role was found on");

        let (_, _, own) = ancestry(pid(10), &parents, &known).unwrap();
        assert!(own);
    }

    /// A `claude.exe` this studio did not spawn is somebody's terminal.
    #[test]
    fn an_unrelated_process_is_recognised_as_nothing() {
        let known = HashMap::from([(pid(10), ("studio".to_string(), None))]);
        let parents = HashMap::from([(pid(99), pid(98))]);
        assert!(ancestry(pid(99), &parents, &known).is_none());
    }

    /// Pids are reused, so a stale parent map can close a loop. Mislabelling one
    /// row is a bug; hanging the sampler is a frozen wall.
    #[test]
    fn a_parent_loop_ends_rather_than_spinning() {
        let known = HashMap::from([(pid(1), ("studio".to_string(), None))]);
        let parents = HashMap::from([(pid(20), pid(21)), (pid(21), pid(20))]);
        assert!(ancestry(pid(20), &parents, &known).is_none());
    }
}
