# What to call this thing

Research done 2026-08-21, from the sink item *"we need to figure out a new name for skein"*.
Kept because the decision was explicitly a *for now* — Volery was chosen with the words "I
might change again in the future" — so the next round should start from here rather than from
nothing.

Every availability check below was made on 2026-08-21 and is a snapshot. Re-check before
committing to any of it; a name that was free is exactly the kind of thing that stops being
free.

## Why Skein had to go

Not "there are similar tools called Skein" — it is worse than that. **Skein is a NIST SHA-3
finalist hash function** (Schneier, Ferguson, Whiting et al.), and that owns the search results
outright. Under it, in rough order of how much they get in the way:

| what | where |
|---|---|
| Skein, the cryptographic hash | the whole first page of any search |
| `skein` — Apache YARN deployment tool | PyPI, and `skein` on npm |
| Skeinforge — 3D-printing G-code toolchain | packaged in Debian |
| Bevy Skein — Blender ↔ Bevy plugin | bevyskein.dev |
| skein.ch — an education app | Play Store |

## The finding that mattered more than any single name

**The textile metaphor is the current land rush in AI agents.** Do not rename into it.

`heddle` alone carries five projects and four are in this exact space: `roackb2/heddle` is "an
open-source terminal coding agent runtime", `heddle.us` is "weaving AI into team workflows",
`getheddle/heddle` is multi-LLM workflow orchestration, `goweft/heddle` is an MCP policy layer.
Warp, Weave, Loom and Thread are gone commercially. Weft, warp, shuttle, bobbin and the rest
are one blog post away from the same fate — so a move from Skein to another weaving word buys
the same problem again in eighteen months, and pays the rename cost twice.

The corollary: the *internal* vocabulary (strands, flights, cards, the wall) does not have to
follow the product name. It never had to.

## Checked and rejected

| name | why not |
|---|---|
| **Heddle** | five projects, four of them agent runtimes. The worst possible collision. |
| **Orrery** | `CaseyHaralson/orrery` is already "workflow planning and orchestration CLI for AI agents". |
| **Murmuration / Murmur** | three agent projects; `instavm/murmur` is "Claude Code, Codex, OpenCode on a shared communication bus" — dangerously adjacent. |
| **Quire** | Getty's multiformat publishing framework, plus a project-management tool with an MCP server. |
| **Maquette** | an npm virtual-DOM library. |
| **Scriptorium** | several small projects and eScriptorium, a real academic OCR platform. |
| **Belvedere** | two file managers on GitHub, `belvedere` taken on npm. Good fit, crowded name. |
| **Vitrine** | French dev slang — *site vitrine* is any showcase site. Unsearchable, and especially so for this author. |
| **Carrel** | Alexis Carrel: Nobel laureate, and a Vichy collaborator and eugenicist. A search landmine, not a name. |
| **Atelier** | the Gust/Koei Tecmo game series, and every design studio on earth. |
| **Foundry / Forge / Kiln / Hive / Codex / Vellum** | all taken hard, several inside the LLM space. |

## The shortlist

Clean on npm, crates.io, PyPI and the obvious domains at the time of checking.

### Volery — chosen 2026-08-21

`/VOH-luh-ree/`. Two meanings at once: **a large enclosure in which birds have room to fly**,
and **a flock of birds in flight**. That is the whole app in one word — the room and the flock
— and it *inherits* Skein's own second meaning, since a skein is geese in flight. Which is the
argument for it over everything else here: nothing in the existing vocabulary has to be
rethought. The flights, the strands, the flock in the ambience and the wall they are all on
were already this metaphor; the product name simply stops being the part of it that collides.

- free: npm, crates.io, PyPI; `volery.dev`, `volery.app`, `volery.com` had no DNS record
- existing, none of it in developer tooling: one Arch Linux batch-install script generator on
  GitHub, `volery.vc` (an unfunded deal-management site, 2017), Media Volery LLC (a Brooklyn
  marketing agency)

### Polyptych

`/POL-ip-tik/`. An artwork of many panels that is one work — literally the wall. Free on npm,
crates.io, PyPI, `polyptych.dev`, `polyptych.app`; nothing on GitHub. Costs nine letters,
everybody will misspell it, and it is erudite out loud in a way Volery is not.

### Predella

The row of small narrative panels along the base of an altarpiece. Free everywhere checked.
Lovely sound; the fit is weaker, because it names the *base* of a work rather than the whole.

### Near misses, with their caveats

- **Skep** — a straw beehive. Four letters, and it keeps the `sk-` so muscle memory and any
  existing identity partly carry over, which is a real practical advantage nothing else here
  has. But `skep` is taken on both npm and PyPI.
- **Dovecote** — many niches, many birds, one structure. `dovecote` taken on npm, free on PyPI.

## Families worth mining if a third round is needed

The three that produced everything above, with the pattern of what survived:

1. **Many things in flight, seen at once** — volery, rookery, aviary, wedge, passage, exaltation,
   charm. This is where the good ones were, because the collective nouns are rare and the
   metaphor is exactly right.
2. **A wall of works at once** — polyptych, predella, salon hang, triptych, cartoon, maquette.
   Art-historical, precise, and mostly unmined outside of `maquette`.
3. **A room of parallel workers** — scriptorium, carrel, atelier, bindery, cloister, apiary.
   The most obvious family, and therefore the most picked over.

And the pattern in what failed: **short, evocative, single English words are all being taken by
AI-agent projects right now**, usually within a year. What survives is either a rarer register
(volery, predella) or a compound nobody would guess at.

## What a rename costs

Measured 2026-08-21: about 1020 case-insensitive mentions of the old name across source. Most
are prose. The load-bearing ones are few and unequal:

| what | where | cost |
|---|---|---|
| product name, window title | `src-tauri/tauri.conf.json`, `index.html` | free, do it |
| package name | `package.json` | free |
| repo name | GitHub | free; GitHub redirects the old URL |
| bundle identifier | `tauri.conf.json` — `dev.skein.studio` | **expensive**: it is the `%APPDATA%` folder the database lives in, hard-coded again in `hooks.rs`. Changing it orphans a live wall unless the folder is migrated first. |
| MCP tool names | `mcp__skein__*`, `classify.ts` constants, `CLAUDE.md`, `.claude/rules/` | **most expensive**: every existing transcript references the old names, so a dormant card's history would quote tools that no longer exist — and the rules teach them by name. |

The last two are why the 2026-08-21 rename deliberately stopped at the visible identity. A
name chosen "for now" should not take the database with it.
