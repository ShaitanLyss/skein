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
//! an agent choose *where* a new one of those stands would be a tool that lets a
//! model pick a directory and be handed the machine in it — and it would arrive
//! through whatever the agent has been reading all turn. So:
//!
//! - **The child stands where the parent stands.** Same `cwd`, same project, no
//!   argument for it. Not a subdirectory, not a sibling, not a path the caller
//!   writes. The capability a spawned card has is exactly the capability the
//!   spawning card already had, which is the only bound here that cannot be
//!   argued around.
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
    /// Where the child stands. The parent's own, always — see the module note.
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
             The new card stands in this conversation's own working directory and has exactly \
             the reach this one has — you cannot point it somewhere else, and a card you open \
             cannot open cards of its own.",
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

    let id = crate::store::uuid_v4();
    /* Recorded before the emit, so the one-generation guard is true of the child
       from the moment it exists rather than from whenever the wall gets round to
       drawing it. `set_mid_turn`'s shape again: bookkeeping about what something
       *is* must not wait for the thing to finish arriving. */
    if let Err(e) = crate::store::record_spawn(&conn, &id, caller) {
        return format!("could not open a card: {e}");
    }
    let cwd = me.cwd.clone();
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

    format!(
        "opening a card in {cwd} — its handle is {}. It has the brief you wrote and nothing \
         else of yours. Tell the user you have opened it and what for. You can `send` to it \
         or `recall` it by that handle; it will not appear in `list` until its process is up, \
         which takes a moment.{}",
        crate::relay::handle_of(&id),
        match &title {
            Some(t) => format!(" It is called {t:?} until it names itself."),
            None => " It will name itself from its first turn.".into(),
        }
    )
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
        /* And the bound it cannot argue around. */
        assert!(d.contains("cannot point it somewhere else"), "{d}");
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
