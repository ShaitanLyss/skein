//! More than one subscription, in an order.
//!
//! The facts half. `accounts.ts` decides *which* account the next turn goes to
//! and what to say about it; this holds the registry, and points one child
//! process at one account's credentials. The same split `limits.rs` draws
//! against `limits.ts`, and `.claude/rules/accounts.md` is the whole of the
//! reasoning.
//!
//! ### An account is a credential store, not a token
//!
//! This was `~/.claude/tokens/<label>.tok` — a long-lived token from `claude
//! setup-token`, DPAPI-wrapped, put on the child as `CLAUDE_CODE_OAUTH_TOKEN`.
//! That design worked for spawning cards and for nothing else, because **a
//! `setup-token` token is scoped `user:inference` alone**: `GET
//! /api/oauth/usage` answers it `403`, and so does `/api/oauth/profile`. Probed
//! 2026-08-19 against claude 2.1.235 — the same request with the CLI's own
//! credential answers `200`. It is deliberate and there is no flag for it; the
//! CLI's authorize URL carries `inferenceOnly: true` and its own diagnostics say
//! long-lived tokens "are limited to inference-only for security reasons".
//!
//! An allowance that can never be read took the whole feature down, because
//! `accounts.ts::standingOf` read "cannot be asked" as "unusable" — so every
//! send on a card with an account met "no account available", for an account
//! that would have run perfectly well.
//!
//! So an account is now **its own credential store**, holding a real
//! `claude auth login` credential with the full scope set:
//!
//! ```text
//! ~/.claude/accounts/<label>/.credentials.json
//! ```
//!
//! and a card is put on one by `CLAUDE_SECURESTORAGE_CONFIG_DIR`, which selects
//! the store **and only the store** — `CLAUDE_CONFIG_DIR` is untouched, so
//! transcripts, sessions and therefore the `--resume` the account swap is built
//! on all stay exactly where they were. Probed 2026-08-20, three ways: an empty
//! store dir reports `loggedIn: false, authMethod: "none"` (so there is no
//! quiet fall-through to the global sign-in), a store holding a credential
//! reports `authMethod: "claude.ai"` with the account's email, org and plan, and
//! a real `--print` turn ran under one while writing its transcript to the
//! shared config directory. `claude auth login` honours it too, leaving the
//! global credential byte-identical — which is the step the whole arrangement
//! rests on and the one that needed a browser to check.
//!
//! What this buys, beyond the feature working at all: the allowance endpoint
//! answers per account, so percentages, your caps, the resets and the reports
//! are all real; the credential **refreshes itself**, because the child owns the
//! store and the CLI does what it always does with it; and signing in is the
//! supported interactive flow rather than a long-lived token mint.
//!
//! ### What it costs, said plainly
//!
//! The store is a plain JSON file on Windows, exactly like the global
//! `~/.claude/.credentials.json` it is a sibling of — so this **loses the DPAPI
//! wrapping** the `.tok` design had. That is a real regression in one respect
//! and an improvement in another: Skein no longer handles a secret at all. It
//! writes no credential, holds none in memory, and puts none in a child's
//! environment; it names a *directory*, and the CLI does the rest. The one place
//! a credential is read is `limits.rs`, asking the allowance endpoint the same
//! question about the same file the CLI reads.
//!
//! Nothing here logs, formats or serialises a credential, and `Account` — the
//! struct that crosses into the webview — carries no secret and no path to one.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

use crate::store::Store;

/* ── the stores on disk ────────────────────────────────────────────────────*/

/// `~/.claude/accounts`. Beside Claude Code's own credential rather than inside
/// Skein's data directory, deliberately: these *are* Claude Code credential
/// stores, written and refreshed by the CLI, and a store Skein happened to own
/// the parent of would still be the CLI's to keep current.
pub fn store_root(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home dir: {e}"))?;
    Ok(home.join(".claude").join("accounts"))
}

/// The store directory for one account — what goes in
/// `CLAUDE_SECURESTORAGE_CONFIG_DIR`.
pub fn store_dir(app: &AppHandle, label: &str) -> Result<PathBuf, String> {
    if !is_label(label) {
        return Err("that is not a usable account name".into());
    }
    Ok(store_root(app)?.join(label))
}

/// The credential inside one account's store. Public because `limits.rs` reads
/// it to ask the allowance endpoint — the same file, in the same shape, that it
/// already reads for the globally signed-in account.
pub fn credential_path(app: &AppHandle, label: &str) -> Result<PathBuf, String> {
    Ok(store_dir(app, label)?.join(".credentials.json"))
}

/// Letters, digits, dot, dash, underscore — and **never a name made only of
/// dots**.
///
/// A label is a path component joined to a directory, so this is the check that
/// stops one from being `..\..\something` rather than a matter of taste. The
/// dots clause is not decoration and the stakes for it changed with this
/// module: when an account was a *file* (`<label>.tok`), a label of `..` merely
/// named a file called `...tok` and did nothing. Now the label names a
/// **directory** that `sign_out` removes recursively, so `..` would resolve to
/// `~/.claude` and `.` to the store root holding every account. Both pass a
/// bare character-class check, since `.` is a legal character in a real label
/// like `work.2`. So the character set is not sufficient on its own and the
/// component is rejected outright when nothing but dots is left of it.
pub fn is_label(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
        && s.chars().any(|c| c != '.')
}

/// Whether this account has been signed in — i.e. whether its store holds a
/// credential. Says nothing about whether that credential is still *fresh*:
/// an access token expires and the CLI refreshes it on its next turn, so a
/// stale store is a signed-in account whose allowance cannot be read this
/// minute, which is a different thing entirely and `accounts.ts::standingOf`
/// keeps them apart.
pub fn signed_in(app: &AppHandle, label: &str) -> bool {
    credential_path(app, label)
        .map(|p| p.is_file())
        .unwrap_or(false)
}

/* ── the registry ──────────────────────────────────────────────────────────*/

/// One account as the front end sees it. No credential and no path to one —
/// **this is what crosses into the webview.**
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub label: String,
    pub rank: i64,
    pub enabled: bool,
    /// Window `kind` → percentage ceiling. Free-form because the rate limiter's
    /// window vocabulary moves; see `migrate_v16`.
    pub caps: serde_json::Value,
    /// Whether this account's store holds a credential.
    pub signed_in: bool,
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
        let has = signed_in(&app, &label);
        out.push(Account {
            caps: serde_json::from_str(&caps).unwrap_or_else(|_| serde_json::json!({})),
            signed_in: has,
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
/// in the order with no credential yet (`accounts.ts` reports it `unusable` and
/// says what to do), and a store can exist for a label nobody has registered.
/// Keeping them apart is what lets the panel show "signed in elsewhere, add it?"
/// rather than silently adopting whatever is on disk.
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

/// Forget an account. **Leaves its credential store alone** — removing a row
/// from a list is not a gesture anybody expects to sign them out of a
/// subscription, and a re-added label picks its store straight back up. Signing
/// out is its own item, worded as what it is.
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

/// Sign an account out of Skein by deleting its credential store.
///
/// Deliberately not `remove_dir_all` on the store root or anything above it: the
/// path is built through `store_dir`, which refuses a label that is not a single
/// path component, and only the one directory is removed. Kept apart from
/// `remove_account` for the reason stated there.
#[tauri::command]
pub fn sign_out(app: AppHandle, label: String) -> Result<(), String> {
    let dir = store_dir(&app, &label)?;
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("could not sign that account out: {e}"))?;
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

/// Labels with a credential store that no registered account claims. Lets the
/// panel offer an account signed in from a terminal, or left behind by a
/// `remove`, rather than adopting it silently.
#[tauri::command]
pub fn stored_accounts(app: AppHandle) -> Result<Vec<String>, String> {
    let root = match store_root(&app) {
        Ok(d) if d.is_dir() => d,
        _ => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&root).map_err(|e| format!("read account stores: {e}"))?;
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(|s| s.to_string()) else {
            continue;
        };
        /* A directory with no credential in it is not an account anybody can
           be offered — it is what `add` then abandoning a sign-in leaves. */
        if is_label(&name) && entry.path().join(".credentials.json").is_file() {
            out.push(name);
        }
    }
    out.sort();
    Ok(out)
}

/* ── signing in ────────────────────────────────────────────────────────────*/

/* It lives in `signin.rs`, which spawns `claude auth login` on pipes with this
   module's `store_dir` in its environment. It used to be here, as a PowerShell
   script launched in a real terminal, because the command it ran then was
   `claude setup-token` — an ink TUI that emits nothing on pipes. `auth login`
   is not that: it is `process.stdout.write` and a readline, so the window it
   was given was inherited rather than needed. See that module's header. */

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

    /// The label names a directory that `sign_out` deletes **recursively**, so
    /// this check is the only thing between a bad label and somebody's home
    /// directory. `.` and `..` are the dangerous pair: both pass a plain
    /// character-class test, because a dot is legal in a real label, and both
    /// resolve *upward* — `..` to `~/.claude`, `.` to the root holding every
    /// account's store. Neither mattered when an account was a file called
    /// `<label>.tok`; both are catastrophic now.
    #[test]
    fn a_label_that_would_escape_its_directory_is_refused() {
        for bad in [".", "..", "...", "../..", "..\\..", "a/../../b", "/", "\\"] {
            assert!(!is_label(bad), "{bad:?} must not be a usable label");
        }
        /* And a dot in an otherwise real label is still fine, which is why the
           character set could not simply drop it. */
        assert!(is_label("work.2"));
        assert!(is_label("a.b.c"));
    }
}
