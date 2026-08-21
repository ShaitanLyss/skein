// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    /* Before anything else, because this binary is also the `PreToolUse` hook it
       hands its cards and a hook invocation must not open a store or a window.
       See `hooks.rs`. The GUI subsystem above does not get in the way: with no
       console attached the standard handles are the ones the parent redirected,
       which for a hook is always a pipe. */
    if skein_lib::hooks::intercept() {
        return;
    }

    skein_lib::run()
}
