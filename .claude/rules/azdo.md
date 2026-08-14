---
paths:
  - "src/lib/azdo.ts"
  - "src/lib/devops.svelte.ts"
  - "src/lib/Pipelines.svelte"
  - "src/lib/Reviews.svelte"
  - "src-tauri/src/azdo.rs"
---

# Azure DevOps: pipelines and reviews

#### Azure DevOps: pipelines and reviews

Two instruments for the forge the work actually lives in: `pipelines` — what is building,
across every project at once — and `reviews` — open pull requests, and which of them want
you. `azdo.rs` answers in facts, `azdo.ts` is pure and owns the whole taxonomy, and
`devops.svelte.ts` is the one connection behind however many of either are up.

**They are two widgets rather than one with a variant, and that was the design question.** A
variant on this wall means a different *reading of the same fact* — a clock's five faces are
all the time, a timer's three are all the run. Runs and pull requests are different facts, off
different endpoints, on different clocks, answering different questions; and decisively, you
want both on the wall **at the same time**, which a variant makes impossible. What they
genuinely share is the connection, so that is what is shared. Each keeps a `variant` of its
own for how it is drawn (`list`, `lanes`, `dots`).

- **The organisation is read off the wall, never configured.** There is no text field anywhere
  in Skein, so an org typed into a settings panel is not a thing this app can offer — and it
  does not have to, because the organisations worth watching are exactly the ones whose repos
  are standing on your wall. `git remote get-url origin` in each project root is the whole of
  the configuration, both spellings (`dev.azure.com/<org>` and `<org>.visualstudio.com`), and a
  wall with no Azure DevOps repo on it asks nothing of the network at all.
- **Authentication is a ladder that falls through on refusal, not on absence**, and that
  distinction is the whole of why it works. Git Credential Manager already holds a credential
  for `dev.azure.com` on any machine that has cloned from the org — free, nothing to set up —
  and it is enough for pull requests and **not** for builds, because GCM issues a code-scoped
  token. Probed 2026-08-14 against `LagardereAWPL` with `.scratch/tlsprobe`, one credential,
  four endpoints: `projects 200`, `pull reqs 200`, `identity 200`, **`builds 401`**. So a
  ladder that stopped at the first credential it could *find* would have worked for reviews and
  been permanently broken for pipelines, with nothing to say about why. Each rung is tried until
  one is *accepted* — git credential, then `az account get-access-token`, then
  `SKEIN_AZDO_PAT` — and which rung answered is remembered per organisation and per endpoint
  family, so that 401 is paid once rather than on every poll.
- **The environment variable is last, and being last costs it nothing.** It has a claim to
  winning outright, being the most deliberate of the three. But since the ladder falls through
  on refusal, the only case where the order decides anything is one where a rung above it was
  *accepted* — and an accepted rung is by definition a credential that works. First, it would
  instead mean a stale variable in somebody's shell profile silently outranking the sign-in they
  just did.
- **GCM refuses to answer for `dev.azure.com` without the organisation, and then tries to
  prompt.** Probed 2026-08-14: asked for the bare host it returns `fatal: Cannot determine the
  organization name for this 'dev.azure.com' remote URL`, and falls through to a sign-in — which
  blocks forever with no terminal and pops a window over the wall from a poll nobody asked for.
  So the org goes in as `path`, `credential.useHttpPath=true` is forced **on the command line**
  rather than trusted from the user's config (it happens to be set on this machine, and a
  feature that quietly dies on a colleague's because of a config they have never heard of is not
  a feature), and `GIT_TERMINAL_PROMPT=0` with `credential.interactive=false` are set for the
  reason `project.rs::fetch_projects` sets them: **a background poll must never ask a
  question.** This is also why the credential is resolved per organisation rather than once.
- **This network intercepts TLS, and the HTTP client had to be chosen for it.** `dev.azure.com`
  here presents a certificate issued by `ca.macquarietelecom-103950.au.goskope.com` — Netskope —
  whose root is in Windows' `LocalMachine\Root` and in no bundled root set. rustls' default
  roots are webpki-roots, a copy of Mozilla's, which *cannot* contain a corporate CA: built the
  obvious way this fails with a certificate error on every request here and works perfectly on
  the developer's home wifi, which is the worst shape a bug can have. Hence `ureq` with
  `native-certs`, and the note in Cargo.toml as well as this one. Those four 200s above are real
  handshakes through the proxy and are the proof.
- **Pull requests are org-wide in one call; builds are not.** `_apis/git/pullrequests` with no
  project in the path returns every open PR in every repo the caller can see. There is no
  equivalent for builds, so runs cost one request per project — six on this workspace — which is
  why the two halves poll on different cadences (20s for runs, 60s for reviews) and why the
  project list is cached for ten minutes.
- **The two halves fail apart, so they are kept apart all the way down.** A `fault` per half,
  not one on the class: the 401 above is *the normal broken state*, and a single field would have
  had the reviews widget reporting the pipelines widget's problem. A pass that got rows keeps
  them even if something else faulted — with two orgs on the wall, one refusing must not blank
  the other — but a pass that got *nothing* and faulted leaves the last good rows up, or a
  network blip would empty a list somebody is reading.
- **`needsMe` is narrower than "am I a reviewer", and that is the judgement the reviews face is
  really making.** A PR you opened is not waiting on you even though Azure DevOps lists you on
  it — which it does: four of this org's eight open PRs had their own author down as a
  *required* reviewer, because that is what the branch policy adds. Nor is one you have already
  voted on, whichever way you voted; rejecting it puts the ball with the author.
- **`partiallySucceeded` is not a fault.** It means the build worked and something non-blocking
  did not, so rust would be a lie about a pipeline that produced an artifact — but it is not
  nothing either, so it takes the warming amber that means exactly that on a card. A cancelled
  run is `rest` for the reason a stopped card is: nothing went wrong and somebody did it on
  purpose. A completed run with a result nothing recognises is muted, never red — a widget that
  invents faults is a widget you stop trusting.
- **`live` is not a strict in-progress filter.** A pipeline that failed ninety seconds ago is
  the single most useful row this widget can draw, and a strict filter makes it vanish at the
  moment it matters, so finished runs stay for `SETTLING_MS`.
- **Colour is status here exactly as everywhere else.** Azure DevOps' own UI has a colour per
  state; this has the wall's four, and introduces no hue. Runs order by how much they want you
  and then longest-running first; reviews order the same way and then **oldest** first — the
  opposite, deliberately, because a stale pull request is a problem where a stale build is
  merely history.
- **A row is a link and nothing else.** No re-run, no cancel, no approve — a deliberate floor
  rather than an unfinished edge. This wall spawns agents with
  `--dangerously-skip-permissions`, so a button here that started a deployment would be the most
  consequential thing in the app sitting one stray click away from a list read at a glance; and
  an approval lands under your name on somebody else's work and belongs where the diff is. Going
  *to* the thing costs nothing and can be taken back. It routes out through
  `Skein.openLink` → `open.rs`, like every link in the transcript.
- **Four silences, told apart.** A wall with no Azure DevOps repo, a first reading still in
  flight, a scope that matched nothing and a genuinely empty list are four different sentences
  (`emptySaid`). Getting that wrong is most of what would make this read as broken.

The control surface has an `azdo` op — `read` takes both readings now rather than waiting out
the beats, `rows` hands back the lists with each row's *tier* on it, which is the only way to
see from outside that the taxonomy reached the face. `snapshot.azdo` reports each half's
`watchers`, `ready`, `orgs`, `asked` and `fault` separately, and `polling` apart from the widget
count for the reason `meter.sampling` is. It deliberately reports no credential and no fragment
of one: a snapshot is written to a file.

