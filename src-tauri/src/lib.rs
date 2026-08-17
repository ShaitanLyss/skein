mod actions;
mod ask;
/// Public so `examples/azdo-probe.rs` can drive the real reading rather than a
/// copy of it — the convention `tools/probe-context.ts` sets for questions of
/// the form "what does this service actually do".
pub mod azdo;
mod control;
mod open;
mod perf;
mod project;
mod servers;
mod sessions;
mod shell;
mod store;
mod supervisor;
mod usage;

use actions::Runs;
use ask::Asks;
use azdo::Azdo;
use control::Control;
use perf::Meter;
use servers::Servers;
use shell::Shells;
use store::Store;
use supervisor::Supervisor;
use usage::Usage;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Supervisor::default())
        .manage(Servers::default())
        /* Empty until Alt+I asks for one — a wall nobody has opened a shell on
           holds no process, and the one it holds outlives the panel being
           toggled shut. */
        .manage(Shells::default())
        .manage(Runs::default())
        .manage(Asks::default())
        .manage(Control::default())
        /* Empty until a performance widget asks: an app with none on the wall
           never enumerates a process. */
        .manage(Meter::default())
        /* Likewise empty until a usage widget asks. It holds a read offset per
           transcript and the requests already counted, so the first reading
           costs a week of files and every one after it costs the tail. */
        .manage(Usage::default())
        /* And likewise empty until a pipelines or reviews widget asks. It holds
           the credential ladder, so a wall with neither on it never spawns a
           `git credential` and never holds a token. */
        .manage(Azdo::default())
        .setup(|app| {
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("no app data dir: {e}"))?;
            app.manage(Store::open(dir.clone())?);
            /* Bind the ask endpoint before any conversation can be spawned,
               so every one of them gets a working --mcp-config. */
            let port = ask::start(app.handle().clone())?;
            app.state::<Asks>().set_port(port);
            /* Off unless SKEIN_CONTROL says otherwise. When it is on, the title
               bar says so — see src/lib/control.svelte.ts. */
            if let Some(ep) = control::start(app.handle().clone(), &dir)? {
                app.state::<Control>().set_endpoint(ep);
            }
            Ok(())
        })
        /* Closing the studio closes the app.
         *
         * `peek` is declared in tauri.conf.json and created at startup, then only
         * ever hidden — never destroyed, which is right for a notification
         * surface. But the run loop exits once *every* window has closed, so
         * closing the studio left a live process with nothing on screen: ports
         * still bound, SQLite still held, control.json still advertising a token,
         * and every spawned `claude` still editing a repo with nobody watching.
         * None of the cleanup below had run, because nothing had asked the app to
         * exit. The only way out was Task Manager. */
        .on_window_event(|window, event| {
            if window.label() == "main"
                && matches!(event, tauri::WindowEvent::CloseRequested { .. })
            {
                window.app_handle().exit(0);
            }
        })
        .invoke_handler(tauri::generate_handler![
            supervisor::spawn_conversation,
            supervisor::send_prompt,
            supervisor::interrupt_conversation,
            supervisor::close_conversation,
            supervisor::read_ai_title,
            supervisor::read_transcript,
            supervisor::wake_quiet,
            sessions::list_sessions,
            store::import_conversation,
            store::forget_project,
            store::load_studio,
            store::ensure_project,
            store::record_conversation,
            store::chat_home,
            store::update_conversation,
            store::clear_conversation,
            store::record_turn,
            store::spend_since,
            store::record_file_touch,
            store::overlapping_conversations,
            store::save_placement,
            store::place_project,
            store::stick_project,
            store::close_conversation_record,
            store::save_server_group,
            store::delete_server_group,
            store::classify_drop,
            store::import_image,
            store::paste_image,
            store::list_images,
            store::save_image,
            store::delete_image,
            store::list_widgets,
            store::save_widget,
            store::delete_widget,
            store::read_pomodoro,
            store::save_pomodoro,
            perf::sample_performance,
            perf::release_performance,
            usage::read_usage,
            azdo::azdo_runs,
            azdo::azdo_reviews,
            azdo::release_azdo,
            store::list_ambience,
            store::save_ambience,
            store::activate_ambience,
            store::delete_ambience,
            servers::start_group,
            servers::stop_group,
            servers::group_running,
            servers::servers_quiet,
            servers::probe_ports,
            shell::open_shell,
            shell::shell_send,
            shell::close_shell,
            shell::shell_alive,
            project::probe_project,
            project::poll_projects,
            project::fetch_projects,
            actions::run_action,
            actions::cancel_action,
            actions::tail_log,
            actions::read_tail,
            actions::unreal_exec,
            actions::launch_detached,
            actions::focus_process,
            actions::close_process,
            actions::process_alive,
            ask::answer_ask,
            open::open_external,
            control::control_endpoint,
            control::control_attach,
            control::control_reply,
            control::control_real_click,
            control::control_real_drag,
        ])
        .build(tauri::generate_context!())
        .expect("error while building skein")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                /* Children die with the app: nothing is left editing a repo
                   unwatched, and no orphan keeps holding a dev server port.
                   Anything still open is marked interrupted so its card comes
                   back saying so rather than pretending it finished. */
                let running = app.state::<Supervisor>().shutdown();
                app.state::<Servers>().shutdown();
                /* And the shell, which is the one process here a person was
                   driving by hand — so it can be holding anything at all. */
                app.state::<Shells>().shutdown();
                /* A build left running would go on writing to a repo nobody is
                   watching, exactly as a conversation would. */
                app.state::<Runs>().shutdown();
                /* Take the published control token away with us, so a dead port
                   never reads as a live one. */
                app.state::<Control>().cleanup();
                if let Some(store) = app.try_state::<Store>() {
                    if let Ok(conn) = store.0.lock() {
                        store::mark_interrupted(&conn, &running);
                    }
                }
            }
        });
}
