//! Cards that can see each other — the roster, and messages between them.
//!
//! Two more tools on the server `ask.rs` already runs, for the same reason that
//! one is there: the URL carries the conversation id, so a call arrives already
//! addressed to a card and there is no correlation logic anywhere. `list`
//! answers who else is on the wall; `send` puts a message into another card's
//! stdin, where it becomes a turn.
//!
//! **Fire and forget, deliberately, where `ask_user` parks.** The parking
//! machinery is right next door and would be the wrong shape here: A waiting on
//! B while B waits on A is two cards wedged with no gesture that unsticks them,
//! and the ten-minute timeout would be the only thing that ever ended it. A
//! reply is the recipient calling `send` back. Symmetric, no deadlock, and
//! nothing to explain to the model.
//!
//! What the design is actually for is several agents working the same feature
//! at once — one has changed the schema, another is about to rebase onto it —
//! and the failure mode it has to survive is not a lost message but a spiral of
//! them. Everything under "the guards" below is that.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::store::{RosterRow, Store};

/// The tool names as the CLI sees them, prefixed by the server.
///
/// Named here because `classify.ts` needs the same two strings to draw the
/// calls, and a rename that reached one of the two would leave the other
/// drawing raw `mcp__skein__…` on the card.
pub const LIST_TOOL: &str = "list";
pub const SEND_TOOL: &str = "send";

/// How far a message may travel before the exchange is stopped.
///
/// Six is a conversation and not a loop. Two agents can hand something back and
/// forth indefinitely at a turn and an API call apiece, with nothing on the wall
/// saying why the allowance is going — this is the wall's answer, and the
/// refusal says to report to the user rather than simply going quiet, because an
/// agent told only "no" will try a different phrasing of the same message.
const MAX_HOPS: i64 = 6;

/// How many `send` calls one card may make in a minute.
///
/// Counted per call and not per recipient, which is the whole reason a
/// broadcast is one call: fanning out to twelve cards deliberately is a thing
/// somebody asked for, and twelve separate sends in a second is a card in a
/// loop that has not noticed.
const MAX_SENDS: usize = 6;
const SEND_WINDOW: Duration = Duration::from_secs(60);

/// The most a message may carry.
///
/// A relay is a message, not a transfer: the recipient shares the machine and
/// can read the file. Truncated rather than refused, since a message that is
/// mostly right is worth delivering and an agent that had its send bounced will
/// send it again slightly shorter, twice.
const MAX_BODY: usize = 4_000;

/// The first line of every delivered message, and the whole of how the front
/// end knows one when it sees it.
///
/// The recipient's CLI replays it as a plain `user` message, which is the same
/// shape as something you typed — so without a marker in the text itself a
/// message from another agent would be drawn in your register, in your card,
/// with nothing saying it was not you. Recognised off the words exactly the way
/// `rousing.ts::isResumePrompt` recognises a resume, and for the same reason:
/// both folds have to draw it, and the live one and the one that reads it back
/// off disk share nothing but the text.
pub const RELAY_MARK: &str = "[skein relay]";

/// What one card is currently acting inside, so a reply can be counted.
struct Inbound {
    chain: String,
    hops: i64,
    /// How many turn-closes this mark must outlive.
    ///
    /// One for the turn the message will be handled in, plus one more if a turn
    /// was already running when it was delivered — the CLI queues the prompt
    /// behind that turn, so its close is not the close of ours. Not perfect:
    /// two relays arriving during one turn, or a turn that never opens because
    /// the card was closed, leave the count off by one, and what a lost mark
    /// costs is one card getting to broadcast once. That is the right direction
    /// to be wrong in — the alternative is a mark that never clears, which
    /// silently forbids a card from ever broadcasting again.
    pending: u32,
}

#[derive(Default)]
pub struct Relays {
    inbound: Mutex<HashMap<String, Inbound>>,
    recent: Mutex<HashMap<String, Vec<Instant>>>,
}

/// A message on its way, for the wall to draw. One per recipient, so a
/// broadcast is a strand each rather than one event to be fanned out in the
/// webview.
#[derive(Clone, Serialize)]
struct RelaySent {
    id: String,
    from: String,
    to: String,
    /// False when the recipient was dormant and this went to its inbox. The
    /// strand still flies — something did leave — but nothing arrives.
    delivered: bool,
    /// Whether this was one of several from a single call, which is what lets
    /// the wall fan the strands apart instead of stacking them.
    broadcast: bool,
    /// This is a message that had been *waiting*, handed over as the card woke.
    /// The wall keeps an inbox mark per card and this is the only thing that
    /// takes one down — `delivered` cannot, since it is also true of every
    /// message that never waited at all.
    from_inbox: bool,
    /// What was said, clipped. Only for the wall's own use; the agent's copy
    /// went down the pipe.
    preview: String,
}

/* ── handles ──────────────────────────────────────────────────────────────
 *
 * A card's id is a uuid, and a model addressing one by 36 characters of hex is
 * tokens spent on nothing. The first eight are the handle: short enough to
 * repeat in prose, long enough that a wall would need millions of cards before
 * two collided. Titles work too, because they are what an agent will reach for
 * first — but they change under it (`naming.ts` renames as the work clarifies)
 * and two cards may share one, so an ambiguous title is refused *by name*
 * rather than guessed between.
 */

pub fn handle_of(id: &str) -> String {
    id.chars().take(8).collect()
}

/// Which row a written address means, or a sentence saying why none of them.
fn resolve<'a>(rows: &'a [RosterRow], want: &str) -> Result<&'a RosterRow, String> {
    let want = want.trim();
    if want.is_empty() {
        return Err("no card was named".into());
    }
    if let Some(r) = rows.iter().find(|r| r.id == want) {
        return Ok(r);
    }
    if let Some(r) = rows.iter().find(|r| handle_of(&r.id) == want.to_lowercase()) {
        return Ok(r);
    }
    let by_title: Vec<&RosterRow> = rows
        .iter()
        .filter(|r| r.title.trim().eq_ignore_ascii_case(want))
        .collect();
    match by_title.len() {
        1 => Ok(by_title[0]),
        0 => Err(format!(
            "no card called {want:?} — call `list` for the handles"
        )),
        _ => Err(format!(
            "{} cards are called {want:?}; name one by handle instead ({})",
            by_title.len(),
            by_title
                .iter()
                .map(|r| handle_of(&r.id))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

/* ── the envelope ─────────────────────────────────────────────────────────── */

/// What the recipient's model actually reads.
///
/// Three jobs, and the middle one is the one that matters: say who this is
/// from, say plainly that it is *not the user*, and say that silence is a
/// legitimate reply. Without the second, a message arrives in the register of
/// an instruction from the person who owns the machine; without the third,
/// every message gets answered and the wall talks to itself.
///
/// The title is quoted, so a quote inside it would end the field the front end
/// reads the name out of. Folded to an apostrophe rather than escaped — one
/// less thing for two parsers in two languages to agree about.
pub fn envelope(from: &RosterRow, body: &str) -> String {
    let name = from.title.replace('"', "'");
    let body = clip(body, MAX_BODY);
    format!(
        "{RELAY_MARK} from \"{name}\" ({}) in {} —\n\n{body}\n\n\
         (This came from another agent on the Skein wall, not from the user. \
         Act on it if it bears on your work, reply with the `send` tool if it \
         needs an answer, and say nothing back if it does not.)",
        handle_of(&from.id),
        from.project,
    )
}

/// The envelope a *notice* arrives in when it comes to find you.
///
/// The same `RELAY_MARK` as a message, so the transcript folds it the same way
/// and there is one recogniser rather than two — but a third header line, since
/// this did not come from a card that decided to write to you. It came from the
/// billboard, and it says which file brought it.
///
/// `from` is absent when the notice is yours or when the card that posted it has
/// been closed since. The board's own name is used then, rather than an
/// invented sender: a notice outlives its author and saying otherwise would put
/// a closed card's words in a living one's mouth.
pub fn board_envelope(from: Option<&RosterRow>, notice: &crate::store::Notice, path: &str) -> String {
    let who = match from {
        Some(r) => format!(
            "\"{}\" ({})",
            r.title.replace('"', "'"),
            handle_of(&r.id)
        ),
        None => "the billboard".to_string(),
    };
    format!(
        "{RELAY_MARK} from the billboard — a notice from {who} covers `{path}`, which \
         you have just edited:\n\n\
         **{}**\n\n{}\n\n\
         (This is a standing notice on the Skein wall, not a message from the user, \
         and you are shown it once. Read it before going further with this file. Call \
         `board` for the rest of what is up, and `send` if you need to agree something \
         with whoever posted it.)",
        notice.subject.replace('"', "'"),
        clip(&notice.body, MAX_BODY),
    )
}

/// Draw a notice reaching a card, when there is somewhere to draw it from.
///
/// The same strand a message gets: it is the same event on the wall — something
/// left one card and arrived at another. Silent when the poster is you or a
/// card that has closed, because a strand from nowhere is a strand that says the
/// wrong thing about where things are.
pub fn announce_board(app: &AppHandle, notice: &crate::store::Notice, to_id: &str) {
    let Some(from) = notice.from_id.as_deref() else { return };
    let live = app
        .state::<Store>()
        .0
        .lock()
        .ok()
        .and_then(|conn| crate::store::roster_one(&conn, from))
        .is_some();
    if !live {
        return;
    }
    let _ = app.emit(
        "relay:sent",
        RelaySent {
            id: crate::store::uuid_v4(),
            from: from.to_string(),
            to: to_id.to_string(),
            delivered: true,
            broadcast: false,
            from_inbox: false,
            preview: clip(&notice.subject, 240),
        },
    );
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}\n\n[…truncated by skein at {max} characters]")
}

/* ── the tools ────────────────────────────────────────────────────────────── */

pub fn list_schema() -> Value {
    json!({
        "name": LIST_TOOL,
        "description":
            "List the other Claude Code conversations open on this Skein wall, so you \
             can coordinate with them instead of duplicating their work or fighting \
             them over the same files. Each entry carries a `handle` — that is what \
             `send` takes. Worth calling before starting anything substantial in a \
             repository somebody else may be in, and again if you are about to change \
             something others build on.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "scope": {
                    "type": "string",
                    "enum": ["project", "skein"],
                    "description":
                        "`project` (the default) lists the cards working in your own \
                         project — nearly always who you mean. `skein` lists every \
                         card on the wall, across every project."
                }
            }
        }
    })
}

pub fn send_schema() -> Value {
    json!({
        "name": SEND_TOOL,
        "description":
            "Send a message to another conversation on this Skein wall. It arrives as \
             a turn in that card, marked as coming from you, and the agent there \
             decides what to do about it. Nothing is returned but a receipt: this does \
             not wait for a reply, and a reply is that agent calling `send` back.\n\n\
             Use it to coordinate real work — 'I have changed the store schema, rebase \
             before you touch store.rs', 'I own the transcript panel this afternoon', \
             'your migration and mine are both v14'. Do not use it to chat, to \
             acknowledge, or to say you have finished something nobody asked about: \
             every message costs the other agent a turn.\n\n\
             **If what you want is to find out who is working on what, read the \
             `board` first.** That is what the billboard is for, it costs nobody \
             anything, and it has usually already been answered up there — where a \
             message asking somebody what they are doing costs them a whole turn to \
             tell you something they had written down.\n\n\
             `to` takes a handle from `list`, a card's exact title, or a list of \
             either. It also takes the word `project` to reach every other card in \
             your project, or `skein` to reach every card on the wall — those two are \
             for announcements, and are refused when you are yourself acting on a \
             message somebody sent you.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "to": {
                    "description":
                        "Who to tell: a handle, a title, an array of them, or the word \
                         `project` or `skein` to broadcast.",
                    "anyOf": [
                        { "type": "string" },
                        { "type": "array", "items": { "type": "string" } }
                    ]
                },
                "message": {
                    "type": "string",
                    "description":
                        "What to tell them. Write it for another agent with its own \
                         context, not for the user: say what changed, where, and what \
                         you want them to do about it. Name files by path. Keep it to \
                         what they need — this is the whole of what they will get, and \
                         they cannot ask you a follow-up question."
                }
            },
            "required": ["to", "message"]
        }
    })
}

/// Answer `list`.
fn do_list(app: &AppHandle, caller: &str, args: &Value) -> String {
    let store = app.state::<Store>();
    let conn = match store.0.lock() {
        Ok(c) => c,
        Err(_) => return "the store is unavailable".into(),
    };

    let me = crate::store::roster_one(&conn, caller);
    /* Refused for the reason `do_send` is, one step earlier. A chat card can
       reach the open web and nothing on this machine, which is the whole of
       what the kind is for — and the roster is a list of this machine's
       directories. See `.claude/rules/chat.md`. */
    if me.as_ref().is_some_and(|m| m.kind == "chat") {
        return "this is a chat card: it stands outside the wall's projects and cannot \
                see the other conversations."
            .into();
    }
    let scope = args.get("scope").and_then(Value::as_str).unwrap_or("project");
    /* Unknown scopes fall back to the default rather than refusing. The model
       wrote a word; the worst reading of a wrong one is a shorter list. */
    let project = match (scope, &me) {
        ("skein", _) => None,
        (_, Some(m)) => Some(m.project_id.clone()),
        /* A caller with no row of its own cannot be narrowed to its project,
           and answering nothing would read as an empty wall. */
        (_, None) => None,
    };

    let rows = match crate::store::roster(&conn, project.as_deref()) {
        Ok(r) => r,
        Err(e) => return format!("could not read the roster: {e}"),
    };
    drop(conn);

    let sup = app.state::<crate::supervisor::Supervisor>();
    let now = crate::store::now();
    let cards: Vec<Value> = rows
        .iter()
        .map(|r| {
            let (open, in_turn) = sup.liveness(&r.id);
            json!({
                "handle": handle_of(&r.id),
                "name": r.title,
                "you": r.id == caller,
                "project": r.project,
                "cwd": r.cwd,
                "worktree": r.worktree,
                "kind": r.kind,
                "state": if !open { "dormant" } else if in_turn { "working" } else { "idle" },
                "idle_seconds": r.last_turn_at.map(|t| (now - t).max(0) / 1000),
                "unread": r.inbox,
            })
        })
        .collect();

    json!({ "scope": if project.is_some() { "project" } else { "skein" }, "cards": cards })
        .to_string()
}

/// What `to` names, once the broadcast words are spent.
fn targets(rows: &[RosterRow], caller: &str, to: &Value) -> Result<(Vec<String>, bool), String> {
    let names: Vec<String> = match to {
        Value::String(s) => vec![s.clone()],
        Value::Array(a) => a
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        _ => return Err("`to` must be a handle, a title, or a list of them".into()),
    };
    if names.is_empty() {
        return Err("`to` named nobody".into());
    }

    let mut ids: Vec<String> = Vec::new();
    let mut broadcast = false;
    for name in &names {
        let word = name.trim().to_lowercase();
        if word == "project" || word == "skein" {
            broadcast = true;
            let mine = rows.iter().find(|r| r.id == caller).map(|r| r.project_id.clone());
            for r in rows {
                if r.id == caller {
                    continue;
                }
                /* A chat card can receive — it has no tools and nothing to be
                   turned against — but it is nobody's colleague either, and
                   sweeping it into an announcement about a repository it cannot
                   see is a turn spent on nothing. Address it by name if you
                   mean it. */
                if r.kind == "chat" {
                    continue;
                }
                if word == "project" && mine.as_deref() != Some(r.project_id.as_str()) {
                    continue;
                }
                ids.push(r.id.clone());
            }
        } else {
            ids.push(resolve(rows, name)?.id.clone());
        }
    }

    /* Named twice in one call — by handle and by title, say — is one message.
       Order-preserving rather than a sort, since the receipt reads back in the
       order they were asked for. */
    ids.retain(|id| id != caller);
    let mut seen = Vec::new();
    ids.retain(|id| {
        if seen.contains(id) {
            false
        } else {
            seen.push(id.clone());
            true
        }
    });
    Ok((ids, broadcast))
}

/// Answer `send`, and do it.
fn do_send(app: &AppHandle, caller: &str, args: &Value) -> String {
    let Some(body) = args.get("message").and_then(Value::as_str) else {
        return "no `message` was given, so nothing was sent".into();
    };
    if body.trim().is_empty() {
        return "the message was empty, so nothing was sent".into();
    }
    let Some(to) = args.get("to") else {
        return "no `to` was given, so nothing was sent".into();
    };

    let relays = app.state::<Relays>();
    let store = app.state::<Store>();

    let (rows, me) = {
        let Ok(conn) = store.0.lock() else {
            return "the store is unavailable".into();
        };
        let rows = match crate::store::roster(&conn, None) {
            Ok(r) => r,
            Err(e) => return format!("could not read the roster: {e}"),
        };
        let me = rows.iter().find(|r| r.id == caller).cloned();
        (rows, me)
    };
    let Some(me) = me else {
        return "this card is not on the wall, so it cannot send".into();
    };

    /* Decided by asking what kind of card this is, never by trusting the
       caller — the rule `spawn_conversation` follows for the same reason. A
       chat card spawns with no tool that touches this machine precisely so that
       what it reads on the web cannot act here; handing it a line into a card
       running --dangerously-skip-permissions would be that route, reopened. */
    if me.kind == "chat" {
        return "this is a chat card: it has no project and no tools that reach this \
                machine, and it may not message cards that do. Tell the user what you \
                wanted to pass on."
            .into();
    }

    /* The chain this send belongs to, and how far along it is. Read before
       anything is written, since delivering to a card sets *its* mark. */
    let (chain, hops) = match relays.inbound.lock().unwrap().get(caller) {
        Some(i) => (i.chain.clone(), i.hops + 1),
        None => (crate::store::uuid_v4(), 0),
    };
    if hops > MAX_HOPS {
        return format!(
            "this exchange has already gone {MAX_HOPS} hops between cards, so it was not \
             sent. Stop relaying and tell the user what is unresolved."
        );
    }

    if let Some(wait) = throttled(&relays, caller) {
        return format!(
            "this card has sent {MAX_SENDS} messages in the last minute, which is the \
             limit. Nothing was sent; try again in {wait}s if it still matters."
        );
    }

    let (ids, broadcast) = match targets(&rows, caller, to) {
        Ok(t) => t,
        Err(e) => return e,
    };
    if ids.is_empty() {
        return "there is nobody else on the wall to tell".into();
    }
    /* Broadcasting is something the user asked for; relaying is something you
       were told about. Fan-out is uncapped on purpose, so the one thing that
       must not happen is a broadcast whose recipients each broadcast — which
       is N² turns and then N³, and the hop limit does not touch it because the
       branching is the problem rather than the depth. */
    if broadcast && hops > 0 {
        return "broadcasting is only for something you started: you are acting on a \
                message another card sent you, so reply to that card instead."
            .into();
    }

    let text = envelope(&me, body);
    let mut receipts = Vec::new();
    for to_id in &ids {
        let awake = crate::supervisor::deliver(app, to_id, &text).is_ok();
        let relay_id = crate::store::uuid_v4();
        if let Ok(conn) = store.0.lock() {
            let _ = crate::store::record_relay(
                &conn, &relay_id, caller, to_id, body, &chain, hops, awake,
            );
        }
        if awake {
            arm(&relays, app, to_id, &chain, hops);
        }
        let name = rows
            .iter()
            .find(|r| &r.id == to_id)
            .map(|r| r.title.clone())
            .unwrap_or_else(|| handle_of(to_id));
        receipts.push(if awake {
            format!("delivered to \"{name}\" ({})", handle_of(to_id))
        } else {
            format!(
                "queued for \"{name}\" ({}) — that card is dormant and will be given \
                 this when it wakes",
                handle_of(to_id)
            )
        });
        let _ = app.emit(
            "relay:sent",
            RelaySent {
                id: relay_id,
                from: caller.to_string(),
                to: to_id.clone(),
                delivered: awake,
                broadcast,
                from_inbox: false,
                preview: clip(body, 240),
            },
        );
    }
    receipts.join("\n")
}

/// Whether this card has spent its minute, and how long is left of it.
fn throttled(relays: &Relays, caller: &str) -> Option<u64> {
    let now = Instant::now();
    let mut recent = relays.recent.lock().unwrap();
    let times = recent.entry(caller.to_string()).or_default();
    times.retain(|t| now.duration_since(*t) < SEND_WINDOW);
    if times.len() >= MAX_SENDS {
        let oldest = times[0];
        return Some((SEND_WINDOW - now.duration_since(oldest)).as_secs() + 1);
    }
    times.push(now);
    None
}

/// Mark a card as acting inside a chain, so what it sends next is counted.
fn arm(relays: &Relays, app: &AppHandle, to_id: &str, chain: &str, hops: i64) {
    let mid_turn = app
        .state::<crate::supervisor::Supervisor>()
        .liveness(to_id)
        .1;
    let mut inbound = relays.inbound.lock().unwrap();
    let entry = inbound.entry(to_id.to_string()).or_insert(Inbound {
        chain: chain.to_string(),
        hops,
        pending: 0,
    });
    entry.chain = chain.to_string();
    entry.hops = hops;
    /* See `Inbound::pending`: a message written while a turn is running is
       queued behind it by the CLI, so that turn's close is not ours. */
    entry.pending += if mid_turn { 2 } else { 1 };
}

/// A turn ended on this card. Called from `supervisor::persist_turn`, which is
/// the one place both boundaries of a turn already go through.
pub fn turn_closed(app: &AppHandle, id: &str) {
    let Some(relays) = app.try_state::<Relays>() else {
        return;
    };
    let mut inbound = relays.inbound.lock().unwrap();
    let done = match inbound.get_mut(id) {
        Some(i) => {
            i.pending = i.pending.saturating_sub(1);
            i.pending == 0
        }
        None => false,
    };
    if done {
        inbound.remove(id);
    }
}

/// Hand a woken card what was written to it while it slept.
///
/// Called from `spawn_conversation`, which is the one line both `wake` and
/// `open` reach — the same argument the `kind` lookup there makes. Ordered
/// oldest first and written before anything else, so a card woken by a prompt
/// you typed reads its post before your instruction, which is the order the two
/// actually happened in.
pub fn drain_inbox(app: &AppHandle, id: &str) {
    let Some(store) = app.try_state::<Store>() else {
        return;
    };
    let queued = {
        let Ok(conn) = store.0.lock() else { return };
        crate::store::inbox(&conn, id).unwrap_or_default()
    };
    if queued.is_empty() {
        return;
    }
    for q in queued {
        let from = {
            let Ok(conn) = store.0.lock() else { return };
            crate::store::roster_one(&conn, &q.from_id)
        };
        /* The sender has been closed since. The message still stands — it was
           true when it was written — so it is delivered under the handle it
           was sent from rather than dropped. */
        let text = match &from {
            Some(row) => envelope(row, &q.body),
            None => format!(
                "{RELAY_MARK} from a card that has since been closed ({}) —\n\n{}",
                handle_of(&q.from_id),
                q.body
            ),
        };
        if crate::supervisor::deliver(app, id, &text).is_ok() {
            if let Ok(conn) = store.0.lock() {
                crate::store::mark_delivered(&conn, &q.id);
            }
            if let Some(relays) = app.try_state::<Relays>() {
                arm(&relays, app, id, &q.chain, q.hops);
            }
            let _ = app.emit(
                "relay:sent",
                RelaySent {
                    id: q.id.clone(),
                    from: q.from_id.clone(),
                    to: id.to_string(),
                    delivered: true,
                    broadcast: false,
                    from_inbox: true,
                    preview: clip(&q.body, 240),
                },
            );
        }
    }
}

/// Route a `tools/call` that is not a question.
///
/// `ask.rs` owns the transport and knows nothing about what a roster is; this
/// is where a tool name becomes an answer. Returns `None` for a name neither
/// file claims, so the caller can say so rather than parking on it.
pub fn handle(app: &AppHandle, conversation_id: &str, tool: &str, args: &Value) -> Option<String> {
    match tool {
        LIST_TOOL => Some(do_list(app, conversation_id, args)),
        SEND_TOOL => Some(do_send(app, conversation_id, args)),
        _ => None,
    }
}

/* ── the control surface's way in ─────────────────────────────────────────
 *
 * Driving the tools by hand, so `wall.test.ts` can exercise a send without an
 * agent taking a turn to make one — the same seam `rouse` and `broadcast` are
 * driven through, and the ops call the shipped path rather than a copy of it.
 *
 * **`relay_send` goes through `off_main`, and the reason is the pipe.** A
 * `#[tauri::command]` without `async` runs inline on the thread that drains the
 * event-loop queue, so anything that parks there stops every card on the wall
 * from being painted for as long as it parks (see the rule in CLAUDE.md). A
 * write to a child's stdin is microseconds until the child stops reading it, at
 * which point the pipe fills and the write blocks — and a broadcast is one of
 * those per card on the wall, each made while `deliver` holds the supervisor's
 * map. `send_prompt` has always had the narrow version of this hazard; what is
 * new is that an agent can now reach it N times in one call.
 *
 * `relay_roster` follows it off the main thread for uniformity rather than out
 * of need — it is two queries — and the honest note is that if it ever stops
 * being two queries, this is already the right place for it.
 *
 * The tools themselves need none of this: they are answered on the ask server's
 * own per-request thread, which is where the parking `ask_user` does already
 * happens.
 */

#[tauri::command]
pub async fn relay_roster(
    app: AppHandle,
    id: String,
    scope: Option<String>,
) -> Result<Value, String> {
    let out = crate::off_main(move || {
        let args = json!({ "scope": scope.unwrap_or_else(|| "project".into()) });
        do_list(&app, &id, &args)
    })
    .await?;
    serde_json::from_str(&out).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn relay_send(
    app: AppHandle,
    id: String,
    to: Value,
    message: String,
) -> Result<String, String> {
    crate::off_main(move || do_send(&app, &id, &json!({ "to": to, "message": message }))).await
}

/// Every card's undelivered count, for the wall's inbox marks on restore.
#[tauri::command]
pub fn relay_inboxes(store: State<'_, Store>) -> Result<Value, String> {
    let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
    let counts: HashMap<String, i64> = crate::store::inbox_counts(&conn).into_iter().collect();
    serde_json::to_value(counts).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, title: &str, project: &str, kind: &str) -> RosterRow {
        RosterRow {
            id: id.into(),
            title: title.into(),
            project: project.into(),
            project_id: project.into(),
            cwd: format!("C:/{project}"),
            worktree: None,
            kind: kind.into(),
            last_turn_at: None,
            inbox: 0,
        }
    }

    fn wall() -> Vec<RosterRow> {
        vec![
            row("aaaaaaaa-1111-4111-8111-111111111111", "store schema", "skein", "project"),
            row("bbbbbbbb-2222-4222-8222-222222222222", "transcript", "skein", "project"),
            row("cccccccc-3333-4333-8333-333333333333", "asset dxf", "assets", "project"),
            row("dddddddd-4444-4444-8444-444444444444", "reading", "chat", "chat"),
        ]
    }

    #[test]
    fn a_handle_is_the_head_of_the_id() {
        assert_eq!(handle_of("aaaaaaaa-1111-4111-8111-111111111111"), "aaaaaaaa");
    }

    #[test]
    fn a_card_answers_to_its_handle_its_id_and_its_title() {
        let w = wall();
        let want = &w[0].id;
        assert_eq!(&resolve(&w, "aaaaaaaa").unwrap().id, want);
        assert_eq!(&resolve(&w, want).unwrap().id, want);
        assert_eq!(&resolve(&w, "store schema").unwrap().id, want);
        // A title is what an agent reaches for first, so it is matched loosely.
        assert_eq!(&resolve(&w, "  Store Schema ").unwrap().id, want);
    }

    /// Guessing between two cards with the same name would put a message in the
    /// wrong repository, silently. Titles are generated and collide often.
    #[test]
    fn an_ambiguous_title_is_refused_by_name() {
        let mut w = wall();
        w[1].title = "store schema".into();
        let e = resolve(&w, "store schema").unwrap_err();
        assert!(e.contains("aaaaaaaa") && e.contains("bbbbbbbb"), "{e}");
    }

    #[test]
    fn an_unknown_address_says_how_to_find_a_real_one() {
        let e = resolve(&wall(), "nobody").unwrap_err();
        assert!(e.contains("list"), "{e}");
    }

    #[test]
    fn project_reaches_the_rest_of_your_project_and_nothing_else() {
        let w = wall();
        let (ids, broadcast) = targets(&w, &w[0].id, &json!("project")).unwrap();
        assert!(broadcast);
        assert_eq!(ids, vec![w[1].id.clone()]);
    }

    #[test]
    fn skein_reaches_every_project() {
        let w = wall();
        let (ids, _) = targets(&w, &w[0].id, &json!("skein")).unwrap();
        assert_eq!(ids, vec![w[1].id.clone(), w[2].id.clone()]);
    }

    /// A chat card has no repository to be coordinated about, so an
    /// announcement to the wall is a turn it spends on nothing. Addressed by
    /// name it still receives — that is a question somebody meant to ask.
    #[test]
    fn a_broadcast_passes_over_chat_cards_and_a_named_send_does_not() {
        let w = wall();
        let (ids, _) = targets(&w, &w[0].id, &json!("skein")).unwrap();
        assert!(!ids.contains(&w[3].id));
        let (named, _) = targets(&w, &w[0].id, &json!("reading")).unwrap();
        assert_eq!(named, vec![w[3].id.clone()]);
    }

    #[test]
    fn several_recipients_are_one_call_and_are_not_repeated() {
        let w = wall();
        let (ids, broadcast) =
            targets(&w, &w[0].id, &json!(["transcript", "bbbbbbbb", "asset dxf"])).unwrap();
        assert!(!broadcast);
        assert_eq!(ids, vec![w[1].id.clone(), w[2].id.clone()]);
    }

    /// Talking to yourself is a send that should have been a thought, and in a
    /// broadcast it would be a card handing itself a turn forever.
    #[test]
    fn a_card_is_never_a_recipient_of_its_own_message() {
        let w = wall();
        assert!(targets(&w, &w[0].id, &json!("store schema")).unwrap().0.is_empty());
        let (ids, _) = targets(&w, &w[0].id, &json!("skein")).unwrap();
        assert!(!ids.contains(&w[0].id));
    }

    #[test]
    fn the_envelope_names_the_sender_and_says_it_is_not_the_user() {
        let e = envelope(&wall()[0], "rebase before you touch store.rs");
        assert!(e.starts_with(RELAY_MARK));
        assert!(e.contains("\"store schema\""));
        assert!(e.contains("(aaaaaaaa)"));
        assert!(e.contains("rebase before you touch store.rs"));
        assert!(e.contains("not from the user"));
    }

    /// The front end reads the name out of a quoted field, so a quote in a
    /// title would end it early and the cap would name half a card.
    #[test]
    fn a_quote_in_a_title_cannot_break_the_envelope() {
        let mut r = wall()[0].clone();
        r.title = "the \"good\" one".into();
        let e = envelope(&r, "hello");
        assert!(e.contains("\"the 'good' one\""), "{e}");
        assert_eq!(e.matches('"').count(), 2);
    }

    #[test]
    fn an_overlong_message_is_clipped_rather_than_refused() {
        let long = "x".repeat(MAX_BODY + 500);
        let e = envelope(&wall()[0], &long);
        assert!(e.contains("truncated by skein"));
        assert!(e.matches('x').count() == MAX_BODY);
    }

    #[test]
    fn the_rate_limit_lets_six_through_and_then_says_how_long_to_wait() {
        let relays = Relays::default();
        for _ in 0..MAX_SENDS {
            assert!(throttled(&relays, "a").is_none());
        }
        let wait = throttled(&relays, "a").expect("the seventh is refused");
        assert!(wait > 0 && wait <= SEND_WINDOW.as_secs() + 1);
        // Per card, not per wall — one busy card must not silence another.
        assert!(throttled(&relays, "b").is_none());
    }

    #[test]
    fn a_list_with_nobody_in_it_is_an_error_rather_than_an_empty_send() {
        assert!(targets(&wall(), "aaaaaaaa", &json!([])).is_err());
        assert!(targets(&wall(), "aaaaaaaa", &json!(7)).is_err());
    }

    #[test]
    fn both_tools_advertise_what_they_take() {
        let l = list_schema();
        assert_eq!(l["name"], LIST_TOOL);
        assert_eq!(l["inputSchema"]["properties"]["scope"]["enum"][0], "project");
        // Scope is optional: the default is the answer nearly every agent wants,
        // and a required field would refuse the call that just asks.
        assert!(l["inputSchema"]["required"].is_null());

        let s = send_schema();
        assert_eq!(s["name"], SEND_TOOL);
        assert_eq!(s["inputSchema"]["required"], json!(["to", "message"]));
        // Several recipients in one call, which is what makes a broadcast one
        // send rather than N against the rate limit.
        assert!(s["inputSchema"]["properties"]["to"]["anyOf"][1]["items"].is_object());
    }
}
