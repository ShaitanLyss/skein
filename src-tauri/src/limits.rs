//! What is left of the allowance, asked of the only thing that knows.
//!
//! `usage.rs` reads the transcripts and answers "what has this cost". That is a
//! real question and it is not the one you ask at four in the afternoon. The one
//! you ask then is **how much of the five-hour window is gone and when does it
//! come back** — what `/usage` prints in the CLI — and for a long time this app
//! answered it by inference, because the note at the top of `usage.ts` was right
//! that a transcript records no limit. `rateLimits` appears in the files only on
//! error records and is `null` on every one of them.
//!
//! It is not right that *nothing* knows. Claude Code asks
//! `GET /api/oauth/usage`, signed with the OAuth token it already holds, and is
//! answered with the utilization of every window the account has and the moment
//! each one rolls. Probed 2026-08-17 against claude 2.1.229 on a `team` plan at
//! `default_claude_max_5x`:
//!
//! ```text
//! five_hour  { utilization: 8.0, resets_at: "2026-08-17T11:39:59.968762+00:00" }
//! seven_day  { utilization: 8.0, resets_at: "2026-08-23T04:59:59.968782+00:00" }
//! limits: [ { kind: "session",       group: "session", percent: 8, severity: "normal", is_active: true  },
//!           { kind: "weekly_all",    group: "weekly",  percent: 8, severity: "normal", is_active: false },
//!           { kind: "weekly_scoped", group: "weekly",  percent: 0, severity: "normal", is_active: false,
//!             scope: { model: { display_name: "Fable" } } } ]
//! ```
//!
//! Four things about that endpoint carry this module:
//!
//! - **`limits[]` is the shape to read, not the named keys.** The response also
//!   carries `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet` —
//!   and, on this account, `seven_day_cowork`, `nimbus_quill`, `tangelo`,
//!   `iguana_necktie`, `amber_ladder`, `cinder_cove` and `omelette_promotional`,
//!   all but one of them null. Those are codenames for windows that do not exist
//!   yet, and a reader keyed on the names would show nothing for whichever one
//!   the account is eventually given. `limits[]` is the projection the CLI's own
//!   readout maps over, it carries a `scope.model.display_name` for the scoped
//!   ones, and a window added next month arrives in it already labelled. The
//!   named keys are kept only as a fallback, for the two that have always been
//!   there.
//!
//! - **The token is read and never refreshed.** `~/.claude/.credentials.json`
//!   holds an access token and a *refresh* token, and spending the refresh token
//!   rotates it — so a Skein that refreshed would race the CLI for the one
//!   credential both of them sign in with, and the loser is signed out. Skein is
//!   a reader here: if the access token has expired it says so and waits, which
//!   costs nothing, because anything that makes this wall interesting also makes
//!   the CLI refresh it within the hour.
//!
//! - **Nothing about the credential leaves this file.** Not into a fault string,
//!   not into the snapshot, not into a log. `source` says *where* the token came
//!   from and never a fragment of it — the rule `azdo.md` already states, and the
//!   reason is the same: a snapshot gets written to a file.
//!
//! - **This network intercepts TLS**, so the client is `ureq` with
//!   `native-certs` for exactly the reason `azdo.rs` documents at length. Built
//!   the obvious way this fails on every corporate wifi and works perfectly at
//!   home.
//!
//! Facts and never verbs, the split `perf.rs`, `usage.rs` and `azdo.rs` all
//! draw. What a percentage *means*, what a window is called, when it has run
//! close enough to be worth a colour and how a reset is worded are `limits.ts`'s,
//! which is pure and tested.

use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

use crate::usage::epoch_ms;

const ENDPOINT: &str = "https://api.anthropic.com/api/oauth/usage";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const READ_TIMEOUT: Duration = Duration::from_secs(10);

/// The most often the endpoint is asked, whoever asks. The front end polls on a
/// minute and the control surface's `read` forces a pass, and neither of those
/// should be able to turn a widget into a hammer: a five-hour window moves by a
/// third of a percent in twenty seconds, so there is nothing to be had for it.
const FLOOR_MS: i64 = 30_000;

#[derive(Default)]
pub struct Limits(Mutex<Cache>);

#[derive(Default)]
struct Cache {
    last: Option<Report>,
    /// When the endpoint was last actually asked — set whether it answered or
    /// refused, so a failing call is throttled exactly like a working one and a
    /// network that is down is not asked sixty times a minute.
    asked: i64,
}

/// One window the account is measured against.
///
/// `kind` is the rate limiter's own vocabulary rather than anything readable —
/// `session`, `weekly_all`, `weekly_scoped` — and is deliberately passed through
/// unchanged, because the same words come back in the `anthropic-ratelimit-*`
/// headers when a limit is actually hit. A window you were watching and the
/// window that stopped you should be nameable as the same thing.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    kind: String,
    /// `session` or `weekly` — which clock this one runs on.
    group: String,
    /// Percent of the allowance used, 0–100. The server's own figure; nothing
    /// here recomputes it from tokens, since only the server knows the divisor.
    used: f64,
    /// What the server itself calls this level — `normal`, `warning`, and the
    /// rejection states. Carried rather than obeyed: `limits.ts` derives its own
    /// tone and takes whichever of the two is worse, so a window at 98% is never
    /// drawn calm because a field arrived saying so.
    severity: String,
    /// When this window rolls, epoch ms, or `None` when the server names no
    /// reset — which a scoped window nobody has touched genuinely does.
    resets_at: Option<i64>,
    /// What the window is scoped to, when it is scoped at all: a model's display
    /// name, as the server spells it.
    scope: Option<String>,
    /// Whether the server considers this the window currently binding.
    active: bool,
}

/// Usage past the plan's allowance, when the account has it turned on. Carried
/// because without it a window pinned at 100% is a lie in the other direction:
/// work is still going through, it is simply being billed.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Overage {
    enabled: bool,
    used: Option<f64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    windows: Vec<Window>,
    overage: Option<Overage>,
    /// When this reading was taken, epoch ms.
    at: i64,
    /// Where the token came from. Never any part of the token itself.
    source: String,
    /// The plan, as the account names it (`max`, `team`, `pro`). The only thing
    /// in the reading that says what these percentages are a percentage *of*.
    plan: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/* ── the credential ────────────────────────────────────────────────────────*/

/// A token, and a word for where it was found. The word is all that is ever
/// reported; the token goes straight into one header and nowhere else.
struct Token {
    value: String,
    source: String,
    plan: Option<String>,
}

/// The token Claude Code is signed in with, if it is signed in.
///
/// Two places, in the order the CLI itself prefers them: the environment
/// variable a headless install is configured with, then the credentials file a
/// normal sign-in writes. An account on Bedrock or Vertex has neither and never
/// will, which is not a fault — it is an account these windows do not apply to,
/// and `read_limits` says so in those words.
fn token(app: &AppHandle) -> Result<Token, String> {
    if let Ok(v) = std::env::var("CLAUDE_CODE_OAUTH_TOKEN") {
        let v = v.trim().to_string();
        if !v.is_empty() {
            return Ok(Token {
                value: v,
                source: "CLAUDE_CODE_OAUTH_TOKEN".into(),
                plan: None,
            });
        }
    }

    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("no home dir: {e}"))?;
    let path = home.join(".claude").join(".credentials.json");
    let raw = std::fs::read_to_string(&path)
        .map_err(|_| "not signed in to Claude Code on this machine".to_string())?;
    let doc: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| "the sign-in file could not be read".to_string())?;

    let oauth = doc
        .get("claudeAiOauth")
        .ok_or_else(|| "not signed in with a Claude account".to_string())?;
    let value = oauth
        .get("accessToken")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if value.is_empty() {
        return Err("not signed in with a Claude account".into());
    }

    /* Expiry is checked here rather than left to the server, because a token we
       can see has expired is one request we know the answer to. Skein does not
       refresh it — see the note at the top — so the honest reading is to say the
       sign-in is stale and pick it up on a later pass; the file is re-read every
       time, so the moment the CLI rotates it this recovers on its own. */
    let expires = oauth.get("expiresAt").and_then(|v| v.as_i64()).unwrap_or(0);
    if expires > 0 && expires <= now_ms() {
        return Err("the CLI's sign-in has expired — it refreshes on its next turn".into());
    }

    Ok(Token {
        value,
        source: "the CLI's sign-in".into(),
        plan: oauth
            .get("subscriptionType")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string()),
    })
}

/* ── reading the answer ────────────────────────────────────────────────────*/

fn text(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn percent(v: &serde_json::Value, key: &str) -> Option<f64> {
    v.get(key)
        .and_then(|x| x.as_f64())
        .filter(|n| n.is_finite())
        .map(|n| n.clamp(0.0, 1000.0))
}

fn reset(v: &serde_json::Value, key: &str) -> Option<i64> {
    v.get(key).and_then(|x| x.as_str()).and_then(epoch_ms)
}

/// The two windows that have always been there, read off their named keys.
///
/// Only reached when `limits[]` is missing or empty — an older server, or a
/// shape that changed under us. Losing the scoped windows in that case is
/// acceptable; losing the five-hour one is not, and it is the whole reason this
/// widget exists.
fn named(doc: &serde_json::Value) -> Vec<Window> {
    const KEYS: [(&str, &str, &str, Option<&str>); 4] = [
        ("five_hour", "session", "session", None),
        ("seven_day", "weekly_all", "weekly", None),
        ("seven_day_opus", "weekly_scoped", "weekly", Some("Opus")),
        ("seven_day_sonnet", "weekly_scoped", "weekly", Some("Sonnet")),
    ];
    let mut out = Vec::new();
    for (key, kind, group, scope) in KEYS {
        let Some(w) = doc.get(key).filter(|v| !v.is_null()) else {
            continue;
        };
        let Some(used) = percent(w, "utilization") else {
            continue;
        };
        out.push(Window {
            kind: kind.into(),
            group: group.into(),
            used,
            severity: "normal".into(),
            resets_at: reset(w, "resets_at"),
            scope: scope.map(|s| s.to_string()),
            active: kind == "session",
        });
    }
    out
}

fn windows(doc: &serde_json::Value) -> Vec<Window> {
    let mut out = Vec::new();
    if let Some(rows) = doc.get("limits").and_then(|v| v.as_array()) {
        for row in rows {
            let Some(kind) = text(row, "kind") else {
                continue;
            };
            let Some(used) = percent(row, "percent") else {
                continue;
            };
            out.push(Window {
                group: text(row, "group").unwrap_or_else(|| kind.clone()),
                kind,
                used,
                severity: text(row, "severity").unwrap_or_else(|| "normal".into()),
                resets_at: reset(row, "resets_at"),
                /* `scope` is present and null on the unscoped rows, and on the
                   scoped one it is `{ model: { display_name } }` with `id` null
                   — so the display name is the only part of it worth carrying,
                   and the only part that is reliably filled in. */
                scope: row
                    .get("scope")
                    .and_then(|s| s.get("model"))
                    .and_then(|m| m.get("display_name"))
                    .and_then(|n| n.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string()),
                active: row
                    .get("is_active")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            });
        }
    }
    if out.is_empty() {
        out = named(doc);
    }
    out
}

fn overage(doc: &serde_json::Value) -> Option<Overage> {
    let x = doc.get("extra_usage").filter(|v| !v.is_null())?;
    Some(Overage {
        enabled: x
            .get("is_enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        used: percent(x, "utilization"),
    })
}

/* ── asking ────────────────────────────────────────────────────────────────*/

fn ask(token: &Token) -> Result<serde_json::Value, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .build();

    match agent
        .get(ENDPOINT)
        .set("Authorization", &format!("Bearer {}", token.value))
        .set("Accept", "application/json")
        /* The beta the OAuth-scoped endpoints are gated behind. Sent explicitly
           rather than relied upon by default, which is how the CLI sends it. */
        .set("anthropic-beta", "oauth-2025-04-20")
        .call()
    {
        Ok(res) => res
            .into_json::<serde_json::Value>()
            .map_err(|e| format!("unreadable answer: {e}")),
        /* 401 here is the sign-in having gone stale between the expiry check
           above and the call — said in the same words, since it has the same
           answer: the CLI will refresh it, and this recovers by itself. */
        Err(ureq::Error::Status(401, _)) => {
            Err("the CLI's sign-in has expired — it refreshes on its next turn".into())
        }
        Err(ureq::Error::Status(403, _)) => {
            Err("this account cannot be asked about its allowance".into())
        }
        Err(ureq::Error::Status(code, _)) => Err(format!("the allowance endpoint answered {code}")),
        Err(e) => Err(format!("could not reach the allowance endpoint: {e}")),
    }
}

/// What is left of the allowance, and when each window rolls.
///
/// Cheap to call often — `FLOOR_MS` is what makes that true. A pass inside the
/// floor hands back the reading already held rather than asking again, so the
/// front end's poll, the control surface's forced read and however many widgets
/// are on the wall all collapse into one request per half-minute at worst.
///
/// Fails rather than inventing: an account with no OAuth sign-in (Bedrock,
/// Vertex, an API key) has no windows of this kind at all, and a widget drawing
/// a confident 0% for one would be worse than a widget saying it cannot see.
#[tauri::command]
pub fn read_limits(app: AppHandle, state: State<'_, Limits>) -> Result<Report, String> {
    let now = now_ms();
    {
        let cache = state.0.lock().unwrap();
        if let Some(last) = &cache.last {
            if now - cache.asked < FLOOR_MS {
                return Ok(last.clone());
            }
        }
    }

    let token = token(&app)?;
    /* The clock starts before the call, not after it: a request that takes ten
       seconds to time out must not then be allowed to go again immediately. */
    state.0.lock().unwrap().asked = now;

    let doc = ask(&token)?;
    let report = Report {
        windows: windows(&doc),
        overage: overage(&doc),
        at: now_ms(),
        source: token.source,
        plan: token.plan,
    };

    let mut cache = state.0.lock().unwrap();
    cache.last = Some(report.clone());
    Ok(report)
}

/// Forget the reading and the credential's whereabouts. Called when the last
/// widget stops watching, for the reason `release_azdo` and
/// `release_performance` exist: a wall with nothing asking should hold nothing.
#[tauri::command]
pub fn release_limits(state: State<'_, Limits>) {
    let mut cache = state.0.lock().unwrap();
    cache.last = None;
    cache.asked = 0;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact body the endpoint returned on 2026-08-17, trimmed to the parts
    /// this module reads — including the null codenamed windows, which are the
    /// reason `limits[]` is preferred over the named keys.
    const REAL: &str = r#"{
      "five_hour": {"utilization": 8.0, "resets_at": "2026-08-17T11:39:59.968762+00:00"},
      "seven_day": {"utilization": 8.0, "resets_at": "2026-08-23T04:59:59.968782+00:00"},
      "seven_day_opus": null, "seven_day_sonnet": null, "seven_day_cowork": null,
      "tangelo": null, "iguana_necktie": null, "cinder_cove": null,
      "nimbus_quill": {"utilization": 0.0, "resets_at": null},
      "extra_usage": {"is_enabled": false, "utilization": null},
      "limits": [
        {"kind":"session","group":"session","percent":8,"severity":"normal",
         "resets_at":"2026-08-17T11:39:59.968762+00:00","scope":null,"is_active":true},
        {"kind":"weekly_all","group":"weekly","percent":8,"severity":"normal",
         "resets_at":"2026-08-23T04:59:59.968782+00:00","scope":null,"is_active":false},
        {"kind":"weekly_scoped","group":"weekly","percent":0,"severity":"normal",
         "resets_at":null,"scope":{"model":{"id":null,"display_name":"Fable"}},
         "is_active":false}
      ]}"#;

    #[test]
    fn the_real_answer_reads_as_three_windows() {
        let doc: serde_json::Value = serde_json::from_str(REAL).unwrap();
        let w = windows(&doc);
        assert_eq!(w.len(), 3, "limits[] is read, not the named keys");

        assert_eq!(w[0].kind, "session");
        assert_eq!(w[0].used, 8.0);
        assert!(w[0].active);
        /* 2026-08-17T11:39:59.968Z, which is four days and 5h32m11.604s past the
           stamp `usage.rs` pins its own parser against. The offset is `+00:00`
           here, and the point of reading it at all is that it might not be. */
        assert_eq!(w[0].resets_at, Some(1_786_966_799_968));

        assert_eq!(w[1].kind, "weekly_all");
        assert_eq!(w[1].scope, None);

        assert_eq!(w[2].kind, "weekly_scoped");
        assert_eq!(w[2].scope.as_deref(), Some("Fable"));
        assert_eq!(w[2].resets_at, None, "a window nobody has touched names no reset");
    }

    #[test]
    fn a_codenamed_window_is_never_mistaken_for_a_real_one() {
        /* `nimbus_quill` is non-null in the body above and is not in `limits[]`.
           Reading the named keys would have to either know that name or drop it;
           reading `limits[]` means it simply is not a window yet. */
        let doc: serde_json::Value = serde_json::from_str(REAL).unwrap();
        assert!(windows(&doc).iter().all(|w| w.scope.as_deref() != Some("nimbus_quill")));
    }

    #[test]
    fn the_named_keys_carry_it_when_the_array_is_gone() {
        let doc: serde_json::Value = serde_json::from_str(
            r#"{"five_hour":{"utilization":41.5,"resets_at":"2026-08-17T11:39:59.968762+00:00"},
                "seven_day":{"utilization":12.0,"resets_at":null},
                "seven_day_opus":{"utilization":3.0,"resets_at":null},
                "limits":[]}"#,
        )
        .unwrap();
        let w = windows(&doc);
        assert_eq!(w.len(), 3, "the fallback runs when limits[] is empty");
        assert_eq!(w[0].kind, "session");
        assert_eq!(w[0].used, 41.5);
        assert!(w[0].active, "the five-hour window is the binding one by default");
        assert_eq!(w[2].scope.as_deref(), Some("Opus"));
    }

    #[test]
    fn nothing_recognisable_is_no_windows_rather_than_a_guess() {
        let doc: serde_json::Value = serde_json::from_str(r#"{"limits":[{"nope":1}]}"#).unwrap();
        assert!(windows(&doc).is_empty());
    }

    #[test]
    fn overage_is_read_when_the_account_has_it() {
        let doc: serde_json::Value =
            serde_json::from_str(r#"{"extra_usage":{"is_enabled":true,"utilization":34.0}}"#)
                .unwrap();
        let o = overage(&doc).unwrap();
        assert!(o.enabled);
        assert_eq!(o.used, Some(34.0));

        let none: serde_json::Value = serde_json::from_str(r#"{"extra_usage":null}"#).unwrap();
        assert!(overage(&none).is_none());
    }
}
