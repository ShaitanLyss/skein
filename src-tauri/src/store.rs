//! The studio, on disk.
//!
//! Everything the wall needs to paint itself before a single process has
//! started: which projects exist, which conversations were open, where their
//! cards sat, and which dev servers should come back up.
//!
//! Two schema decisions are deliberate and worth not undoing:
//!
//! 1. `conversation.id` is a Skein UUID and `agent_session_id` is the agent's
//!    handle. Today they hold the same value, because we mint the id and hand
//!    it to `--session-id`. Keeping them as separate columns costs nothing now
//!    and is the only thing here that would be painful to change once there is
//!    real data behind it.
//!
//! 2. `file_touch` is written from the first build and read by almost nobody.
//!    It is what collision detection will need, and what the broadcast bar
//!    already uses to warn that two selected cards share a working tree.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// `.0` is the connection, `.1` the app data directory (imported reference
/// images are copied in beside the database).
pub struct Store(pub Mutex<Connection>, pub PathBuf);

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub root_path: String,
    /// Where the territory has been dragged to, if it ever has. `None` means the
    /// wall's territory grid decides — the same contract `placement` has for a
    /// card that was never pinned.
    pub x: Option<f64>,
    pub y: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ServerSpec {
    pub label: String,
    pub command: String,
    pub cwd: Option<String>,
    pub port: Option<u16>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ServerGroup {
    pub id: String,
    pub project_id: String,
    pub label: String,
    pub autostart: bool,
    pub start_order: i64,
    pub servers: Vec<ServerSpec>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StoredConversation {
    pub id: String,
    pub agent_session_id: Option<String>,
    pub project_id: String,
    pub cwd: String,
    pub title: String,
    pub worktree: Option<String>,
    pub model: Option<String>,
    pub interrupted: bool,
    pub last_ctx_frac: f64,
    pub last_ending: Option<String>,
    /// Canvas position. `None` means "let the layout place it".
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub pinned: bool,
}

/// Everything needed to paint the wall, in one round trip.
#[derive(Debug, Serialize, Clone)]
pub struct Studio {
    pub projects: Vec<Project>,
    pub conversations: Vec<StoredConversation>,
    pub server_groups: Vec<ServerGroup>,
}

impl Store {
    pub fn open(dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&dir).map_err(|e| format!("create data dir: {e}"))?;
        let conn = Connection::open(dir.join("skein.db")).map_err(|e| e.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
        migrate(&conn)?;
        Ok(Store(Mutex::new(conn), dir))
    }
}

/// Schema version. Bump it and add an arm to `migrate` for every change.
///
/// `CREATE TABLE IF NOT EXISTS` is not a migration: it silently does nothing
/// when the table already exists, so a renamed or added column never lands and
/// the next query fails against a schema that looks superficially fine. This
/// caught us once already. Every future change gets a numbered step.
const SCHEMA_VERSION: i64 = 5;

fn migrate(conn: &Connection) -> Result<(), String> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| format!("read schema version: {e}"))?;

    if version < 1 {
        migrate_v1(conn)?;
    }
    if version < 2 {
        migrate_v2(conn)?;
    }
    if version < 3 {
        migrate_v3(conn)?;
    }
    if version < 4 {
        migrate_v4(conn)?;
    }
    if version < 5 {
        migrate_v5(conn)?;
    }
    // Future changes go here as `if version < 6 { ... }`, each one an ALTER
    // rather than a CREATE, so existing databases actually move forward.

    conn.pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(|e| format!("stamp schema version: {e}"))?;
    Ok(())
}

fn migrate_v1(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS project (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            root_path   TEXT NOT NULL UNIQUE,
            created_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS server_group (
            id           TEXT PRIMARY KEY,
            project_id   TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
            label        TEXT NOT NULL,
            autostart    INTEGER NOT NULL DEFAULT 1,
            start_order  INTEGER NOT NULL DEFAULT 0,
            spec_json    TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversation (
            id                TEXT PRIMARY KEY,
            agent_session_id  TEXT,
            project_id        TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
            cwd               TEXT NOT NULL,
            title             TEXT NOT NULL DEFAULT 'untitled',
            worktree          TEXT,
            branch            TEXT,
            model             TEXT,
            effort            TEXT,
            born_at           INTEGER NOT NULL,
            closed_at         INTEGER,
            interrupted       INTEGER NOT NULL DEFAULT 0,
            last_ctx_frac     REAL NOT NULL DEFAULT 0,
            last_ending         TEXT
        );

        CREATE TABLE IF NOT EXISTS placement (
            conversation_id  TEXT PRIMARY KEY REFERENCES conversation(id) ON DELETE CASCADE,
            x                REAL NOT NULL,
            y                REAL NOT NULL,
            pinned           INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS turn (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id  TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
            ended_at         INTEGER NOT NULL,
            status_tier      TEXT NOT NULL,
            in_tokens        INTEGER NOT NULL DEFAULT 0,
            out_tokens       INTEGER NOT NULL DEFAULT 0,
            cache_tokens     INTEGER NOT NULL DEFAULT 0,
            usd              REAL NOT NULL DEFAULT 0,
            broadcast_id     TEXT
        );

        CREATE TABLE IF NOT EXISTS file_touch (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id  TEXT NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
            path             TEXT NOT NULL,
            op               TEXT NOT NULL,
            at               INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS file_touch_path ON file_touch(path);
        CREATE INDEX IF NOT EXISTS conversation_open ON conversation(closed_at);

        -- Reference images pinned to the wall. Deliberately NOT tied to a
        -- project: a reference board is personal and spans everything you are
        -- working on. Always placed by hand, so unlike a card it carries its own
        -- size and rotation and never enters the auto-layout.
        CREATE TABLE IF NOT EXISTS reference_image (
            id          TEXT PRIMARY KEY,
            path        TEXT NOT NULL,
            x           REAL NOT NULL,
            y           REAL NOT NULL,
            w           REAL NOT NULL,
            h           REAL NOT NULL,
            rotation    REAL NOT NULL DEFAULT 0,
            z           INTEGER NOT NULL DEFAULT 0,
            created_at  INTEGER NOT NULL
        );
        "#,
    )
    .map_err(|e| format!("migrate v1: {e}"))
}

/// Repair `last_ending` for conversations that spoke before it was ever written.
///
/// The front end sent `lastTier` where the command takes `last_ending`. Tauri
/// drops an unknown key, so the parameter arrived as `None`, the COALESCE kept
/// the old value, and the column stayed NULL for every turn ever taken. The
/// front end derives `everSpoke` from it, so those cards woke with
/// `--session-id` instead of `--resume` — a card with real history restarting
/// from nothing.
///
/// No schema change: the column always existed, it was just never filled. What
/// we can recover is *whether* a turn happened, from the `turn` rows that were
/// written correctly all along. How it ended is genuinely lost, so it gets
/// `'ok'` — which is exactly what `Conversation.restore` already substitutes for
/// a NULL, so this changes no card's appearance, only whether it resumes.
fn migrate_v2(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "UPDATE conversation SET last_ending = 'ok'
          WHERE last_ending IS NULL
            AND EXISTS (SELECT 1 FROM turn WHERE turn.conversation_id = conversation.id)",
        [],
    )
    .map(|_| ())
    .map_err(|e| format!("migrate v2: {e}"))
}

/// Where a territory has been put. Territories used to run along a single line
/// off the origin, so there was nothing to remember; now that one can be dragged
/// — carrying its cards with it — the wall has to come back the way it was left.
///
/// Nullable, and null is meaningful: it means the grid still places this project,
/// which is what every existing row starts as and what "tidy it back" returns it
/// to. An ALTER rather than a CREATE, per the note on `SCHEMA_VERSION`.
fn migrate_v3(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        ALTER TABLE project ADD COLUMN x REAL;
        ALTER TABLE project ADD COLUMN y REAL;
        "#,
    )
    .map_err(|e| format!("migrate v3: {e}"))
}

/// What the wall does when nobody is asking it anything: stacks of background
/// effects, saved as profiles you can switch between.
///
/// The layers are one JSON column rather than a table of layers and a table of
/// parameters. Every effect has its own knobs, and they change as the effects do
/// — a normalised schema here would mean a migration every time a slider is
/// added, to describe data that is only ever read and written whole. The front
/// end normalises whatever comes back (`ambience.ts::normalizeProfile`), which
/// is the same contract `server_group.spec_json` has.
///
/// `active` is at most one row. Which profile is showing is studio state and
/// belongs next to the profiles rather than in localStorage — unlike the
/// viewport, it is a thing you *made*, not where you happen to be looking.
fn migrate_v4(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS ambience_profile (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            layers_json TEXT NOT NULL,
            active      INTEGER NOT NULL DEFAULT 0,
            created_at  INTEGER NOT NULL
        );
        "#,
    )
    .map_err(|e| format!("migrate v4: {e}"))
}

/// Instruments hung on the wall: a clock, a reading of what the studio's own
/// processes are costing. Like a reference image and unlike a card, a widget is
/// always placed by hand and belongs to no project — it is furniture in the
/// room rather than part of the work.
///
/// `config_json` is one opaque column for the same reason `ambience_profile`'s
/// layer stack is: every kind of widget has its own knobs, a clock's variant
/// means nothing to a performance meter, and they change as the widgets do. A
/// normalised schema would be a migration per parameter, to describe data that
/// is only ever read and written whole. Rust never parses it; the front end's
/// `normalizeWidget` does, on every read.
fn migrate_v5(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS widget (
            id          TEXT PRIMARY KEY,
            kind        TEXT NOT NULL,
            x           REAL NOT NULL,
            y           REAL NOT NULL,
            w           REAL NOT NULL,
            h           REAL NOT NULL,
            z           INTEGER NOT NULL DEFAULT 0,
            config_json TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        );
        "#,
    )
    .map_err(|e| format!("migrate v5: {e}"))
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn dir_name(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(path)
        .to_string()
}

/* ── commands ─────────────────────────────────────────────────────────── */

/// Find or create the project that owns a directory. Projects are implicit:
/// pointing at a new path is all it takes to make one.
#[tauri::command]
pub fn ensure_project(store: tauri::State<'_, Store>, root_path: String) -> Result<Project, String> {
    let conn = store.0.lock().unwrap();
    let existing: Option<(String, String, Option<f64>, Option<f64>)> = conn
        .query_row(
            "SELECT id, name, x, y FROM project WHERE root_path = ?1",
            params![root_path],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    if let Some((id, name, x, y)) = existing {
        return Ok(Project { id, name, root_path, x, y });
    }

    let id = uuid_v4();
    let name = dir_name(&root_path);
    conn.execute(
        "INSERT INTO project (id, name, root_path, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, name, root_path, now()],
    )
    .map_err(|e| e.to_string())?;
    /* No position: a project arrives in the grid's hands, and the wall writes
       one back as soon as it has flowed it somewhere. */
    Ok(Project { id, name, root_path, x: None, y: None })
}

/// Where a territory sits on the wall.
///
/// `None`/`None` hands it back to the grid, which is what the territory menu's
/// "tidy it back onto the grid" does — so this is one command rather than a
/// place and a separate clear.
///
/// Only the territory is recorded here. The cards it carried are pinned by
/// `save_placement`, one call each, because that is already what a card's
/// position means and a territory drag is a drag of each of them too.
#[tauri::command]
pub fn place_project(
    store: tauri::State<'_, Store>,
    root_path: String,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    place_row(&conn, &root_path, x, y)
}

/// The write itself, so it can be tested without an app around it.
fn place_row(
    conn: &Connection,
    root_path: &str,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE project SET x = ?2, y = ?3 WHERE root_path = ?1",
        params![root_path, x, y],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn record_conversation(
    store: tauri::State<'_, Store>,
    id: String,
    project_id: String,
    cwd: String,
    worktree: Option<String>,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute(
        "INSERT OR IGNORE INTO conversation
           (id, agent_session_id, project_id, cwd, worktree, born_at)
         VALUES (?1, ?1, ?2, ?3, ?4, ?5)",
        params![id, project_id, cwd, worktree, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Take a project off the wall for good.
///
/// The counterpart to a territory outliving its last card: an empty territory
/// stays because you are likely to use it again, so there has to be a way to
/// say you are not — otherwise every folder ever opened accumulates, and a
/// wall you cannot tidy stops being a wall you read.
///
/// Refused while anything is open in it, which is the case where the territory
/// is plainly still in use. Closed conversations go with it, and so do its
/// server groups and placements, by cascade — rows, not transcripts. Those stay
/// where Claude Code wrote them and can be adopted back at any time.
#[tauri::command]
pub fn forget_project(
    store: tauri::State<'_, Store>,
    root_path: String,
) -> Result<bool, String> {
    let conn = store.0.lock().unwrap();
    forget_row(&conn, &root_path)
}

/// The refusal and the delete, so both branches can be tested without an app.
fn forget_row(conn: &Connection, root_path: &str) -> Result<bool, String> {
    let open: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM conversation c
               JOIN project p ON p.id = c.project_id
              WHERE p.root_path = ?1 AND c.closed_at IS NULL",
            params![root_path],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if open > 0 {
        return Err(format!(
            "{open} conversation{} still open there",
            if open == 1 { " is" } else { "s are" }
        ));
    }
    let gone = conn
        .execute("DELETE FROM project WHERE root_path = ?1", params![root_path])
        .map_err(|e| e.to_string())?;
    Ok(gone > 0)
}

/// Adopt a conversation Claude Code recorded, as a card on the wall.
///
/// The row is a *pointer*: the transcript stays where the CLI wrote it and
/// stays canonical, because waking this card runs `--resume` against that same
/// file — which appends to it rather than forking (probed against 2.1.228). So
/// the same session remains resumable from a terminal afterwards, with whatever
/// Skein added to it.
///
/// `last_ending` is set to `ok` rather than left NULL, and that is load-bearing
/// rather than cosmetic: `Conversation.restore` reads NULL as "never spoke",
/// and a card that never spoke wakes with `--session-id` instead of `--resume`
/// — which for an id that already has a transcript is a collision, not a fresh
/// start. We cannot know how the last turn actually ended (that lives in
/// `result` events, which are not written to the transcript), so `ok` here
/// means no more than "there is something to resume".
///
/// Re-importing an id already on the wall is an update, and one that clears
/// `closed_at`: closing a card removes it from the wall without deleting it, so
/// adoption has to be able to bring it back.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn import_conversation(
    store: tauri::State<'_, Store>,
    id: String,
    project_id: String,
    cwd: String,
    title: Option<String>,
    model: Option<String>,
    last_ctx_frac: Option<f64>,
    born_at: Option<i64>,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    import_row(
        &conn,
        &id,
        &project_id,
        &cwd,
        title.as_deref(),
        model.as_deref(),
        last_ctx_frac,
        born_at,
    )
}

/// The statement itself, so the upsert can be tested without a Tauri app.
#[allow(clippy::too_many_arguments)]
fn import_row(
    conn: &Connection,
    id: &str,
    project_id: &str,
    cwd: &str,
    title: Option<&str>,
    model: Option<&str>,
    last_ctx_frac: Option<f64>,
    born_at: Option<i64>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO conversation
           (id, agent_session_id, project_id, cwd, title, model, born_at,
            last_ctx_frac, last_ending)
         VALUES (?1, ?1, ?2, ?3, COALESCE(?4, 'untitled'), ?5, ?6,
                 COALESCE(?7, 0), 'ok')
         ON CONFLICT(id) DO UPDATE SET
           closed_at     = NULL,
           title         = COALESCE(?4, title),
           model         = COALESCE(?5, model),
           last_ctx_frac = COALESCE(?7, last_ctx_frac),
           last_ending   = COALESCE(last_ending, 'ok')",
        params![
            id,
            project_id,
            cwd,
            title,
            model,
            born_at.unwrap_or_else(now),
            last_ctx_frac
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Called as a turn settles, so a dormant card can show what it reached without
/// ever spawning the session it belonged to.
#[tauri::command]
pub fn update_conversation(
    store: tauri::State<'_, Store>,
    id: String,
    title: Option<String>,
    model: Option<String>,
    last_ctx_frac: Option<f64>,
    last_ending: Option<String>,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute(
        "UPDATE conversation SET
           title         = COALESCE(?2, title),
           model         = COALESCE(?3, model),
           last_ctx_frac = COALESCE(?4, last_ctx_frac),
           last_ending     = COALESCE(?5, last_ending)
         WHERE id = ?1",
        params![id, title, model, last_ctx_frac, last_ending],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn record_turn(
    store: tauri::State<'_, Store>,
    conversation_id: String,
    status_tier: String,
    in_tokens: i64,
    out_tokens: i64,
    cache_tokens: i64,
    usd: f64,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute(
        "INSERT INTO turn
           (conversation_id, ended_at, status_tier, in_tokens, out_tokens, cache_tokens, usd)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![conversation_id, now(), status_tier, in_tokens, out_tokens, cache_tokens, usd],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Written from day one and read by almost nobody — see the module note.
#[tauri::command]
pub fn record_file_touch(
    store: tauri::State<'_, Store>,
    conversation_id: String,
    path: String,
    op: String,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute(
        "INSERT INTO file_touch (conversation_id, path, op, at) VALUES (?1, ?2, ?3, ?4)",
        params![conversation_id, path, op, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Which other open conversations have edited the same files as this one.
/// The broadcast bar reads this to warn before a prompt fans out across a
/// shared working tree.
#[tauri::command]
pub fn overlapping_conversations(
    store: tauri::State<'_, Store>,
    conversation_id: String,
) -> Result<Vec<String>, String> {
    let conn = store.0.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT b.conversation_id
               FROM file_touch a
               JOIN file_touch b ON a.path = b.path
              WHERE a.conversation_id = ?1
                AND b.conversation_id <> ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![conversation_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_placement(
    store: tauri::State<'_, Store>,
    conversation_id: String,
    x: f64,
    y: f64,
    pinned: bool,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute(
        "INSERT INTO placement (conversation_id, x, y, pinned) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(conversation_id) DO UPDATE SET x = ?2, y = ?3, pinned = ?4",
        params![conversation_id, x, y, pinned as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn close_conversation_record(
    store: tauri::State<'_, Store>,
    id: String,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute(
        "UPDATE conversation SET closed_at = ?2 WHERE id = ?1",
        params![id, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Marks the conversations that lost a turn when the app went down. An in-flight
/// turn does not survive, and the card should say so rather than pretend it
/// finished cleanly.
///
/// Only the ones that were actually running, which is why `Supervisor::shutdown`
/// hands back its ids. `closed_at IS NULL` on its own also matches every dormant
/// card restored from a previous session and never woken — nothing was in flight
/// there, and flagging them meant a wall you had merely looked at came back with
/// every card claiming its last turn was interrupted.
pub fn mark_interrupted(conn: &Connection, ids: &[String]) {
    for id in ids {
        let _ = conn.execute(
            "UPDATE conversation SET interrupted = 1 WHERE id = ?1 AND closed_at IS NULL",
            params![id],
        );
    }
}

#[tauri::command]
pub fn save_server_group(
    store: tauri::State<'_, Store>,
    group: ServerGroup,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    let spec = serde_json::to_string(&group.servers).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO server_group (id, project_id, label, autostart, start_order, spec_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
           label = ?3, autostart = ?4, start_order = ?5, spec_json = ?6",
        params![
            group.id,
            group.project_id,
            group.label,
            group.autostart as i64,
            group.start_order,
            spec
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_server_group(store: tauri::State<'_, Store>, id: String) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute("DELETE FROM server_group WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The whole studio, in one round trip. This is what lets the wall paint
/// itself before anything has been spawned.
#[tauri::command]
pub fn load_studio(store: tauri::State<'_, Store>) -> Result<Studio, String> {
    let conn = store.0.lock().unwrap();

    let mut ps = conn
        .prepare("SELECT id, name, root_path, x, y FROM project ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let projects = ps
        .query_map([], |r| {
            Ok(Project {
                id: r.get(0)?,
                name: r.get(1)?,
                root_path: r.get(2)?,
                x: r.get(3)?,
                y: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut cs = conn
        .prepare(
            "SELECT c.id, c.agent_session_id, c.project_id, c.cwd, c.title, c.worktree,
                    c.model, c.interrupted, c.last_ctx_frac, c.last_ending,
                    p.x, p.y, p.pinned
               FROM conversation c
               LEFT JOIN placement p ON p.conversation_id = c.id
              WHERE c.closed_at IS NULL
              ORDER BY c.born_at",
        )
        .map_err(|e| e.to_string())?;
    let conversations = cs
        .query_map([], |r| {
            Ok(StoredConversation {
                id: r.get(0)?,
                agent_session_id: r.get(1)?,
                project_id: r.get(2)?,
                cwd: r.get(3)?,
                title: r.get(4)?,
                worktree: r.get(5)?,
                model: r.get(6)?,
                interrupted: r.get::<_, i64>(7)? != 0,
                last_ctx_frac: r.get(8)?,
                last_ending: r.get(9)?,
                x: r.get(10)?,
                y: r.get(11)?,
                pinned: r.get::<_, Option<i64>>(12)?.unwrap_or(0) != 0,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut gs = conn
        .prepare(
            "SELECT id, project_id, label, autostart, start_order, spec_json
               FROM server_group ORDER BY start_order",
        )
        .map_err(|e| e.to_string())?;
    let server_groups = gs
        .query_map([], |r| {
            let spec: String = r.get(5)?;
            Ok(ServerGroup {
                id: r.get(0)?,
                project_id: r.get(1)?,
                label: r.get(2)?,
                autostart: r.get::<_, i64>(3)? != 0,
                start_order: r.get(4)?,
                servers: serde_json::from_str(&spec).unwrap_or_default(),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(Studio {
        projects,
        conversations,
        server_groups,
    })
}

/* ── reference images ─────────────────────────────────────────────────── */

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RefImage {
    pub id: String,
    pub path: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub rotation: f64,
    pub z: i64,
}

const IMAGE_EXTS: [&str; 8] = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg"];

/// Copy an image into the studio's own storage and return its new home.
///
/// Deliberately a copy, not a link. A reference board is a thing you build up
/// over months; it should not quietly fill with broken rectangles because you
/// tidied your downloads folder. It also means the asset protocol can be scoped
/// to one directory instead of the whole disk.
#[tauri::command]
pub fn import_image(store: tauri::State<'_, Store>, src: String) -> Result<String, String> {
    let src_path = std::path::Path::new(&src);
    let ext = src_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !IMAGE_EXTS.contains(&ext.as_str()) {
        return Err(format!("not an image: .{ext}"));
    }

    let dir = store.1.join("references");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create references dir: {e}"))?;
    let dest = dir.join(format!("{}.{ext}", uuid_v4()));
    std::fs::copy(src_path, &dest).map_err(|e| format!("copy {src}: {e}"))?;
    Ok(dest.to_string_lossy().to_string())
}

/// Sort dropped paths into the two things the wall accepts: directories become
/// conversations, images get pinned up. Anything else is ignored rather than
/// guessed at.
#[derive(Debug, Serialize, Default)]
pub struct Dropped {
    pub dirs: Vec<String>,
    pub images: Vec<String>,
}

#[tauri::command]
pub fn classify_drop(paths: Vec<String>) -> Dropped {
    let mut out = Dropped::default();
    for p in paths {
        let path = std::path::Path::new(&p);
        if path.is_dir() {
            out.dirs.push(p);
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if IMAGE_EXTS.contains(&ext.as_str()) {
            out.images.push(p);
        }
    }
    out
}

#[tauri::command]
pub fn list_images(store: tauri::State<'_, Store>) -> Result<Vec<RefImage>, String> {
    let conn = store.0.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT id, path, x, y, w, h, rotation, z FROM reference_image ORDER BY z, created_at")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(RefImage {
                id: r.get(0)?,
                path: r.get(1)?,
                x: r.get(2)?,
                y: r.get(3)?,
                w: r.get(4)?,
                h: r.get(5)?,
                rotation: r.get(6)?,
                z: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_image(store: tauri::State<'_, Store>, image: RefImage) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute(
        "INSERT INTO reference_image (id, path, x, y, w, h, rotation, z, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
           x = ?3, y = ?4, w = ?5, h = ?6, rotation = ?7, z = ?8",
        params![
            image.id, image.path, image.x, image.y, image.w, image.h,
            image.rotation, image.z, now()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Removes the row and the copied file — since we own the copy, leaving it
/// behind would just accumulate orphans nobody can see.
#[tauri::command]
pub fn delete_image(store: tauri::State<'_, Store>, id: String) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    let path: Option<String> = conn
        .query_row(
            "SELECT path FROM reference_image WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM reference_image WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;

    /* Only ever delete inside our own references directory. */
    if let Some(p) = path {
        let owned = store.1.join("references");
        if std::path::Path::new(&p).starts_with(&owned) {
            let _ = std::fs::remove_file(p);
        }
    }
    Ok(())
}

/* ── ambience ─────────────────────────────────────────────────────────────
 *
 * See the note on `migrate_v4` for why the layers are one JSON column. Nothing
 * here understands what an effect is: the vocabulary lives in
 * `src/lib/ambience.ts`, which is also the only thing that validates it, so
 * adding a parameter never touches Rust. */

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AmbienceProfile {
    pub id: String,
    pub name: String,
    /// The layer stack, verbatim. Opaque here on purpose.
    pub layers: serde_json::Value,
    pub active: bool,
}

#[tauri::command]
pub fn list_ambience(store: tauri::State<'_, Store>) -> Result<Vec<AmbienceProfile>, String> {
    let conn = store.0.lock().unwrap();
    list_ambience_rows(&conn)
}

/// The read itself, so the round trip can be tested without an app around it.
fn list_ambience_rows(conn: &Connection) -> Result<Vec<AmbienceProfile>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, layers_json, active FROM ambience_profile ORDER BY created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let raw: String = r.get(2)?;
            Ok(AmbienceProfile {
                id: r.get(0)?,
                name: r.get(1)?,
                /* A column that will not parse is an empty stack, not a failure
                   to paint the wall — the profile is still there to be edited. */
                layers: serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!([])),
                active: r.get::<_, i64>(3)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Upsert one profile. Called on every adjustment (debounced in the front end),
/// so it must be cheap and must not disturb which profile is showing.
#[tauri::command]
pub fn save_ambience(
    store: tauri::State<'_, Store>,
    profile: AmbienceProfile,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    save_ambience_row(&conn, &profile)
}

fn save_ambience_row(conn: &Connection, profile: &AmbienceProfile) -> Result<(), String> {
    let layers = serde_json::to_string(&profile.layers).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO ambience_profile (id, name, layers_json, active, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET name = ?2, layers_json = ?3",
        params![profile.id, profile.name, layers, profile.active as i64, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Show a profile, or `None` for a bare wall.
///
/// One statement clears whatever was showing and one lights this, in a
/// transaction: two profiles both marked active would leave the front end
/// picking one by row order, which is a wall that changes when nothing did.
#[tauri::command]
pub fn activate_ambience(
    store: tauri::State<'_, Store>,
    id: Option<String>,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    activate_ambience_row(&conn, id.as_deref())
}

fn activate_ambience_row(conn: &Connection, id: Option<&str>) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("UPDATE ambience_profile SET active = 0 WHERE active <> 0", [])
        .map_err(|e| e.to_string())?;
    if let Some(id) = id {
        let hit = tx
            .execute(
                "UPDATE ambience_profile SET active = 1 WHERE id = ?1",
                params![id],
            )
            .map_err(|e| e.to_string())?;
        if hit == 0 {
            /* Dropping the transaction rolls it back, so a bad id leaves what
               was showing showing rather than blanking the wall. */
            return Err(format!("no ambience profile {id}"));
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_ambience(store: tauri::State<'_, Store>, id: String) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute("DELETE FROM ambience_profile WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/* ── widgets ──────────────────────────────────────────────────────────────
 *
 * See the note on `migrate_v5`. Nothing here knows what a clock is: the
 * catalogue, the variants and the defaults live in `src/lib/widgets.ts`, which
 * is also the only thing that validates a config — so a new variant, a new knob
 * or a whole new kind of widget never touches Rust. */

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Widget {
    pub id: String,
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub z: i64,
    /// Whatever this kind of widget was set to. Opaque here on purpose.
    pub config: serde_json::Value,
}

#[tauri::command]
pub fn list_widgets(store: tauri::State<'_, Store>) -> Result<Vec<Widget>, String> {
    let conn = store.0.lock().unwrap();
    list_widget_rows(&conn)
}

/// The read itself, so the round trip can be tested without an app around it.
fn list_widget_rows(conn: &Connection) -> Result<Vec<Widget>, String> {
    let mut stmt = conn
        .prepare("SELECT id, kind, x, y, w, h, z, config_json FROM widget ORDER BY z, created_at")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let raw: String = r.get(7)?;
            Ok(Widget {
                id: r.get(0)?,
                kind: r.get(1)?,
                x: r.get(2)?,
                y: r.get(3)?,
                w: r.get(4)?,
                h: r.get(5)?,
                z: r.get(6)?,
                /* A config that will not parse is a widget at its defaults, not
                   a hole in the wall — `normalizeWidget` fills in every knob it
                   does not find, so an empty object is the honest fallback. */
                config: serde_json::from_str(&raw).unwrap_or_else(|_| serde_json::json!({})),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Upsert one widget. Called on every drag frame (debounced in the front end),
/// so it must be cheap.
#[tauri::command]
pub fn save_widget(store: tauri::State<'_, Store>, widget: Widget) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    save_widget_row(&conn, &widget)
}

fn save_widget_row(conn: &Connection, w: &Widget) -> Result<(), String> {
    let config = serde_json::to_string(&w.config).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO widget (id, kind, x, y, w, h, z, config_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
           x = ?3, y = ?4, w = ?5, h = ?6, z = ?7, config_json = ?8",
        params![w.id, w.kind, w.x, w.y, w.w, w.h, w.z, config, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_widget(store: tauri::State<'_, Store>, id: String) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute("DELETE FROM widget WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn seed_project(conn: &Connection, id: &str, path: &str) {
        conn.execute(
            "INSERT INTO project (id, name, root_path, created_at) VALUES (?1, ?1, ?2, 0)",
            params![id, path],
        )
        .unwrap();
    }

    #[test]
    fn migrate_stamps_a_version_and_is_idempotent() {
        let conn = db();
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, SCHEMA_VERSION);

        // Running it again must not throw or reset anything.
        migrate(&conn).unwrap();
        let v2: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v2, SCHEMA_VERSION);
    }

    #[test]
    fn the_schema_carries_the_columns_lazy_restore_depends_on() {
        let conn = db();
        let mut stmt = conn.prepare("PRAGMA table_info(conversation)").unwrap();
        let cols: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(Result::unwrap)
            .collect();

        // A dormant card shows what it reached without spawning anything.
        assert!(cols.contains(&"last_ctx_frac".to_string()));
        assert!(cols.contains(&"last_ending".to_string()));
        assert!(cols.contains(&"interrupted".to_string()));
        // Identity stays separate from the agent's own session handle.
        assert!(cols.contains(&"agent_session_id".to_string()));
    }

    /// The v2 repair: a card that has turns behind it must come back resumable.
    #[test]
    fn the_backfill_marks_conversations_that_spoke_and_leaves_the_silent_ones_alone() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        // Start from a v1 database, as an existing install would.
        migrate_v1(&conn).unwrap();
        seed_project(&conn, "p1", "C:/x");
        for id in ["spoke", "silent"] {
            conn.execute(
                "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES (?1,'p1','C:/x',0)",
                params![id],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO turn (conversation_id, ended_at, status_tier) VALUES ('spoke', 0, 'rest')",
            [],
        )
        .unwrap();

        migrate_v2(&conn).unwrap();

        let ending = |id: &str| -> Option<String> {
            conn.query_row(
                "SELECT last_ending FROM conversation WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap()
        };
        // everSpoke is read off this column, and decides --resume vs --session-id.
        assert_eq!(ending("spoke").as_deref(), Some("ok"));
        assert_eq!(ending("silent"), None, "a card that never spoke has nothing to resume");
    }

    #[test]
    fn the_backfill_never_overwrites_an_ending_we_actually_know() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at, last_ending)
             VALUES ('c1','p1','C:/x',0,'error')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO turn (conversation_id, ended_at, status_tier) VALUES ('c1', 0, 'fail')",
            [],
        )
        .unwrap();

        migrate_v2(&conn).unwrap();

        let ending: String = conn
            .query_row("SELECT last_ending FROM conversation WHERE id='c1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(ending, "error", "a real ending was flattened to ok");
    }

    /// An adopted CLI session must wake with `--resume`, and the only thing
    /// that decides that is a non-NULL `last_ending` — `restore` reads NULL as
    /// "never spoke", and a fresh `--session-id` on an id that already has a
    /// transcript collides instead of resuming.
    #[test]
    fn an_imported_session_is_restorable_and_resumable() {
        let conn = db();
        seed_project(&conn, "p1", "C:/atelier/caravan");
        import_row(
            &conn,
            "0f3bbb4e",
            "p1",
            "C:/atelier/caravan",
            Some("Set default sweep behavior"),
            Some("claude-opus-5"),
            Some(0.23),
            Some(1_700_000_000_000),
        )
        .unwrap();

        let (title, ending, born, frac): (String, Option<String>, i64, f64) = conn
            .query_row(
                "SELECT title, last_ending, born_at, last_ctx_frac FROM conversation WHERE id='0f3bbb4e'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(title, "Set default sweep behavior");
        assert_eq!(ending.as_deref(), Some("ok"), "would wake as a fresh session");
        // Age comes off the transcript, not off the moment it was adopted.
        assert_eq!(born, 1_700_000_000_000);
        assert_eq!(frac, 0.23);
    }

    /// Forgetting is the deliberate counterpart to a territory surviving its
    /// last card, so it must not be possible to do it to a project that is
    /// plainly still in use.
    #[test]
    fn a_project_with_something_open_cannot_be_forgotten() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES ('c1','p1','C:/x',0)",
            [],
        )
        .unwrap();

        let refused = forget_row(&conn, "C:/x").unwrap_err();
        assert!(refused.contains("still open"), "unhelpful refusal: {refused}");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM project", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "the project was forgotten anyway");
    }

    /// Closed conversations go with it — the rows, not the transcripts, which
    /// stay on disk and can be adopted back.
    #[test]
    fn forgetting_an_empty_project_takes_its_history_with_it() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at, closed_at)
             VALUES ('c1','p1','C:/x',0,1)",
            [],
        )
        .unwrap();

        assert_eq!(forget_row(&conn, "C:/x"), Ok(true));
        let projects: i64 = conn
            .query_row("SELECT COUNT(*) FROM project", [], |r| r.get(0))
            .unwrap();
        let convs: i64 = conn
            .query_row("SELECT COUNT(*) FROM conversation", [], |r| r.get(0))
            .unwrap();
        assert_eq!((projects, convs), (0, 0));
    }

    #[test]
    fn forgetting_something_that_was_never_there_is_not_an_error() {
        let conn = db();
        assert_eq!(forget_row(&conn, "C:/never"), Ok(false));
    }

    /// Closing a card leaves the row behind, so adopting the same session again
    /// has to put it back on the wall rather than quietly do nothing.
    #[test]
    fn importing_something_closed_brings_it_back() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        import_row(&conn, "c1", "p1", "C:/x", Some("first"), None, None, None).unwrap();
        conn.execute("UPDATE conversation SET closed_at = 1 WHERE id = 'c1'", [])
            .unwrap();

        import_row(&conn, "c1", "p1", "C:/x", Some("later"), None, None, None).unwrap();

        let (closed, title): (Option<i64>, String) = conn
            .query_row(
                "SELECT closed_at, title FROM conversation WHERE id='c1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(closed, None, "re-adopting left the card off the wall");
        assert_eq!(title, "later");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM conversation", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "adoption duplicated the conversation");
    }

    /// A card that has been worked in since it was adopted knows more about
    /// itself than the transcript scan does, so re-adopting must not blank it.
    #[test]
    fn re_importing_does_not_overwrite_what_the_card_already_knows() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        import_row(
            &conn,
            "c1",
            "p1",
            "C:/x",
            Some("titled"),
            Some("claude-opus-5"),
            Some(0.5),
            None,
        )
        .unwrap();
        conn.execute(
            "UPDATE conversation SET last_ending = 'question' WHERE id = 'c1'",
            [],
        )
        .unwrap();

        import_row(&conn, "c1", "p1", "C:/x", None, None, None, None).unwrap();

        let (title, model, frac, ending): (String, String, f64, String) = conn
            .query_row(
                "SELECT title, model, last_ctx_frac, last_ending FROM conversation WHERE id='c1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(title, "titled");
        assert_eq!(model, "claude-opus-5");
        assert_eq!(frac, 0.5);
        assert_eq!(ending, "question", "a known ending was reset to a guess");
    }

    #[test]
    fn closing_a_conversation_removes_it_from_the_wall_without_deleting_it() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES ('c1','p1','C:/x',0)",
            [],
        )
        .unwrap();

        let open: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM conversation WHERE closed_at IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(open, 1);

        conn.execute("UPDATE conversation SET closed_at = 1 WHERE id = 'c1'", [])
            .unwrap();

        let open: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM conversation WHERE closed_at IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(open, 0);
        // The history is still there — closing a card is not forgetting it.
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM conversation", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 1);
    }

    /// Shutdown marks what was *running*, not everything still on the wall.
    ///
    /// The bug: `WHERE closed_at IS NULL` also matches every dormant card
    /// restored from a previous session and never woken. Quitting cleanly flagged
    /// the whole wall, so the next launch had every card claiming its last turn
    /// was interrupted — including ones nobody had spoken to in days.
    #[test]
    fn shutdown_marks_only_the_conversations_that_were_actually_running() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        for id in ["live", "dormant"] {
            conn.execute(
                "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES (?1,'p1','C:/x',0)",
                params![id],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at, closed_at)
             VALUES ('done','p1','C:/x',0,1)",
            [],
        )
        .unwrap();

        /* Only `live` had a child in the supervisor. `done` is passed too, to
           show the closed_at guard holds even if a stale id turns up. */
        mark_interrupted(&conn, &["live".to_string(), "done".to_string()]);

        let flag = |id: &str| -> i64 {
            conn.query_row(
                "SELECT interrupted FROM conversation WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(flag("live"), 1, "a card mid-turn at shutdown lost that turn");
        assert_eq!(flag("dormant"), 0, "a card that was never woken lost nothing");
        assert_eq!(flag("done"), 0, "a card already closed was not mid-turn");
    }

    #[test]
    fn marking_nothing_is_a_no_op_rather_than_a_wall_wide_update() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES ('c1','p1','C:/x',0)",
            [],
        )
        .unwrap();

        // Quitting with nothing awake must not touch a single row.
        mark_interrupted(&conn, &[]);

        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM conversation WHERE interrupted = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn placements_survive_and_upsert_rather_than_duplicating() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES ('c1','p1','C:/x',0)",
            [],
        )
        .unwrap();

        for (x, y) in [(10.0, 20.0), (99.0, 88.0)] {
            conn.execute(
                "INSERT INTO placement (conversation_id, x, y, pinned) VALUES ('c1', ?1, ?2, 1)
                 ON CONFLICT(conversation_id) DO UPDATE SET x = ?1, y = ?2, pinned = 1",
                params![x, y],
            )
            .unwrap();
        }

        let (n, x, y): (i64, f64, f64) = conn
            .query_row(
                "SELECT COUNT(*), MAX(x), MAX(y) FROM placement WHERE conversation_id='c1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(n, 1, "dragging a card twice must not make two placements");
        assert_eq!((x, y), (99.0, 88.0));
    }

    /// A territory is dragged, not flowed, once it has been moved once — so the
    /// position has to come back, and NULL has to keep meaning "the grid decides".
    #[test]
    fn a_territory_remembers_where_it_was_put_and_can_be_given_back_to_the_grid() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");

        let at = || -> (Option<f64>, Option<f64>) {
            conn.query_row("SELECT x, y FROM project WHERE root_path='C:/x'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap()
        };
        assert_eq!(at(), (None, None), "a new project starts in the grid's hands");

        place_row(&conn, "C:/x", Some(1100.0), Some(560.0)).unwrap();
        assert_eq!(at(), (Some(1100.0), Some(560.0)));

        // Moved again — one row, not two positions.
        place_row(&conn, "C:/x", Some(20.0), Some(30.0)).unwrap();
        assert_eq!(at(), (Some(20.0), Some(30.0)));

        // "tidy it back onto the grid" is the same command with nothing in it.
        place_row(&conn, "C:/x", None, None).unwrap();
        assert_eq!(at(), (None, None));
    }

    /// The v3 columns have to land on databases that already exist, which is the
    /// whole reason a schema change is an ALTER and not a CREATE.
    #[test]
    fn an_existing_database_gains_the_territory_position_columns() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate_v1(&conn).unwrap();
        seed_project(&conn, "p1", "C:/x");

        migrate(&conn).unwrap();

        let mut stmt = conn.prepare("PRAGMA table_info(project)").unwrap();
        let cols: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert!(cols.contains(&"x".to_string()));
        assert!(cols.contains(&"y".to_string()));
        // An existing territory keeps flowing until somebody moves it.
        place_row(&conn, "C:/x", Some(7.0), Some(8.0)).unwrap();
    }

    /* ── ambience ─────────────────────────────────────────────────────── */

    fn ambience(id: &str, name: &str, layers: serde_json::Value) -> AmbienceProfile {
        AmbienceProfile {
            id: id.to_string(),
            name: name.to_string(),
            layers,
            active: false,
        }
    }

    /// Rust holds the layer stack without understanding it, which is the whole
    /// bargain of the JSON column: a knob added in `ambience.ts` must survive a
    /// round trip through a build of Rust that has never heard of it.
    #[test]
    fn a_layer_stack_comes_back_exactly_as_it_went_in() {
        let conn = db();
        let layers = serde_json::json!([
            { "id": "l1", "kind": "leaves", "on": true, "opacity": 0.8,
              "params": { "count": 12, "wind": -40.5, "somethingNewer": 3 } },
            { "id": "l2", "kind": "ripples", "on": false, "opacity": 1,
              "params": { "rate": 9 } }
        ]);
        save_ambience_row(&conn, &ambience("p1", "late october", layers.clone())).unwrap();

        let got = list_ambience_rows(&conn).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "late october");
        assert_eq!(got[0].layers, layers);
    }

    /// Every drag of a slider writes, so this is the hot path — and it must not
    /// disturb which profile is showing.
    #[test]
    fn adjusting_a_profile_updates_it_rather_than_making_another() {
        let conn = db();
        save_ambience_row(&conn, &ambience("p1", "atelier", serde_json::json!([]))).unwrap();
        activate_ambience_row(&conn, Some("p1")).unwrap();

        let mut edited = ambience("p1", "atelier", serde_json::json!([{ "kind": "swirls" }]));
        /* The front end sends the profile as it holds it; `active` is not its
           business, and a save must never be able to switch the wall. */
        edited.active = false;
        save_ambience_row(&conn, &edited).unwrap();

        let got = list_ambience_rows(&conn).unwrap();
        assert_eq!(got.len(), 1, "editing a profile made a second one");
        assert_eq!(got[0].layers, serde_json::json!([{ "kind": "swirls" }]));
        assert!(got[0].active, "editing the showing profile stopped it showing");
    }

    #[test]
    fn exactly_one_profile_is_ever_showing() {
        let conn = db();
        for id in ["p1", "p2", "p3"] {
            save_ambience_row(&conn, &ambience(id, id, serde_json::json!([]))).unwrap();
        }
        let showing = |conn: &Connection| -> Vec<String> {
            list_ambience_rows(conn)
                .unwrap()
                .into_iter()
                .filter(|p| p.active)
                .map(|p| p.id)
                .collect()
        };

        activate_ambience_row(&conn, Some("p2")).unwrap();
        assert_eq!(showing(&conn), vec!["p2".to_string()]);

        activate_ambience_row(&conn, Some("p3")).unwrap();
        assert_eq!(showing(&conn), vec!["p3".to_string()]);

        // A bare wall is a real choice, not the absence of one.
        activate_ambience_row(&conn, None).unwrap();
        assert!(showing(&conn).is_empty());
    }

    /// The rollback matters: a stale id from a profile deleted in another window
    /// must leave the wall as it was rather than clearing it.
    #[test]
    fn activating_something_that_is_not_there_leaves_the_wall_alone() {
        let conn = db();
        save_ambience_row(&conn, &ambience("p1", "atelier", serde_json::json!([]))).unwrap();
        activate_ambience_row(&conn, Some("p1")).unwrap();

        assert!(activate_ambience_row(&conn, Some("gone")).is_err());

        let got = list_ambience_rows(&conn).unwrap();
        assert!(got[0].active, "a bad id blanked the wall on its way out");
    }

    /// The column is written by the front end and read by it too, so the shapes
    /// can only ever drift in one direction — but a row that will not parse must
    /// still list, or a profile becomes impossible to fix or delete.
    #[test]
    fn a_layer_column_that_will_not_parse_reads_as_an_empty_stack() {
        let conn = db();
        conn.execute(
            "INSERT INTO ambience_profile (id, name, layers_json, active, created_at)
             VALUES ('p1', 'broken', 'not json at all', 1, 0)",
            [],
        )
        .unwrap();

        let got = list_ambience_rows(&conn).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].layers, serde_json::json!([]));
        assert_eq!(got[0].name, "broken");
    }

    #[test]
    fn a_profile_can_be_thrown_away() {
        let conn = db();
        save_ambience_row(&conn, &ambience("p1", "atelier", serde_json::json!([]))).unwrap();
        conn.execute("DELETE FROM ambience_profile WHERE id = 'p1'", []).unwrap();
        assert!(list_ambience_rows(&conn).unwrap().is_empty());
    }

    /// v4 has to land on databases that already exist — the whole reason a
    /// schema change is a numbered step and not a `CREATE TABLE IF NOT EXISTS`
    /// somewhere on the read path.
    #[test]
    fn an_existing_database_gains_the_ambience_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate_v1(&conn).unwrap();

        migrate(&conn).unwrap();

        save_ambience_row(&conn, &ambience("p1", "atelier", serde_json::json!([]))).unwrap();
        assert_eq!(list_ambience_rows(&conn).unwrap().len(), 1);
    }

    fn widget(id: &str, kind: &str, config: serde_json::Value) -> Widget {
        Widget {
            id: id.to_string(),
            kind: kind.to_string(),
            x: 10.0,
            y: 20.0,
            w: 200.0,
            h: 200.0,
            z: 3,
            config,
        }
    }

    /// The same bargain the layer stack has: Rust holds a widget's settings
    /// without understanding them, so a variant invented in `widgets.ts` must
    /// survive a round trip through a build that has never heard of it.
    #[test]
    fn a_widget_config_comes_back_exactly_as_it_went_in() {
        let conn = db();
        let config = serde_json::json!({
            "variant": "something-newer", "seconds": false, "rows": 7
        });
        save_widget_row(&conn, &widget("w1", "clock", config.clone())).unwrap();

        let got = list_widget_rows(&conn).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].kind, "clock");
        assert_eq!(got[0].config, config);
        assert_eq!(got[0].z, 3);
    }

    /// Moving one fires continuously, so the hot path must update rather than
    /// accumulate — the bug reference images had before their save was debounced.
    #[test]
    fn moving_a_widget_updates_it_rather_than_making_another() {
        let conn = db();
        save_widget_row(&conn, &widget("w1", "clock", serde_json::json!({}))).unwrap();
        let mut moved = widget("w1", "clock", serde_json::json!({ "variant": "abstract" }));
        moved.x = 400.0;
        save_widget_row(&conn, &moved).unwrap();

        let got = list_widget_rows(&conn).unwrap();
        assert_eq!(got.len(), 1, "dragging a widget left a second one behind");
        assert_eq!(got[0].x, 400.0);
        assert_eq!(got[0].config, serde_json::json!({ "variant": "abstract" }));
    }

    /// A config that will not parse must still list, or a widget becomes
    /// impossible to fix or take down.
    #[test]
    fn a_config_column_that_will_not_parse_reads_as_defaults() {
        let conn = db();
        conn.execute(
            "INSERT INTO widget (id, kind, x, y, w, h, z, config_json, created_at)
             VALUES ('w1', 'clock', 0, 0, 10, 10, 0, 'not json at all', 0)",
            [],
        )
        .unwrap();

        let got = list_widget_rows(&conn).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].config, serde_json::json!({}));
    }

    /// v5 has to land on databases that already exist — the whole reason a
    /// schema change is a numbered step.
    #[test]
    fn an_existing_database_gains_the_widget_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate_v1(&conn).unwrap();

        migrate(&conn).unwrap();

        save_widget_row(&conn, &widget("w1", "clock", serde_json::json!({}))).unwrap();
        assert_eq!(list_widget_rows(&conn).unwrap().len(), 1);
    }

    #[test]
    fn closing_a_conversation_cascades_to_its_rows() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES ('c1','p1','C:/x',0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO placement (conversation_id, x, y, pinned) VALUES ('c1',1,1,1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO file_touch (conversation_id, path, op, at) VALUES ('c1','a.ts','write',0)",
            [],
        )
        .unwrap();

        conn.execute("DELETE FROM conversation WHERE id='c1'", []).unwrap();

        let p: i64 = conn
            .query_row("SELECT COUNT(*) FROM placement", [], |r| r.get(0))
            .unwrap();
        let f: i64 = conn
            .query_row("SELECT COUNT(*) FROM file_touch", [], |r| r.get(0))
            .unwrap();
        assert_eq!((p, f), (0, 0), "orphan rows were left behind");
    }

    /// This is the query the broadcast bar reads to warn that the cards you
    /// have gathered are about to rebase the same files.
    #[test]
    fn overlap_finds_conversations_sharing_a_file_and_ignores_the_rest() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        for id in ["a", "b", "c"] {
            conn.execute(
                "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES (?1,'p1','C:/x',0)",
                params![id],
            )
            .unwrap();
        }
        let touch = |c: &str, p: &str| {
            conn.execute(
                "INSERT INTO file_touch (conversation_id, path, op, at) VALUES (?1, ?2, 'write', 0)",
                params![c, p],
            )
            .unwrap();
        };
        touch("a", "src/db.ts");
        touch("b", "src/db.ts");
        touch("b", "src/ui.ts");
        touch("c", "docs/readme.md");

        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT b.conversation_id FROM file_touch a
                   JOIN file_touch b ON a.path = b.path
                  WHERE a.conversation_id = ?1 AND b.conversation_id <> ?1",
            )
            .unwrap();
        let hits: Vec<String> = stmt
            .query_map(params!["a"], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();

        assert_eq!(hits, vec!["b".to_string()], "c shares no files with a");
    }

    #[test]
    fn a_project_is_found_by_path_rather_than_created_twice() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        // root_path is UNIQUE — the same directory is always the same project.
        let again = conn.execute(
            "INSERT INTO project (id, name, root_path, created_at) VALUES ('p2','x','C:/x',0)",
            [],
        );
        assert!(again.is_err(), "the same directory made two projects");
    }

    #[test]
    fn dir_name_handles_both_separators_and_trailing_slashes() {
        assert_eq!(dir_name("C:\\atelier\\skein"), "skein");
        assert_eq!(dir_name("C:/atelier/skein/"), "skein");
        assert_eq!(dir_name("/home/x/nova"), "nova");
        assert_eq!(dir_name("skein"), "skein");
    }

    #[test]
    fn generated_ids_are_well_formed_and_distinct() {
        let a = uuid_v4();
        let b = uuid_v4();
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        // Version 4, RFC 4122 variant — claude validates --session-id.
        assert_eq!(&a[14..15], "4");
        assert!(matches!(&a[19..20], "8" | "9" | "a" | "b"));
    }
}

/// A v4 UUID without pulling in a crate for it.
pub fn uuid_v4() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut b = [0u8; 16];
    for chunk in b.chunks_mut(8) {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(now() as u64);
        h.write_usize(chunk.as_ptr() as usize);
        chunk.copy_from_slice(&h.finish().to_ne_bytes()[..chunk.len()]);
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]
    )
}
