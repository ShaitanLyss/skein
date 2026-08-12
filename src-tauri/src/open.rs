//! Handing a link to the rest of the desktop.
//!
//! The transcript renders markdown, and markdown has links. An `<a href>` in
//! this webview would navigate the *studio* to it — the window has no back
//! button and no address bar, so that is a one-way trip out of the app. So a
//! click on a link is a command instead, and the link opens where a link should.
//!
//! `rundll32 url.dll,FileProtocolHandler` rather than `cmd /c start`: `start`
//! goes through the shell, which reads `&` and `^` in a url as its own syntax,
//! and the url here is a string an agent wrote. rundll32 takes it as one
//! argument and hands it to the registered protocol handler — no shell in the
//! middle. The scheme is checked here as well as in `markdown.ts::safeHref`,
//! because a command is reachable from anything holding the IPC, not only from
//! the code path that rendered the link.

/// Is this something we are willing to hand to the shell's protocol handlers?
/// Only the three schemes a transcript can legitimately point at.
fn openable(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    let scheme = lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:");
    scheme && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !openable(&url) {
        return Err(format!("refusing to open {url}"));
    }

    #[cfg(windows)]
    {
        std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
            .map_err(|e| format!("could not open {url}: {e}"))?;
        Ok(())
    }

    #[cfg(not(windows))]
    {
        Err("opening links is implemented for windows only".into())
    }
}

#[cfg(test)]
mod tests {
    use super::openable;

    #[test]
    fn ordinary_web_and_mail_links_are_openable() {
        assert!(openable("https://example.com/a?b=1&c=2"));
        assert!(openable("http://localhost:1420/"));
        assert!(openable("mailto:someone@example.com"));
        assert!(openable("HTTPS://Example.com"));
    }

    #[test]
    fn other_schemes_are_refused() {
        // The front end filters these too; this is the side that can't be skipped.
        assert!(!openable("javascript:alert(1)"));
        assert!(!openable("data:text/html,<script>"));
        assert!(!openable("file:///C:/Windows/System32/calc.exe"));
        assert!(!openable("C:\\Windows\\System32\\calc.exe"));
        assert!(!openable(""));
    }

    #[test]
    fn whitespace_means_it_was_never_one_url() {
        assert!(!openable("https://example.com /x"));
        assert!(!openable("https://example.com\nhttps://evil.example"));
    }
}
