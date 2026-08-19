//! The billboard: what a card wants every other card to know before it starts.
//!
//! `send` is a message to somebody. This is a notice to nobody in particular —
//! "I am reworking the transcript panel this afternoon, leave `markdown.ts`
//! alone" — and the difference that matters is what each costs. Reading the
//! board is free and reaches the whole wall; a `send` costs the recipient a
//! turn and reaches one card. So an agent that wants to know who is working
//! nearby should read the board *first*, and only send once it knows who to
//! send to. Both tool descriptions say so.
//!
//! Three tools, and there are three rather than two because taking a notice
//! down has to be as obvious as putting one up. A board nobody clears is a
//! board nobody believes, and the failure mode is quiet: every notice on it
//! stays true-looking forever, so the first thing an agent learns is that the
//! board is out of date and can be skipped.
//!
//! **Clearing therefore has four mechanisms, in descending order of how much
//! they can be relied on.** Only the first works without anybody remembering:
//!
//! 1. A card that closes takes its notices with it (`store::sweep_notices`,
//!    called when a card closes and again on every read as the crash backstop).
//!    The commonest stale notice by a long way is one from a card that finished
//!    and went away.
//! 2. Clearing a card clears its notices — a reset card is not still doing what
//!    it said it was doing.
//! 3. A notice untouched for `STALE_AFTER` is *marked* stale in every reading,
//!    to the agent and on the wall. Marked, never removed: a long refactor is a
//!    real thing, and deleting a true notice is worse than showing an old one.
//! 4. Your own notices are listed first, under a line saying they are yours to
//!    take down, and the receipt for posting one says the same.
//!
//! And the notice can reach out. A notice carrying `paths` is served to any
//! card that touches a file it covers, once — see `on_touch`, which is the only
//! part of this that does not wait to be asked.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::store::{Notice, Store};

pub const BOARD_TOOL: &str = "board";
pub const POST_TOOL: &str = "post";
pub const UNPOST_TOOL: &str = "unpost";

/// How many notices one card may have up at once.
///
/// Four is more than any honest use and few enough that the board stays a page.
/// Refused rather than rotated: an agent whose oldest notice was silently
/// dropped would go on believing the wall had been told.
const MAX_PER_CARD: i64 = 4;
const MAX_SUBJECT: usize = 120;
const MAX_BODY: usize = 1_200;
const MAX_GLOBS: usize = 8;

/// When a notice starts being asked whether it is still true.
///
/// Ninety minutes. Long enough to cover the piece of work most notices are
/// about, short enough that one left up over lunch says so. The number lives
/// here and only here — the wall draws `stale` off the row rather than
/// recomputing it, so the widget and the agent cannot disagree about what is
/// current.
const STALE_AFTER_MS: i64 = 90 * 60 * 1_000;

#[derive(Clone, Serialize)]
struct BoardChanged {
    /// Which board moved, so a widget showing the other one need not re-read.
    /// `null` for the wall-wide board.
    project_id: Option<String>,
}

fn changed(app: &AppHandle, project_id: Option<String>) {
    let _ = app.emit("board:changed", BoardChanged { project_id });
}

/* ── globs ────────────────────────────────────────────────────────────────
 *
 * Small and deliberately forgiving, because the alternative is worse in one
 * direction only: a glob that matches too little is a notice that never
 * reaches the agent it was written for, and looks exactly like the feature
 * working. A glob that matches too much costs somebody one paragraph they did
 * not need.
 *
 * So `src/lib/store.rs` matches the *tail* of a path — the agent writes what it
 * would type, not the absolute path SQLite happens to be holding — and a
 * pattern with no separator in it matches the basename, since `*.rs` obviously
 * means "any Rust file" and not "a Rust file in the drive root".
 */

/// Backslashes to forward, and case folded. Windows paths arrive in both
/// spellings from the same agent within one turn, and `C:\` and `c:/` are the
/// same directory.
pub fn normalize(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

/// Does this pattern cover this path?
///
/// `*` is a run within one segment, `**` crosses separators, `?` is one
/// character that is not one.
pub fn covers(pattern: &str, path: &str) -> bool {
    let pat = normalize(pattern.trim());
    if pat.is_empty() {
        return false;
    }
    let full = normalize(path);
    if !pat.contains('/') {
        let base = full.rsplit('/').next().unwrap_or(&full);
        return glob(&pat, base);
    }
    if glob(&pat, &full) {
        return true;
    }
    /* The tail, so `src/lib/store.rs` reaches
       `c:/users/…/skein/src/lib/store.rs`. Anchored at a separator, or `re.rs`
       would match `store.rs`. */
    let mut rest = full.as_str();
    while let Some(cut) = rest.find('/') {
        rest = &rest[cut + 1..];
        if glob(&pat, rest) {
            return true;
        }
    }
    false
}

/// Wildcard match over already-normalised strings.
///
/// Iterative with a backtrack point rather than recursive: the input is a model's
/// glob against a path, and a pattern like `**a**a**a**` on a long path is
/// exponential in the naive recursion. Nothing here is adversarial today, but a
/// frame loop is one module away and this runs on every write a card makes.
fn glob(pat: &str, s: &str) -> bool {
    let p: Vec<char> = pat.chars().collect();
    let t: Vec<char> = s.chars().collect();
    let (mut pi, mut ti) = (0usize, 0usize);
    /* Where to resume from if the current `*` turns out to have eaten too
       little. `None` means there is no star behind us to give ground. */
    let mut star: Option<(usize, usize, bool)> = None;

    while ti < t.len() {
        if pi < p.len() && p[pi] == '*' {
            let deep = pi + 1 < p.len() && p[pi + 1] == '*';
            let after = pi + if deep { 2 } else { 1 };
            star = Some((after, ti, deep));
            pi = after;
            continue;
        }
        if pi < p.len() && (p[pi] == t[ti] || (p[pi] == '?' && t[ti] != '/')) {
            pi += 1;
            ti += 1;
            continue;
        }
        match star {
            /* A single star may not swallow a separator; a double one may. */
            Some((after, at, deep)) if deep || t[at] != '/' => {
                pi = after;
                ti = at + 1;
                star = Some((after, at + 1, deep));
            }
            _ => return false,
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn globs_of(notice: &Notice) -> Vec<&str> {
    notice
        .paths
        .lines()
        .map(str::trim)
        .filter(|g| !g.is_empty())
        .collect()
}

pub fn stale(notice: &Notice, now: i64) -> bool {
    now - notice.touched_at > STALE_AFTER_MS
}

/* ── the tools ────────────────────────────────────────────────────────────── */

pub fn board_schema() -> Value {
    json!({
        "name": BOARD_TOOL,
        "description":
            "Read the billboard: standing notices other conversations on this Skein \
             wall have put up about work in progress — what they are reworking, what \
             to leave alone, what to wait for. **Read it before starting anything \
             substantial in a shared repository**, and read it again before messaging \
             another card to ask what they are doing, because the answer is usually \
             already here and reading costs nothing where a `send` costs that agent a \
             turn.\n\n\
             Your own notices are listed first. Anything marked stale has been up a \
             long time without being touched — if it is one of yours, either re-`post` \
             it to say it is still true or `unpost` it.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "scope": {
                    "type": "string",
                    "enum": ["project", "skein"],
                    "description":
                        "`project` (the default) is your own project's board plus any \
                         wall-wide notices — nearly always what you want. `skein` is \
                         every board in the studio."
                }
            }
        }
    })
}

pub fn post_schema() -> Value {
    json!({
        "name": POST_TOOL,
        "description":
            "Put a notice on the billboard, so every other conversation on this wall \
             knows what you are doing without anyone having to ask. Use it when you are \
             about to work across a module, take over a feature, or change something \
             others build on — 'reworking the transcript panel, leave markdown.ts \
             alone until I say'.\n\n\
             **Take it down with `unpost` the moment it stops being true.** A notice \
             you leave up after you have finished is worse than no notice: it stops \
             somebody else from working, and it teaches everyone here that the board \
             cannot be trusted. If a piece of work runs long, `post` the same subject \
             again to say it is still current.\n\n\
             Posting the same `subject` twice replaces your earlier notice rather than \
             adding a second.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "subject": {
                    "type": "string",
                    "description":
                        "What this is about, in a few words — 'reworking the store \
                         schema'. This is what identifies the notice, so use the same \
                         one to update it and a different one for a different piece of \
                         work."
                },
                "body": {
                    "type": "string",
                    "description":
                        "What you want the others to actually do: what you are \
                         changing, what they should hold off on, and what would tell \
                         them you are finished. Write it for another agent with its own \
                         context — name files by path."
                },
                "paths": {
                    "description":
                        "Optional. File globs this notice is about — 'src/lib/*.ts', \
                         'store.rs', 'src/lib/transcript.ts'. Any card that edits a \
                         file one of these covers is shown this notice once, \
                         automatically, so a notice with paths on it reaches the agent \
                         who needed it even if they never read the board. Give them \
                         whenever the work is about particular files; it is the single \
                         most useful thing on a notice.",
                    "anyOf": [
                        { "type": "string" },
                        { "type": "array", "items": { "type": "string" } }
                    ]
                },
                "scope": {
                    "type": "string",
                    "enum": ["project", "skein"],
                    "description":
                        "`project` (the default) posts to your own project's board. \
                         `skein` posts to the whole studio and is seen by every card in \
                         every project — for something that genuinely crosses them."
                }
            },
            "required": ["subject", "body"]
        }
    })
}

pub fn unpost_schema() -> Value {
    json!({
        "name": UNPOST_TOOL,
        "description":
            "Take one of your own notices off the billboard, because it is no longer \
             true. Do this as soon as the work it describes is done — it is the half \
             of the billboard that makes the other half worth reading, and nobody else \
             can do it for you.\n\n\
             Name it by its `subject` or by the id `board` reports, or pass \
             `all: true` to clear everything you have up, which is what to do when you \
             finish a piece of work.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "subject": { "type": "string", "description": "The notice's subject, or its id." },
                "all": {
                    "type": "boolean",
                    "description": "Take down every notice you have up."
                }
            }
        }
    })
}

/// Who is reading, and which board they get.
struct Reader {
    project_id: Option<String>,
    chat: bool,
}

fn reader(app: &AppHandle, id: &str) -> Reader {
    let store = app.state::<Store>();
    let row = store
        .0
        .lock()
        .ok()
        .and_then(|conn| crate::store::roster_one(&conn, id));
    match row {
        Some(r) => Reader {
            project_id: Some(r.project_id),
            chat: r.kind == "chat",
        },
        /* A card with no row is not a chat card — the unknown case falls to
           "an ordinary card" for the reason `store::kind_row` does. What it has
           no answer for is which project board is its own, so it reads the
           whole wall rather than nothing. */
        None => Reader { project_id: None, chat: false },
    }
}

/// A chat card stands outside the wall's projects and cannot reach this
/// machine; the board is a list of this machine's work. Same gate as `relay.rs`,
/// decided the same way — by asking the store, never the caller.
const NOT_FOR_CHAT: &str =
    "this is a chat card: it stands outside the wall's projects and has no billboard.";

fn do_board(app: &AppHandle, caller: &str, args: &Value) -> String {
    let me = reader(app, caller);
    if me.chat {
        return NOT_FOR_CHAT.into();
    }
    let all = args.get("scope").and_then(Value::as_str) == Some("skein");
    let store = app.state::<Store>();
    let Ok(conn) = store.0.lock() else {
        return "the store is unavailable".into();
    };
    crate::store::sweep_notices(&conn);
    let scope = if all { None } else { me.project_id.as_deref() };
    let notices = match crate::store::notices(&conn, scope) {
        Ok(n) => n,
        Err(e) => return format!("could not read the board: {e}"),
    };
    drop(conn);

    if notices.is_empty() {
        return "the billboard is empty — nobody has anything up.".into();
    }

    let now = crate::store::now();
    /* Yours first, and said out loud. The whole of nudge (4): an agent that
       sees its own notice at the top of every read it makes is an agent that
       remembers it is still up. */
    let (mine, theirs): (Vec<&Notice>, Vec<&Notice>) =
        notices.iter().partition(|n| n.from_id.as_deref() == Some(caller));

    let mut out = String::new();
    if !mine.is_empty() {
        out.push_str(
            "Yours, still up — take any of these down with `unpost` once they are no \
             longer true:\n\n",
        );
        for n in &mine {
            out.push_str(&render(n, now));
        }
        out.push('\n');
    }
    if theirs.is_empty() {
        out.push_str("Nobody else has anything up.");
    } else {
        out.push_str("From the other conversations on this wall:\n\n");
        for n in &theirs {
            out.push_str(&render(n, now));
        }
    }
    out
}

fn render(n: &Notice, now: i64) -> String {
    let who = match &n.from_id {
        Some(id) => crate::relay::handle_of(id),
        None => "the user".into(),
    };
    let age = ago(now - n.posted_at);
    let mark = if stale(n, now) {
        " — STALE, may no longer be true"
    } else {
        ""
    };
    let globs = globs_of(n);
    let files = if globs.is_empty() {
        String::new()
    } else {
        format!("\n  files: {}", globs.join(", "))
    };
    format!(
        "- [{}] {} (from {who}, {age}{mark})\n  {}{files}\n",
        n.id.chars().take(8).collect::<String>(),
        n.subject,
        n.body.replace('\n', "\n  "),
    )
}

fn ago(ms: i64) -> String {
    let mins = ms / 60_000;
    if mins < 1 {
        return "just now".into();
    }
    if mins < 60 {
        return format!("{mins}m ago");
    }
    let hours = mins / 60;
    if hours < 24 {
        return format!("{hours}h ago");
    }
    format!("{}d ago", hours / 24)
}

fn do_post(app: &AppHandle, caller: &str, args: &Value) -> String {
    let me = reader(app, caller);
    if me.chat {
        return NOT_FOR_CHAT.into();
    }
    let Some(subject) = args.get("subject").and_then(Value::as_str) else {
        return "no `subject` was given, so nothing was posted".into();
    };
    let subject = clip(subject.trim(), MAX_SUBJECT);
    if subject.is_empty() {
        return "the subject was empty, so nothing was posted".into();
    }
    let body = clip(
        args.get("body").and_then(Value::as_str).unwrap_or("").trim(),
        MAX_BODY,
    );
    if body.is_empty() {
        return "no `body` was given — a notice with no instruction in it tells nobody \
                anything, so nothing was posted"
            .into();
    }
    let paths = globs_from(args.get("paths"));
    let skein = args.get("scope").and_then(Value::as_str) == Some("skein");
    let project_id = if skein { None } else { me.project_id.clone() };
    if !skein && project_id.is_none() {
        return "this card is not on the wall, so it has no project board to post to".into();
    }

    let store = app.state::<Store>();
    let Ok(conn) = store.0.lock() else {
        return "the store is unavailable".into();
    };
    /* Counted after the sweep, or a card whose old notices died with a closed
       colleague would be refused against a board that no longer exists. */
    crate::store::sweep_notices(&conn);
    let held = crate::store::notice_count_of(&conn, caller);
    let replacing = crate::store::notices(&conn, None)
        .unwrap_or_default()
        .into_iter()
        .any(|n| n.from_id.as_deref() == Some(caller) && n.subject == subject);
    if !replacing && held >= MAX_PER_CARD {
        return format!(
            "this card already has {held} notices up, which is the limit. Take one \
             down with `unpost` first — or post under a subject you are already using, \
             which replaces it."
        );
    }

    let id = crate::store::uuid_v4();
    let put = crate::store::put_notice(
        &conn,
        &id,
        if skein { "skein" } else { "project" },
        project_id.as_deref(),
        Some(caller),
        &subject,
        &body,
        &paths,
    );
    drop(conn);

    match put {
        Err(e) => format!("could not post: {e}"),
        Ok(_) => {
            changed(app, project_id);
            let watching = if paths.is_empty() {
                String::new()
            } else {
                format!(
                    " Any card that edits {} will be shown it once, without having to \
                     look.",
                    paths.lines().collect::<Vec<_>>().join(" or ")
                )
            };
            format!(
                "posted to the {} board: {subject:?}.{watching} Take it down with \
                 `unpost` as soon as it is no longer true — a notice left up after the \
                 work is done stops somebody else for no reason.",
                if skein { "wall-wide" } else { "project" }
            )
        }
    }
}

fn do_unpost(app: &AppHandle, caller: &str, args: &Value) -> String {
    let store = app.state::<Store>();
    let me = reader(app, caller);
    let Ok(conn) = store.0.lock() else {
        return "the store is unavailable".into();
    };

    if args.get("all").and_then(Value::as_bool) == Some(true) {
        let n = crate::store::drop_notices_of(&conn, caller);
        drop(conn);
        changed(app, me.project_id);
        return match n {
            0 => "you had nothing up.".into(),
            1 => "took your notice down.".into(),
            n => format!("took all {n} of your notices down."),
        };
    }

    let Some(want) = args.get("subject").and_then(Value::as_str).map(str::trim) else {
        return "name the notice by its subject or its id, or pass `all: true`".into();
    };
    let mine: Vec<Notice> = crate::store::notices(&conn, None)
        .unwrap_or_default()
        .into_iter()
        .filter(|n| n.from_id.as_deref() == Some(caller))
        .collect();
    /* Id first, then the exact subject, then the id's short head — the same
       ladder `relay::resolve` walks, and for the same reason: the agent was
       given both spellings and either is a fair thing to type back. */
    let found = mine
        .iter()
        .find(|n| n.id == want)
        .or_else(|| mine.iter().find(|n| n.subject.eq_ignore_ascii_case(want)))
        .or_else(|| mine.iter().find(|n| n.id.starts_with(want) && want.len() >= 4));

    let Some(n) = found else {
        drop(conn);
        return if mine.is_empty() {
            "you have no notices up.".into()
        } else {
            format!(
                "no notice of yours called {want:?}. Yours are: {}",
                mine.iter()
                    .map(|n| format!("{:?}", n.subject))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
    };
    let subject = n.subject.clone();
    let gone = crate::store::drop_notice(&conn, &n.id, Some(caller));
    drop(conn);
    if gone {
        changed(app, me.project_id);
        format!("took {subject:?} down.")
    } else {
        format!("{subject:?} was already gone.")
    }
}

/// Turn whatever the model wrote into newline-separated globs.
fn globs_from(v: Option<&Value>) -> String {
    let list: Vec<String> = match v {
        Some(Value::String(s)) => s
            .split(['\n', ','])
            .map(|g| g.trim().to_string())
            .filter(|g| !g.is_empty())
            .collect(),
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|x| x.as_str())
            .map(|g| g.trim().to_string())
            .filter(|g| !g.is_empty())
            .collect(),
        _ => Vec::new(),
    };
    list.into_iter().take(MAX_GLOBS).collect::<Vec<_>>().join("\n")
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

/* ── the notice that comes to you ─────────────────────────────────────────── */

/// A card just wrote to a file. Serve it any notice that covers it, once.
///
/// This is the only part of the billboard that does not wait to be asked, and
/// the honest framing is that it is a **notice served, not a lock**. Skein sees
/// the `tool_use` on the wire, which is the earliest moment it can know — but
/// the CLI queues a prompt written mid-turn behind the running turn, so what the
/// agent actually gets is "before you go further" rather than "before you
/// touch". There is no gate to hold: a project card runs with
/// `--dangerously-skip-permissions` and the edit is already being made when the
/// event arrives. Reading the board first is still the cheap way to find this
/// out; this is the backstop for when it did not.
///
/// Once per (notice, card) pair — `store::serve_notice` decides, atomically, so
/// a card making three edits in one turn is told once. Editing the notice clears
/// those marks, since new words are news again.
pub fn on_touch(app: &AppHandle, conversation_id: &str, path: &str) {
    let me = reader(app, conversation_id);
    if me.chat {
        return;
    }
    let Some(store) = app.try_state::<Store>() else { return };

    let candidates: Vec<Notice> = {
        let Ok(conn) = store.0.lock() else { return };
        crate::store::notices(&conn, me.project_id.as_deref())
            .unwrap_or_default()
            .into_iter()
            /* Never your own: a card being told about its own notice is a card
               being told what it already said. */
            .filter(|n| n.from_id.as_deref() != Some(conversation_id))
            .filter(|n| globs_of(n).iter().any(|g| covers(g, path)))
            .collect()
    };
    if candidates.is_empty() {
        return;
    }

    for n in candidates {
        let fresh = {
            let Ok(conn) = store.0.lock() else { return };
            crate::store::serve_notice(&conn, &n.id, conversation_id)
        };
        if !fresh {
            continue;
        }
        let from = n.from_id.as_ref().and_then(|id| {
            store
                .0
                .lock()
                .ok()
                .and_then(|conn| crate::store::roster_one(&conn, id))
        });
        let text = crate::relay::board_envelope(from.as_ref(), &n, path);
        /* Delivery is best effort and a failure is left *unserved* — no. It is
           left served, deliberately: the card is dormant, and a notice replayed
           at every wake for the rest of the day is a worse outcome than one
           missed. The board is still there to be read. */
        let ok = crate::supervisor::deliver(app, conversation_id, &text).is_ok();
        if ok {
            crate::relay::announce_board(app, &n, conversation_id);
        }
    }
}

/* ── the wall's way in ────────────────────────────────────────────────────
 *
 * The widget reads through these, and so does the control surface. Off the main
 * thread for `relay_send`'s reason where a write to a pipe is involved, and on
 * it where the work is a query — see the note there.
 */

fn as_json(n: &Notice, now: i64) -> Value {
    json!({
        "id": n.id,
        "scope": n.scope,
        "projectId": n.project_id,
        "from": n.from_id,
        "subject": n.subject,
        "body": n.body,
        "paths": globs_of(n),
        "postedAt": n.posted_at,
        "touchedAt": n.touched_at,
        /* Computed here rather than in the webview, so the reading an agent
           gets and the reading you get cannot disagree about what is current —
           see `STALE_AFTER_MS`. */
        "stale": stale(n, now),
    })
}

#[tauri::command]
pub fn read_board(app: AppHandle, project_id: Option<String>) -> Result<Value, String> {
    let store = app.state::<Store>();
    let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
    crate::store::sweep_notices(&conn);
    let notices = crate::store::notices(&conn, project_id.as_deref())?;
    let now = crate::store::now();
    Ok(json!(notices.iter().map(|n| as_json(n, now)).collect::<Vec<_>>()))
}

/// Post as *yourself*. A notice with no card behind it, which is the one
/// instruction on this wall that reaches every agent without costing a turn.
#[tauri::command]
pub fn post_notice(
    app: AppHandle,
    subject: String,
    body: String,
    paths: Option<Vec<String>>,
    project_id: Option<String>,
) -> Result<String, String> {
    let subject = clip(subject.trim(), MAX_SUBJECT);
    if subject.is_empty() {
        return Err("a notice needs a subject".into());
    }
    let id = crate::store::uuid_v4();
    let globs = globs_from(paths.map(|p| json!(p)).as_ref());
    {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
        crate::store::put_notice(
            &conn,
            &id,
            if project_id.is_some() { "project" } else { "skein" },
            project_id.as_deref(),
            None,
            &subject,
            &clip(body.trim(), MAX_BODY),
            &globs,
        )?;
    }
    changed(&app, project_id);
    Ok(id)
}

/// Take any notice down, including a card's — it is your wall.
#[tauri::command]
pub fn unpost_notice(app: AppHandle, id: String) -> Result<bool, String> {
    let gone = {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
        crate::store::drop_notice(&conn, &id, None)
    };
    changed(&app, None);
    Ok(gone)
}

/* Driving the three tools by hand, as a named card, so `wall.test.ts` can
 * exercise them without an agent taking a turn to make the call — the same seam
 * `relay_send` gives the roster. They return the tool's own words rather than a
 * structured result, deliberately: a refusal is a normal answer here, and a test
 * that asserted on a status code would be checking something no model ever
 * reads. Off the main thread for `relay_send`'s reason, since `do_post` can end
 * in an emit and `do_board` holds the store's lock across a sweep. */

#[tauri::command]
pub async fn relay_board(app: AppHandle, id: String, scope: Option<String>) -> Result<String, String> {
    crate::off_main(move || {
        do_board(&app, &id, &json!({ "scope": scope.unwrap_or_else(|| "project".into()) }))
    })
    .await
}

#[tauri::command]
pub async fn relay_post(
    app: AppHandle,
    id: String,
    subject: String,
    body: String,
    paths: Option<Vec<String>>,
    scope: Option<String>,
) -> Result<String, String> {
    crate::off_main(move || {
        let mut args = json!({ "subject": subject, "body": body });
        if let Some(p) = paths {
            args["paths"] = json!(p);
        }
        if let Some(s) = scope {
            args["scope"] = json!(s);
        }
        do_post(&app, &id, &args)
    })
    .await
}

#[tauri::command]
pub async fn relay_unpost(
    app: AppHandle,
    id: String,
    subject: Option<String>,
    all: Option<bool>,
) -> Result<String, String> {
    crate::off_main(move || {
        let mut args = json!({ "all": all.unwrap_or(false) });
        if let Some(s) = subject {
            args["subject"] = json!(s);
        }
        do_unpost(&app, &id, &args)
    })
    .await
}

/// A card wrote to a file. Called beside `record_file_touch`, from the one
/// place in the front end that folds a write out of the stream.
///
/// Async through `off_main` for `relay_send`'s reason: `on_touch` can end in a
/// write to another child's stdin, and that is the one thing here that can park
/// — see the note over the relay commands. Fire-and-forget from the webview, so
/// nothing waits on it either way.
#[tauri::command]
pub async fn board_touch(app: AppHandle, conversation_id: String, path: String) {
    let _ = crate::off_main(move || on_touch(&app, &conversation_id, &path)).await;
}

/// A card is going. Everything it had up goes with it — mechanism (1), and the
/// only one that needs nobody to remember anything.
pub fn clear_for(app: &AppHandle, conversation_id: &str) {
    let Some(store) = app.try_state::<Store>() else { return };
    let n = {
        let Ok(conn) = store.0.lock() else { return };
        crate::store::drop_notices_of(&conn, conversation_id)
    };
    if n > 0 {
        changed(app, None);
    }
}

/// Route a `tools/call` that belongs to the board. `None` for a name this file
/// does not claim, so `ask.rs` can go on asking.
pub fn handle(app: &AppHandle, conversation_id: &str, tool: &str, args: &Value) -> Option<String> {
    match tool {
        BOARD_TOOL => Some(do_board(app, conversation_id, args)),
        POST_TOOL => Some(do_post(app, conversation_id, args)),
        UNPOST_TOOL => Some(do_unpost(app, conversation_id, args)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notice(paths: &str, touched: i64) -> Notice {
        Notice {
            id: "n1".into(),
            scope: "project".into(),
            project_id: Some("skein".into()),
            from_id: Some("aaaaaaaa-1111-4111-8111-111111111111".into()),
            subject: "reworking the store".into(),
            body: "leave store.rs alone".into(),
            paths: paths.into(),
            posted_at: 0,
            touched_at: touched,
        }
    }

    #[test]
    fn a_bare_name_matches_the_file_wherever_it_is() {
        /* `*.rs` obviously means "any Rust file" rather than "one in the drive
           root", so a pattern with no separator is matched against the base. */
        assert!(covers("store.rs", "C:/repo/src-tauri/src/store.rs"));
        assert!(covers("*.rs", "C:/repo/src/store.rs"));
        assert!(!covers("store.rs", "C:/repo/src/relay.rs"));
    }

    #[test]
    fn a_path_matches_the_tail_so_the_agent_can_write_what_it_would_type() {
        assert!(covers("src/lib/store.rs", "C:/repo/src/lib/store.rs"));
        assert!(covers("src-tauri/src/*.rs", "C:/repo/src-tauri/src/board.rs"));
        assert!(!covers("src/lib/store.rs", "C:/repo/other/lib/store.rs"));
    }

    /// Anchored at a separator, or a suffix would match half a filename.
    #[test]
    fn a_tail_match_starts_at_a_directory_boundary() {
        assert!(!covers("re/store.rs", "C:/repo/src/store.rs"));
        assert!(!covers("ib/store.rs", "C:/repo/lib/store.rs"));
    }

    #[test]
    fn one_star_stays_inside_a_segment_and_two_do_not() {
        assert!(!covers("src/*.ts", "C:/repo/src/lib/deep.ts"));
        assert!(covers("src/**/*.ts", "C:/repo/src/lib/deep.ts"));
        assert!(covers("src/**", "C:/repo/src/lib/deep.ts"));
    }

    #[test]
    fn windows_spells_a_path_two_ways_and_both_are_the_same_file() {
        assert!(covers("src/lib/Store.rs", "C:\\repo\\src\\lib\\store.rs"));
        assert!(covers("src\\lib\\store.rs", "C:/repo/src/lib/store.rs"));
    }

    /// The naive recursion is exponential on a pattern like this, and it runs on
    /// every write every card makes.
    #[test]
    fn a_pathological_pattern_still_answers_at_once() {
        let pat = "**a**a**a**a**a**a**b";
        let path = "/".to_string() + &"a".repeat(200);
        assert!(!covers(pat, &path));
    }

    #[test]
    fn an_empty_pattern_covers_nothing_rather_than_everything() {
        assert!(!covers("", "C:/repo/src/store.rs"));
        assert!(!covers("   ", "C:/repo/src/store.rs"));
        assert!(globs_of(&notice("", 0)).is_empty());
        assert!(globs_of(&notice("\n  \n", 0)).is_empty());
    }

    #[test]
    fn globs_arrive_as_a_string_or_a_list_and_are_capped() {
        assert_eq!(globs_from(Some(&json!("a.rs, b.rs"))), "a.rs\nb.rs");
        assert_eq!(globs_from(Some(&json!(["a.rs", " b.rs "]))), "a.rs\nb.rs");
        assert_eq!(globs_from(None), "");
        let many: Vec<String> = (0..30).map(|i| format!("f{i}.rs")).collect();
        assert_eq!(globs_from(Some(&json!(many))).lines().count(), MAX_GLOBS);
    }

    /// Marked, never removed. A long refactor is a real thing, and deleting a
    /// true notice is worse than showing an old one.
    #[test]
    fn a_notice_goes_stale_by_being_left_alone_and_re_posting_revives_it() {
        let now = STALE_AFTER_MS * 2;
        assert!(stale(&notice("", 0), now));
        assert!(!stale(&notice("", now - 60_000), now));
    }

    #[test]
    fn the_reading_names_the_notice_its_author_and_its_files() {
        let out = render(&notice("src/lib/*.ts\nstore.rs", 0), 0);
        assert!(out.contains("reworking the store"));
        assert!(out.contains("aaaaaaaa"));
        assert!(out.contains("src/lib/*.ts, store.rs"));
        assert!(!out.contains("STALE"));
        assert!(render(&notice("", 0), STALE_AFTER_MS * 2).contains("STALE"));
    }

    #[test]
    fn a_notice_you_posted_says_so_rather_than_naming_a_card() {
        let mut n = notice("", 0);
        n.from_id = None;
        assert!(render(&n, 0).contains("the user"));
    }

    #[test]
    fn ages_read_as_prose() {
        assert_eq!(ago(0), "just now");
        assert_eq!(ago(5 * 60_000), "5m ago");
        assert_eq!(ago(3 * 3_600_000), "3h ago");
        assert_eq!(ago(50 * 3_600_000), "2d ago");
    }

    #[test]
    fn all_three_tools_say_what_they_take() {
        let b = board_schema();
        assert_eq!(b["name"], BOARD_TOOL);
        assert!(b["inputSchema"]["required"].is_null());

        let p = post_schema();
        assert_eq!(p["inputSchema"]["required"], json!(["subject", "body"]));
        /* Globs as a string or a list, since a model asked for "paths" writes
           either and a refused call is a notice that never went up. */
        assert!(p["inputSchema"]["properties"]["paths"]["anyOf"][1]["items"].is_object());

        let u = unpost_schema();
        assert_eq!(u["name"], UNPOST_TOOL);
        assert!(u["inputSchema"]["properties"]["all"].is_object());
        /* Nothing required: `all: true` is a whole call, and demanding a
           subject would refuse the one an agent makes when it finishes. */
        assert!(u["inputSchema"]["required"].is_null());
    }

    /// Taking one down has to be as loud as putting one up, or the board fills
    /// with notices that were true this morning.
    #[test]
    fn every_description_says_to_clear_it_up() {
        assert!(post_schema()["description"].as_str().unwrap().contains("unpost"));
        assert!(board_schema()["description"].as_str().unwrap().contains("unpost"));
        assert!(unpost_schema()["description"].as_str().unwrap().contains("as soon as"));
    }
}
