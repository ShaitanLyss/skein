//! A card putting a card on the wall.
//!
//! This wall's whole thesis is that concurrent conversations are the unit of
//! work, and until now only *you* could start one. An agent that has decomposed
//! a job into four independent pieces has one move: do them one after another in
//! its own context, or spawn subagents that live inside its turn, report back
//! through it, and vanish. Neither is a card. Neither can be looked at, talked
//! to, sent a message, or left running while you go and read something else.
//!
//! So `spawn` — and it is the most consequential tool on this server, which is
//! what most of this file is about.
//!
//! ### What it deliberately cannot do
//!
//! A project card spawns with `--dangerously-skip-permissions`. A tool that let
//! an agent choose *where* a new one of those stands by writing a path would be
//! a tool that lets a model pick a directory and be handed the machine in it —
//! and the path would arrive through whatever the agent has been reading all
//! turn. So:
//!
//! - **The child stands on the wall.** Either where the parent stands, which is
//!   the default and no argument at all, or in one of the wall's own
//!   territories, named. Not a subdirectory, not a sibling, and never a path the
//!   caller writes: `project` is matched against `store::projects` and a needle
//!   that matches nothing is refused with the list of what would have. The bound
//!   that cannot be argued around is no longer "the parent's cwd" but **the
//!   user's own declaration of where they work here** — a territory is on the
//!   wall because they opened it and stays until they forget it, so the set of
//!   reachable directories is a thing they curated rather than a thing a model
//!   composed. It buys the case the whole wall is for: a card in `atelier` that
//!   has worked out what `nova` and `caravan` each need can open a card in each,
//!   rather than describing the work and waiting to be asked.
//! - **A chat card may not spawn at all.** It reaches nothing on this machine on
//!   purpose (`.claude/rules/chat.md`), and a chat card opening a project card
//!   would be a line from the open web to a shell — the same hole `relay.rs`
//!   refuses `send` and `list` to close, one layer further up. Decided by asking
//!   the store what kind of card the caller is, never by trusting the caller,
//!   which is the rule `spawn_conversation` already follows.
//! - **One generation.** A card an agent opened may not open one of its own.
//!   This is the guard that matters and it is `relay.rs`'s reasoning exactly:
//!   the **branching** is the problem rather than the depth, so a depth counter
//!   is the wrong instrument. Four children each spawning four is sixteen agents
//!   on one prompt, and then sixty-four, and the wall's own hop limit cannot see
//!   it because every spawn is a first.
//!
//! ### And what it cannot help doing
//!
//! It costs money without asking. That is true of `send` too, and of a
//! broadcast, and the answer here is the same one: bound it, make it visible,
//! and say what it cost in the receipt. Four live children per parent, six
//! spawns an hour, and every spawned card is *a card* — it is on the wall, it
//! has a title, it turns up in `list`, the perf meter names it, and closing it
//! is the same gesture as closing any other. Nothing about it is hidden, which
//! is the difference between this and a subagent.
//!
//! ### Rust decides; the wall opens
//!
//! `Skein.#openIn` is the one correct way a card comes into being — ensure the
//! project, write the row *before* the spawn so `spawn_conversation` can ask the
//! store what kind of card it is, resolve the account off the waterfall, mint
//! the `Conversation`, load its history. Reproducing any of that here would be a
//! second birth path, and the one that drifts is the one nobody is looking at.
//!
//! So this checks the guards, mints the id, records the parentage, and emits.
//! **Minting the id here is what makes the receipt useful**: the agent is handed
//! the child's handle in the same call, so it can `send` to it or `recall` it
//! without a round of `list` and a guess about which card is new.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::store::Store;

pub const SPAWN_TOOL: &str = "spawn";

/// How many of one card's children may be on the wall at once.
const MAX_LIVE: i64 = 4;

/// How many spawns one card may ask for in an hour, drawn or not — see
/// `store::live_children_of` on why both bounds exist.
const MAX_PER_HOUR: i64 = 6;
const HOUR_MS: i64 = 60 * 60 * 1_000;

const MAX_PROMPT: usize = 4_000;
const MAX_TITLE: usize = 80;

#[derive(Clone, Serialize)]
struct SpawnAsked {
    /// The id the wall must use, so the handle in the receipt is the handle of
    /// the card that appears.
    id: String,
    parent_id: String,
    /// Where the child stands: the parent's own directory, or the root of a
    /// territory the parent named — resolved here against `store::projects`,
    /// never a string the caller wrote. See the module note.
    cwd: String,
    /// Its first turn.
    prompt: String,
    /// What to call it until it has named itself, or null.
    title: Option<String>,
}

pub fn spawn_schema() -> Value {
    json!({
        "name": SPAWN_TOOL,
        "description":
            "Open another conversation on this Skein wall and give it a piece of work. It \
             becomes a real card beside yours: the user can watch it, read it, talk to it, \
             and you can `send` to it or `recall` it by the handle this returns.\n\n\
             **This is not a subagent.** A subagent lives inside your turn, reports through \
             you and disappears; a card outlives your turn, has its own context and its own \
             transcript, and is still there tomorrow. Use `Agent` for work whose *answer* you \
             need in order to carry on. Use this for work that is genuinely a separate job — \
             a second feature, a long migration, an investigation that should not be \
             interleaved with yours.\n\n\
             It costs the user money and attention without asking, so treat it as you would \
             a broadcast. **Tell them you are opening a card, and why, before or in the same \
             reply.** Two or three is a decomposition; eight is a fan-out nobody asked for.\n\n\
             By default the new card stands in this conversation's own working directory. \
             `project` stands it in another of the wall's territories instead — one the user \
             has already opened here, named as `list` names it — so a card that has worked \
             out what two other repositories each need can open a card in each. You cannot \
             point it at an arbitrary path, only at somewhere already on this wall, and a \
             card you open cannot open cards of its own.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description":
                        "The whole of what the new conversation gets. It shares your \
                         repository and nothing else — not your context, not what the user \
                         told you, not what you have worked out — so write it as a brief to \
                         somebody who has just walked in: what to do, which files, what \
                         'done' looks like, and anything you have already ruled out. A \
                         one-line prompt spends a whole card rediscovering what you \
                         already know."
                },
                "project": {
                    "type": "string",
                    "description":
                        "Optional. Which of the wall's territories the card stands in — a \
                         project name exactly as `list` reports it ('nova', 'caravan'), or \
                         its full root path. Omit it and the card stands where you do, which \
                         is the usual case; name one when the work genuinely belongs to \
                         another repository, and remember the card that arrives there knows \
                         only what your brief tells it. It must be a project the user has \
                         already opened on this wall: an arbitrary directory is refused, and \
                         so is a name that matches nothing — which is answered with the list \
                         of what is here."
                },
                "title": {
                    "type": "string",
                    "description":
                        "Optional. What to call the card until it names itself — a few \
                         words, so the user can tell your cards apart at a glance on the \
                         wall."
                }
            },
            "required": ["prompt"]
        }
    })
}

/// Where a `project` argument says the child stands, decided against the wall's
/// own territories rather than against the filesystem.
///
/// `There` carries an index into the list it was resolved against, so the
/// caller of this keeps the one `ProjectRow` and nothing is looked up twice.
#[derive(Debug, PartialEq)]
enum Standing {
    /// Nothing was named, or what was named is the territory the caller already
    /// stands in — the same answer either way, and it keeps the parent's own
    /// `cwd` rather than the project root, so a card in a worktree opens one
    /// beside it instead of one in the main tree.
    Here,
    There(usize),
    /// Nothing on the wall goes by that.
    Unknown,
    /// More than one does. Refused rather than guessed: two territories can
    /// share a directory name (`C:\dev\nova`, `D:\archive\nova`) since only the
    /// root path is unique, and picking the first would put a card in the wrong
    /// repository with the machine in its hands.
    Ambiguous,
}

/// One path as another path, for comparing. Separators folded and case dropped
/// because this is a Windows-first wall and `C:\atelier\skein` is not a second
/// project from `c:/atelier/skein/`.
fn tidy(p: &str) -> String {
    p.trim().replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn standing(wall: &[crate::store::ProjectRow], home: &str, asked: &str) -> Standing {
    let asked = asked.trim();
    if asked.is_empty() {
        return Standing::Here;
    }
    /* By root path first, which is unique, so a caller that has the full path
       from `list` never trips the ambiguity below. */
    let found = match wall.iter().position(|p| tidy(&p.root_path) == tidy(asked)) {
        Some(i) => i,
        None => {
            let wanted = asked.to_lowercase();
            let mut hits = wall
                .iter()
                .enumerate()
                .filter(|(_, p)| p.name.trim().to_lowercase() == wanted);
            match (hits.next(), hits.next()) {
                (Some((i, _)), None) => i,
                (Some(_), Some(_)) => return Standing::Ambiguous,
                _ => return Standing::Unknown,
            }
        }
    };
    if wall[found].id == home {
        Standing::Here
    } else {
        Standing::There(found)
    }
}

/// What the wall holds, said back to a caller that named something else. A
/// refusal that lists the alternatives is one an agent can act on; `MAX_HOPS`'
/// lesson, which is the reason every refusal in this file carries its reasoning.
fn offer(wall: &[crate::store::ProjectRow]) -> String {
    if wall.is_empty() {
        return "nothing".into();
    }
    wall.iter()
        .map(|p| format!("{} ({})", p.name, p.root_path))
        .collect::<Vec<_>>()
        .join(", ")
}

/// A directory of Skein's own rather than a project of the user's.
///
/// Chat cards need *an* address and get a folder beside the database
/// (`store::chat_home`), and `#openIn` makes a `project` row of it like any
/// other directory — so it is in the table without ever having been a territory
/// anybody declared. Standing a card that carries
/// `--dangerously-skip-permissions` in Skein's own state directory is not
/// something to make nameable by accident.
fn is_skeins_own(root: &str, data_dir: &std::path::Path) -> bool {
    let base = tidy(&data_dir.to_string_lossy());
    let root = tidy(root);
    root == base || root.starts_with(&format!("{base}/"))
}

fn do_spawn(app: &AppHandle, caller: &str, args: &Value) -> String {
    let Some(prompt) = args.get("prompt").and_then(Value::as_str).map(str::trim) else {
        return "no `prompt` was given, so no card was opened".into();
    };
    if prompt.is_empty() {
        return "the prompt was empty — a card opened with nothing to do is a process and \
                an API turn spent on nothing, so none was opened"
            .into();
    }
    let prompt = clip(prompt, MAX_PROMPT);
    let title = args
        .get("title")
        .and_then(Value::as_str)
        .map(|t| clip(t.trim(), MAX_TITLE))
        .filter(|t| !t.is_empty());

    let Some(store) = app.try_state::<Store>() else {
        return "the store is unavailable".into();
    };
    let Ok(conn) = store.0.lock() else {
        return "the store is unavailable".into();
    };

    /* Asked of the store, never of the caller — `spawn_conversation`'s rule, and
       the one that keeps a capability from travelling as an argument. */
    let Some(me) = crate::store::roster_one(&conn, caller) else {
        return "this card is not on the wall, so it has nowhere to open another".into();
    };
    if me.kind == "chat" {
        return "this is a chat card: it stands outside the wall's projects and reaches \
                nothing on this machine, so it cannot open a card that would. Tell the \
                user what you would have opened and let them do it."
            .into();
    }
    if crate::store::was_spawned(&conn, caller) {
        /* The guard that matters. Said with its reasoning, because an agent told
           only "no" tries a different phrasing — `MAX_HOPS`' lesson. */
        return "this card was itself opened by another conversation, and a card opened \
                that way may not open more — four cards each opening four is sixteen \
                agents on one prompt, which is the thing this limit exists to stop. Do \
                the work here, or tell the user what else needs its own card."
            .into();
    }
    let live = crate::store::live_children_of(&conn, caller);
    if live >= MAX_LIVE {
        return format!(
            "this card already has {live} conversations of its own open on the wall, which \
             is the limit. Wait for one to finish, or tell the user which of them should be \
             closed."
        );
    }
    let recent = crate::store::spawns_since(&conn, caller, crate::store::now() - HOUR_MS);
    if recent >= MAX_PER_HOUR {
        return format!(
            "this card has opened {recent} conversations in the last hour, which is the \
             limit — that is the shape of a fan-out rather than of decomposing a job. Stop, \
             and tell the user what you were about to open and why."
        );
    }

    /* Read whether or not anything was named, because a refusal has to be able
       to say what would have worked. Skein's own directories are dropped here
       rather than in the query: what makes them not a territory is that nobody
       declared them, which is knowledge about where the database lives and not
       something SQL can see. */
    let wall: Vec<crate::store::ProjectRow> = match crate::store::projects(&conn) {
        Ok(ps) => ps
            .into_iter()
            .filter(|p| !is_skeins_own(&p.root_path, &store.1))
            .collect(),
        Err(e) => return format!("could not read the wall's projects: {e}"),
    };
    let asked = args.get("project").and_then(Value::as_str).unwrap_or("");
    /* Resolved before the id is minted and the spawn recorded, so a misnamed
       project costs nothing against the hourly bound — an agent correcting a
       name is not an agent fanning out. */
    let (cwd, elsewhere) = match standing(&wall, &me.project_id, asked) {
        Standing::Here => (me.cwd.clone(), None),
        Standing::There(i) => (wall[i].root_path.clone(), Some(wall[i].name.clone())),
        Standing::Unknown => {
            return format!(
                "there is no project called {asked:?} on this wall, so no card was opened. \
                 What is here: {}. Name one of those exactly, or leave `project` out to open \
                 the card where you stand. A directory that is not a territory on the wall \
                 cannot be named at all — if the work belongs somewhere the user has not \
                 opened here, tell them that instead of trying another path.",
                offer(&wall)
            );
        }
        Standing::Ambiguous => {
            return format!(
                "more than one project on this wall is called {asked:?}, so nothing was \
                 picked rather than the wrong one — name the one you mean by its full root \
                 path. What is here: {}.",
                offer(&wall)
            );
        }
    };

    let id = crate::store::uuid_v4();
    /* Recorded before the emit, so the one-generation guard is true of the child
       from the moment it exists rather than from whenever the wall gets round to
       drawing it. `set_mid_turn`'s shape again: bookkeeping about what something
       *is* must not wait for the thing to finish arriving. */
    if let Err(e) = crate::store::record_spawn(&conn, &id, caller) {
        return format!("could not open a card: {e}");
    }
    drop(conn);

    let _ = app.emit(
        "spawn:asked",
        SpawnAsked {
            id: id.clone(),
            parent_id: caller.to_string(),
            cwd: cwd.clone(),
            prompt,
            title: title.clone(),
        },
    );

    let handle = crate::relay::handle_of(&id);
    let called = match &title {
        Some(t) => format!(" It is called {t:?} until it names itself."),
        None => " It will name itself from its first turn.".into(),
    };
    match elsewhere {
        None => format!(
            "opening a card in {cwd} — its handle is {handle}. It has the brief you wrote and \
             nothing else of yours. Tell the user you have opened it and what for. You can \
             `send` to it or `recall` it by that handle; it will not appear in `list` until \
             its process is up, which takes a moment.{called}"
        ),
        /* Said differently on purpose. A card in another repository is the one
           case where "it has the brief and nothing else" costs something real:
           it cannot read the file you were looking at, so anything it needed
           from here was either in the brief or is gone. And it is outside the
           caller's project, so the default `list` will not show it — being told
           that here saves a round of looking for a card that is standing right
           where it was asked to. */
        Some(name) => format!(
            "opening a card in the {name} project, at {cwd} — its handle is {handle}. It has \
             the brief you wrote and nothing else of yours, and it stands in a different \
             repository from this one, so whatever it needs to know about *this* one had to \
             be in the brief. Tell the user you have opened it, where, and what for. You can \
             `send` to it or `recall` it by that handle; it will not appear in `list` until \
             its process is up, and then only under `scope: \"skein\"`, since it is not in \
             your project.{called}"
        ),
    }
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

pub fn handle(app: &AppHandle, conversation_id: &str, tool: &str, args: &Value) -> Option<String> {
    (tool == SPAWN_TOOL).then(|| do_spawn(app, conversation_id, args))
}

/// The whole wall's parentage, for the roots to be drawn from — `[child,
/// parent]` per pair, both ends still open.
///
/// Asked once at launch and then never again: a spawn *emits*, so the wall
/// learns about a new root from `spawn:asked` rather than by asking. That is the
/// same bargain every other table on this server strikes with the front end, and
/// the reason `Lineage.svelte` has no poll in it.
#[tauri::command]
pub fn lineage(app: AppHandle) -> Result<Vec<[String; 2]>, String> {
    let store = app.state::<Store>();
    let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
    Ok(crate::store::lineage(&conn)?
        .into_iter()
        .map(|(child, parent)| [child, parent])
        .collect())
}

/// Who opened this card, for the wall to draw. `None` for one you opened
/// yourself, which is nearly all of them.
#[tauri::command]
pub fn spawned_by(app: AppHandle, id: String) -> Result<Option<String>, String> {
    let store = app.state::<Store>();
    let conn = store.0.lock().map_err(|_| "the store is unavailable")?;
    Ok(crate::store::spawner_of(&conn, &id))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three things an agent has to understand before calling this, all of
    /// which are in the description because there is nowhere else to put them.
    #[test]
    fn the_tool_draws_the_line_against_a_subagent() {
        let s = spawn_schema();
        assert_eq!(s["name"], SPAWN_TOOL);
        let d = s["description"].as_str().unwrap();
        /* Without this an agent reaches for it where `Agent` was wanted, and
           leaves cards on the wall for work it needed the answer to. */
        assert!(d.contains("not a subagent"), "{d}");
        assert!(d.contains("`Agent`"), "{d}");
        /* Without this it opens one without saying so, which is the one thing
           that must not be quiet — it spends the user's money. */
        assert!(d.contains("Tell them"), "{d}");
        /* And the bound it cannot argue around — which is no longer "here" but
           "somewhere already on this wall". An agent that does not read that as
           a bound reads `project` as a path argument and writes one. */
        assert!(d.contains("cannot point it at an arbitrary path"), "{d}");
        assert!(d.contains("already on this wall"), "{d}");
    }

    /// Naming another territory is the point of the argument, and naming the one
    /// you are in is not an error — it is the default said out loud.
    #[test]
    fn the_project_field_offers_the_wall_and_refuses_a_path() {
        let d = spawn_schema()["inputSchema"]["properties"]["project"]["description"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(d.contains("already opened on this wall"), "{d}");
        assert!(d.contains("arbitrary directory is refused"), "{d}");
        /* Omitting it has to read as the normal case, or every spawn arrives
           carrying a project it did not need to name. */
        assert!(d.contains("Omit it and the card stands where you do"), "{d}");
    }

    fn wall() -> Vec<crate::store::ProjectRow> {
        vec![
            row("p-atelier", "atelier", r"C:\atelier"),
            row("p-caravan", "caravan", r"C:\dev\caravan"),
            row("p-nova", "nova", r"C:\dev\nova"),
            row("p-old-nova", "nova", r"D:\archive\nova"),
            row("p-skein", "skein", r"C:\atelier\skein"),
        ]
    }

    fn row(id: &str, name: &str, root: &str) -> crate::store::ProjectRow {
        crate::store::ProjectRow {
            id: id.into(),
            name: name.into(),
            root_path: root.into(),
        }
    }

    /// The whole of the new argument: a card in one territory naming another.
    #[test]
    fn a_named_territory_is_the_one_it_names() {
        let w = wall();
        assert_eq!(standing(&w, "p-atelier", "caravan"), Standing::There(1));
        assert_eq!(standing(&w, "p-atelier", "skein"), Standing::There(4));
        /* Case and separators folded — a model typing a path back at us from
           `list` should not depend on which slash it chose. */
        assert_eq!(standing(&w, "p-atelier", "Caravan"), Standing::There(1));
        assert_eq!(standing(&w, "p-atelier", "c:/dev/caravan/"), Standing::There(1));
    }

    /// No argument and your own project are the same answer, and it is the
    /// parent's `cwd` rather than the project root — see `Standing::Here`.
    #[test]
    fn your_own_project_is_where_you_already_stand() {
        let w = wall();
        assert_eq!(standing(&w, "p-atelier", ""), Standing::Here);
        assert_eq!(standing(&w, "p-atelier", "   "), Standing::Here);
        assert_eq!(standing(&w, "p-atelier", "atelier"), Standing::Here);
        assert_eq!(standing(&w, "p-atelier", r"C:\atelier"), Standing::Here);
    }

    /// The bound. A path the caller composed is not a territory, and being a
    /// *subdirectory* of one is exactly the shape a model reaches for first.
    #[test]
    fn a_path_that_is_not_a_territory_is_nobody() {
        let w = wall();
        assert_eq!(standing(&w, "p-atelier", r"C:\atelier\skein\src-tauri"), Standing::Unknown);
        assert_eq!(standing(&w, "p-atelier", r"C:\Windows\System32"), Standing::Unknown);
        /* And a near miss is a miss: the name is what `list` says, not a
           description of it. */
        assert_eq!(standing(&w, "p-atelier", "the nova repo"), Standing::Unknown);
    }

    /// Only `root_path` is unique, so two territories can share a name — and
    /// picking the first would open a card with the machine in its hands in the
    /// wrong repository. The full path is the way out and the refusal says so.
    #[test]
    fn one_name_over_two_territories_picks_neither() {
        let w = wall();
        assert_eq!(standing(&w, "p-atelier", "nova"), Standing::Ambiguous);
        assert_eq!(standing(&w, "p-atelier", r"D:\archive\nova"), Standing::There(3));
        assert!(offer(&w).contains(r"D:\archive\nova"), "the refusal has to carry the paths");
    }

    /// Chat cards' address is a folder beside the database, and `#openIn` writes
    /// a project row for it like any other directory. It is in the table without
    /// anybody having declared it, so it is not on offer.
    #[test]
    fn skeins_own_directory_is_not_a_territory() {
        let data = std::path::PathBuf::from(r"C:\Users\a\AppData\Roaming\skein");
        assert!(is_skeins_own(r"C:\Users\a\AppData\Roaming\skein\chat", &data));
        assert!(is_skeins_own(r"c:/users/a/appdata/roaming/skein", &data));
        /* A sibling that merely starts with the same characters is somebody's
           actual repository. */
        assert!(!is_skeins_own(r"C:\Users\a\AppData\Roaming\skein-notes", &data));
        assert!(!is_skeins_own(r"C:\atelier\skein", &data));
    }

    /// The brief is the whole of what the child gets, and an agent that does not
    /// know that writes one line and spends a card rediscovering the context.
    #[test]
    fn the_prompt_field_says_it_shares_nothing() {
        let d = spawn_schema()["inputSchema"]["properties"]["prompt"]["description"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(d.contains("not your context"), "{d}");
        assert!(d.contains("somebody who has just walked in"), "{d}");
    }

    /// Branching, not depth — see the module note. Both bounds are needed and
    /// the product of them is what a runaway would cost before it was stopped.
    #[test]
    fn the_bounds_are_a_decomposition_rather_than_a_fan_out() {
        assert_eq!(MAX_LIVE, 4);
        assert_eq!(MAX_PER_HOUR, 6);
        /* One generation only, so this is the whole of it rather than the first
           term of a series. */
        assert!(MAX_LIVE * MAX_LIVE > MAX_PER_HOUR, "why the generation guard is not a depth");
    }
}
