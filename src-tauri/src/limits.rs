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
//! - **The endpoint rate limits, and it counts asks rather than answers.** On
//!   2026-08-17 a wall polling this on a minute was answered `429`, which is the
//!   one refusal that asking again makes worse. So a refusal is not merely
//!   reported: it starts a *hush*, and while the hush lasts nothing here goes
//!   near the network — see `FLOOR_MS` and `HUSH_MIN_MS` below. The hush is the
//!   only piece of state that survives `release_limits`, because a hush a
//!   detach could clear is a hush a widget's knob could clear.
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

/// The most often the endpoint is asked, whoever asks. The front end polls on
/// three minutes and the control surface's `read` forces a pass, and neither of
/// those should be able to turn a widget into a hammer: a five-hour window moves
/// one percent in three minutes and the face prints whole percents, so a minute
/// is already twice as often as anything can be drawn.
const FLOOR_MS: i64 = 60_000;

/// The first hush after a refusal, doubling with each one after it.
///
/// The floor above is about there being nothing to gain; this is about the
/// server having said so. `429` is the one answer that asking again makes worse,
/// and a poll that keeps its cadence through one is a poll that turns a minute
/// of rate limiting into an afternoon of it.
const HUSH_MIN_MS: i64 = 60_000;

/// How far the doubling goes on its own. A `Retry-After` longer than this is
/// still obeyed — the cap bounds how long *this* will guess for, not how long
/// the server may ask for.
const HUSH_MAX_MS: i64 = 30 * 60_000;

/// A `Retry-After` past this is read as nonsense and clamped. A day is already
/// far past any hush that outlives the app.
const DAY_MS: i64 = 24 * 60 * 60_000;

#[derive(Default)]
pub struct Limits(Mutex<Cache>);

#[derive(Default)]
struct Cache {
    last: Option<Report>,
    /// When the endpoint was last actually asked — set whether it answered or
    /// refused, so a failing call is throttled exactly like a working one and a
    /// network that is down is not asked sixty times a minute.
    asked: i64,
    /// Nothing is asked before this instant, because the server said so.
    quiet_until: i64,
    /// How long the current hush runs, doubling per refusal and cleared by an
    /// answer — kept apart from `quiet_until` so the doubling has somewhere to
    /// stand once the waiting is over.
    hush: i64,
    /// What the server refused with, so the hush can go on saying it rather
    /// than reporting a bare wait nobody can account for.
    hush_say: String,
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

/* ── being told to wait ────────────────────────────────────────────────────*/

/// A wait, in the fewest characters that still say it. Rounded *up* throughout,
/// so a hush with a moment left on it never reads `0s` — this goes in the note
/// beside a stale reading, and a countdown that reaches zero and stays there is
/// the one thing worse than no countdown.
fn soon(ms: i64) -> String {
    let secs = (ms.max(0) + 999) / 1000;
    if secs < 60 {
        return format!("{secs}s");
    }
    let mins = (secs + 59) / 60;
    if mins < 60 {
        return format!("{mins}m");
    }
    let (h, m) = (mins / 60, mins % 60);
    if m == 0 {
        format!("{h}h")
    } else {
        format!("{h}h {m}m")
    }
}

/// What a `Retry-After` header is worth, in ms.
///
/// Seconds only, integral or not. The header may also carry an HTTP-date, and
/// this endpoint has not been seen to send one; a date is read here as the
/// server having said nothing, which costs only the difference between its
/// number and `next_hush`'s guess. A second date parser to save that is the
/// trade `usage.rs::epoch_ms` already refused once.
fn after_ms(raw: &str) -> Option<i64> {
    let secs: f64 = raw.trim().parse().ok()?;
    if !secs.is_finite() || secs < 0.0 {
        return None;
    }
    Some(((secs * 1000.0).ceil() as i64).min(DAY_MS))
}

/// How long to stay away, given how long we stayed away last time and whatever
/// the server asked for.
///
/// The doubling is what makes a refusal cost less each time it is repeated; the
/// `max` is what keeps it from ever being *shorter* than the server asked, which
/// is the only way a backoff can be politely wrong.
fn next_hush(prev: i64, after: Option<i64>) -> i64 {
    let ours = if prev <= 0 {
        HUSH_MIN_MS
    } else {
        prev.saturating_mul(2).min(HUSH_MAX_MS)
    };
    after.map_or(ours, |a| a.max(ours))
}

/* ── asking ────────────────────────────────────────────────────────────────*/

/// Why the endpoint did not answer, and whether it asked to be left alone.
struct Refusal {
    say: String,
    /// Set when asking again soon would be worse than not asking — the server
    /// rate limiting us, or telling us it is in no state to answer. A sign-in
    /// that has gone stale is not one of these: that recovers by itself and the
    /// next pass is the thing that notices.
    hush: bool,
    /// What `Retry-After` said, where it said anything.
    after: Option<i64>,
}

impl Refusal {
    fn fault(say: impl Into<String>) -> Self {
        Refusal { say: say.into(), hush: false, after: None }
    }
    fn wait(say: impl Into<String>, after: Option<i64>) -> Self {
        Refusal { say: say.into(), hush: true, after }
    }
}

fn ask(token: &Token) -> Result<serde_json::Value, Refusal> {
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
            .map_err(|e| Refusal::fault(format!("unreadable answer: {e}"))),
        /* 401 here is the sign-in having gone stale between the expiry check
           above and the call — said in the same words, since it has the same
           answer: the CLI will refresh it, and this recovers by itself. */
        Err(ureq::Error::Status(401, _)) => Err(Refusal::fault(
            "the CLI's sign-in has expired — it refreshes on its next turn",
        )),
        Err(ureq::Error::Status(403, _)) => Err(Refusal::fault(
            "this account cannot be asked about its allowance",
        )),
        /* The one refusal that is *about* how often we asked. Named in plain
           words rather than by its number, because the number is the part of it
           nobody reading a widget can act on. */
        Err(ureq::Error::Status(429, res)) => Err(Refusal::wait(
            "the allowance endpoint is rate limiting this poll",
            res.header("retry-after").and_then(after_ms),
        )),
        /* A server saying it is overloaded is saying the same thing 429 says,
           and a five-minute outage answered at the usual cadence is a hundred
           requests that could not have been answered. */
        Err(ureq::Error::Status(code, res)) if code >= 500 => Err(Refusal::wait(
            format!("the allowance endpoint answered {code}"),
            res.header("retry-after").and_then(after_ms),
        )),
        Err(ureq::Error::Status(code, _)) => Err(Refusal::fault(format!(
            "the allowance endpoint answered {code}"
        ))),
        Err(e) => Err(Refusal::fault(format!(
            "could not reach the allowance endpoint: {e}"
        ))),
    }
}

/// What is left of the allowance, and when each window rolls.
///
/// Cheap to call often — `FLOOR_MS` and the hush are what make that true. A
/// pass inside the floor hands back the reading already held rather than asking
/// again, so the front end's poll, the control surface's forced read and however
/// many widgets are on the wall all collapse into one request per minute at
/// worst; a pass inside a hush asks nothing at all.
///
/// **A refusal is reported even when a reading is held**, rather than the held
/// one being handed back as though it were current. The front end keeps what it
/// last saw and draws it beside the fault as `stale`, which is the arrangement
/// this file's half of `usage.md` describes: a percentage does not become wrong
/// because the network went away, and it does not stay right either.
///
/// Fails rather than inventing: an account with no OAuth sign-in (Bedrock,
/// Vertex, an API key) has no windows of this kind at all, and a widget drawing
/// a confident 0% for one would be worse than a widget saying it cannot see.
///
/// Off the main thread, via `crate::off_main`: this leaves the machine, against
/// a five second connect and a ten second read, and on the main thread that wait
/// was the whole wall's. `release_limits` stays where it is — it contends for the
/// same mutex, but nothing here holds that mutex across the request.
#[tauri::command]
pub async fn read_limits(app: AppHandle) -> Result<Report, String> {
    crate::off_main(move || report_with(&app, &app.state::<Limits>())).await?
}

/// The reading itself, apart from the command that carries it.
fn report_with(app: &AppHandle, state: &Limits) -> Result<Report, String> {
    let now = now_ms();
    {
        let cache = state.0.lock().unwrap();
        /* The hush is checked before anything else and holds whether or not a
           reading is in hand: the server has asked to be left alone, and every
           way of not-quite-obeying that is worse than the wait. */
        if now < cache.quiet_until {
            return Err(format!(
                "{} — asking again in {}",
                cache.hush_say,
                soon(cache.quiet_until - now)
            ));
        }
        if now - cache.asked < FLOOR_MS {
            /* Inside the floor with nothing held, the answer is still not to
               ask. `release_limits` drops the reading, so a knob turned from
               the allowance to the cost and back is two attaches with no cache
               between them — and letting that fall through is a gesture that
               costs a request every time it is made. */
            return match &cache.last {
                Some(last) => Ok(last.clone()),
                None => Err(format!(
                    "the allowance was asked for a moment ago — asking again in {}",
                    soon(FLOOR_MS - (now - cache.asked))
                )),
            };
        }
    }

    let token = token(app)?;
    /* The clock starts before the call, not after it: a request that takes ten
       seconds to time out must not then be allowed to go again immediately. */
    state.0.lock().unwrap().asked = now;

    let doc = match ask(&token) {
        Ok(doc) => doc,
        Err(refusal) if !refusal.hush => return Err(refusal.say),
        Err(refusal) => {
            let mut cache = state.0.lock().unwrap();
            cache.hush = next_hush(cache.hush, refusal.after);
            cache.quiet_until = now_ms() + cache.hush;
            cache.hush_say = refusal.say;
            return Err(format!(
                "{} — asking again in {}",
                cache.hush_say,
                soon(cache.hush)
            ));
        }
    };

    let report = Report {
        windows: windows(&doc),
        overage: overage(&doc),
        at: now_ms(),
        source: token.source,
        plan: token.plan,
    };

    let mut cache = state.0.lock().unwrap();
    cache.last = Some(report.clone());
    /* An answer ends the hush and puts the doubling back at the bottom.
       Whatever the server was protecting itself from has passed, and carrying
       the old span forward would make the next unrelated refusal a fortnight
       later start at half an hour. */
    cache.hush = 0;
    cache.quiet_until = 0;
    cache.hush_say = String::new();
    Ok(report)
}

/// Forget the reading and the credential's whereabouts. Called when the last
/// widget stops watching, for the reason `release_azdo` and
/// `release_performance` exist: a wall with nothing asking should hold nothing.
///
/// What is *kept* is everything owed to the endpoint — when it was last asked,
/// and any hush it is serving. Those are not the wall's to drop: a hush a detach
/// could clear is a hush a widget's knob could clear, and a wall being rate
/// limited would go on being rate limited by the very gesture made to stop it.
/// Three integers and the sentence the server refused with; no credential is in
/// any of them.
#[tauri::command]
pub fn release_limits(state: State<'_, Limits>) {
    state.0.lock().unwrap().last = None;
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
    fn a_refusal_costs_twice_as_much_each_time_it_is_repeated() {
        /* Nothing said by the server, so the doubling is all there is. */
        let one = next_hush(0, None);
        assert_eq!(one, HUSH_MIN_MS);
        let two = next_hush(one, None);
        assert_eq!(two, 2 * HUSH_MIN_MS);
        assert_eq!(next_hush(two, None), 4 * HUSH_MIN_MS);

        /* And it stops doubling rather than walking off into the afternoon. */
        assert_eq!(next_hush(HUSH_MAX_MS, None), HUSH_MAX_MS);
        assert_eq!(next_hush(HUSH_MAX_MS - 1, None), HUSH_MAX_MS);
    }

    #[test]
    fn the_servers_own_wait_is_obeyed_even_past_our_cap() {
        /* Shorter than the doubling: the doubling wins, since the point of it is
           that a repeated refusal costs more than the last one did. */
        assert_eq!(next_hush(4 * HUSH_MIN_MS, Some(1_000)), 8 * HUSH_MIN_MS);
        /* Longer: obeyed, and the cap does not talk it down. The cap bounds our
           guess, not the server's instruction. */
        assert_eq!(next_hush(0, Some(2 * HUSH_MAX_MS)), 2 * HUSH_MAX_MS);
    }

    #[test]
    fn retry_after_is_read_as_seconds_and_nothing_else() {
        assert_eq!(after_ms("30"), Some(30_000));
        assert_eq!(after_ms("  7 "), Some(7_000));
        /* Fractional seconds round up rather than down — a wait rounded down is
           a request sent before the server said to send one. */
        assert_eq!(after_ms("0.25"), Some(250));
        assert_eq!(after_ms("1.0005"), Some(1_001));
        /* An HTTP-date is read as the server having said nothing, which leaves
           `next_hush`'s doubling to cover it. */
        assert_eq!(after_ms("Wed, 21 Oct 2026 07:28:00 GMT"), None);
        assert_eq!(after_ms(""), None);
        assert_eq!(after_ms("-5"), None);
        assert_eq!(after_ms("inf"), None);
        /* Absurd is clamped rather than trusted into an overflow. */
        assert_eq!(after_ms("99999999999"), Some(DAY_MS));
    }

    #[test]
    fn a_wait_is_said_short_and_never_as_nothing() {
        /* Rounded up at every scale: the note beside a stale reading must not
           sit at `0s` for the last second of a hush. */
        assert_eq!(soon(1), "1s");
        assert_eq!(soon(0), "0s");
        assert_eq!(soon(29_400), "30s");
        assert_eq!(soon(60_000), "1m");
        assert_eq!(soon(61_000), "2m");
        assert_eq!(soon(HUSH_MAX_MS), "30m");
        assert_eq!(soon(2 * 60 * 60_000), "2h");
        assert_eq!(soon(90 * 60_000), "1h 30m");
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
