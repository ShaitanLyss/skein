//! The sink: what an agent noticed and could not act on there and then.
//!
//! The billboard is about *now* — "I am reworking the transcript panel, leave
//! `markdown.ts` alone" — and a notice is worthless the moment that stops being
//! true, which is why every mechanism in `board.rs` is about taking one down.
//! This is the other half of that, and it is the opposite in every respect that
//! matters. An item here is a **finding**: a bug seen in passing while doing
//! something else, a tool that should exist, a rough edge worth someone's
//! afternoon, a thing to take care of later. Its whole value is that it survives
//! the turn that found it, the card that found it, and the session both were in.
//!
//! Without somewhere to put those, an agent has exactly two options for a thing
//! it notices but must not stop for, and both lose it: say it in a transcript
//! nobody will scroll back through, or act on it now and blow the scope of the
//! job it was asked to do. The commonest outcome is the third one — say nothing.
//!
//! Four tools, and the fourth is the one that makes the other three worth
//! having:
//!
//! - `sink` reads it. Free, like the board, and for the same reason.
//! - `drop` puts something in. One title, one paragraph, optionally the files.
//! - `take` claims one, so two cards do not both do it. **Nothing here is
//!   assigned**: an agent reads the sink because it was asked to, or because it
//!   is about to do something the sink has an opinion about. A box that handed
//!   out work would be a scheduler, and the wall already has one of those — you.
//! - `done` takes it down, with a line saying what was actually done about it.
//!
//! ### Why a hold expires and a notice does not
//!
//! Both go stale; only one of them gives way. `board::STALE_AFTER_MS` *marks* a
//! notice and never removes it, because a long refactor is a real thing and
//! deleting a true notice is worse than showing an old one. A hold has to
//! actually expire, because while it stands the item is blocked — so the cost of
//! keeping a dead hold is not a stale paragraph, it is work nobody can pick up,
//! forever, on the word of a card that wandered off two days ago.
//!
//! So `HOLD_STALE_MS` is load-bearing and, for the same reason, generous:
//! expiring a hold somebody is still honouring costs two agents doing one job
//! and finding out in the diff. Two hours, against the board's ninety minutes,
//! and the asymmetry is deliberate rather than a rounding of the same number.
//! The reliable clearing is still the one that needs nobody to remember —
//! `release_for`, where a card closes or is cleared — and `sweep` on every read
//! is the crash backstop.
//!
//! ### What the sink is not
//!
//! It does not come and find you. `board::on_touch` serves a notice to a card
//! that writes to a file it covers, because a notice is about work *in flight*
//! and arriving late makes it useless. An item here has no deadline and no
//! claim on anybody's attention; interrupting a card mid-task with "by the way,
//! somebody once thought this file was untidy" would teach the wall's agents
//! that Skein's own messages can be skimmed. It is read when it is asked for.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::store::{SinkItem, Store};

pub const SINK_TOOL: &str = "sink";
pub const DROP_TOOL: &str = "drop";
pub const TAKE_TOOL: &str = "take";
pub const DONE_TOOL: &str = "done";

/// How many still-open items one card may have dropped.
///
/// Twelve. Higher than the board's four, because these accumulate honestly over
/// a long session where notices do not, and low enough that a card which has
/// started narrating every thought into the sink is stopped while the box is
/// still readable. Refused rather than rotated, for `board::MAX_PER_CARD`'s
/// reason: an agent whose oldest item was silently dropped would go on
/// believing it had been written down.
const MAX_OPEN_PER_CARD: i64 = 12;

/// How many items one card may hold at once.
///
/// Three. A hold is a claim to be doing the thing now, and an agent doing three
/// things at once is an agent doing none of them — while every item it holds is
/// one no other card will touch.
const MAX_HELD: i64 = 3;

/// When a hold stops being believed. See the module note: deliberately longer
/// than the billboard's staleness, because this one gives way.
const HOLD_STALE_MS: i64 = 120 * 60 * 1_000;

const MAX_TITLE: usize = 120;
const MAX_BODY: usize = 1_200;
const MAX_NOTE: usize = 400;
const MAX_GLOBS: usize = 8;

/// The four an agent may set. `note` is the default and the least committal —
/// nothing in Skein reads these except the widget's grouping and your own eye,
/// so the vocabulary is small on purpose: a taxonomy an agent has to think about
/// is one it will get wrong in a way that hides the item.
const KINDS: [&str; 4] = ["note", "idea", "bug", "chore"];

#[derive(Clone, Serialize)]
struct SinkChanged {
    project_id: Option<String>,
}

fn changed(app: &AppHandle, project_id: Option<String>) {
    let _ = app.emit("sink:changed", SinkChanged { project_id });
}

pub fn hold_stale(item: &SinkItem, now: i64) -> bool {
    match item.held_at {
        Some(at) => now - at > HOLD_STALE_MS,
        None => false,
    }
}

/// Is this item free to be taken? A hold nobody has honoured for two hours is
/// not a hold — see the module note.
fn free(item: &SinkItem, now: i64) -> bool {
    item.held_by.is_none() || hold_stale(item, now)
}

/* ── the tools ────────────────────────────────────────────────────────────── */

pub fn sink_schema() -> Value {
    json!({
        "name": SINK_TOOL,
        "description":
            "Read the sink: the wall's standing pile of things somebody noticed and did \
             not stop for — bugs seen in passing, tools that should exist, rough edges, \
             things to take care of later. Unlike the billboard, nothing here is about \
             work in flight and nothing here expires; an item sits until it is settled.\n\n\
             Read it when you are asked what is pending, when you are about to work \
             somewhere and want to know what is already known about it, or when you have \
             finished what you were asked and are looking for the next useful thing. \
             Reading costs nobody a turn.\n\n\
             **Nothing here is assigned to you.** An item marked as held is one another \
             conversation has said it is doing — leave it alone. Anything else is fair to \
             `take`, but take it because the user asked or because you are already there, \
             not merely because it is unheld.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "scope": {
                    "type": "string",
                    "enum": ["project", "skein"],
                    "description":
                        "`project` (the default) is this project's items plus the \
                         wall-wide ones. `skein` is everything in the studio."
                },
                "settled": {
                    "type": "boolean",
                    "description":
                        "Show what has already been addressed instead of what is \
                         pending. For answering 'has anyone dealt with this' before \
                         raising it again."
                },
                "kind": {
                    "type": "string",
                    "enum": ["note", "idea", "bug", "chore"],
                    "description": "Only items of this kind."
                }
            }
        }
    })
}

pub fn drop_schema() -> Value {
    json!({
        "name": DROP_TOOL,
        "description":
            "Put something in the sink, so it outlives this conversation. For the thing \
             you noticed and must not stop for: a bug you walked past while doing \
             something else, a Skein tool that should exist or misbehaved on you, a file \
             that needs an afternoon, a decision somebody should make. It persists across \
             sessions and survives this card being closed.\n\n\
             **This is not a to-do list for the turn you are in.** Do not drop what you \
             are about to do anyway, and do not drop what the repository already records \
             — a bug with a failing test, something already in the git log, anything a \
             comment in the code says. Write the thing that would otherwise be lost.\n\n\
             Dropping under a title that is already in the sink adds your voice to that \
             item rather than making a second one, and the receipt says so.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description":
                        "The thing itself, in one line, specific enough to act on \
                         months later — 'ask_user times out in a non-interactive \
                         session', not 'asking is broken'. This is what a repeat of the \
                         same finding is matched on."
                },
                "body": {
                    "type": "string",
                    "description":
                        "What somebody picking this up needs: what you saw, where, what \
                         you think is behind it, and how you would know it was fixed. \
                         Write it for another agent with its own context — name files by \
                         path. If you were mid-task when you found it, say what you were \
                         doing, because that is usually the reproduction."
                },
                "kind": {
                    "type": "string",
                    "enum": ["note", "idea", "bug", "chore"],
                    "description":
                        "`bug` for something wrong, `idea` for something that should \
                         exist, `chore` for work that is nobody's idea of interesting \
                         but wants doing, `note` (the default) for anything else worth \
                         keeping."
                },
                "paths": {
                    "description":
                        "Optional. Files this is about — 'src/lib/markdown.ts', \
                         'store.rs'. Give them whenever you know them: it is what lets \
                         somebody working in that file find this without reading the \
                         whole sink.",
                    "anyOf": [
                        { "type": "string" },
                        { "type": "array", "items": { "type": "string" } }
                    ]
                },
                "scope": {
                    "type": "string",
                    "enum": ["project", "skein"],
                    "description":
                        "`project` (the default) files it under this project. `skein` is \
                         for something about the studio itself rather than any one \
                         repository."
                }
            },
            "required": ["title", "body"]
        }
    })
}

pub fn take_schema() -> Value {
    json!({
        "name": TAKE_TOOL,
        "description":
            "Say you are dealing with an item in the sink, so no other conversation on \
             this wall starts the same work. Do this **before** you begin, not after — a \
             claim made at the end is a claim that prevented nothing.\n\n\
             One card holds an item at a time, so this can be refused; if it is, you are \
             told who holds it and you should leave it to them and say so. Calling it \
             again on something you already hold keeps the hold fresh, which is worth \
             doing on a long piece of work.\n\n\
             **Put it back with `release` if you stop without finishing**, including when \
             the user redirects you onto something else. A held item nobody is working on \
             is worse than an unheld one: it is invisible to everybody and blocked for \
             everybody.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "item": {
                    "type": "string",
                    "description": "The item's id as `sink` reported it, or its exact title."
                },
                "release": {
                    "type": "boolean",
                    "description":
                        "Put it back instead of taking it — you have stopped, and it is \
                         not done."
                }
            },
            "required": ["item"]
        }
    })
}

pub fn done_schema() -> Value {
    json!({
        "name": DONE_TOOL,
        "description":
            "Take an item out of the sink because it has actually been dealt with. This \
             is the half that makes the rest of it worth reading: a sink of things that \
             were quietly fixed months ago is one nobody trusts, and then nobody looks, \
             and then nothing in it gets done.\n\n\
             Only when it is **fully** addressed — the change is made and stands up. If \
             you did part of it, leave the item and `drop` what is left as its own thing, \
             or say so in the note and leave it standing. It is kept, not deleted, so the \
             user can put it back if you were wrong about it.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "item": {
                    "type": "string",
                    "description": "The item's id as `sink` reported it, or its exact title."
                },
                "note": {
                    "type": "string",
                    "description":
                        "What was actually done about it, in a line — the commit, the \
                         fix, or why it turned out not to be a problem. This is all \
                         anybody reading the settled list later will have."
                }
            },
            "required": ["item"]
        }
    })
}

/* ── who is reading ───────────────────────────────────────────────────────── */

struct Reader {
    /// Which project's sink is this card's own. `None` for a card the store has
    /// no row for, which reads the whole wall rather than nothing.
    project_id: Option<String>,
    /// A chat card stands in a territory that is not a repository, so its items
    /// go to the wall rather than to that territory — see the note in `do_drop`.
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
        None => Reader { project_id: None, chat: false },
    }
}

/// Everything this card may see, swept first.
fn visible(app: &AppHandle, me: &Reader, all: bool, settled: bool) -> Result<Vec<SinkItem>, String> {
    let store = app.state::<Store>();
    let conn = store.0.lock().map_err(|_| "the store is unavailable".to_string())?;
    crate::store::sweep_sink_holds(&conn);
    let scope = if all { None } else { me.project_id.as_deref() };
    crate::store::sink_items(&conn, scope, settled)
}

/* ── reading ──────────────────────────────────────────────────────────────── */

fn do_sink(app: &AppHandle, caller: &str, args: &Value) -> String {
    let me = reader(app, caller);
    let all = args.get("scope").and_then(Value::as_str) == Some("skein");
    let settled = args.get("settled").and_then(Value::as_bool) == Some(true);
    let want_kind = args.get("kind").and_then(Value::as_str).map(str::to_lowercase);

    let items = match visible(app, &me, all, settled) {
        Ok(i) => i,
        Err(e) => return format!("could not read the sink: {e}"),
    };
    let items: Vec<&SinkItem> = items
        .iter()
        .filter(|i| want_kind.as_deref().is_none_or(|k| i.kind == k))
        .collect();

    if items.is_empty() {
        return if settled {
            "nothing in the sink has been settled yet.".into()
        } else {
            "the sink is empty — nobody has left anything in it.".into()
        };
    }

    let now = crate::store::now();
    let mut out = String::new();
    if settled {
        out.push_str("Already dealt with — do not raise these again unless they are back:\n\n");
        for i in &items {
            out.push_str(&render(i, now, caller));
        }
        return out;
    }

    /* Yours first, and said out loud, for `do_board`'s reason: an agent that
       sees what it is holding at the top of every read is one that remembers it
       is holding it. */
    let (mine, rest): (Vec<&&SinkItem>, Vec<&&SinkItem>) =
        items.iter().partition(|i| i.held_by.as_deref() == Some(caller));

    if !mine.is_empty() {
        out.push_str(
            "You are holding these — finish them with `done`, or put them back with \
             `take … release: true` if you have stopped:\n\n",
        );
        for i in &mine {
            out.push_str(&render(i, now, caller));
        }
        out.push('\n');
    }

    let (held, open): (Vec<&&&SinkItem>, Vec<&&&SinkItem>) =
        rest.iter().partition(|i| !free(i, now));

    if !open.is_empty() {
        out.push_str("Waiting, nobody on them:\n\n");
        for i in &open {
            out.push_str(&render(i, now, caller));
        }
    } else if mine.is_empty() {
        out.push_str("Nothing is waiting — every item is held.\n");
    }
    if !held.is_empty() {
        out.push_str("\nHeld by another conversation — leave these alone:\n\n");
        for i in &held {
            out.push_str(&render(i, now, caller));
        }
    }
    out
}

fn render(i: &SinkItem, now: i64, caller: &str) -> String {
    let voices = if i.voices > 1 {
        format!(" ×{}", i.voices)
    } else {
        String::new()
    };
    let who = match &i.from_id {
        Some(id) if id == caller => "you".to_string(),
        Some(id) => crate::relay::handle_of(id),
        None => "the user".into(),
    };
    let globs = globs_of(i);
    let files = if globs.is_empty() {
        String::new()
    } else {
        format!("\n  files: {}", globs.join(", "))
    };
    let hold = match (&i.held_by, i.held_at) {
        (Some(h), _) if h == caller => " · yours".to_string(),
        (Some(h), Some(at)) if now - at > HOLD_STALE_MS => format!(
            " · was held by {}, {} and untouched since — free to take",
            crate::relay::handle_of(h),
            ago(now - at)
        ),
        (Some(h), Some(at)) => format!(" · held by {}, {}", crate::relay::handle_of(h), ago(now - at)),
        (Some(h), None) => format!(" · held by {}", crate::relay::handle_of(h)),
        (None, _) => String::new(),
    };
    let settled = match (i.settled_at, &i.settled_note) {
        (Some(at), Some(note)) => format!("\n  settled {}: {note}", ago(now - at)),
        (Some(at), None) => format!("\n  settled {}", ago(now - at)),
        _ => String::new(),
    };
    format!(
        "- [{}] {}{voices} — {}\n  {}{files}\n  dropped by {who}, {}{hold}{settled}\n",
        i.id.chars().take(8).collect::<String>(),
        i.kind,
        i.title,
        i.body.replace('\n', "\n  "),
        ago(now - i.dropped_at),
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

/* ── dropping ─────────────────────────────────────────────────────────────── */

fn do_drop(app: &AppHandle, caller: &str, args: &Value) -> String {
    let me = reader(app, caller);
    let Some(title) = args.get("title").and_then(Value::as_str) else {
        return "no `title` was given, so nothing was dropped".into();
    };
    let title = clip(title.trim(), MAX_TITLE);
    if title.is_empty() {
        return "the title was empty, so nothing was dropped".into();
    }
    let body = clip(
        args.get("body").and_then(Value::as_str).unwrap_or("").trim(),
        MAX_BODY,
    );
    if body.is_empty() {
        return "no `body` was given — a title on its own is a thing nobody will be able \
                to act on in a month, so nothing was dropped"
            .into();
    }
    let kind = args
        .get("kind")
        .and_then(Value::as_str)
        .map(str::to_lowercase)
        .filter(|k| KINDS.contains(&k.as_str()))
        .unwrap_or_else(|| "note".into());
    let paths = globs_from(args.get("paths"));

    /* A chat card's territory is Skein's own data folder rather than a
       repository (see `.claude/rules/chat.md`), so filing an item under it would
       put the finding somewhere nobody will ever look for it. Its items go to
       the wall instead. The one card that cannot read a file is also the one
       most likely to meet an `ask_user` fault worth reporting, so refusing it
       outright — which is what `board` and `relay` do — would lose exactly the
       reports this exists to collect. */
    let wall = args.get("scope").and_then(Value::as_str) == Some("skein") || me.chat;
    let project_id = if wall { None } else { me.project_id.clone() };
    if !wall && project_id.is_none() {
        return "this card is not on the wall, so it has no project to file this under — \
                pass `scope: \"skein\"` to leave it for the studio"
            .into();
    }

    let store = app.state::<Store>();
    let Ok(conn) = store.0.lock() else {
        return "the store is unavailable".into();
    };
    if crate::store::sink_dropped_count(&conn, caller) >= MAX_OPEN_PER_CARD {
        return format!(
            "this card has already left {MAX_OPEN_PER_CARD} unsettled items in the \
             sink, which is the limit. Read the sink and settle or narrow what is \
             already there before adding more — a pile this long is one nobody reads."
        );
    }
    let id = crate::store::uuid_v4();
    let put = crate::store::put_sink_item(
        &conn,
        &id,
        project_id.as_deref(),
        &kind,
        &title,
        &body,
        &paths,
        Some(caller),
    );
    drop(conn);

    match put {
        Err(e) => format!("could not drop that: {e}"),
        Ok(p) => {
            changed(app, project_id);
            if p.merged {
                let voices = if p.voices > 1 {
                    format!(" {} conversations have now met it.", p.voices)
                } else {
                    String::new()
                };
                format!(
                    "{title:?} was already in the sink, so this went onto that item \
                     rather than making a second one — anything your words added is on \
                     it now.{voices} It is [{}]. Tell the user you seconded an existing \
                     item rather than raising a new one.",
                    p.id.chars().take(8).collect::<String>()
                )
            } else {
                format!(
                    "dropped into the {} sink as [{}]: {title:?}. It will outlive this \
                     conversation. Nobody is assigned to it — if you are about to deal \
                     with it yourself, `take` it first.",
                    if wall { "wall-wide" } else { "project" },
                    p.id.chars().take(8).collect::<String>()
                )
            }
        }
    }
}

/* ── taking and settling ──────────────────────────────────────────────────── */

/// Find the item an agent means. Full id, then its short head, then the exact
/// title — the same ladder `relay::resolve` and `do_unpost` walk, because the
/// agent was shown both spellings and either is a fair thing to type back.
fn resolve<'a>(items: &'a [SinkItem], want: &str) -> Option<&'a SinkItem> {
    let want = want.trim();
    items
        .iter()
        .find(|i| i.id == want)
        .or_else(|| items.iter().find(|i| i.id.starts_with(want) && want.len() >= 4))
        .or_else(|| items.iter().find(|i| i.title.eq_ignore_ascii_case(want)))
}

fn do_take(app: &AppHandle, caller: &str, args: &Value) -> String {
    let me = reader(app, caller);
    let Some(want) = args.get("item").and_then(Value::as_str) else {
        return "name the item by its id or its exact title".into();
    };
    let release = args.get("release").and_then(Value::as_bool) == Some(true);

    /* Read across the whole wall rather than this card's scope: an id an agent
       was given is one it should be able to act on, and an item it can see in a
       `skein`-scoped read but not take would be a distinction nothing in the
       tool's description prepares it for. */
    let items = match visible(app, &me, true, false) {
        Ok(i) => i,
        Err(e) => return format!("could not read the sink: {e}"),
    };
    let Some(item) = resolve(&items, want) else {
        return not_found(&items, want);
    };
    let now = crate::store::now();

    if release {
        if item.held_by.as_deref() != Some(caller) {
            return match &item.held_by {
                Some(h) => format!(
                    "{:?} is held by {}, not by you — nothing to put back.",
                    item.title,
                    crate::relay::handle_of(h)
                ),
                None => format!("{:?} was not held by anyone.", item.title),
            };
        }
        let store = app.state::<Store>();
        let Ok(conn) = store.0.lock() else {
            return "the store is unavailable".into();
        };
        let ok = crate::store::hold_sink_item(&conn, &item.id, None, Some(caller));
        drop(conn);
        if ok {
            changed(app, item.project_id.clone());
            return format!(
                "put {:?} back. It is waiting for whoever picks it up next — if you got \
                 part of the way, `drop` what you learned so that is not lost too.",
                item.title
            );
        }
        return format!("{:?} had already moved on.", item.title);
    }

    if item.held_by.as_deref() == Some(caller) {
        let store = app.state::<Store>();
        let Ok(conn) = store.0.lock() else {
            return "the store is unavailable".into();
        };
        crate::store::touch_sink_hold(&conn, &item.id, caller);
        drop(conn);
        changed(app, item.project_id.clone());
        return format!("you already hold {:?} — the hold is fresh again.", item.title);
    }

    if !free(item, now) {
        let who = item
            .held_by
            .as_deref()
            .map(crate::relay::handle_of)
            .unwrap_or_default();
        return format!(
            "{:?} is held by {who}, who said so {}. Leave it to them and tell the user \
             that is why you did not start it — if it genuinely needs two of you, \
             message {who} rather than working over them.",
            item.title,
            item.held_at.map(|at| ago(now - at)).unwrap_or_else(|| "recently".into())
        );
    }

    let store = app.state::<Store>();
    let Ok(conn) = store.0.lock() else {
        return "the store is unavailable".into();
    };
    let held = crate::store::sink_held_count(&conn, caller);
    if held >= MAX_HELD {
        return format!(
            "this card is already holding {held} items, which is the limit — every one \
             of them is an item no other conversation will touch. Finish one with `done` \
             or put it back before taking this."
        );
    }
    /* Conditional on the hold we read, so two cards claiming this in the same
       instant cannot both be told they have it — see `store::hold_sink_item`. */
    let ok = crate::store::hold_sink_item(&conn, &item.id, Some(caller), item.held_by.as_deref());
    drop(conn);
    if !ok {
        return format!(
            "{:?} was taken by another conversation a moment before you — leave it to \
             them.",
            item.title
        );
    }
    changed(app, item.project_id.clone());
    let was = match &item.held_by {
        Some(h) => format!(
            " It had been held by {} since {}, untouched long enough to be free.",
            crate::relay::handle_of(h),
            item.held_at.map(|at| ago(now - at)).unwrap_or_else(|| "some time".into())
        ),
        None => String::new(),
    };
    format!(
        "you are holding {:?}.{was} No other conversation will start it while you have \
         it. `done` when it is fully addressed, or `take … release: true` the moment you \
         stop.",
        item.title
    )
}

fn do_done(app: &AppHandle, caller: &str, args: &Value) -> String {
    let me = reader(app, caller);
    let Some(want) = args.get("item").and_then(Value::as_str) else {
        return "name the item by its id or its exact title".into();
    };
    let note = args
        .get("note")
        .and_then(Value::as_str)
        .map(|n| clip(n.trim(), MAX_NOTE))
        .filter(|n| !n.is_empty());

    let items = match visible(app, &me, true, false) {
        Ok(i) => i,
        Err(e) => return format!("could not read the sink: {e}"),
    };
    let Some(item) = resolve(&items, want) else {
        return not_found(&items, want);
    };
    let now = crate::store::now();

    /* Somebody else's live hold is a refusal rather than a warning. `done` on an
       item another card is in the middle of is either two agents on one job — in
       which case the news the user needs is the collision, not the tick — or an
       agent settling work it did not do. Both are worse than being told no. A
       hold that has gone stale is not a hold, so that case falls through. */
    if let Some(h) = &item.held_by {
        if h != caller && !hold_stale(item, now) {
            return format!(
                "{:?} is held by {} — they are dealing with it, so this is not yours to \
                 take down. If you have just done the same work, say so to the user and \
                 message {} rather than settling it over them.",
                item.title,
                crate::relay::handle_of(h),
                crate::relay::handle_of(h)
            );
        }
    }

    let store = app.state::<Store>();
    let Ok(conn) = store.0.lock() else {
        return "the store is unavailable".into();
    };
    let ok = crate::store::settle_sink_item(&conn, &item.id, note.as_deref());
    drop(conn);
    if !ok {
        return format!("{:?} was already settled.", item.title);
    }
    changed(app, item.project_id.clone());
    let asked = if note.is_none() {
        " It is kept with no note on it, which is a thin record — say what you did about \
         it next time."
    } else {
        ""
    };
    format!(
        "took {:?} out of the sink.{asked} It is kept rather than deleted, so the user \
         can put it back if it turns out not to be finished.",
        item.title
    )
}

fn not_found(items: &[SinkItem], want: &str) -> String {
    if items.is_empty() {
        return "there is nothing in the sink.".into();
    }
    format!(
        "no item called {want:?}. Read `sink` for the ids — the ones there now are: {}",
        items
            .iter()
            .take(8)
            .map(|i| format!("[{}] {:?}", i.id.chars().take(8).collect::<String>(), i.title))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/* ── shared with the board ────────────────────────────────────────────────── */

fn globs_of(item: &SinkItem) -> Vec<&str> {
    item.paths
        .lines()
        .map(str::trim)
        .filter(|g| !g.is_empty())
        .collect()
}

/// Whatever the model wrote, as newline-separated globs. Same shape as
/// `board::globs_from`, and deliberately not shared with it: the two will drift
/// (a notice's globs are matched against live writes, an item's are read by a
/// human) and a common helper would make the next change to either one a
/// question about both.
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

/* ── the wall's way in ────────────────────────────────────────────────────── */

fn as_json(i: &SinkItem, now: i64) -> Value {
    json!({
        "id": i.id,
        "projectId": i.project_id,
        "kind": i.kind,
        "title": i.title,
        "body": i.body,
        "paths": globs_of(i),
        "from": i.from_id,
        "droppedAt": i.dropped_at,
        "touchedAt": i.touched_at,
        "voices": i.voices,
        "heldBy": i.held_by,
        "heldAt": i.held_at,
        /* Computed here rather than in the webview, for `board::as_json`'s
           reason: the reading an agent is given and the reading you are given
           must not be able to disagree about whether a hold still stands. */
        "holdStale": hold_stale(i, now),
        "settledAt": i.settled_at,
        "settledNote": i.settled_note,
    })
}

#[tauri::command]
pub fn read_sink(
    app: AppHandle,
    project_id: Option<String>,
    settled: Option<bool>,
) -> Result<Value, String> {
    let store = app.state::<Store>();
    let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
    crate::store::sweep_sink_holds(&conn);
    let items = crate::store::sink_items(&conn, project_id.as_deref(), settled.unwrap_or(false))?;
    let now = crate::store::now();
    Ok(json!(items.iter().map(|i| as_json(i, now)).collect::<Vec<_>>()))
}

/// Drop something in as *yourself*. An item with no card behind it, which is the
/// one thing in the sink that is not a report from an agent — it is an
/// instruction, and the reading says "from the user".
#[tauri::command]
pub fn sink_add(
    app: AppHandle,
    title: String,
    body: String,
    kind: Option<String>,
    paths: Option<Vec<String>>,
    project_id: Option<String>,
) -> Result<String, String> {
    let title = clip(title.trim(), MAX_TITLE);
    if title.is_empty() {
        return Err("an item needs a title".into());
    }
    let kind = kind
        .map(|k| k.to_lowercase())
        .filter(|k| KINDS.contains(&k.as_str()))
        .unwrap_or_else(|| "note".into());
    let id = crate::store::uuid_v4();
    let globs = globs_from(paths.map(|p| json!(p)).as_ref());
    let put = {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
        crate::store::put_sink_item(
            &conn,
            &id,
            project_id.as_deref(),
            &kind,
            &title,
            &clip(body.trim(), MAX_BODY),
            &globs,
            None,
        )?
    };
    changed(&app, project_id);
    Ok(put.id)
}

/// Mark it dealt with, from the wall. No note: the note is what an *agent* has
/// to say about work it did, and you were there.
#[tauri::command]
pub fn sink_settle(app: AppHandle, id: String) -> Result<bool, String> {
    let ok = {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
        crate::store::settle_sink_item(&conn, &id, None)
    };
    changed(&app, None);
    Ok(ok)
}

/// Put a settled item back — the whole reason `done` keeps the row.
#[tauri::command]
pub fn sink_unsettle(app: AppHandle, id: String) -> Result<bool, String> {
    let ok = {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
        crate::store::unsettle_sink_item(&conn, &id)
    };
    changed(&app, None);
    Ok(ok)
}

/// Throw it away. Yours only — no agent reaches this.
#[tauri::command]
pub fn sink_delete(app: AppHandle, id: String) -> Result<bool, String> {
    let ok = {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
        crate::store::drop_sink_item(&conn, &id)
    };
    changed(&app, None);
    Ok(ok)
}

/// Prise a hold off an item, because you can see the card holding it is not
/// doing it. The hold expires on its own eventually; this is for when you know
/// sooner.
#[tauri::command]
pub fn sink_release(app: AppHandle, id: String) -> Result<bool, String> {
    let ok = {
        let store = app.state::<Store>();
        let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
        crate::store::hold_sink_item(&conn, &id, None, None) || {
            let item = crate::store::sink_one(&conn, &id);
            match item.and_then(|i| i.held_by) {
                Some(h) => crate::store::hold_sink_item(&conn, &id, None, Some(&h)),
                None => false,
            }
        }
    };
    changed(&app, None);
    Ok(ok)
}

/// Drive one of the four tools by hand, as a named card.
///
/// One command rather than four, which is where this parts company with
/// `board::relay_post` and friends: those grew one at a time and each has its
/// own typed parameters, and the cost is four near-identical wrappers that must
/// be kept in step with four schemas. What `wall.test.ts` and the control
/// surface actually want is to make the call an agent would make, and the honest
/// spelling of that is the tool's name and the tool's arguments. Off the main
/// thread for `relay_send`'s reason: `do_drop` and `do_take` end in an emit and
/// hold the store's lock across a sweep.
#[tauri::command]
pub async fn sink_tool(
    app: AppHandle,
    id: String,
    tool: String,
    args: Option<Value>,
) -> Result<String, String> {
    let args = args.unwrap_or_else(|| json!({}));
    crate::off_main(move || {
        handle(&app, &id, &tool, &args)
            .unwrap_or_else(|| format!("the sink has no tool {tool:?}"))
    })
    .await
}

/// A card is going, or has been cleared. It lets go of what it was holding —
/// and that is all. The items stay: see `store::migrate_v18`.
pub fn release_for(app: &AppHandle, conversation_id: &str) {
    let Some(store) = app.try_state::<Store>() else { return };
    let n = {
        let Ok(conn) = store.0.lock() else { return };
        crate::store::release_sink_holds_of(&conn, conversation_id)
    };
    if n > 0 {
        changed(app, None);
    }
}

/// Route a `tools/call` that belongs to the sink. `None` for a name this file
/// does not claim, so `ask.rs` can go on asking.
pub fn handle(app: &AppHandle, conversation_id: &str, tool: &str, args: &Value) -> Option<String> {
    match tool {
        SINK_TOOL => Some(do_sink(app, conversation_id, args)),
        DROP_TOOL => Some(do_drop(app, conversation_id, args)),
        TAKE_TOOL => Some(do_take(app, conversation_id, args)),
        DONE_TOOL => Some(do_done(app, conversation_id, args)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::SinkItem;

    fn item(held_by: Option<&str>, held_at: Option<i64>) -> SinkItem {
        SinkItem {
            id: "abcd1234-0000".into(),
            project_id: None,
            kind: "bug".into(),
            title: "ask_user times out in a non-interactive session".into(),
            body: "the call parks for ten minutes".into(),
            paths: String::new(),
            from_id: None,
            dropped_at: 0,
            touched_at: 0,
            voices: 1,
            held_by: held_by.map(str::to_string),
            held_at,
            settled_at: None,
            settled_note: None,
        }
    }

    #[test]
    fn an_unheld_item_is_free() {
        assert!(free(&item(None, None), 0));
    }

    #[test]
    fn a_fresh_hold_blocks_it() {
        let i = item(Some("c1"), Some(1_000));
        assert!(!free(&i, 1_000 + HOLD_STALE_MS / 2));
    }

    /// The half that parts company with the billboard: a hold nobody has
    /// honoured gives way, where a stale notice is only marked. See the module
    /// note.
    #[test]
    fn a_hold_nobody_has_honoured_gives_way() {
        let i = item(Some("c1"), Some(1_000));
        assert!(hold_stale(&i, 1_000 + HOLD_STALE_MS + 1));
        assert!(free(&i, 1_000 + HOLD_STALE_MS + 1));
    }

    /// A hold is longer-lived than a notice, deliberately — expiring one that is
    /// still being honoured costs two agents doing one job.
    #[test]
    fn a_hold_outlasts_a_notice() {
        assert!(HOLD_STALE_MS > 90 * 60 * 1_000);
    }

    #[test]
    fn an_item_resolves_by_id_by_its_head_and_by_title() {
        let items = vec![item(None, None)];
        assert!(resolve(&items, "abcd1234-0000").is_some());
        assert!(resolve(&items, "abcd").is_some());
        assert!(resolve(&items, "ASK_USER TIMES OUT IN A NON-INTERACTIVE SESSION").is_some());
        assert!(resolve(&items, "nothing like it").is_none());
    }

    /// Three characters is not enough of an id to act on. An agent that typed a
    /// fragment should be told what is there rather than handed whichever item
    /// happened to start with it.
    #[test]
    fn too_short_a_fragment_matches_nothing() {
        let items = vec![item(None, None)];
        assert!(resolve(&items, "abc").is_none());
    }

    #[test]
    fn a_missing_item_names_what_is_actually_there() {
        let items = vec![item(None, None)];
        let msg = not_found(&items, "the wrong thing");
        assert!(msg.contains("ask_user times out"), "{msg}");
    }

    #[test]
    fn globs_arrive_in_both_spellings() {
        assert_eq!(globs_from(Some(&json!("a.ts, b.ts"))), "a.ts\nb.ts");
        assert_eq!(globs_from(Some(&json!(["a.ts", "b.ts"]))), "a.ts\nb.ts");
        assert_eq!(globs_from(None), "");
    }

    #[test]
    fn the_four_tools_are_advertised_with_usable_schemas() {
        for s in [sink_schema(), drop_schema(), take_schema(), done_schema()] {
            assert!(s["name"].is_string());
            assert!(s["description"].as_str().unwrap().len() > 200);
            assert_eq!(s["inputSchema"]["type"], "object");
        }
    }

    /// `drop` is the one an agent will reach for without being asked, so its
    /// description has to say what *not* to put in — a box that fills with
    /// restatements of the git log is one nobody reads.
    #[test]
    fn drop_says_what_does_not_belong_in_the_sink() {
        let d = drop_schema()["description"].as_str().unwrap().to_string();
        assert!(d.contains("not a to-do list"));
        assert!(d.contains("already records"));
    }

    /// The hold is only worth having if an agent is told to put it back.
    #[test]
    fn take_says_to_put_it_back() {
        let d = take_schema()["description"].as_str().unwrap().to_string();
        assert!(d.contains("release"));
    }
}
