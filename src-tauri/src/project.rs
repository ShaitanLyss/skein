//! What a project *is*, and what it is doing.
//!
//! Two questions, answered at two very different rates. What a project *is* —
//! a package.json with a `build` script, a `.uproject` whose engine lives at
//! `C:\Program Files\Epic Games\UE_5.8` — is read once, when the territory
//! appears on the wall. What it is *doing* — is its editor up, is the branch
//! ahead of its remote — is re-read on a slow poll, because both change while
//! you are looking at them.
//!
//! Everything here answers in *facts*. Which verbs those facts add up to is
//! decided in `src/lib/actions.ts`, which is pure and tested; this file must
//! never grow an opinion about what a build is.
//!
//! The one thing worth knowing about the poll: finding out whether *this*
//! project's editor is open is expensive done properly. The proper way is the
//! process command line (another project's `UnrealEditor.exe` must never
//! receive our compile triggers), and on Windows that means WMI, which means a
//! PowerShell spawn of a few hundred milliseconds. So the cheap answer is tried
//! first — a top-level window of class `UnrealWindow` whose title carries the
//! project name, which costs one `EnumWindows` — and the expensive one only
//! runs when that finds nothing, at most once every 15 seconds.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/* ── no console windows ────────────────────────────────────────────────────
 *
 * Every helper here shells out to something, and a GUI app spawning a console
 * program flashes a black window on screen unless it says not to. */
#[cfg(windows)]
fn quiet(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW)
}
#[cfg(not(windows))]
fn quiet(cmd: &mut Command) -> &mut Command {
    cmd
}

fn output(cmd: &mut Command) -> Option<String> {
    let out = quiet(cmd).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/* ── what a project is ────────────────────────────────────────────────────── */

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnrealFacts {
    pub uproject: String,
    pub name: String,
    pub engine: Option<String>,
    pub mcp_port: Option<u16>,
    pub log: String,
}

#[derive(Clone, Serialize)]
pub struct ProjectFacts {
    pub root: String,
    /// "pnpm" | "npm" | "yarn" | "bun"
    pub manager: String,
    pub scripts: Vec<String>,
    pub node: bool,
    pub tauri: bool,
    pub cargo: bool,
    pub git: bool,
    pub unreal: Option<UnrealFacts>,
}

/// Which package manager this repo is written for.
///
/// A lockfile is the strongest evidence there is — it exists because somebody
/// ran that manager here. `packageManager` is a declaration and comes first
/// anyway, since it is the thing a repo says on purpose. With neither, the
/// answer is **pnpm**: npm is what gets typed out of habit, not chosen.
fn manager_for(root: &Path, pkg: Option<&serde_json::Value>) -> String {
    if let Some(field) = pkg
        .and_then(|p| p.get("packageManager"))
        .and_then(|v| v.as_str())
    {
        let name = field.split('@').next().unwrap_or("").trim().to_lowercase();
        if matches!(name.as_str(), "pnpm" | "npm" | "yarn" | "bun") {
            return name;
        }
    }
    for (file, mgr) in [
        ("bun.lock", "bun"),
        ("bun.lockb", "bun"),
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("package-lock.json", "npm"),
    ] {
        if root.join(file).exists() {
            return mgr.into();
        }
    }
    "pnpm".into()
}

/// The `.uproject` at or above `root`, if there is one.
///
/// Upward as well as at the root because what gets opened on the wall is a
/// folder you were working in, which for a big project is often `Source/` or a
/// plugin, not the directory holding the `.uproject`.
fn find_uproject(root: &Path) -> Option<PathBuf> {
    let mut at = Some(root);
    for _ in 0..5 {
        let dir = at?;
        if let Ok(entries) = std::fs::read_dir(dir) {
            let mut hits: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.extension()
                        .map(|e| e.eq_ignore_ascii_case("uproject"))
                        .unwrap_or(false)
                })
                .collect();
            /* Stable: two .uproject files in one directory is unusual but a
               different answer every launch would be worse than the wrong one. */
            hits.sort();
            if let Some(first) = hits.into_iter().next() {
                return Some(first);
            }
        }
        at = dir.parent();
    }
    None
}

/// Where the engine this project is associated with is installed.
///
/// `EngineAssociation` comes in two forms, and they live in two different
/// hives: a launcher install is a version string under HKLM, and anything
/// registered by UnrealVersionSelector — including every source build — is a
/// GUID under HKCU. `reg query` rather than a registry crate, because this runs
/// once per project and a dependency is a poor trade for that.
fn engine_root(uproject: &Path) -> Option<String> {
    let text = std::fs::read_to_string(uproject).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let assoc = json
        .get("EngineAssociation")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if !assoc.is_empty() {
        let out = if assoc.starts_with('{') {
            output(Command::new("reg").args([
                "query",
                r"HKCU\SOFTWARE\Epic Games\Unreal Engine\Builds",
                "/v",
                &assoc,
            ]))
        } else {
            output(Command::new("reg").args([
                "query",
                &format!(r"HKLM\SOFTWARE\EpicGames\Unreal Engine\{assoc}"),
                "/v",
                "InstalledDirectory",
            ]))
        };
        if let Some(dir) = out.as_deref().and_then(parse_reg_sz) {
            let dir = dir.replace('/', "\\");
            if Path::new(&dir).is_dir() {
                return Some(dir);
            }
        }
        if !assoc.starts_with('{') {
            let default = format!(r"C:\Program Files\Epic Games\UE_{assoc}");
            if Path::new(&default).is_dir() {
                return Some(default);
            }
        }
    }

    /* A project sitting inside an engine tree has an empty association, and
       nothing in the registry will ever answer for it. The engine is simply
       above it. */
    let mut at = uproject.parent();
    for _ in 0..6 {
        let dir = at?;
        if dir
            .join("Engine")
            .join("Build")
            .join("BatchFiles")
            .join("Build.bat")
            .exists()
        {
            return Some(dir.to_string_lossy().into_owned());
        }
        at = dir.parent();
    }
    None
}

/// The value out of `reg query` output: `    InstalledDirectory    REG_SZ    C:\…`
fn parse_reg_sz(out: &str) -> Option<String> {
    for line in out.lines() {
        if let Some(at) = line.find("REG_SZ") {
            let value = line[at + "REG_SZ".len()..].trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// The port this *repo* declares in its committed `.mcp.json`.
///
/// The source of truth on purpose: the editor's own `ServerPortNumber` lives in
/// `Saved/Config`, which is per-machine and does not survive a clone, so a
/// fresh checkout would come up on the default port while `.mcp.json` still
/// pointed somewhere else — silent, and it reads as the agent's fault.
fn mcp_port(root: &Path) -> Option<u16> {
    let text = std::fs::read_to_string(root.join(".mcp.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    for (_, server) in json.get("mcpServers")?.as_object()? {
        let Some(url) = server.get("url").and_then(|v| v.as_str()) else {
            continue;
        };
        /* http://127.0.0.1:7245/mcp → 7245 */
        let after_scheme = url.split("//").nth(1)?;
        let host = after_scheme.split('/').next()?;
        if let Some(port) = host.rsplit(':').next().and_then(|p| p.parse().ok()) {
            return Some(port);
        }
    }
    None
}

#[tauri::command]
pub async fn probe_project(root: String) -> ProjectFacts {
    let dir = PathBuf::from(&root);

    let pkg: Option<serde_json::Value> = std::fs::read_to_string(dir.join("package.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());

    let mut scripts: Vec<String> = pkg
        .as_ref()
        .and_then(|p| p.get("scripts"))
        .and_then(|s| s.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    scripts.sort();

    let tauri = dir.join("src-tauri").join("tauri.conf.json").exists()
        || scripts.iter().any(|s| s == "tauri");

    let unreal = find_uproject(&dir).map(|up| {
        let name = up
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let project_root = up.parent().unwrap_or(&dir).to_path_buf();
        UnrealFacts {
            log: project_root
                .join("Saved")
                .join("Logs")
                .join(format!("{name}.log"))
                .to_string_lossy()
                .into_owned(),
            engine: engine_root(&up),
            mcp_port: mcp_port(&project_root),
            uproject: up.to_string_lossy().into_owned(),
            name,
        }
    });

    ProjectFacts {
        manager: manager_for(&dir, pkg.as_ref()),
        node: pkg.is_some(),
        scripts,
        tauri,
        /* The root's own Cargo.toml. `src-tauri/Cargo.toml` is part of a Tauri
           project rather than a project of its own, and offering `cargo build`
           for it would build the back end without the front end it needs. */
        cargo: dir.join("Cargo.toml").exists(),
        /* A file, not only a directory: that is what a git worktree has, and
           worktrees are how half the cards on this wall get opened. */
        git: dir.join(".git").exists(),
        unreal,
        root,
    }
}

/* ── what a project is doing ──────────────────────────────────────────────── */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PollRequest {
    pub root: String,
    /// The Unreal project name to look for a running editor of, if this is one.
    pub unreal_name: Option<String>,
    pub git: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatus {
    pub root: String,
    pub editor_pid: Option<u32>,
    pub branch: Option<String>,
    pub upstream: bool,
    pub ahead: u32,
    pub dirty: bool,
}

/// One `git` call for branch, tracking, distance and cleanliness together.
///
/// `--porcelain=v2 --branch` answers all four; asking separately would be four
/// process spawns per project per poll, which on a wall of a dozen projects is
/// a great deal of nothing happening.
///
/// Two flags are about the cost of asking this every few seconds. `-uno` skips
/// the untracked scan, which on an Unreal project — `Saved/`, `Intermediate/`,
/// `DerivedDataCache/`, hundreds of thousands of files — is essentially the
/// whole of what status costs, and answers a question the push chip never asks.
/// `--no-optional-locks` stops it refreshing the index, so a poll can never
/// collide with a commit you are making in a terminal.
fn git_status(root: &str) -> (Option<String>, bool, u32, bool) {
    let Some(out) = output(Command::new("git").current_dir(root).args([
        "--no-optional-locks",
        "status",
        "--porcelain=v2",
        "--branch",
        "-uno",
    ])) else {
        return (None, false, 0, false);
    };

    let mut branch = None;
    let mut upstream = false;
    let mut ahead = 0;
    let mut dirty = false;

    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            let name = rest.trim();
            /* Detached HEAD reports `(detached)`, which is not a branch and
               must not become one on a chip. */
            if name != "(detached)" {
                branch = Some(name.to_string());
            }
        } else if line.starts_with("# branch.upstream ") {
            upstream = true;
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            if let Some(plus) = rest.split_whitespace().next() {
                ahead = plus.trim_start_matches('+').parse().unwrap_or(0);
            }
        } else if !line.starts_with('#') && !line.trim().is_empty() {
            dirty = true;
        }
    }

    (branch, upstream, ahead, dirty)
}

/* ── is this project's editor open? ───────────────────────────────────────── */

/// Every top-level Unreal window on the desktop, as (pid, title).
#[cfg(windows)]
fn unreal_windows() -> Vec<(u32, String)> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    };

    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
        unsafe {
            let found = &mut *(lparam.0 as *mut Vec<(u32, String)>);
            if !IsWindowVisible(hwnd).as_bool() {
                return TRUE;
            }
            /* The class is the guard. A browser tab called "… Unreal Editor"
               would otherwise read as a running editor, and the whole point of
               this is deciding whether to send a compile somewhere. */
            let mut class = [0u16; 64];
            let n = GetClassNameW(hwnd, &mut class);
            if n <= 0 || !String::from_utf16_lossy(&class[..n as usize]).starts_with("Unreal") {
                return TRUE;
            }
            let mut text = [0u16; 512];
            let n = GetWindowTextW(hwnd, &mut text);
            if n <= 0 {
                return TRUE;
            }
            let title = String::from_utf16_lossy(&text[..n as usize]);
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid != 0 {
                found.push((pid, title));
            }
            TRUE
        }
    }

    let mut found: Vec<(u32, String)> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(visit), LPARAM(&mut found as *mut _ as isize));
    }
    found
}

#[cfg(not(windows))]
fn unreal_windows() -> Vec<(u32, String)> {
    Vec::new()
}

/// Every running `UnrealEditor.exe`, as (pid, command line).
///
/// The authoritative answer, and the expensive one — a PowerShell spawn, so it
/// is cached hard and only ever reached for when the window pass came back with
/// nothing. Deliberately quote-free: quotes get mangled between an argv and
/// powershell's own re-parse of `-Command`, which is a debugging afternoon
/// nobody needs twice.
fn unreal_processes() -> Vec<(u32, String)> {
    static CACHE: Mutex<Option<(Instant, Vec<(u32, String)>)>> = Mutex::new(None);
    const TTL: Duration = Duration::from_secs(15);

    if let Ok(cache) = CACHE.lock() {
        if let Some((at, hits)) = cache.as_ref() {
            if at.elapsed() < TTL {
                return hits.clone();
            }
        }
    }

    let out = output(Command::new("powershell").args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Where-Object Name -eq UnrealEditor.exe \
         | ForEach-Object { ($_.ProcessId, $_.CommandLine) -join [char]9 }",
    ]))
    .unwrap_or_default();

    let hits: Vec<(u32, String)> = out
        .lines()
        .filter_map(|l| {
            let (pid, cmd) = l.split_once('\t')?;
            Some((pid.trim().parse().ok()?, cmd.to_string()))
        })
        .collect();

    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some((Instant::now(), hits.clone()));
    }
    hits
}

/// Which window, if any, belongs to *this* project's editor.
fn window_pid(name: &str, windows: &[(u32, String)]) -> Option<u32> {
    let needle = name.to_lowercase();
    windows
        .iter()
        .find(|(_, title)| {
            let t = title.to_lowercase();
            t.contains(&needle) && t.contains("unreal")
        })
        .map(|(pid, _)| *pid)
}

/// Which process, if any, was told to open this project's `.uproject`.
fn process_pid(name: &str, procs: &[(u32, String)]) -> Option<u32> {
    let uproject = format!("{}.uproject", name.to_lowercase());
    procs
        .iter()
        .find(|(_, cmd)| cmd.to_lowercase().contains(&uproject))
        .map(|(pid, _)| *pid)
}

#[tauri::command]
pub async fn poll_projects(requests: Vec<PollRequest>) -> Vec<ProjectStatus> {
    /* One window sweep for the whole wall, not one per project. */
    let unreal = requests.iter().any(|r| r.unreal_name.is_some());
    let windows = if unreal { unreal_windows() } else { Vec::new() };

    let mut by_window: Vec<(String, Option<u32>)> = Vec::new();
    for r in &requests {
        by_window.push((
            r.root.clone(),
            r.unreal_name.as_deref().and_then(|n| window_pid(n, &windows)),
        ));
    }

    /* The expensive answer, and only when the cheap one came back empty for
       some Unreal project: an editor still loading has no window yet, and one
       minimised to the tray has none either. */
    let procs = if requests
        .iter()
        .zip(&by_window)
        .any(|(r, (_, pid))| r.unreal_name.is_some() && pid.is_none())
    {
        unreal_processes()
    } else {
        Vec::new()
    };

    requests
        .into_iter()
        .zip(by_window)
        .map(|(r, (_, from_window))| {
            let (branch, upstream, ahead, dirty) = if r.git {
                git_status(&r.root)
            } else {
                (None, false, 0, false)
            };
            ProjectStatus {
                editor_pid: from_window.or_else(|| {
                    r.unreal_name
                        .as_deref()
                        .and_then(|n| process_pid(n, &procs))
                }),
                branch,
                upstream,
                ahead,
                dirty,
                root: r.root,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reg_query_value_is_read_off_the_reg_sz_line() {
        let out = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\EpicGames\\Unreal Engine\\5.8\r\n    \
                   InstalledDirectory    REG_SZ    C:\\Program Files\\Epic Games\\UE_5.8\r\n\r\n";
        assert_eq!(
            parse_reg_sz(out).as_deref(),
            Some("C:\\Program Files\\Epic Games\\UE_5.8")
        );
    }

    #[test]
    fn a_registry_miss_is_not_a_path() {
        assert_eq!(parse_reg_sz("ERROR: The system was unable to find..."), None);
        assert_eq!(parse_reg_sz(""), None);
    }

    /// pnpm unless the repo says otherwise — npm is what gets typed by habit.
    #[test]
    fn the_default_manager_is_pnpm() {
        let dir = std::env::temp_dir().join("skein-probe-default");
        let _ = std::fs::create_dir_all(&dir);
        assert_eq!(manager_for(&dir, None), "pnpm");
    }

    #[test]
    fn a_declared_manager_beats_a_lockfile() {
        let dir = std::env::temp_dir().join("skein-probe-declared");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("package-lock.json"), "{}");
        let pkg = serde_json::json!({ "packageManager": "pnpm@9.1.0" });
        assert_eq!(manager_for(&dir, Some(&pkg)), "pnpm");
        /* …and something that is not one of the four is not a declaration. */
        let odd = serde_json::json!({ "packageManager": "corepack@1" });
        assert_eq!(manager_for(&dir, Some(&odd)), "npm");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_lockfile_is_evidence_somebody_ran_that_manager_here() {
        let dir = std::env::temp_dir().join("skein-probe-lock");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("bun.lock"), "");
        assert_eq!(manager_for(&dir, None), "bun");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_editor_window_is_matched_by_project_and_not_by_the_word_alone() {
        let windows = vec![
            (10, "Untitled - Notepad".to_string()),
            (20, "Overworld - Caravan - Unreal Editor".to_string()),
        ];
        assert_eq!(window_pid("Caravan", &windows), Some(20));
        /* Another project's editor must never receive our compile triggers. */
        let others = vec![(30, "Lyra - Unreal Editor".to_string())];
        assert_eq!(window_pid("Caravan", &others), None);
    }

    #[test]
    fn a_loading_editor_is_found_by_what_it_was_told_to_open() {
        let procs = vec![
            (40, r"...\UnrealEditor.exe C:\atelier\lyra\Lyra.uproject".to_string()),
            (41, r"...\UnrealEditor.exe C:\atelier\caravan\Caravan.uproject -x".to_string()),
        ];
        assert_eq!(process_pid("Caravan", &procs), Some(41));
        assert_eq!(process_pid("Nothing", &procs), None);
    }
}
