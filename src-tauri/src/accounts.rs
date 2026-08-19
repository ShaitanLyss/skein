//! More than one subscription, in an order.
//!
//! The facts half. `accounts.ts` decides *which* account the next turn goes to
//! and what to say about it; this holds the registry, reads the credential, and
//! puts one token into one child process's environment. The same split
//! `limits.rs` draws against `limits.ts`, and `.claude/rules/accounts.md` is
//! the whole of the reasoning.
//!
//! ### Nothing here stores a token
//!
//! The registry — label, rank, caps, enabled — is in SQLite. The **token is
//! not**, and there is no code path that would put it there. It lives in
//! `~/.claude/tokens/<label>.tok`, DPAPI-wrapped, written by the `cc-add`
//! PowerShell helper or by Skein's own sign-in, and this module reads one at
//! the moment it builds a `Command` and drops it again.
//!
//! That is `limits.rs`'s rule extended rather than a new one, and it buys a
//! property worth the small awkwardness: deleting Skein's database costs you no
//! credentials, a database copied off this machine carries none, and a bug in
//! any of the three thousand lines around this one cannot leak a token this
//! module never held. Every function below that touches a secret returns it to
//! exactly one caller and none of them log, format, or serialise it.
//!
//! **Rust reads the store; PowerShell writes it.** There is deliberately no
//! `put_token` here — the sign-in terminal wraps and writes the file itself
//! (see `SIGNIN_PS1`), and the `cc-add` helper writes the identical shape. One
//! writer means one place where a credential is handled on the way in, and it
//! is the one place that already has the secret in hand for other reasons.
//!
//! ### The wrapping
//!
//! PowerShell's `ConvertFrom-SecureString` with no `-Key` is `CryptProtectData`
//! with no entropy: the file is a raw DPAPI blob, hex-encoded, over the
//! **UTF-16LE** bytes of the token. Probed 2026-08-19 — a 35-character token
//! came to 524 hex characters opening with the v1 magic `01000000` and the
//! provider GUID `d08c9ddf-0115-d111-8c7a-00c04fc297eb` in its little-endian
//! spelling. Round-tripped through `ConvertTo-SecureString` in the same probe.
//!
//! DPAPI at user scope means the blob decrypts **only under this Windows user
//! on this machine**. Copying the store to another machine, or to another
//! account on this one, yields nothing — which is the whole reason the tokens
//! are not simply sitting in a JSON file next to `.credentials.json`, which is
//! what they would otherwise be.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

use crate::store::Store;

/* ── the store on disk ─────────────────────────────────────────────────────*/

/// `~/.claude/tokens`. Beside Claude Code's own credentials rather than inside
/// Skein's data directory, deliberately: the same store is written by the
/// PowerShell helper and read by both, so a token added from a terminal is one
/// Skein can already use and vice versa. One store, two consumers.
pub fn token_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home dir: {e}"))?;
    Ok(home.join(".claude").join("tokens"))
}

fn token_path(app: &AppHandle, label: &str) -> Result<PathBuf, String> {
    if !is_label(label) {
        return Err("that is not a usable account name".into());
    }
    Ok(token_dir(app)?.join(format!("{label}.tok")))
}

/// Letters, digits, dot, dash, underscore. The same set the PowerShell helper
/// validates, and it is a path component that gets joined to a directory — so
/// this is the check that stops a label from being `..\..\something`, not a
/// matter of taste. Kept in step with `Add-ClaudeAccount`'s `ValidatePattern`.
pub fn is_label(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

/// Whether the store has a file for this label. Says nothing about whether the
/// token inside still works — that question is only answerable by spending it,
/// and `limits.rs` asking for the allowance is what answers it in practice.
pub fn has_token(app: &AppHandle, label: &str) -> bool {
    token_path(app, label).map(|p| p.is_file()).unwrap_or(false)
}

/* ── DPAPI ─────────────────────────────────────────────────────────────────*/

fn unhex(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if s.len() % 2 != 0 || s.is_empty() {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let b = s.as_bytes();
    for pair in b.chunks(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
    }
    Some(out)
}

/// Unwrap one DPAPI blob to the string inside it.
///
/// The output buffer is LocalAlloc'd by the API and freed here on every path,
/// including the error one. It holds a plaintext credential, so it is also
/// zeroed before it is freed — belt to the braces of freeing it, and cheap.
#[cfg(windows)]
fn unprotect(blob: &[u8]) -> Result<String, String> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{CRYPT_INTEGER_BLOB, CryptUnprotectData};

    let mut input = CRYPT_INTEGER_BLOB {
        cbData: blob.len() as u32,
        pbData: blob.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();

    unsafe {
        CryptUnprotectData(&mut input, None, None, None, None, 0, &mut output)
            .map_err(|_| "this token could not be decrypted — it was wrapped by a different Windows user or on a different machine".to_string())?;

        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        /* UTF-16LE, because that is what a SecureString is made of. An odd
           length is not a short string, it is the wrong kind of blob. */
        let text = if bytes.len() % 2 == 0 {
            let wide: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            String::from_utf16(&wide).ok()
        } else {
            None
        };

        std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut std::ffi::c_void)));

        text.map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .ok_or_else(|| "this token file did not hold readable text".to_string())
    }
}

#[cfg(not(windows))]
fn unprotect(_blob: &[u8]) -> Result<String, String> {
    Err("the token store is DPAPI-wrapped and only readable on Windows".into())
}

/// The token for one account.
///
/// The one function in the app that produces a credential, and it has exactly
/// one caller: `supervisor.rs`, putting it into a child's environment. It is
/// not a `#[tauri::command]` and must never become one — a command is reachable
/// from the front end, and a token in the front end is a token in a webview,
/// in a devtools console, and one `console.log` from a screenshot.
pub fn token_for(app: &AppHandle, label: &str) -> Result<String, String> {
    let path = token_path(app, label)?;
    let raw = std::fs::read_to_string(&path).map_err(|_| {
        format!("no token stored for '{label}' — sign in to that account in the accounts panel")
    })?;
    let blob = unhex(&raw).ok_or_else(|| {
        format!("the token file for '{label}' is not in the expected format")
    })?;
    unprotect(&blob)
}

/* ── the registry ──────────────────────────────────────────────────────────*/

/// One account as the front end sees it. **No token field, and there is no
/// version of this struct that has one** — this is what crosses into the
/// webview.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub label: String,
    pub rank: i64,
    pub enabled: bool,
    /// Window `kind` → percentage ceiling. Free-form because the rate limiter's
    /// window vocabulary moves; see `migrate_v16`.
    pub caps: serde_json::Value,
    /// Whether the store has a token file for this label.
    pub has_token: bool,
}

#[tauri::command]
pub fn list_accounts(app: AppHandle, store: State<'_, Store>) -> Result<Vec<Account>, String> {
    let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
    let mut stmt = conn
        .prepare("SELECT label, rank, enabled, caps FROM account ORDER BY rank, label")
        .map_err(|e| format!("read accounts: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            let label: String = r.get(0)?;
            let caps: String = r.get(3)?;
            Ok((label, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, caps))
        })
        .map_err(|e| format!("read accounts: {e}"))?;

    let mut out = Vec::new();
    for row in rows {
        let (label, rank, enabled, caps) = row.map_err(|e| format!("read accounts: {e}"))?;
        let has = has_token(&app, &label);
        out.push(Account {
            caps: serde_json::from_str(&caps).unwrap_or_else(|_| serde_json::json!({})),
            has_token: has,
            label,
            rank,
            enabled: enabled != 0,
        });
    }
    Ok(out)
}

/// Add an account to the registry, at the end of the order.
///
/// Registering and signing in are two gestures, not one: an account can exist
/// in the order with no token yet (`accounts.ts` reports it `unusable` and says
/// what to do), and a token can exist in the store for a label nobody has
/// registered. Keeping them apart is what lets the panel show "signed in
/// elsewhere, add it?" rather than silently adopting whatever is on disk.
#[tauri::command]
pub fn add_account(store: State<'_, Store>, label: String) -> Result<(), String> {
    if !is_label(&label) {
        return Err("an account name may use letters, digits, dot, dash and underscore".into());
    }
    let conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
    let next: i64 = conn
        .query_row("SELECT COALESCE(MAX(rank), -1) + 1 FROM account", [], |r| r.get(0))
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO account (label, rank, enabled, caps, added_at)
         VALUES (?1, ?2, 1, '{}', ?3)
         ON CONFLICT(label) DO NOTHING",
        rusqlite::params![label, next, crate::store::now()],
    )
    .map_err(|e| format!("add account: {e}"))?;
    Ok(())
}

/// Forget an account. **Leaves the token file alone** — removing a row from a
/// list is not a gesture anybody expects to destroy a credential, and a
/// re-added label picks its token straight back up. The panel offers deleting
/// the token as its own item, worded as what it is.
#[tauri::command]
pub fn remove_account(store: State<'_, Store>, label: String) -> Result<(), String> {
    store
        .0
        .lock()
        .map_err(|_| "the store is wedged".to_string())?
        .execute("DELETE FROM account WHERE label = ?1", rusqlite::params![label])
        .map_err(|e| format!("remove account: {e}"))?;
    Ok(())
}

/// Delete the stored credential for an account, which is the gesture that
/// actually signs it out of Skein. Kept apart from `remove_account` for the
/// reason stated there.
#[tauri::command]
pub fn forget_token(app: AppHandle, label: String) -> Result<(), String> {
    let path = token_path(&app, &label)?;
    if path.is_file() {
        std::fs::remove_file(&path).map_err(|e| format!("could not delete the token: {e}"))?;
    }
    Ok(())
}

/// Set the whole order at once, from the list the panel is showing.
///
/// The order is the feature — it is what makes the waterfall a waterfall — so
/// it is written as one transaction rather than a rank per call. A reorder that
/// half-applied would leave two accounts claiming the same rank and the tie
/// broken by label, which is a wall quietly spending the wrong subscription.
#[tauri::command]
pub fn reorder_accounts(store: State<'_, Store>, labels: Vec<String>) -> Result<(), String> {
    let mut conn = store.0.lock().map_err(|_| "the store is wedged".to_string())?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("reorder accounts: {e}"))?;
    for (i, label) in labels.iter().enumerate() {
        tx.execute(
            "UPDATE account SET rank = ?1 WHERE label = ?2",
            rusqlite::params![i as i64, label],
        )
        .map_err(|e| format!("reorder accounts: {e}"))?;
    }
    tx.commit().map_err(|e| format!("reorder accounts: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn set_account_enabled(
    store: State<'_, Store>,
    label: String,
    enabled: bool,
) -> Result<(), String> {
    store
        .0
        .lock()
        .map_err(|_| "the store is wedged".to_string())?
        .execute(
            "UPDATE account SET enabled = ?1 WHERE label = ?2",
            rusqlite::params![enabled as i64, label],
        )
        .map_err(|e| format!("set account: {e}"))?;
    Ok(())
}

/// Set the ceilings for one account. `caps` is `{ "session": 80 }` and friends;
/// an empty object means no ceiling of yours on any window, which leaves the
/// server's.
#[tauri::command]
pub fn set_account_caps(
    store: State<'_, Store>,
    label: String,
    caps: serde_json::Value,
) -> Result<(), String> {
    if !caps.is_object() {
        return Err("caps must be an object of window kind to percentage".into());
    }
    store
        .0
        .lock()
        .map_err(|_| "the store is wedged".to_string())?
        .execute(
            "UPDATE account SET caps = ?1 WHERE label = ?2",
            rusqlite::params![caps.to_string(), label],
        )
        .map_err(|e| format!("set caps: {e}"))?;
    Ok(())
}

/// Labels that have a token in the store. Lets the panel offer an account that
/// was signed in from a terminal but never registered here.
#[tauri::command]
pub fn stored_tokens(app: AppHandle) -> Result<Vec<String>, String> {
    let dir = match token_dir(&app) {
        Ok(d) if d.is_dir() => d,
        _ => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("read token store: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("tok") {
            continue;
        }
        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
            if is_label(stem) {
                out.push(stem.to_string());
            }
        }
    }
    out.sort();
    Ok(out)
}

/* ── signing in ────────────────────────────────────────────────────────────*/

/// The script the sign-in terminal runs. Self-contained on purpose: it must not
/// depend on the user's PowerShell profile having been set up, since the whole
/// point of doing this from Skein is that nothing had to be set up first.
///
/// `{LABEL}` and `{DIR}` are substituted. Nothing else is — a label is checked
/// by `is_label` before it reaches here, which is what makes the substitution
/// safe rather than a quoting exercise.
const SIGNIN_PS1: &str = r#"
$ErrorActionPreference = 'Stop'
$label = '{LABEL}'
$dir   = '{DIR}'

Write-Host ''
Write-Host "  Signing in to Claude Code as '$label'." -ForegroundColor Cyan
Write-Host '  A browser will open. When it gives you a token, come back here.'
Write-Host ''

claude setup-token

Write-Host ''
Write-Host '  Paste the token above (it will not be echoed).' -ForegroundColor Cyan
$secure = Read-Host "  token for '$label'" -AsSecureString
if (-not $secure -or $secure.Length -eq 0) {
  Write-Host '  nothing pasted - no token stored.' -ForegroundColor Yellow
  Read-Host '  press Enter to close'
  exit 1
}

$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  if ($plain -notmatch '^sk-ant-') {
    Write-Host "  warning: that does not look like a Claude token (expected 'sk-ant-...'). Storing it anyway." -ForegroundColor Yellow
  }
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Variable plain -ErrorAction SilentlyContinue
}

New-Item -ItemType Directory -Path $dir -Force | Out-Null
ConvertFrom-SecureString $secure | Set-Content -Path (Join-Path $dir "$label.tok") -Encoding ascii

Write-Host ''
Write-Host "  stored '$label'. Skein has it - you can close this window." -ForegroundColor Green
Start-Sleep -Seconds 2
"#;

/// Open a terminal and walk one account through `claude setup-token`.
///
/// **Why this needs a window at all.** `claude setup-token` is an interactive
/// TUI. Probed 2026-08-19: given pipes for stdio it prints nothing and never
/// exits — it wants a terminal, and there is no `--print`-shaped arm to ask for
/// instead. The obvious answer is a PTY and it is closed here: ConPTY is broken
/// on this machine, every `openpty` child dying at `0xC0000142` (`servers.md`,
/// `shell.md`, and `shell.rs` is pipes for exactly this reason). The other
/// obvious answer — Skein speaking the OAuth flow itself — would mean pinning a
/// `client_id` that is not ours against undocumented endpoints, and a sign-in is
/// the last thing that should be reverse-engineered.
///
/// So the flow is orchestrated rather than embedded, and **the token never
/// passes through Skein**: the paste happens in the terminal, and the script
/// wraps it with DPAPI and writes it straight into the store. Skein supplies the
/// label and watches for the file. Nothing here ever holds the secret, which is
/// the same property `token_for` is careful about from the other side.
///
/// Returns as soon as the terminal is launched. The front end watches
/// `stored_tokens` for the label to appear — there is no completion signal to
/// wait for, and inventing one by waiting on the child would block on however
/// long somebody takes to find their browser.
#[tauri::command]
pub fn begin_signin(app: AppHandle, label: String) -> Result<(), String> {
    if !is_label(&label) {
        return Err("an account name may use letters, digits, dot, dash and underscore".into());
    }
    let dir = token_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not make the token store: {e}"))?;

    let script = SIGNIN_PS1
        .replace("{LABEL}", &label)
        .replace("{DIR}", &dir.to_string_lossy());

    /* Skein's own data directory rather than %TEMP%: a script that survives
       until the user finishes reading it, in a place we already own and can
       clean. Named per label so two sign-ins at once do not overwrite one
       another. */
    let here = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no data dir: {e}"))?;
    std::fs::create_dir_all(&here).map_err(|e| format!("could not make the data dir: {e}"))?;
    let path = here.join(format!("signin-{label}.ps1"));
    std::fs::write(&path, script).map_err(|e| format!("could not write the sign-in script: {e}"))?;

    launch_terminal(&path)
}

/// Put a real console in front of the user.
///
/// Windows Terminal first because it is what a modern install has and it renders
/// the TUI properly; `powershell.exe` is the fallback that exists on every
/// Windows box. **Deliberately not `quiet`** — every other spawn in this app
/// hides its console and this one *is* the console; `CREATE_NO_WINDOW` here
/// would produce exactly the invisible hang the pipes probe already found.
#[cfg(windows)]
fn launch_terminal(script: &std::path::Path) -> Result<(), String> {
    use std::process::Command;

    let arg = script.to_string_lossy().to_string();
    /* `wt.exe` returns immediately having handed off to the terminal process,
       so a failure to *launch* is all that can be detected here — which is why
       the fallback is tried on spawn error rather than on exit status. */
    let wt = Command::new("wt.exe")
        .args(["-w", "0", "nt", "--title", "Claude Code sign-in", "powershell"])
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-File", &arg])
        .spawn();
    if wt.is_ok() {
        return Ok(());
    }

    Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-File", &arg])
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not open a terminal to sign in with: {e}"))
}

#[cfg(not(windows))]
fn launch_terminal(_script: &std::path::Path) -> Result<(), String> {
    Err("signing in from Skein is Windows-only for now".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_label_is_a_path_component_and_is_checked_as_one() {
        assert!(is_label("work"));
        assert!(is_label("team-2"));
        assert!(!is_label(""));
        assert!(!is_label("../../etc"));
        assert!(!is_label("a\\b"));
        assert!(!is_label("a/b"));
        assert!(!is_label("with space"));
    }

    #[test]
    fn hex_round_trips() {
        assert_eq!(unhex("01ff0A"), Some(vec![0x01, 0xff, 0x0a]));
    }

    /// A blob is even-length hex by construction; anything else is a file that
    /// is not one of ours, and reading it as a short token would be worse than
    /// refusing it.
    #[test]
    fn malformed_hex_is_refused_rather_than_truncated() {
        assert_eq!(unhex("012"), None);
        assert_eq!(unhex("zz"), None);
        assert_eq!(unhex(""), None);
    }

    /// The real prefix a PowerShell-written token carries: DPAPI v1 and the
    /// provider GUID, little-endian. Probed 2026-08-19.
    #[test]
    fn the_powershell_blob_prefix_decodes() {
        let got = unhex("01000000d08c9ddf0115d1118c7a00c04fc297eb").unwrap();
        assert_eq!(&got[..4], &[0x01, 0x00, 0x00, 0x00]);
        assert_eq!(got.len(), 20);
    }
}
