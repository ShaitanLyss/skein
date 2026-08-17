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
    /// Where the territory is *drawn* if it has been stuck to the glass — the
    /// pane in front of the wall — in screen pixels. Independent of `x`/`y`,
    /// which stay whatever the wall says: a stuck territory keeps its cell, so
    /// putting it back moves nothing. See `migrate_v9`.
    ///
    /// Renamed for the wire because the four things that can be stuck speak one
    /// vocabulary in the front end (`glassX`), and a feature spelled two ways
    /// depending on which table it landed in is a feature read twice.
    #[serde(rename = "glassX")]
    pub glass_x: Option<f64>,
    #[serde(rename = "glassY")]
    pub glass_y: Option<f64>,
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
    /// Put by on purpose: on the wall, out of what is waiting, and not roused.
    pub aside: bool,
    /// `project` or `chat` — see `migrate_v11`. A string rather than a bool
    /// because this is a taxonomy with room in it, and `chat: false` would be a
    /// column that could only ever answer one more question.
    pub kind: String,
    /// Canvas position. `None` means "let the layout place it".
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub pinned: bool,
    /// Where the card is drawn if it has been stuck to the glass. Beside the
    /// canvas position rather than instead of it — see `migrate_v9`.
    #[serde(rename = "glassX")]
    pub glass_x: Option<f64>,
    #[serde(rename = "glassY")]
    pub glass_y: Option<f64>,
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
const SCHEMA_VERSION: i64 = 11;

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
    if version < 6 {
        migrate_v6(conn)?;
    }
    if version < 7 {
        migrate_v7(conn)?;
    }
    if version < 8 {
        migrate_v8(conn)?;
    }
    if version < 9 {
        migrate_v9(conn)?;
    }
    if version < 10 {
        migrate_v10(conn)?;
    }
    if version < 11 {
        migrate_v11(conn)?;
    }
    // Future changes go here as `if version < 12 { ... }`, each one an ALTER
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

/// A card put by on purpose — kept on the wall, kept out of what is waiting.
///
/// It has to be a column rather than front-end state for two reasons that both
/// happen at launch: the waiting cycle is the same cycle on the next run, and
/// rousing spawns a process for every dormant card it finds, so a flag that did
/// not survive a restart would give back exactly the sessions you had put down.
///
/// An ALTER with a default, per the note on `SCHEMA_VERSION` — every existing
/// row is a card nobody has set aside, which is what 0 means.
fn migrate_v6(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "ALTER TABLE conversation ADD COLUMN aside INTEGER NOT NULL DEFAULT 0;",
    )
    .map_err(|e| format!("migrate v6: {e}"))
}

/// Cache reads and cache writes are one column in v1 and must not be, because
/// they are not one price. A cache read is 0.1x input and a cache write is
/// 1.25x — a factor of 12.5 between two numbers that were being added
/// together, so the summed column cannot answer the only question a ledger is
/// for. Measured over the 15 sessions this wall had taken by 2026-08-14:
/// 231.4M cache-read tokens against 6.23M written, which is $115.69 against
/// $38.91 at Opus 5 rates. Summed, that is one meaningless number.
///
/// `cache_tokens` stays and keeps its name, but its *meaning* is repaired:
/// `record_turn` was passing `ctxTokens` — the context ring's occupancy, which
/// is a reading of the last request, not a count of anything this turn spent.
/// Occupancy already has a home in `conversation.last_ctx_frac`.
///
/// Nothing backfills, because there is nothing recoverable to backfill from:
/// every existing row carries zeros for in/out and an occupancy figure under
/// `cache_tokens`. The rows are left as they are rather than deleted — they
/// still date a turn and record how it ended, which is what the EXISTS check
/// in v2 reads them for.
fn migrate_v7(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        ALTER TABLE turn ADD COLUMN cache_read_tokens  INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE turn ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
        "#,
    )
    .map_err(|e| format!("migrate v7: {e}"))
}

/// The pomodoro cycle — one per studio, so at most one row.
///
/// It is not a widget's config, and that is the whole point of the table. A
/// pomodoro widget is a *view*: two of them on the wall are two readings of one
/// afternoon, and if each held its own phase they would be two clocks telling
/// different times. The cycle outlives any one of them too, so swapping which
/// view is up carries on rather than starting again — which a per-widget config
/// could not do, since the state would leave with the widget.
///
/// It does not run without any view at all: a cycle with no pomodoro widget on
/// the wall pauses (`Cycle.watched`), the way the process sampler stops when the
/// last meter comes down. The row is what makes that a *pause* rather than a
/// loss — the phase is still here when a widget goes back up.
///
/// `state_json` is opaque here for the same reason `widget.config_json` and
/// `ambience_profile.layers_json` are: the phase machine, the cadences and what
/// a snooze means all live in `src/lib/timing.ts`, which is pure and tested, and
/// none of it is worth a migration per field. Rust never parses it; the front
/// end's `normalizeCycle` does, on every read.
///
/// A CREATE rather than an ALTER, per the note on `SCHEMA_VERSION` — this is a
/// new table, so there is nothing to backfill and no existing row to give a
/// default to. A studio that has never run a pomodoro simply has no row, which
/// `read_pomodoro` reports as `None`.
fn migrate_v8(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS pomodoro (
            id          INTEGER PRIMARY KEY CHECK (id = 1),
            state_json  TEXT NOT NULL,
            updated_at  INTEGER NOT NULL
        );
        "#,
    )
    .map_err(|e| format!("migrate v8: {e}"))
}

/// The glass: where a thing is drawn when it has been stuck to the window
/// rather than left on the wall.
///
/// Four tables get the same pair because four kinds of thing can be stuck —
/// a card, a territory, a reference image and a widget — and the glass means
/// exactly the same thing to each. Columns on the thing's own row rather than
/// one `glass(kind, id, x, y)` table, for two reasons: the position travels
/// with what it is a position *of*, so it is written by the same upsert and
/// read by the same query as everything else about it; and closing a card or
/// forgetting a project takes it with them by the cascade that is already
/// there, where a side table keyed on a mixed id would quietly accumulate rows
/// pointing at things nobody can see any more.
///
/// Nullable, and null is meaningful — "on the wall", which is what every
/// existing row starts as and what putting one back returns it to. That is the
/// same shape `project.x`/`y` took in v3.
///
/// Emphatically **not** a replacement for the wall positions beside them. A
/// card stuck to the glass keeps its placement, a territory keeps its cell, and
/// the wall is laid out as though nothing were stuck at all — so taking a thing
/// off the pane puts it back where it was and nothing else moves. Storing one
/// pair of coordinates whose meaning depended on a flag would have made that
/// round trip lossy, which on a wall whose whole argument is that position is
/// memory is the one thing it must not be. See `src/lib/glass.ts`.
///
/// These are screen pixels, which is unlike everything else in this file, and
/// they are still studio data rather than viewport state: where you put a thing
/// is something you *made*, unlike where you happen to be looking. What depends
/// on the window is handled where it is drawn (`glassAt`), so a narrow window
/// borrows a widget back from the edge and a wide one gives it straight back.
fn migrate_v9(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        ALTER TABLE placement       ADD COLUMN glass_x REAL;
        ALTER TABLE placement       ADD COLUMN glass_y REAL;
        ALTER TABLE project         ADD COLUMN glass_x REAL;
        ALTER TABLE project         ADD COLUMN glass_y REAL;
        ALTER TABLE reference_image ADD COLUMN glass_x REAL;
        ALTER TABLE reference_image ADD COLUMN glass_y REAL;
        ALTER TABLE widget          ADD COLUMN glass_x REAL;
        ALTER TABLE widget          ADD COLUMN glass_y REAL;
        "#,
    )
    .map_err(|e| format!("migrate v9: {e}"))
}

/// Throw away every stored `interrupted`, because none of them means what the
/// column says.
///
/// `Supervisor::shutdown` returned every id it killed, and rousing gives every
/// dormant card a process at launch — so from the day rousing shipped, a clean
/// quit flagged the entire wall, cards that had been resting for days included.
/// The next launch then sent each of them a `resumePrompt`.
///
/// No schema change: the column is right, the values in it are not, and unlike
/// v2 there is nothing to recover them from — a `turn` row says a turn ended,
/// never that one was cut off. So it clears rather than repairs, and the cost is
/// bounded and one-way: at worst a card that genuinely was mid-turn at the last
/// quit is not offered its resume, which is a prompt you can send yourself. The
/// alternative is running the bug once more over every card on the wall.
fn migrate_v10(conn: &Connection) -> Result<(), String> {
    conn.execute("UPDATE conversation SET interrupted = 0", [])
        .map(|_| ())
        .map_err(|e| format!("migrate v10: {e}"))
}

/// What a card *is*, which until now every card was the same answer to.
///
/// `project` is a card standing in a working tree with the machine at its
/// disposal; `chat` is a card with no project and no tools but the two web
/// ones. It is a column rather than something inferred from `cwd`, even though
/// every chat card shares one directory: the cwd is where a chat card was put
/// so that it would have somewhere harmless to be, and reading a *capability*
/// off a path means the day that path changes, every card built on it silently
/// gets the machine back. The column says what was meant.
///
/// Defaulted rather than backfilled, because the default is the truth: every
/// row written before this one was a project card and still is.
fn migrate_v11(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "ALTER TABLE conversation ADD COLUMN kind TEXT NOT NULL DEFAULT 'project';",
    )
    .map_err(|e| format!("migrate v11: {e}"))
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
    type Row = (String, String, Option<f64>, Option<f64>, Option<f64>, Option<f64>);
    let existing: Option<Row> = conn
        .query_row(
            "SELECT id, name, x, y, glass_x, glass_y FROM project WHERE root_path = ?1",
            params![root_path],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    if let Some((id, name, x, y, glass_x, glass_y)) = existing {
        return Ok(Project { id, name, root_path, x, y, glass_x, glass_y });
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
    /* And not on the glass: the pane is somewhere you put a thing on purpose,
       never somewhere a thing arrives. */
    Ok(Project { id, name, root_path, x: None, y: None, glass_x: None, glass_y: None })
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

/// Where a territory is drawn when it has been stuck to the glass, or `None`
/// for one put back on the wall.
///
/// Its own command rather than two more arguments on `place_project`, whose own
/// pair of nulls already means something else entirely -- "hand it back to the
/// grid". Conflating them would make one call able to say two unrelated things
/// and neither of them clearly.
///
/// It deliberately does not touch `x`/`y`. A territory on the pane still holds
/// its cell on the wall, so putting it back drops it among its neighbours
/// exactly where it was and nothing else moves.
#[tauri::command]
pub fn stick_project(
    store: tauri::State<'_, Store>,
    root_path: String,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    stick_row(&conn, &root_path, x, y)
}

/// The write itself, so the round trip can be tested without an app around it.
fn stick_row(
    conn: &Connection,
    root_path: &str,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE project SET glass_x = ?2, glass_y = ?3 WHERE root_path = ?1",
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
    /* `chat` for a card with no project; absent means `project`. One word, so
       there is no camelCase for `invoke` to convert and get wrong — the trap
       that left `last_ending` NULL for every turn ever taken. */
    kind: Option<String>,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    record_row(&conn, &id, &project_id, &cwd, worktree.as_deref(), kind.as_deref())
}

/// The statement itself, so the insert can be tested without a Tauri app —
/// the bargain `import_row` and `forget_row` already strike.
fn record_row(
    conn: &Connection,
    id: &str,
    project_id: &str,
    cwd: &str,
    worktree: Option<&str>,
    kind: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "INSERT OR IGNORE INTO conversation
           (id, agent_session_id, project_id, cwd, worktree, born_at, kind)
         VALUES (?1, ?1, ?2, ?3, ?4, ?5, COALESCE(?6, 'project'))",
        params![id, project_id, cwd, worktree, now(), kind],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// What kind of card this id is, asked of the store.
///
/// The supervisor asks this rather than being told, for the reason it asks the
/// disk whether to resume: a capability that travels as an argument is one
/// every future call site has to remember to pass, and the failure mode here is
/// not a card that starts wrong but a chat card that comes back from a rouse
/// with the machine in its hands. `wake` never has to know.
///
/// Unknown ids answer `project`, which is what every id was before v11 — and
/// the conservative direction is the *card* being ordinary, never the sandbox
/// being lifted: a chat card is only ever chat because a row says so.
pub fn kind_of(store: &Store, id: &str) -> String {
    kind_row(&store.0.lock().unwrap(), id)
}

/// The query itself, so the fallback can be tested without a Tauri app.
fn kind_row(conn: &Connection, id: &str) -> String {
    conn.query_row(
        "SELECT kind FROM conversation WHERE id = ?1",
        params![id],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .unwrap_or_else(|| "project".into())
}

/// Where chat cards stand.
///
/// They need *a* directory — the CLI is spawned in one, and the transcript
/// path is derived from it — but nothing about a chat card wants a project, so
/// this is a folder of Skein's own beside the database, created on demand. It
/// holds nothing and is never written to; it exists so that "no project" has an
/// address.
///
/// One directory for every chat card rather than one apiece: they share no
/// state because none of them can read or write a file, so a directory each
/// would be a hundred empty folders and a hundred transcript slugs.
#[tauri::command]
pub fn chat_home(store: tauri::State<'_, Store>) -> Result<String, String> {
    let dir = store.1.join("chat");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create chat dir: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
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
///
/// `interrupted` is the one column here that is ever *un*set, and it is passed
/// explicitly rather than cleared by a rule: the flag says "the app went away
/// while this was mid-turn", which stops being news the moment somebody — or the
/// rousing queue — sends the card its next prompt. Left standing it would be
/// read as fresh at every launch from then on, and an interrupted card gets sent
/// a resume prompt, so a flag that never cleared would resume the same lost turn
/// every time the app opened. COALESCE still applies, so an absent argument
/// leaves it alone exactly as for the rest.
///
/// `aside` is the other one that goes both ways, and needs nothing special for
/// it: it is only ever written by the gesture that sets or unsets it, so it
/// always arrives with the value it is meant to take. That is what a COALESCE
/// cannot express and why `clear_conversation` is its own command — the
/// difference is whether a caller ever means "put this back to the default",
/// which nothing here does.
#[tauri::command]
pub fn update_conversation(
    store: tauri::State<'_, Store>,
    id: String,
    title: Option<String>,
    model: Option<String>,
    last_ctx_frac: Option<f64>,
    last_ending: Option<String>,
    interrupted: Option<bool>,
    aside: Option<bool>,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute(
        "UPDATE conversation SET
           title         = COALESCE(?2, title),
           model         = COALESCE(?3, model),
           last_ctx_frac = COALESCE(?4, last_ctx_frac),
           last_ending     = COALESCE(?5, last_ending),
           interrupted   = COALESCE(?6, interrupted),
           aside         = COALESCE(?7, aside)
         WHERE id = ?1",
        params![id, title, model, last_ctx_frac, last_ending, interrupted, aside],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Point a card at a fresh session, keeping the card.
///
/// Deliberately not an `update_conversation` with more parameters: that command
/// means "fill in what a settling turn learned", and every column it touches is
/// COALESCEd so an absent argument leaves the old value alone. Clearing needs
/// the opposite of that for three of these — `last_ending` back to NULL is the
/// whole point (the front end reads NULL as "never spoke", which is what makes
/// the next spawn use `--session-id` rather than `--resume` against a
/// transcript that does not exist yet), and a COALESCE cannot express it.
///
/// `agent_session_id` has been written since v1 and read by nobody until now,
/// so there is no migration here: the column was always the right shape, it
/// simply never had a reason to differ from `id`.
///
/// Nothing is deleted. The previous session's transcript stays where Claude
/// Code wrote it and can be adopted back onto the wall as its own card — the
/// same property that makes `forget_project` safe.
#[tauri::command]
pub fn clear_conversation(
    store: tauri::State<'_, Store>,
    id: String,
    session_id: String,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    clear_row(&conn, &id, &session_id)
}

/// The statement itself, so it can be tested without a Tauri app.
fn clear_row(conn: &Connection, id: &str, session_id: &str) -> Result<(), String> {
    let n = conn
        .execute(
            "UPDATE conversation SET
               agent_session_id = ?2,
               title            = 'untitled',
               last_ctx_frac    = 0,
               last_ending      = NULL,
               interrupted      = 0
             WHERE id = ?1",
            params![id, session_id],
        )
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("no conversation {id}"));
    }
    Ok(())
}

/// One row per settled turn, and the only place the wall records what a turn
/// *cost* — so every argument here has to be a fact about this turn alone.
/// Two of them were not, and the ledger was unreadable for it: `in_tokens` and
/// `out_tokens` were hardcoded to 0 at the call site, and `usd` was handed
/// `result.total_cost_usd`, which is the session's running total rather than
/// the turn's, so a card's rows climbed monotonically and no row said what its
/// own turn had spent. Both are read off `result.usage` now, whose sum-over-
/// the-turn shape — the very thing that disqualifies it from feeding the
/// context ring — is exactly what a turn row wants. See `Conversation.ingest`.
///
/// `cache_read_tokens` and `cache_write_tokens` are apart because their prices
/// are (0.1x against 1.25x input); see `migrate_v7`. `cache_tokens` is their
/// sum, kept so the column keeps meaning something rather than being left to
/// rot at whatever it last held.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn record_turn(
    store: tauri::State<'_, Store>,
    conversation_id: String,
    status_tier: String,
    in_tokens: i64,
    out_tokens: i64,
    cache_read_tokens: i64,
    cache_write_tokens: i64,
    usd: f64,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute(
        "INSERT INTO turn
           (conversation_id, ended_at, status_tier, in_tokens, out_tokens,
            cache_read_tokens, cache_write_tokens, cache_tokens, usd)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            conversation_id,
            now(),
            status_tier,
            in_tokens,
            out_tokens,
            cache_read_tokens,
            cache_write_tokens,
            cache_read_tokens + cache_write_tokens,
            usd
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// What this studio has spent since a moment, in dollars — the figure in the
/// title bar and the warmth in the ground.
///
/// The cutoff is an argument rather than something worked out here, and both
/// halves of that are deliberate. "Today" is a *local* day, and the timezone —
/// with the two days a year its offset moves — is knowledge the front end has
/// and this file would have to grow a calendar to acquire. And a wall left open
/// overnight has to roll over, so the boundary is a moving argument rather than
/// a constant either way; `Skein.dayTick` is what notices.
///
/// Read off `turn`, which is the only place the wall records what a turn cost,
/// so this covers cards closed earlier today and turns taken in a previous run
/// of the app — everything the day's figure used to lose. It is *this* studio's
/// spend and not the account's: turns taken in a terminal are in no `turn` row,
/// which is what the usage widget reads transcripts for.
///
/// No index on `ended_at`. The table is one row per settled turn and the query
/// is a SUM of a few tens of thousands of tiny rows, run as a turn settles and
/// once when the day rolls; an index would cost a migration to save a fraction
/// of a millisecond.
#[tauri::command]
pub fn spend_since(store: tauri::State<'_, Store>, since: i64) -> Result<f64, String> {
    let conn = store.0.lock().unwrap();
    spend_row(&conn, since)
}

/// The statement itself, so it can be tested without a Tauri app.
fn spend_row(conn: &Connection, since: i64) -> Result<f64, String> {
    /* COALESCE because SUM over no rows is NULL, and a day with nothing spent
       in it yet is the normal state at nine in the morning. */
    conn.query_row(
        "SELECT COALESCE(SUM(usd), 0) FROM turn WHERE ended_at >= ?1",
        params![since],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
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

/// A card's whole placement: where it belongs on the wall, and where it is
/// drawn if it has been stuck to the glass.
///
/// Every column is written every time, with no COALESCE anywhere -- unlike
/// `update_conversation`, which leaves an absent argument alone. That is
/// deliberate, and the front end holds up the other end of it (`savePlacement`
/// takes the whole placement, never a piece of one): the two positions are set
/// by different gestures, so a partial write would mean dragging a territory
/// silently un-sticking every card in it, with no error anywhere to see it by.
/// `glass_x`/`glass_y` have to be able to say "on the wall", which is exactly
/// what a COALESCE cannot express -- the same reason `clear_conversation` is a
/// command of its own rather than more arguments on `update_conversation`.
#[tauri::command]
pub fn save_placement(
    store: tauri::State<'_, Store>,
    conversation_id: String,
    x: f64,
    y: f64,
    pinned: bool,
    glass_x: Option<f64>,
    glass_y: Option<f64>,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute(
        "INSERT INTO placement (conversation_id, x, y, pinned, glass_x, glass_y)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(conversation_id) DO UPDATE SET
           x = ?2, y = ?3, pinned = ?4, glass_x = ?5, glass_y = ?6",
        params![conversation_id, x, y, pinned as i64, glass_x, glass_y],
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
        .prepare(
            "SELECT id, name, root_path, x, y, glass_x, glass_y
               FROM project ORDER BY created_at",
        )
        .map_err(|e| e.to_string())?;
    let projects = ps
        .query_map([], |r| {
            Ok(Project {
                id: r.get(0)?,
                name: r.get(1)?,
                root_path: r.get(2)?,
                x: r.get(3)?,
                y: r.get(4)?,
                glass_x: r.get(5)?,
                glass_y: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut cs = conn
        .prepare(
            "SELECT c.id, c.agent_session_id, c.project_id, c.cwd, c.title, c.worktree,
                    c.model, c.interrupted, c.last_ctx_frac, c.last_ending, c.aside,
                    c.kind,
                    p.x, p.y, p.pinned, p.glass_x, p.glass_y
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
                aside: r.get::<_, i64>(10)? != 0,
                kind: r.get(11)?,
                x: r.get(12)?,
                y: r.get(13)?,
                pinned: r.get::<_, Option<i64>>(14)?.unwrap_or(0) != 0,
                glass_x: r.get(15)?,
                glass_y: r.get(16)?,
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

/// `rename_all` is a no-op for every field that was already here — they are all
/// one word — and gives the glass pair the `glassX`/`glassY` the front end
/// speaks everywhere else. See `migrate_v9`.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RefImage {
    pub id: String,
    pub path: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub rotation: f64,
    pub z: i64,
    /// Where it is drawn if it has been stuck to the glass, or `None` for one
    /// on the wall. Never a substitute for `x`/`y`.
    ///
    /// `default` because these arrive from the front end as well as leaving for
    /// it, and a payload written by a build that predates the glass has to be
    /// readable as "on the wall" rather than refused.
    #[serde(default)]
    pub glass_x: Option<f64>,
    #[serde(default)]
    pub glass_y: Option<f64>,
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

/// What kind of image these bytes are, read off the bytes themselves.
///
/// The clipboard route has no filename to take an extension from, and the front
/// end's `type` string is not a fact about the bytes — so this asks the bytes.
/// The extension it returns is what names the file, and the asset protocol
/// serves a content type off that name, so a guess here would be served as a
/// lie later. `None` means "nothing we can draw", which is the honest answer for
/// the audio, the html and the shortcut that also live on a clipboard.
fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    let head = |sig: &[u8]| bytes.starts_with(sig);
    if head(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if head(b"\xff\xd8\xff") {
        Some("jpg")
    } else if head(b"GIF87a") || head(b"GIF89a") {
        Some("gif")
    } else if head(b"BM") {
        Some("bmp")
    /* RIFF is a container — the four bytes after the length say which one, and
       only WEBP is an image. */
    } else if head(b"RIFF") && bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        Some("webp")
    /* AVIF is ISO-BMFF: a length, then `ftyp`, then the brand. */
    } else if bytes.len() > 12 && &bytes[4..8] == b"ftyp" && &bytes[8..12] == b"avif" {
        Some("avif")
    } else {
        None
    }
}

/// Give bytes off the clipboard the same home an imported file gets.
///
/// A screenshot has no path: Windows' capture tools put a bitmap on the
/// clipboard and write nothing to disk, so `import_image`'s copy-from-a-path has
/// nothing to copy from. Everything downstream is unchanged — the file lands in
/// the same `references` directory, which is the only place the asset protocol
/// will serve from.
///
/// The bytes ride as a raw IPC body (`InvokeBody::Raw`) rather than as command
/// arguments, because a `Vec<u8>` argument is serialised as a JSON array of
/// numbers: a two-megabyte screenshot would cross as roughly eight million
/// characters of text.
#[tauri::command]
pub fn paste_image(
    store: tauri::State<'_, Store>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("clipboard image arrived as json, not bytes".into());
    };
    let Some(ext) = sniff_image(bytes) else {
        return Err("clipboard holds no image we can draw".into());
    };

    let dir = store.1.join("references");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create references dir: {e}"))?;
    let dest = dir.join(format!("{}.{ext}", uuid_v4()));
    std::fs::write(&dest, bytes).map_err(|e| format!("write pasted image: {e}"))?;
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
        .prepare(
            "SELECT id, path, x, y, w, h, rotation, z, glass_x, glass_y
               FROM reference_image ORDER BY z, created_at",
        )
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
                glass_x: r.get(8)?,
                glass_y: r.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_image(store: tauri::State<'_, Store>, image: RefImage) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    conn.execute(
        "INSERT INTO reference_image
           (id, path, x, y, w, h, rotation, z, glass_x, glass_y, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
           x = ?3, y = ?4, w = ?5, h = ?6, rotation = ?7, z = ?8,
           glass_x = ?9, glass_y = ?10",
        params![
            image.id, image.path, image.x, image.y, image.w, image.h,
            image.rotation, image.z, image.glass_x, image.glass_y, now()
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

/// `rename_all` as on `RefImage`, and for the same reason.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Widget {
    pub id: String,
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub z: i64,
    /// Where it is drawn if it has been stuck to the glass, or `None` for one
    /// on the wall. Never a substitute for `x`/`y`.
    ///
    /// `default` because these arrive from the front end as well as leaving for
    /// it, and a payload written by a build that predates the glass has to be
    /// readable as "on the wall" rather than refused.
    #[serde(default)]
    pub glass_x: Option<f64>,
    #[serde(default)]
    pub glass_y: Option<f64>,
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
        .prepare(
            "SELECT id, kind, x, y, w, h, z, config_json, glass_x, glass_y
               FROM widget ORDER BY z, created_at",
        )
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
                glass_x: r.get(8)?,
                glass_y: r.get(9)?,
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
        "INSERT INTO widget
           (id, kind, x, y, w, h, z, config_json, glass_x, glass_y, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
           x = ?3, y = ?4, w = ?5, h = ?6, z = ?7, config_json = ?8,
           glass_x = ?9, glass_y = ?10",
        params![
            w.id, w.kind, w.x, w.y, w.w, w.h, w.z, config, w.glass_x, w.glass_y, now()
        ],
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

/* ── the pomodoro cycle ────────────────────────────────────────────────────
 *
 * One row or none. See `migrate_v8` for why it is not a widget's config. */

/// The cycle as last written, or `None` when no pomodoro has ever been started
/// here. `None` is a real answer rather than a failure — the front end reads it
/// as the default cycle, switched off, which is what an untouched studio is.
#[tauri::command]
pub fn read_pomodoro(store: tauri::State<'_, Store>) -> Result<Option<serde_json::Value>, String> {
    let conn = store.0.lock().unwrap();
    read_pomodoro_row(&conn)
}

fn read_pomodoro_row(conn: &Connection) -> Result<Option<serde_json::Value>, String> {
    let raw: Option<String> = conn
        .query_row("SELECT state_json FROM pomodoro WHERE id = 1", [], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    /* A state that will not parse is a studio with no cycle running, not an
       error to put on the fault bar: `normalizeCycle` fills in every field it
       does not find, so `null` is the honest fallback and the next write
       repairs the row. */
    Ok(raw.map(|s| serde_json::from_str(&s).unwrap_or(serde_json::Value::Null)))
}

/// Upsert the cycle. Written on every transition and on a slow beat while one
/// is running, so like `save_widget` it has to be cheap.
#[tauri::command]
pub fn save_pomodoro(
    store: tauri::State<'_, Store>,
    state: serde_json::Value,
) -> Result<(), String> {
    let conn = store.0.lock().unwrap();
    save_pomodoro_row(&conn, &state)
}

fn save_pomodoro_row(conn: &Connection, state: &serde_json::Value) -> Result<(), String> {
    let json = serde_json::to_string(state).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO pomodoro (id, state_json, updated_at) VALUES (1, ?1, ?2)
         ON CONFLICT(id) DO UPDATE SET state_json = ?1, updated_at = ?2",
        params![json, now()],
    )
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
    fn sniff_image_names_the_format_from_the_bytes() {
        assert_eq!(sniff_image(b"\x89PNG\r\n\x1a\n\x00\x00"), Some("png"));
        assert_eq!(sniff_image(b"\xff\xd8\xff\xe0JFIF"), Some("jpg"));
        assert_eq!(sniff_image(b"GIF89a\x01\x00"), Some("gif"));
        assert_eq!(sniff_image(b"BM\x36\x00\x00\x00"), Some("bmp"));
        assert_eq!(sniff_image(b"RIFF\x24\x00\x00\x00WEBPVP8 "), Some("webp"));
        assert_eq!(sniff_image(b"\x00\x00\x00\x20ftypavif\x00\x00"), Some("avif"));

        /* A RIFF that is not an image, and a clipboard holding text: both are
           "nothing to draw" rather than a file to write with a wrong name. */
        assert_eq!(sniff_image(b"RIFF\x24\x00\x00\x00WAVEfmt "), None);
        assert_eq!(sniff_image(b"hello from the clipboard"), None);
        assert_eq!(sniff_image(b""), None);

        /* Short enough that the container checks would index out of bounds if
           they read the brand before checking the length. */
        assert_eq!(sniff_image(b"RIFF"), None);
        assert_eq!(sniff_image(b"\x00\x00\x00\x20ftyp"), None);
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
        // A card put by stays put by across a launch — the rousing queue reads
        // this before it spawns anything.
        assert!(cols.contains(&"aside".to_string()));
    }

    /// The whole risk in migration v6 is the default: every row that existed
    /// before the column did is a card nobody has set aside, and a NULL there
    /// would come back through `load_studio` as neither true nor false.
    #[test]
    fn a_card_nobody_has_put_by_reads_as_such() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES ('c1','p1','C:/x',0)",
            [],
        )
        .unwrap();

        let aside: i64 = conn
            .query_row("SELECT aside FROM conversation WHERE id = 'c1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(aside, 0);
    }

    /// It goes both ways, which is the thing a COALESCEd column can normally
    /// only half-do — see the note on `update_conversation`. Nothing here ever
    /// means "put it back to the default", so an explicit false is enough.
    #[test]
    fn setting_a_card_aside_and_picking_it_back_up_both_land() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES ('c1','p1','C:/x',0)",
            [],
        )
        .unwrap();

        let set = |v: bool| {
            conn.execute(
                "UPDATE conversation SET aside = COALESCE(?2, aside) WHERE id = ?1",
                params!["c1", Some(v)],
            )
            .unwrap();
            conn.query_row::<i64, _, _>(
                "SELECT aside FROM conversation WHERE id = 'c1'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };

        assert_eq!(set(true), 1);
        assert_eq!(set(false), 0);

        // And an absent argument leaves whatever is there alone, so a settling
        // turn writing its context fraction cannot quietly pick a card back up.
        conn.execute(
            "UPDATE conversation SET aside = COALESCE(?2, aside) WHERE id = ?1",
            params!["c1", None::<bool>],
        )
        .unwrap();
        let after: i64 = conn
            .query_row("SELECT aside FROM conversation WHERE id = 'c1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(after, 0);
    }

    /// Clearing swaps the session and keeps the card. The distinction is the
    /// whole feature: placements, turns and file touches all key on `id`, so an
    /// id that changed would leave the card standing somewhere else with none
    /// of its history attached.
    #[test]
    fn clearing_repoints_the_row_without_moving_the_card() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        import_row(&conn, "s1", "p1", "C:/x", Some("some work"), None, Some(0.8), None).unwrap();
        conn.execute(
            "INSERT INTO placement (conversation_id, x, y, pinned) VALUES ('s1', 40, 90, 1)",
            [],
        )
        .unwrap();

        clear_row(&conn, "s1", "s2").unwrap();

        let (session, title, frac, ending, interrupted): (
            String,
            String,
            f64,
            Option<String>,
            i64,
        ) = conn
            .query_row(
                "SELECT agent_session_id, title, last_ctx_frac, last_ending, interrupted
                   FROM conversation WHERE id = 's1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(session, "s2", "the card is still pointed at the old session");
        assert_eq!(title, "untitled", "the next prompt has to be able to name it");
        assert_eq!(frac, 0.0, "a fresh session holds no context");
        /* NULL, not 'ok': the front end reads NULL as "never spoke" and only
           then spawns with --session-id. Left as 'ok' the card would wake with
           --resume against a transcript that does not exist. */
        assert_eq!(ending, None);
        assert_eq!(interrupted, 0);

        let pinned: (f64, f64, i64) = conn
            .query_row(
                "SELECT x, y, pinned FROM placement WHERE conversation_id = 's1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(pinned, (40.0, 90.0, 1), "clearing moved the card off its pin");
    }

    #[test]
    fn clearing_a_card_that_is_not_there_says_so() {
        let conn = db();
        assert!(clear_row(&conn, "ghost", "s2").is_err());
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

    /// The day's figure: everything the wall spent since the cutoff, whoever
    /// spent it and whether or not that card is still open.
    #[test]
    fn the_days_spend_sums_every_turn_past_the_cutoff() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        for id in ["open", "closed"] {
            conn.execute(
                "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES (?1,'p1','C:/x',0)",
                params![id],
            )
            .unwrap();
        }
        // A card closed this afternoon still spent what it spent this morning.
        conn.execute(
            "UPDATE conversation SET closed_at = 500 WHERE id = 'closed'",
            [],
        )
        .unwrap();
        let turn = |id: &str, at: i64, usd: f64| {
            conn.execute(
                "INSERT INTO turn (conversation_id, ended_at, status_tier, usd)
                 VALUES (?1, ?2, 'rest', ?3)",
                params![id, at, usd],
            )
            .unwrap();
        };
        turn("open", 50, 1.0); // yesterday
        turn("open", 100, 2.0); // exactly on the boundary — the day owns its own midnight
        turn("open", 150, 0.5);
        turn("closed", 200, 0.25);

        assert_eq!(spend_row(&conn, 100).unwrap(), 2.75);
        assert_eq!(spend_row(&conn, 0).unwrap(), 3.75, "the whole table");
        assert_eq!(
            spend_row(&conn, 900).unwrap(),
            0.0,
            "a day with nothing in it yet is zero, not an error"
        );
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

    /// Every flag stored before v10 was written by a shutdown that counted
    /// processes rather than turns, and rousing gives every card a process — so
    /// they are cleared wholesale rather than trusted.
    #[test]
    fn v10_clears_the_flags_the_old_shutdown_wrote() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at, interrupted)
             VALUES ('resting','p1','C:/x',0,1)",
            [],
        )
        .unwrap();

        migrate_v10(&conn).unwrap();

        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM conversation WHERE interrupted = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0, "a resting card would be sent a resume prompt at launch");
    }

    /// Every row that existed before the column did is a project card, and the
    /// default has to say so — a v11 that left `kind` NULL would leave
    /// `kind_of` reading NULL for the whole wall.
    #[test]
    fn v11_gives_every_existing_card_the_kind_it_already_had() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        /* Start from a database that predates the column, as an install would. */
        migrate_v1(&conn).unwrap();
        seed_project(&conn, "p1", "C:/x");
        conn.execute(
            "INSERT INTO conversation (id, project_id, cwd, born_at) VALUES ('old','p1','C:/x',0)",
            [],
        )
        .unwrap();

        migrate_v11(&conn).unwrap();

        assert_eq!(kind_row(&conn, "old"), "project");
    }

    /// The store is what the argv is built from, so this is the whole of what
    /// makes a chat card one.
    #[test]
    fn a_recorded_kind_is_what_comes_back_out() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        record_row(&conn, "talk", "p1", "C:/x", None, Some("chat")).unwrap();
        record_row(&conn, "work", "p1", "C:/x", None, None).unwrap();

        assert_eq!(kind_row(&conn, "talk"), "chat");
        assert_eq!(
            kind_row(&conn, "work"),
            "project",
            "a caller that says nothing means the card it has always meant"
        );
    }

    /// An id with no row answers `project`, and the direction matters: the
    /// unknown case must fall to the card the wall has always had, never to the
    /// one whose tools are gone. A chat card is only ever chat because a row
    /// says so — so a lost row costs a card its sandbox, loudly, rather than
    /// costing a working card its tools, silently.
    #[test]
    fn an_id_with_no_row_is_a_project_card() {
        let conn = db();
        assert_eq!(kind_row(&conn, "never-recorded"), "project");
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

    /// The glass is beside the wall, never instead of it. This is the whole
    /// round trip the feature rests on: a territory stuck to the pane must come
    /// back off it standing exactly where it was packed, so the two positions
    /// have to be written and read independently.
    #[test]
    fn sticking_a_territory_leaves_its_place_on_the_wall_alone() {
        let conn = db();
        seed_project(&conn, "p1", "C:/x");
        place_row(&conn, "C:/x", Some(1100.0), Some(560.0)).unwrap();

        let at = || -> (Option<f64>, Option<f64>, Option<f64>, Option<f64>) {
            conn.query_row(
                "SELECT x, y, glass_x, glass_y FROM project WHERE root_path='C:/x'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap()
        };
        assert_eq!(at(), (Some(1100.0), Some(560.0), None, None));

        stick_row(&conn, "C:/x", Some(40.0), Some(90.0)).unwrap();
        assert_eq!(
            at(),
            (Some(1100.0), Some(560.0), Some(40.0), Some(90.0)),
            "sticking says nothing about where the territory belongs"
        );

        stick_row(&conn, "C:/x", None, None).unwrap();
        assert_eq!(
            at(),
            (Some(1100.0), Some(560.0), None, None),
            "and putting it back gives it its own cell, not a fresh one"
        );
    }

    /// v9 adds the same pair to four tables, and the one that would go unnoticed
    /// is `placement` — a card's glass spot is the only one whose absence looks
    /// exactly like a card nobody ever stuck.
    #[test]
    fn an_existing_database_gains_the_glass_columns() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate_v1(&conn).unwrap();

        migrate(&conn).unwrap();

        for table in ["placement", "project", "reference_image", "widget"] {
            let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})")).unwrap();
            let cols: Vec<String> = stmt
                .query_map([], |r| r.get::<_, String>(1))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            assert!(cols.contains(&"glass_x".to_string()), "{table} has no glass_x");
            assert!(cols.contains(&"glass_y".to_string()), "{table} has no glass_y");
        }
    }

    /// A widget's glass spot rides on the same upsert as everything else about
    /// it, so taking one off the pane has to actually clear the columns rather
    /// than leave the old spot behind for the next launch to read back.
    #[test]
    fn a_widget_remembers_the_pane_and_forgets_it_again() {
        let conn = db();
        let mut w = widget("w1", "clock", serde_json::json!({}));
        w.glass_x = Some(120.0);
        w.glass_y = Some(64.0);
        save_widget_row(&conn, &w).unwrap();
        let got = &list_widget_rows(&conn).unwrap()[0];
        assert_eq!((got.glass_x, got.glass_y), (Some(120.0), Some(64.0)));
        assert_eq!((got.x, got.y), (10.0, 20.0), "the wall position is untouched");

        w.glass_x = None;
        w.glass_y = None;
        save_widget_row(&conn, &w).unwrap();
        let back = &list_widget_rows(&conn).unwrap()[0];
        assert_eq!((back.glass_x, back.glass_y), (None, None));
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
            glass_x: None,
            glass_y: None,
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

    /// A studio that has never run a pomodoro has no row, and that is an answer
    /// rather than a failure — the front end reads `None` as the default cycle,
    /// switched off.
    #[test]
    fn a_studio_with_no_cycle_reports_none() {
        let conn = db();
        assert!(read_pomodoro_row(&conn).unwrap().is_none());
    }

    /// The same bargain the widget config and the layer stack have: the phase
    /// machine lives in `timing.ts` and Rust holds its state without
    /// understanding a field of it, so anything invented there must survive the
    /// round trip untouched.
    #[test]
    fn a_cycle_comes_back_exactly_as_it_went_in() {
        let conn = db();
        let state = serde_json::json!({
            "cadence": "50/10",
            "per": 4,
            "done": 3,
            "since": 1_760_000_000_000i64,
            "banked": 42.5,
            "snoozedUntil": 0,
            "pushed": 2,
            "on": true,
            "paused": false,
            "invented_tomorrow": ["anything"],
        });
        save_pomodoro_row(&conn, &state).unwrap();
        assert_eq!(read_pomodoro_row(&conn).unwrap().unwrap(), state);
    }

    /// One cycle per studio, so writing it twice must leave one row — the
    /// `CHECK (id = 1)` is the schema saying so, and this is the upsert
    /// honouring it. Two rows would leave the front end picking by row order,
    /// which is an afternoon that changes when nothing did.
    #[test]
    fn saving_the_cycle_twice_leaves_one_row() {
        let conn = db();
        save_pomodoro_row(&conn, &serde_json::json!({ "done": 1 })).unwrap();
        save_pomodoro_row(&conn, &serde_json::json!({ "done": 2 })).unwrap();

        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM pomodoro", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "the studio grew a second pomodoro cycle");
        assert_eq!(read_pomodoro_row(&conn).unwrap().unwrap()["done"], 2);
    }

    /// A state that will not parse is a studio with no cycle running, not a
    /// fault to put on the red bar: the next write repairs the row.
    #[test]
    fn an_unparseable_cycle_still_reads() {
        let conn = db();
        conn.execute(
            "INSERT INTO pomodoro (id, state_json, updated_at) VALUES (1, 'not json at all', 0)",
            [],
        )
        .unwrap();
        assert_eq!(read_pomodoro_row(&conn).unwrap().unwrap(), serde_json::Value::Null);
    }

    /// v8 has to land on databases that already exist — the whole reason a
    /// schema change is a numbered step.
    #[test]
    fn an_existing_database_gains_the_pomodoro_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate_v1(&conn).unwrap();

        migrate(&conn).unwrap();

        save_pomodoro_row(&conn, &serde_json::json!({ "on": true })).unwrap();
        assert_eq!(read_pomodoro_row(&conn).unwrap().unwrap()["on"], true);
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
