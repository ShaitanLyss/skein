//! Putting a thing on the wall, from a card.
//!
//! An agent that has made something to look at — a diagram, a screenshot, a
//! rendered chart, a frame out of a scene — has one way to hand it over today,
//! and that is to write a path in the transcript. Which means: you read the
//! line, you copy the path, you find something to open it with, and you come
//! back. Four gestures, and the thing that was made is not *on the wall* at any
//! point.
//!
//! There is a wall, and it already draws images. `pin` is the tool that reaches
//! it.
//!
//! ### Rust copies; the wall places
//!
//! The split is not arbitrary and it is the whole of this file. Copying the file
//! into the studio's own storage has to be Rust's — it is the filesystem, and
//! `import_image` already does it for the reason stated there (a reference board
//! is built up over months and must not fill with broken rectangles because you
//! tidied your downloads folder). **Sizing it cannot be Rust's**, because the
//! only thing on this machine that knows how big a PNG is without decoding one
//! is the webview: `images.svelte.ts::#measure` loads it and reads
//! `naturalWidth`. An image placed at a guessed box arrives at the wrong aspect
//! ratio, which for a diagram somebody made on purpose is the one failure worth
//! avoiding.
//!
//! So this validates and copies, and then emits. `skein.svelte.ts` places it
//! through the *same* `#place` a dropped file and a pasted screenshot go through
//! — or a pinned image and a dropped one would arrive at different sizes and in
//! different z-bands, which is exactly the note `images.svelte.ts` already has
//! on itself.
//!
//! ### It is not a widget and it is not a note
//!
//! Only images, deliberately. A pinned *text* note would want a widget kind, a
//! config, a face and a rule of its own, and the thing an agent has to say in
//! text it can already say in the transcript — where the panel renders it
//! properly. What the transcript cannot do is show you a picture beside the card
//! that made it. That is the gap, and it is the whole gap.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::store::Store;

pub const PIN_TOOL: &str = "pin";

/// How many images one card may put up in a minute.
///
/// Four. A card rendering a frame per second onto the wall is not showing you
/// anything — it is filling the studio, and every one of them is a file copied
/// into storage that somebody has to take down by hand. The wall is yours and
/// nothing here may fill it faster than you can clear it.
const MAX_PER_MINUTE: usize = 4;
const WINDOW: std::time::Duration = std::time::Duration::from_secs(60);

/// Recent pins per card, for the rate above. In memory rather than a table: it
/// is a rate over a minute, and a rate that survived a restart would be a
/// restart that cost you the wall for a minute.
#[derive(Default)]
pub struct Pins(std::sync::Mutex<std::collections::HashMap<String, Vec<std::time::Instant>>>);

/// What the wall is asked to draw. It has already been copied by the time this
/// is emitted, so the path is inside the studio's own storage and the front end
/// need not know where it came from.
#[derive(Clone, Serialize)]
struct PinAsked {
    conversation_id: String,
    /// The copy, in `references/`.
    path: String,
}

pub fn pin_schema() -> Value {
    json!({
        "name": PIN_TOOL,
        "description":
            "Put an image up on the Skein wall, beside this conversation's card, where the \
             user can see it without opening anything. For something you *made* and want \
             looked at: a diagram, a chart you rendered, a screenshot of the thing you just \
             changed, a frame out of a render.\n\n\
             **This is what to do instead of writing a path in the transcript.** A path \
             costs the user four gestures — read the line, copy it, find something to open \
             it with, come back — and at no point is the thing you made actually in front \
             of them. Pin it and it is on the wall, at its own aspect ratio, next to the \
             card that made it. Say in your reply that you have pinned it and what it \
             shows.\n\n\
             Images only, and the file must already exist on disk — write it first, then \
             pin it. For anything you want to *say* rather than show, say it: the \
             transcript renders markdown properly and is the right place for words. The \
             wall is the user's, so use this for the thing worth their eye and not for \
             every intermediate output.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description":
                        "The image file, as an absolute path or one relative to this \
                         conversation's working directory. png, jpg, gif, webp, bmp, avif \
                         or svg. It is copied into the studio's own storage, so you may \
                         delete or overwrite the original afterwards."
                }
            },
            "required": ["path"]
        }
    })
}

fn do_pin(app: &AppHandle, caller: &str, args: &Value) -> String {
    let Some(want) = args.get("path").and_then(Value::as_str).map(str::trim) else {
        return "no `path` was given, so nothing was pinned".into();
    };
    if want.is_empty() {
        return "the path was empty, so nothing was pinned".into();
    }

    let Some(store) = app.try_state::<Store>() else {
        return "the store is unavailable".into();
    };

    /* Resolved against the card's own working directory, because that is the
       directory the agent has been typing paths relative to all turn. An
       absolute path is left alone. */
    let cwd = {
        let Ok(conn) = store.0.lock() else {
            return "the store is unavailable".into();
        };
        crate::store::session_of(&conn, caller).map(|(cwd, _)| cwd)
    };
    let path = std::path::Path::new(want);
    let full = if path.is_absolute() {
        path.to_path_buf()
    } else {
        match &cwd {
            Some(dir) => std::path::Path::new(dir).join(path),
            None => path.to_path_buf(),
        }
    };
    if !full.is_file() {
        return format!(
            "there is no file at {}. Write the image first, then pin it — and if you meant \
             a path relative to somewhere other than this card's working directory, give \
             the absolute one.",
            full.display()
        );
    }

    let rate = app.state::<Pins>();
    {
        let Ok(mut recent) = rate.0.lock() else {
            return "could not check the rate".into();
        };
        let seen = recent.entry(caller.to_string()).or_default();
        let now = std::time::Instant::now();
        seen.retain(|t| now.duration_since(*t) < WINDOW);
        if seen.len() >= MAX_PER_MINUTE {
            return format!(
                "this conversation has pinned {MAX_PER_MINUTE} images in the last minute, \
                 which is the limit — the wall is the user's and nothing here may fill it \
                 faster than they can clear it. Pin the one that matters and describe the \
                 rest."
            );
        }
        seen.push(now);
    }

    let stored = match crate::store::copy_into_references(&store.1, &full) {
        Ok(p) => p,
        Err(e) => return format!("could not pin that: {e}"),
    };

    /* The wall sizes and places it — see the module note on why that cannot
       happen here. Fire and forget: if nothing is listening the copy is a file
       in storage that `sweep_references` will collect, which is a better failure
       than refusing to answer. */
    let _ = app.emit(
        "pin:asked",
        PinAsked {
            conversation_id: caller.to_string(),
            path: stored,
        },
    );
    "pinned it to the wall beside this card, at its own aspect ratio. Say what it shows — \
     an image on the wall with nothing said about it is a thing the user has to work out. \
     They can move, resize or take it down like any other reference image."
        .into()
}

pub fn handle(app: &AppHandle, conversation_id: &str, tool: &str, args: &Value) -> Option<String> {
    (tool == PIN_TOOL).then(|| do_pin(app, conversation_id, args))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tool_says_what_it_replaces_and_what_it_is_not() {
        let s = pin_schema();
        assert_eq!(s["name"], PIN_TOOL);
        let d = s["description"].as_str().unwrap();
        /* The sentence that makes it worth having: an agent that does not know
           this beats writing a path will go on writing paths. */
        assert!(d.contains("instead of writing a path"), "{d}");
        /* And the boundary, or the wall fills with renderings of prose. */
        assert!(d.contains("Images only"), "{d}");
        assert!(d.contains("transcript"), "{d}");
        /* Whose wall it is. */
        assert!(d.contains("user's"), "{d}");
    }

    #[test]
    fn the_rate_is_slower_than_a_person_can_clear() {
        assert_eq!(MAX_PER_MINUTE, 4);
        assert_eq!(WINDOW.as_secs(), 60);
    }
}
