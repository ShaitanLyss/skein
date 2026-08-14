//! Does Skein reach Azure DevOps from here, and with whose credential?
//!
//!     cargo run --example azdo-probe -- ../../nova ../../rise
//!
//! The counterpart to `tools/probe-context.ts`, one layer down and pointed at a
//! service rather than at the CLI: it drives `azdo::runs_with` and
//! `azdo::reviews_with` — the same functions the two Tauri commands are thin
//! wrappers over — against real project roots, and prints what came back.
//!
//! Two questions it exists to answer, neither of which can be assumed:
//!
//! 1. **Does TLS resolve at all?** This network runs Netskope interception, so
//!    `dev.azure.com` presents a certificate signed by a corporate root that is
//!    in Windows' store and in no bundled root set. A client built the obvious
//!    way fails every request here with a certificate error and works perfectly
//!    on the developer's home wifi, which is the worst shape a bug can have.
//!
//! 2. **Which rung of the credential ladder does each endpoint accept?** Probed
//!    2026-08-14 against org `LagardereAWPL` with claude-adjacent tooling: the
//!    credential Git Credential Manager holds returns 200 on `_apis/projects`
//!    and `_apis/git/pullrequests` and **401 on every build endpoint**, because
//!    GCM issues a code-scoped token. That single fact is why the ladder falls
//!    through on refusal rather than stopping at the first credential it finds.
//!
//! Nothing here is a test — it talks to the network and to whatever identity
//! this machine is signed in as, so it is run by hand and its findings are
//! written into the comments that depend on them.

fn main() {
    let roots: Vec<String> = std::env::args().skip(1).collect();
    if roots.is_empty() {
        eprintln!("usage: cargo run --example azdo-probe -- <project root> [<project root>…]");
        eprintln!("       (the roots are read for their `origin` remote, exactly as the wall does)");
        std::process::exit(2);
    }

    println!("roots      {}", roots.join("  "));

    /* One cache across both readings, which is also what the app does — so the
       project list and the identity are fetched once and the second reading
       shows the cache working rather than a cold start twice. */
    let mut cache = skein_lib::azdo::Cache::default();

    let t0 = std::time::Instant::now();
    let reviews = skein_lib::azdo::reviews_with(&mut cache, &roots);
    let reviews_ms = t0.elapsed().as_millis();

    let t1 = std::time::Instant::now();
    let runs = skein_lib::azdo::runs_with(&mut cache, &roots);
    let runs_ms = t1.elapsed().as_millis();

    show("reviews", reviews_ms, &serde_json::to_value(&reviews).unwrap());
    show("runs", runs_ms, &serde_json::to_value(&runs).unwrap());

    /* A second runs pass, to show what the caches are worth: the project list
       and the identity are held, so this is the build requests alone. */
    let t2 = std::time::Instant::now();
    let again = skein_lib::azdo::runs_with(&mut cache, &roots);
    println!(
        "\nruns again in {}ms  ({} rows, {} requests) — the project list and identity were cached",
        t2.elapsed().as_millis(),
        serde_json::to_value(&again).unwrap()["runs"]
            .as_array()
            .map(|a| a.len())
            .unwrap_or(0),
        serde_json::to_value(&again).unwrap()["asked"]
    );
}

fn show(what: &str, ms: u128, v: &serde_json::Value) {
    let rows = v[what].as_array().cloned().unwrap_or_default();
    println!("\n── {what} ──────────────────────────────────────────");
    println!(
        "{ms}ms   {} rows   {} requests   orgs {}",
        rows.len(),
        v["asked"],
        v["orgs"]
    );
    if let Some(f) = v["fault"].as_str() {
        println!("fault      {f}");
    }
    for row in rows.iter().take(10) {
        if what == "runs" {
            println!(
                "  {:<20} {:<28} {:<11} {:<16} {}",
                cut(&row["project"], 20),
                cut(&row["pipeline"], 28),
                cut(&row["status"], 11),
                cut(&row["result"], 16),
                cut(&row["branch"], 40),
            );
        } else {
            println!(
                "  {:<14} !{:<5} {:<44} by {:<22} merge {:<10} mine {} reviewing {} vote {}",
                cut(&row["repo"], 14),
                row["number"],
                cut(&row["title"], 44),
                cut(&row["by"], 22),
                cut(&row["merge"], 10),
                row["mine"],
                row["reviewing"],
                row["myVote"],
            );
        }
    }
    if rows.len() > 10 {
        println!("  … and {} more", rows.len() - 10);
    }
}

fn cut(v: &serde_json::Value, n: usize) -> String {
    let s = v.as_str().unwrap_or("");
    if s.chars().count() <= n {
        return s.to_string();
    }
    s.chars().take(n.saturating_sub(1)).collect::<String>() + "…"
}
