//! What `/api/oauth/usage` actually answers, through the client Skein uses.
//!
//! ```powershell
//! cd src-tauri; cargo run --example limits-probe
//! ```
//!
//! The convention `tools/probe-context.ts` and `examples/azdo-probe.rs` set: when
//! the question is "what does this service really do", drive it with the app's
//! exact client rather than reasoning about it. There are two things here that a
//! unit test cannot answer, and both have bitten this repo before.
//!
//! **The TLS one.** `azdo.md` records at length that this network presents
//! certificates signed by a Netskope CA whose root is in the Windows store and in
//! no bundled root set — so a client built the obvious way fails on every request
//! here and works perfectly on the developer's home wifi. `ureq` with
//! `native-certs` is chosen for exactly that, and this probe is what demonstrates
//! the choice reaches `api.anthropic.com` too rather than only `dev.azure.com`.
//! Curl or PowerShell proving the endpoint works proves nothing about it: those
//! go through schannel, which was never the thing in doubt.
//!
//! **The shape one.** The response carries a named key per window *and* a
//! normalised `limits[]` array, and `limits.rs` reads the array on the argument
//! that the names are unstable — seven of them were codenames for windows that do
//! not exist yet on 2026-08-17. This prints both, so that argument can be checked
//! against the account rather than taken on faith.
//!
//! Prints no token and no fragment of one.

fn main() {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .expect("no home directory");
    let path = std::path::Path::new(&home).join(".claude").join(".credentials.json");

    let token = match std::env::var("CLAUDE_CODE_OAUTH_TOKEN") {
        Ok(v) if !v.trim().is_empty() => {
            println!("token from CLAUDE_CODE_OAUTH_TOKEN");
            v.trim().to_string()
        }
        _ => {
            let raw = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("no sign-in at {}: {e}", path.display()));
            let doc: serde_json::Value = serde_json::from_str(&raw).expect("unreadable sign-in");
            let oauth = &doc["claudeAiOauth"];
            let expires = oauth["expiresAt"].as_i64().unwrap_or(0);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64;
            println!(
                "token from the CLI's sign-in — plan {}, expires in {} min",
                oauth["subscriptionType"].as_str().unwrap_or("?"),
                (expires - now) / 60_000
            );
            oauth["accessToken"]
                .as_str()
                .expect("no access token")
                .to_string()
        }
    };

    let started = std::time::Instant::now();
    let res = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(5))
        .timeout_read(std::time::Duration::from_secs(10))
        .build()
        .get("https://api.anthropic.com/api/oauth/usage")
        .set("Authorization", &format!("Bearer {token}"))
        .set("Accept", "application/json")
        .set("anthropic-beta", "oauth-2025-04-20")
        .call();

    let doc: serde_json::Value = match res {
        Ok(r) => {
            println!("200 in {}ms — the handshake went through\n", started.elapsed().as_millis());
            r.into_json().expect("unreadable answer")
        }
        Err(ureq::Error::Status(code, r)) => {
            let body = r.into_string().unwrap_or_default();
            panic!("answered {code}: {}", body.chars().take(200).collect::<String>());
        }
        Err(e) => panic!("could not reach it: {e}"),
    };

    println!("limits[] — what limits.rs reads:");
    match doc["limits"].as_array() {
        Some(rows) if !rows.is_empty() => {
            for r in rows {
                println!(
                    "  {:<14} {:>6}%  severity {:<8} active {:<5} resets {}  scope {}",
                    r["kind"].as_str().unwrap_or("?"),
                    r["percent"],
                    r["severity"].as_str().unwrap_or("?"),
                    r["is_active"],
                    r["resets_at"].as_str().unwrap_or("—"),
                    r["scope"]["model"]["display_name"].as_str().unwrap_or("—"),
                );
            }
        }
        _ => println!("  (none — limits.rs would fall back to the named keys)"),
    }

    println!("\nthe named keys — why the array is preferred:");
    if let Some(obj) = doc.as_object() {
        let (mut real, mut null) = (0, 0);
        for (k, v) in obj {
            if matches!(k.as_str(), "limits" | "extra_usage" | "spend" | "member_dashboard_available")
            {
                continue;
            }
            if v.is_null() {
                null += 1;
                println!("  {k:<28} null");
            } else {
                real += 1;
                println!("  {k:<28} {}%", v["utilization"]);
            }
        }
        println!("\n  {real} carry a figure, {null} are null placeholders");
    }
}
