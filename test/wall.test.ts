/* The wall, driven from outside.
 *
 * Every other test in this repo checks a pure function. This one checks the
 * running app: it talks to the control surface over loopback and asserts on what
 * the studio actually holds and actually renders. That distinction earned its
 * keep immediately — the first two bugs it found were an op that silently
 * spawned two agents, and a wall whose DOM disagreed with its own model.
 *
 * Excluded from the default `bun test` run: it needs a Skein to be running.
 *
 *   $env:SKEIN_CONTROL="1"; bun run tauri dev      # in one terminal
 *   bun run test:wall                              # in another
 *
 * Add SKEIN_CONTROL_INPUT="1" to also run the two tests that move the real
 * cursor. They are skipped by default, because they steal focus and click
 * wherever the card happens to be — fine when you are watching, hostile when
 * you are typing in another window.
 *
 * SAFETY: every conversation this suite creates lives under .scratch, and
 * afterAll closes anything open there. Nothing outside .scratch is touched, so
 * running this cannot disturb real work on the wall.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.env.APPDATA ?? "", "dev.skein.studio");
const CONTROL = join(DIR, "control.json");
const DB = join(DIR, "skein.db");

/** The only place this suite is allowed to create anything. */
const SCRATCH = "C:\\atelier\\skein\\.scratch";
const WALL = join(SCRATCH, "wall");
/** A real image, already in the repo from the icon work. */
const IMAGE = "C:\\atelier\\skein\\src-tauri\\icons\\128x128.png";

type Reply = Record<string, any>;

let ep: { port: number; token: string } | null = null;
let health: Reply | null = null;

if (existsSync(CONTROL)) {
  ep = await Bun.file(CONTROL).json();
  health = await fetch(`http://127.0.0.1:${ep!.port}/health`)
    .then((r) => r.json() as Promise<Reply>)
    /* A stale control.json is exactly what `cleanup()` on exit is meant to
       prevent, but an older build may still have left one behind. */
    .catch(() => null);
}

const live = !!health?.attached;
const armed = live && !!health?.inputArmed;

if (!live) {
  console.log(
    "\n  Skein is not running with a control surface, so these are skipped.\n" +
      '    $env:SKEIN_CONTROL="1"; bun run tauri dev\n',
  );
} else if (!armed) {
  console.log(
    "\n  Real-input tests skipped. To include them:\n" +
      '    $env:SKEIN_CONTROL_INPUT="1"   (with SKEIN_CONTROL=1)\n',
  );
}

/** Runs when a Skein is there to answer. */
const t = live ? test : test.skip;
/** Runs only when the mouse has been explicitly lent to us. */
const ti = armed ? test : test.skip;

async function ctl(op: string, body: Reply = {}): Promise<Reply> {
  const res = await fetch(`http://127.0.0.1:${ep!.port}/op`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Skein-Token": ep!.token },
    body: JSON.stringify({ op, ...body }),
  });
  const v = (await res.json()) as Reply;
  /* Refuse to assert on a ghost. If a superseded studio answered, the app has
     been hot-reloaded and every number in this reply describes a component tree
     that is no longer on screen. */
  if (v.gen !== undefined && health!.generation !== undefined && v.gen !== health!.generation) {
    throw new Error(
      `${op} was answered by studio generation ${v.gen}, but the newest is ` +
        `${health!.generation}. The front end was hot-reloaded — restart it.`,
    );
  }
  if (v.ok === false) throw new Error(`${op}: ${v.error}`);
  return v;
}

/** Poll until a predicate holds, so a test never sleeps longer than it must. */
async function until<T>(
  what: string,
  get: () => Promise<T>,
  ok: (v: T) => boolean,
  ms = 8000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: T;
  for (;;) {
    last = await get();
    if (ok(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}; last was ${JSON.stringify(last)}`);
    }
    await Bun.sleep(120);
  }
}

const snapshot = () => ctl("snapshot");
const cardOf = async (id: string) => (await ctl("card", { id })).card;

/** Conversation rows the studio would restore, straight from SQLite. The point
 *  of going behind the app is that "one card appeared" and "one row was written"
 *  are different claims, and the bug this suite was built for satisfied one. */
function openRows(under = SCRATCH): { id: string; cwd: string }[] {
  const db = new Database(DB, { readonly: true });
  try {
    return db
      .query(
        `SELECT id, cwd FROM conversation
          WHERE closed_at IS NULL AND cwd LIKE ?1 ORDER BY born_at`,
      )
      .all(`${under}%`) as { id: string; cwd: string }[];
  } finally {
    db.close();
  }
}

/** The shared scratch card, for tests that only need something to talk to. */
let card = "";
const opened: string[] = [];
const placed: string[] = [];

async function newCard(): Promise<string> {
  const { id } = await ctl("open", { dir: WALL });
  expect(id).toBeTruthy();
  opened.push(id);
  return id;
}

beforeAll(async () => {
  if (!live) return;
  mkdirSync(WALL, { recursive: true });
  card = await newCard();
});

afterAll(async () => {
  if (!live) return;
  for (const id of placed) await ctl("image.remove", { id }).catch(() => {});
  /* Close everything under .scratch, not just what we opened — that also sweeps
     up any leftovers from an earlier run that died before its afterAll. */
  const snap = await snapshot().catch(() => null);
  for (const c of snap?.cards ?? []) {
    if (typeof c.cwd === "string" && c.cwd.startsWith(SCRATCH)) {
      await ctl("close", { id: c.id }).catch(() => {});
    }
  }
  /* And take the territories with them. A project now outlives its last card
     on purpose, which means a suite that only closed its cards would leave a
     `.scratch` territory on the real wall after every run. */
  const after = await snapshot().catch(() => null);
  for (const p of after?.projects ?? []) {
    if (typeof p.root === "string" && p.root.startsWith(SCRATCH)) {
      await ctl("forget", { cwd: p.root }).catch(() => {});
    }
  }
});

/* ── the harness telling the truth about itself ───────────────────────── */

t("only the newest studio answers, so a reply describes what is on screen", async () => {
  expect(health!.attached).toBe(true);
  const snap = await snapshot();
  /* ctl() already fails on a mismatch; asserting it here names the guarantee. */
  expect(snap.gen).toBe(health!.generation);
  if (health!.attachments > 1) {
    console.log(
      `  note: ${health!.attachments} studios have attached this session ` +
        `(hot reloads); generation ${health!.generation} is serving.`,
    );
  }
});

t("every card in the model is a card on the wall", async () => {
  const snap = await snapshot();
  const model = snap.cards.map((c: Reply) => c.id).sort();
  const painted = snap.dom.cardNodes.map((n: Reply) => n.id).sort();
  /* The assertion that would have caught the hot-reload fork in one line: a
     forked app keeps two models and renders only one of them. */
  expect(painted).toEqual(model);
});

/* ── opening ─────────────────────────────────────────────────────────── */

t("one open makes exactly one card and exactly one row", async () => {
  const rowsBefore = openRows().length;
  const cardsBefore = (await snapshot()).cards.length;

  await newCard();

  expect((await snapshot()).cards.length).toBe(cardsBefore + 1);
  /* The regression: a duplicated op handler spawned two agents and wrote two
     rows while reporting one card, because only the first reply was accepted. */
  expect(openRows().length).toBe(rowsBefore + 1);
});

t("a freshly opened card is awake, with nothing to resume", async () => {
  const c = await cardOf(card);
  /* Left dormant, `send` would try to wake an already-running process and the
     first message to every new conversation would be undeliverable. */
  expect(c.dormant).toBe(false);
  expect(c.everSpoke).toBe(false);
  expect(c.activity).toBe("ready");
  expect(c.interrupted).toBe(false);
});

/* ── the context ring ────────────────────────────────────────────────── */

t("context occupancy is the last assistant usage, never the cumulative result", async () => {
  const held = 182_000;
  await ctl("feed", {
    id: card,
    event: {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "most of the way through the window" }],
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 180_000,
          cache_creation_input_tokens: 1_000,
          output_tokens: 900,
        },
      },
    },
  });

  let c = await cardOf(card);
  expect(c.ctxTokens).toBe(held);
  expect(c.ctx).toBeCloseTo(held / c.contextWindow, 5);

  /* `result.usage` sums every iteration of the turn — a probe measured 51,140
     cache_read across a turn whose final request held 29,128. Reading it here
     would peg the ring, so the fold must ignore it. */
  await ctl("feed", {
    id: card,
    event: {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.42,
      usage: { input_tokens: 5, cache_read_input_tokens: 900_000, output_tokens: 4_000 },
    },
  });

  c = await cardOf(card);
  expect(c.ctxTokens).toBe(held);
  expect(c.costUsd).toBeCloseTo(0.42, 5);
  expect(c.turns).toBe(1);
  expect(c.everSpoke).toBe(true);
});

t("a 1M session is not reported as a 200k one", async () => {
  const wide = await newCard();

  /* The wire says two different things about one session. `system/init` reports
     the configured model, tier and all; every assistant message then reports
     the bare API name, because `[1m]` is Claude Code's notation for the beta
     window rather than part of the model's name. Probed against 2.1.227. */
  await ctl("feed", {
    id: wide,
    event: { type: "system", subtype: "init", model: "claude-opus-5[1m]" },
  });
  expect((await cardOf(wide)).contextWindow).toBe(1_000_000);

  await ctl("feed", {
    id: wide,
    event: {
      type: "assistant",
      message: {
        model: "claude-opus-5",
        content: [{ type: "text", text: "a while into the work" }],
        usage: { input_tokens: 81, cache_read_input_tokens: 92_000 },
      },
    },
  });

  const c = await cardOf(wide);
  expect(c.ctxTokens).toBe(92_081);
  /* The bug: the bare id narrowed the window to 200k, so 92,081 tokens read as
     46% of a session that was really 9% full. */
  expect(c.contextWindow).toBe(1_000_000);
  expect(c.ctx).toBeCloseTo(0.092, 3);

  /* A genuinely different model *is* adopted — a fallback taking the request is
     real news about the window, unlike a dropped tier suffix. */
  await ctl("feed", {
    id: wide,
    event: {
      type: "assistant",
      message: {
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "fell back" }],
        usage: { input_tokens: 1_000 },
      },
    },
  });
  expect((await cardOf(wide)).contextWindow).toBe(200_000);
});

/* ── your half of the conversation ───────────────────────────────────── */

t("what you said is in the transcript, and the turn starts when it lands", async () => {
  const mine = await newCard();
  await ctl("focus", { id: mine });

  /* This is the acknowledgement, not an optimistic local echo:
     --replay-user-messages re-emits what went to stdin, flagged isReplay. */
  await ctl("feed", {
    id: mine,
    event: {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "read package.json" }] },
      parent_tool_use_id: null,
      isReplay: true,
    },
  });

  const c = await cardOf(mine);
  expect(c.lines.at(-1)).toEqual({ kind: "you", text: "read package.json" });
  /* The card goes live the moment your words land, not seconds later when the
     first token comes back. */
  expect(c.working).toBe(true);

  /* And it is on screen, distinguishable from what the agent said. */
  const painted = await ctl("dom", { selector: ".detail .line.you" });
  expect(painted.count).toBe(1);
  expect(painted.nodes[0].text).toBe("read package.json");

  /* A tool result arrives as a user message too, and is not speech. */
  await ctl("feed", {
    id: mine,
    event: {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_nothing", content: "1\t{...}" }],
      },
      parent_tool_use_id: null,
    },
  });
  expect((await cardOf(mine)).lines.at(-1)).toEqual({ kind: "you", text: "read package.json" });
});

/* ── what the agent said, folded into markdown ────────────────────────── */

t("the agent's markdown is rendered as elements, not printed as punctuation", async () => {
  const mine = await newCard();
  await ctl("focus", { id: mine });

  const said = [
    "## the plan",
    "",
    "read `store.rs`, then **stop**.",
    "",
    "- one",
    "- two",
    "",
    "```rust",
    "let x = 1;",
    "```",
    "",
    "| file | what |",
    "| --- | --- |",
    "| a.ts | one |",
  ].join("\n");

  await ctl("feed", {
    id: mine,
    event: { type: "assistant", message: { content: [{ type: "text", text: said }] } },
  });

  const sel = ".detail .line.md";
  await until("the folded line to paint", () => ctl("dom", { selector: sel }), (r) => r.count > 0);

  /* Every shape it contains, on screen as itself. The bug this replaces: all of
     it arrived as one pre-wrap block of literal hashes, asterisks and pipes. */
  for (const child of [".h", "p", "ul li", "pre code", "table td", "strong", "p code"]) {
    const found = await ctl("dom", { selector: `${sel} ${child}` });
    expect([child, found.count > 0]).toEqual([child, true]);
  }

  /* And the punctuation is gone from the text — the marks became the shapes. */
  const line = (await ctl("dom", { selector: sel })).nodes[0];
  expect(line.text).not.toContain("##");
  expect(line.text).not.toContain("**");
  expect(line.text).toContain("the plan");

  /* A code fence keeps its contents verbatim, including the marks. */
  const code = await ctl("dom", { selector: `${sel} pre code` });
  expect(code.nodes[0].text).toContain("let x = 1;");
});

t("a link is a button, so following one cannot navigate the studio away", async () => {
  const mine = await newCard();
  await ctl("focus", { id: mine });
  await ctl("feed", {
    id: mine,
    event: {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "see [the docs](https://example.com/x) and also <script>x</script>" },
        ],
      },
    },
  });

  const links = await until(
    "the link to paint",
    () => ctl("dom", { selector: ".detail .line.md button.link" }),
    (r) => r.count > 0,
  );
  expect(links.nodes[0].text).toBe("the docs");
  /* An `<a href>` in an undecorated window with no address bar is a one-way
     trip out of the app, so there must not be one. */
  expect((await ctl("dom", { selector: ".detail .line.md a" })).count).toBe(0);
  /* Nodes, not html: a transcript is not a document anybody chose to trust. */
  expect((await ctl("dom", { selector: ".detail .line.md script" })).count).toBe(0);
  expect((await ctl("dom", { selector: ".detail .line.md" })).nodes[0].text).toContain(
    "<script>",
  );
});

t("the ring warms to the failing colour as the window fills", async () => {
  const root = await ctl("dom", { selector: ":root", styles: ["--st-fail", "--st-work"] });
  const fail = root.nodes[0].styles["--st-fail"];
  const work = root.nodes[0].styles["--st-work"];
  expect(fail).not.toBe(work);

  const ring = async () => {
    const r = await ctl("dom", {
      selector: `[data-conv="${card}"] .ring .fill`,
      styles: ["stroke"],
    });
    expect(r.count).toBe(1);
    return r.nodes[0].styles.stroke;
  };

  /* The previous test left this card at 91%, which is past the 0.85 threshold. */
  const hot = await ring();

  const fresh = await newCard();
  await ctl("feed", {
    id: fresh,
    event: {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "barely started" }],
        usage: { input_tokens: 4_000 },
      },
    },
  });
  const cool = await ctl("dom", {
    selector: `[data-conv="${fresh}"] .ring .fill`,
    styles: ["stroke"],
  });

  /* Colour, not a number in a corner: a card at 91% must not look like one at
     2%, whatever the tokens say. */
  expect(hot).not.toBe(cool.nodes[0].styles.stroke);
});

/* ── the committee ───────────────────────────────────────────────────── */

t("a committee takes seats, thinks aloud, then collapses to one line", async () => {
  const seat = await newCard();
  const personas = ["skeptic", "architect", "user-advocate"];

  /* One `Task` block per seat, exactly as the stream carries it. */
  await ctl("feed", {
    id: seat,
    event: {
      type: "assistant",
      message: {
        content: personas.map((p, i) => ({
          type: "tool_use",
          id: `toolu_${i}`,
          name: "Task",
          input: { subagent_type: p, description: `ask the ${p}` },
        })),
        usage: { input_tokens: 2_000 },
      },
    },
  });

  let c = await cardOf(seat);
  expect(c.seats.map((s: Reply) => s.persona)).toEqual(personas);
  expect(c.seats.every((s: Reply) => s.state === "spawning")).toBe(true);

  /* A seat is only rendered above the card once it exists, so this is where the
     thought bubbles either appear or quietly don't. */
  const painted = await ctl("dom", { selector: `[data-conv="${seat}"] [data-seat]` });
  expect(painted.count).toBe(personas.length);

  /* `--forward-subagent-text` re-emits a subagent's words tagged with the
     parent tool call, which is the only thing tying a thought to a seat. */
  await ctl("feed", {
    id: seat,
    event: {
      type: "assistant",
      parent_tool_use_id: "toolu_1",
      message: { content: [{ type: "text", text: "The seam is in the wrong place." }] },
    },
  });

  c = await cardOf(seat);
  const architect = c.seats.find((s: Reply) => s.persona === "architect");
  expect(architect.state).toBe("thinking");
  expect(architect.thought).toContain("seam");
  /* The others have not spoken, so they stay dim rather than inventing a line. */
  expect(c.seats.find((s: Reply) => s.persona === "skeptic").state).toBe("spawning");

  /* A tool_result addressed to a seat is that subagent reporting in. */
  await ctl("feed", {
    id: seat,
    event: {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "Move it behind the parser." },
        ],
      },
    },
  });
  c = await cardOf(seat);
  const done = c.seats.find((s: Reply) => s.persona === "architect");
  expect(done.state).toBe("done");
  expect(done.verdict).toContain("parser");

  /* The arc dissolves back into the card, leaving one line behind. */
  await ctl("feed", { id: seat, event: { type: "result", subtype: "success" } });
  c = await cardOf(seat);
  expect(c.seats).toHaveLength(0);
  expect(c.lastLine).toContain("seats · synthesised");
  expect((await ctl("dom", { selector: `[data-conv="${seat}"] [data-seat]` })).count).toBe(0);
});

/* ── the question that actually blocks ───────────────────────────────── */

t("a question parked over MCP blocks the card, raises the peek, and resumes on an answer", async () => {
  const asked = await newCard();
  const answer = "Take the second one.";

  /* The real round trip: this is a `tools/call` to the same endpoint every
     conversation gets pointed at with --mcp-config, and it must stay open. */
  const call = fetch(`http://127.0.0.1:${health!.mcpPort}/mcp/${asked}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ask_user",
        arguments: {
          question: "Fold the parser into the classifier, or keep the seam?",
          options: [{ label: "Keep the seam" }, { label: "Fold it in" }],
        },
      },
    }),
  });

  const blocked = await until(
    "the card to report a parked question",
    () => cardOf(asked),
    (c) => !!c.pendingAsk,
  );
  expect(blocked.pendingAsk.question).toContain("seam");
  expect(blocked.pendingAsk.options).toEqual(["Keep the seam", "Fold it in"]);
  /* Loudest thing a card can be: not an inference from silence, a fact. */
  expect(blocked.tier).toBe("ask");

  const snap = await snapshot();
  expect(snap.blocked).toContain(asked);
  expect(snap.dom.askOpen).toBe(true);

  /* The peek only exists for when you are somewhere else, so it can only be
     tested from somewhere else — which is exactly where this suite runs. */
  if (snap.attention.windowFocused) {
    console.log("  note: Skein is the focused window, so the peek is not asserted.");
  } else {
    const peek = await until(
      "the peek window to appear",
      () => ctl("peek"),
      (p) => p.visible === true,
    );
    expect(peek.exists).toBe(true);
  }

  await ctl("answer", { id: asked, text: answer });

  /* The turn resumes from where it stopped: same request, answered. */
  const body = (await call.then((r) => r.json())) as Reply;
  expect(body.result.content[0].text).toBe(answer);

  const after = await cardOf(asked);
  expect(after.pendingAsk).toBeNull();
  expect(after.tier).not.toBe("ask");
  if (!snap.attention.windowFocused) {
    await until("the peek to withdraw", () => ctl("peek"), (p) => p.visible === false, 4000);
  }
});

/* ── reference images ────────────────────────────────────────────────── */

t("a dropped image lands where it was aimed", async () => {
  const before = (await snapshot()).images.length;

  /* Where the drop is aimed, in CSS pixels. The op converts to the physical
     pixels the OS payload actually carries, so the 1.5x on a 150% display is
     under test rather than assumed. */
  const at = { x: 520, y: 360 };
  const surface = (await ctl("dom", { selector: ".surface" })).nodes[0].rect;
  const view = (await snapshot()).viewport;

  const res = await ctl("drop", { path: IMAGE, ...at });
  expect(res.fault).toBeNull();
  expect(res.images).toBe(before + 1);

  const snap = await snapshot();
  expect(snap.images).toHaveLength(before + 1);
  const img = snap.images[snap.images.length - 1];
  placed.push(img.id);

  /* An image is dropped centred on the cursor: you aimed at a spot, not a
     corner. Off by devicePixelRatio, this lands a third of a screen away. */
  const want = {
    x: (at.x - surface.x - view.x) / view.scale,
    y: (at.y - surface.y - view.y) / view.scale,
  };
  expect(img.x + img.w / 2).toBeCloseTo(want.x, 0);
  expect(img.y + img.h / 2).toBeCloseTo(want.y, 0);

  /* It arrives at its own aspect ratio rather than a guessed box. */
  expect(img.w).toBe(img.h);
  expect(img.w).toBeGreaterThan(0);
  expect((await ctl("dom", { selector: `[data-image="${img.id}"]` })).count).toBe(1);
});

/* ── waking ──────────────────────────────────────────────────────────── */

t("a card that believes it is dormant recovers when the supervisor disagrees", async () => {
  const sleeper = await newCard();
  /* Convince the card its process is gone. The process is in fact still there,
     which is precisely the state that used to deadlock: `send` called `wake`,
     `wake` spawned again, and the supervisor refused because it was already
     open — so the message was never delivered. */
  await ctl("exit", { id: sleeper, code: 0 });
  expect((await cardOf(sleeper)).dormant).toBe(true);

  const sent = await ctl("send", { id: sleeper, text: "Reply with the single word: ok" });
  expect(sent.fault).toBeNull();
  expect((await cardOf(sleeper)).dormant).toBe(false);
});

/* ── real input ──────────────────────────────────────────────────────── *
 *
 * A dispatched `pointerdown` proves the handlers are wired to each other. It
 * cannot see Chromium retargeting a *real* click after setPointerCapture, which
 * is the bug that shipped here twice: first the close button stopped working,
 * then clicking a card stopped focusing it. Only the real cursor finds that. */

ti("a real click on the close control removes the card", async () => {
  const doomed = await newCard();
  const sel = `[data-conv="${doomed}"]`;

  /* The control is opacity 0 until the card is hovered, so it has no business
     being clicked before the mouse is actually over the card. */
  await ctl("real.hover", { selector: sel });
  /* The control fades in over 150ms, and getComputedStyle mid-transition returns
     the interpolated value — so read it after the transition, not during. */
  await Bun.sleep(250);
  const shut = await ctl("dom", { selector: `${sel} .shut`, styles: ["opacity"] });
  expect(shut.count).toBe(1);
  expect(Number(shut.nodes[0].styles.opacity)).toBeGreaterThan(0.5);

  await ctl("real.click", { selector: `${sel} .shut` });

  await until(
    "the card to leave the wall",
    () => snapshot(),
    (s) => !s.cards.some((c: Reply) => c.id === doomed),
  );
  expect((await ctl("dom", { selector: sel })).count).toBe(0);
});

ti("a nudge focuses the card, a real drag pins it", async () => {
  const moved = await newCard();
  const sel = `[data-conv="${moved}"]`;

  /* Opening a card focuses it, so focus has to go elsewhere first or the
     assertion below passes without the click having done anything. */
  const other = (await snapshot()).cards.find((c: Reply) => c.id !== moved);
  await ctl("focus", { id: other.id });
  expect((await snapshot()).focusedId).not.toBe(moved);

  /* Under the 4px slop this is a click, not a drag — and a click focuses. */
  await ctl("real.drag", { selector: sel, dx: 3, dy: 0, steps: 3 });
  let snap = await snapshot();
  expect(snap.focusedId).toBe(moved);
  expect(snap.cards.find((c: Reply) => c.id === moved).placement).toBeNull();

  const from = (await ctl("dom", { selector: sel })).nodes[0].rect;
  await ctl("real.drag", { selector: sel, dx: 140, dy: 60 });

  snap = await snapshot();
  const placement = snap.cards.find((c: Reply) => c.id === moved).placement;
  /* Past the slop it is a drag: the card earns a pin and keeps the position. */
  expect(placement).not.toBeNull();
  expect(placement.pinned).toBe(true);

  const to = (await ctl("dom", { selector: sel })).nodes[0].rect;
  expect(to.x - from.x).toBeCloseTo(140, -1);
  expect(to.y - from.y).toBeCloseTo(60, -1);

  /* And the pin outlives the app, so it has to have reached SQLite. */
  const db = new Database(DB, { readonly: true });
  const row = db
    .query("SELECT x, y, pinned FROM placement WHERE conversation_id = ?1")
    .get(moved) as Reply | null;
  db.close();
  expect(row).not.toBeNull();
  expect(row!.pinned).toBe(1);
});

t("a card's transcript is read for it, without being asked", async () => {
  const fresh = await newCard();
  /* Nothing focused, no panel opened, no agent woken: reading a transcript
     spawns nothing, so the wall does it as it loads rather than waiting for a
     click. `none` here is the right answer — a session that has never spoken
     has no file — and what matters is that it is no longer `unread`. */
  const c = await until(
    "the card to have been read for",
    () => cardOf(fresh),
    (c: Reply) => c.historyState !== "unread",
    4000,
  );
  expect(["none", "ready"]).toContain(c.historyState);
});

/* ── adopting what claude recorded elsewhere ─────────────────────────── */

t("the adopt panel offers only sessions no card already points at", async () => {
  /* The chip toggles, so open by state rather than by clicking once and
     hoping — a suite that assumed the direction would pass or fail on whatever
     the previous test left behind. */
  if ((await ctl("dom", { selector: ".panel" })).count === 0) {
    await ctl("click", { selector: "[data-adopt]" });
  }
  await until(
    "the adopt panel",
    () => ctl("dom", { selector: ".panel" }),
    (r) => r.count === 1,
    4000,
  );
  const panel = await ctl("dom", { selector: ".panel .row" });

  /* Hermetic on any machine: the assertion is about the *relationship* between
     the list and the wall, not about which transcripts happen to exist here.
     Offering a session that is already a card is how you get two cards writing
     to one transcript. */
  const onWall = new Set((await snapshot()).cards.map((c: Reply) => c.id));
  const offered = panel.nodes.map((n: Reply) => n.data.session);
  expect(offered.filter((id: string) => onWall.has(id))).toEqual([]);

  /* Every row is a real session id, not a placeholder. */
  for (const id of offered) expect(id).toMatch(/^[0-9a-f-]{36}$/);

  await ctl("key", { selector: ".panel", key: "Escape" });
  await until(
    "the panel to withdraw",
    () => ctl("dom", { selector: ".panel" }),
    (r) => r.count === 0,
    3000,
  );
});

/* ── navigating the wall ─────────────────────────────────────────────── */

t("the bare wheel zooms at the cursor, and shift pans", async () => {
  /* Put the camera back where it was found. The real-input tests below aim the
     OS cursor at whatever is under a selector, so a suite that left the wall
     somewhere else would have them clicking a neighbour's card. */
  const was = (await snapshot()).viewport;
  await ctl("viewport", { x: 0, y: 0, scale: 1 });

  const inward = await ctl("wheel", { dy: -240, x: 300, y: 200 });
  expect(inward.viewport.scale).toBeGreaterThan(1);
  /* Zooming at a point moves the origin — anchoring at the cursor is the whole
     difference between this and a scale slider. */
  expect(inward.viewport.x).not.toBe(0);

  const outward = await ctl("wheel", { dy: 240, x: 300, y: 200 });
  expect(outward.viewport.scale).toBeLessThan(inward.viewport.scale);

  await ctl("viewport", { x: 0, y: 0, scale: 1 });
  const panned = await ctl("wheel", { dy: 120, dx: 60, shift: true });
  expect(panned.viewport.scale).toBe(1);
  expect(panned.viewport).toMatchObject({ x: -60, y: -120 });

  await ctl("viewport", was);
});

t("the transformed layer covers the whole wall", async () => {
  /* Which is why "the ground" cannot mean the surface element alone: at rest
     the layer is exactly the viewport, so `e.target === surface` was true
     nowhere at all. Asserting the geometry names what made the bug possible. */
  const was = (await snapshot()).viewport;
  await ctl("viewport", { x: 0, y: 0, scale: 1 });

  const layer = (await ctl("dom", { selector: ".layer" })).nodes[0].rect;
  const surface = (await ctl("dom", { selector: ".surface" })).nodes[0].rect;
  expect(layer).toMatchObject({ x: surface.x, y: surface.y, w: surface.w, h: surface.h });

  await ctl("viewport", was);
});

ti("pressing the ground pans, wherever on it the press lands", async () => {
  /* It read as "dragging works in some places" — the places being wherever the
     layer had been translated off, which is why it survived so long. */
  const was = (await snapshot()).viewport;
  await ctl("viewport", { x: 0, y: 0, scale: 1 });

  await ctl("real.drag", { selector: ".layer", dx: 100, dy: 60 });
  expect((await snapshot()).viewport).toMatchObject({ x: 100, y: 60 });

  await ctl("viewport", was);
});

ti("a right-drag pans the wall without leaving a menu behind", async () => {
  /* The right button pans as readily as the left; what it must not do is
     open a menu when it comes up, because the gesture was "move the wall".
     Only a real button can show this — the whole question is what Chromium
     does between pointerup and contextmenu. */
  const was = (await snapshot()).viewport;
  await ctl("viewport", { x: 0, y: 0, scale: 1 });

  await ctl("real.drag", { selector: ".layer", dx: 90, dy: 50, button: "right" });
  expect((await snapshot()).viewport).toMatchObject({ x: 90, y: 50 });
  expect((await ctl("dom", { selector: ".menu" })).count).toBe(0);

  /* A right-click that stays put still opens a menu — the suppression is
     about the drag, not the button. That half is covered synthetically by the
     `menu` op, which is the same handler this one had to get past. */
  await ctl("viewport", was);
});

ti("dragging a card carries it rather than selecting its text", async () => {
  /* The bug: .surface had no `user-select`, so a real press-and-move started a
     text selection over the card's title and the highlight outlived the drop.
     A synthetic pointer never sees this — only Chromium's own hit testing
     does — which is why this test is down here with the real cursor. */
  const sel = `[data-conv="${card}"]`;
  await ctl("real.drag", { selector: sel, dx: 120, dy: 40 });

  const snap = await snapshot();
  expect(snap.dom.selectionChars).toBe(0);
  expect(snap.cards.find((c: Reply) => c.id === card).placement).not.toBeNull();
});

/* ── where a new conversation lands ──────────────────────────────────── */

t("a new card takes free wall, not the slot a pinned card is sitting on", async () => {
  /* The bug, from the wall rather than from layout.ts: a card pinned near the
     top of its territory kept its slot in the flow as well, so every
     conversation opened afterwards appeared underneath it in the same corner. */
  const rectOf = async (id: string) =>
    (await snapshot()).dom.cardNodes.find((n: Reply) => n.id === id);

  const first = await newCard();
  const a = await rectOf(first);

  /* Pin it exactly where it already sits — the common case, and the one that
     used to leave its slot claimable. Screen back to canvas by hand, which
     means subtracting the surface's own origin as `toCanvas` does: the header
     is 47px tall, and skipping that put the pin most of a slot out of place. */
  const v = (await snapshot()).viewport;
  const origin = (await ctl("dom", { selector: ".surface" })).nodes[0].rect;
  await ctl("pin", {
    id: first,
    x: (a.x - origin.x - v.x) / v.scale,
    y: (a.y - origin.y - v.y) / v.scale,
  });

  const next = await newCard();
  const c = await rectOf(next);
  expect(c).toBeDefined();
  expect({ x: c.x, y: c.y }).not.toMatchObject({ x: a.x, y: a.y });

  /* The general form, and the one that does not care how many cards the suite
     has already put in this territory: nothing is stacked on anything. */
  const here = (await snapshot()).cards
    .filter((x: Reply) => String(x.cwd).startsWith(SCRATCH))
    .map((x: Reply) => x.id);
  const spots = (await snapshot()).dom.cardNodes
    .filter((n: Reply) => here.includes(n.id))
    .map((n: Reply) => `${n.x},${n.y}`);
  expect(new Set(spots).size).toBe(spots.length);
});

/* ── where a territory lands, and where it can be carried ────────────── */

t("every territory has a place of its own, and can be carried elsewhere", async () => {
  /* Territories ran along one line off the origin and were never recorded, so
     there was nothing to move and nothing to remember. Both halves matter: the
     position has to be *written down* (otherwise it depends on the project list,
     and forgetting one in the middle slides every later territory a cell along,
     leaving the cards pinned inside them behind), and it has to be movable. */
  const here = await newCard();
  const project = async () =>
    (await snapshot()).projects.find((p: Reply) => p.root === WALL);

  const p0 = await project();
  expect(p0.x).not.toBeNull();
  expect(p0.y).not.toBeNull();

  const sel = '.region[data-cwd$="wall"]';
  const box = async () => (await ctl("dom", { selector: sel })).nodes[0].rect;
  const cardBox = async () =>
    (await snapshot()).dom.cardNodes.find((n: Reply) => n.id === here);

  const wasRegion = await box();
  const wasCard = await cardBox();
  const { scale } = (await snapshot()).viewport;

  await ctl("place", { cwd: WALL, x: p0.x + 400, y: p0.y + 240 });

  const moved = await box();
  expect(Math.abs(moved.x - wasRegion.x - 400 * scale)).toBeLessThan(2);
  expect(Math.abs(moved.y - wasRegion.y - 240 * scale)).toBeLessThan(2);

  /* The cards standing in it came along — this one flows, so it moves because
     its slot is measured off the territory's origin. */
  const carried = await cardBox();
  expect(Math.abs(carried.x - wasCard.x - 400 * scale)).toBeLessThan(2);
  expect(Math.abs(carried.y - wasCard.y - 240 * scale)).toBeLessThan(2);

  /* Having been moved, it offers the way back — the territory's equivalent of a
     card's "let it flow again". */
  expect((await ctl("menu", { selector: sel })).items).toContain("reflow");
  await ctl("key", { key: "Escape" });

  /* Settling it back packs it in among the others again — against their real
     heights, so where it lands depends on the wall, not on a fixed pitch. What
     has to hold is that it is somewhere, and no longer where we put it. */
  await ctl("place", { cwd: WALL });
  const back = await project();
  expect(back.x).not.toBeNull();
  expect(back.y).not.toBeNull();
  expect([back.x, back.y]).not.toEqual([p0.x + 400, p0.y + 240]);
});

ti("a territory is carried by its name, not by its whole area", async () => {
  /* The area has to keep panning — a press anywhere on a region being inert is
     the bug `isGround` exists to have fixed — so the handle is the name. Only a
     real cursor can show that Chromium routes the press to it rather than
     starting a text selection over the label. */
  const p0 = (await snapshot()).projects.find((p: Reply) => p.root === WALL);
  const { scale } = (await snapshot()).viewport;

  await ctl("real.drag", { selector: '.name[data-cwd$="wall"]', dx: 90, dy: 70 });

  const after = (await snapshot()).projects.find((p: Reply) => p.root === WALL);
  expect(Math.abs(after.x - p0.x - 90 / scale)).toBeLessThan(2);
  expect(Math.abs(after.y - p0.y - 70 / scale)).toBeLessThan(2);
  expect((await snapshot()).dom.selectionChars).toBe(0);

  await ctl("place", { cwd: WALL, x: p0.x, y: p0.y });
});

t("a project outlives its last card, and can be dismissed on purpose", async () => {
  /* Closing everything and starting again in the same place is ordinary, and
     the territory is where the "+" that starts it lives. */
  const dir = `${SCRATCH}\\outlives`;
  mkdirSync(dir, { recursive: true });
  const only = (await ctl("open", { dir })).id as string;
  opened.push(only);

  const territories = async () =>
    (await ctl("dom", { selector: ".region" })).nodes.map((n: Reply) => n.data.name);
  expect(await territories()).toContain("outlives");

  await ctl("close", { id: only });
  expect(await territories()).toContain("outlives");

  /* Which is why it also has to be possible to say you are done with it —
     otherwise every folder ever opened stays on the wall for good. */
  const sel = '.region[data-cwd$="outlives"]';
  expect((await ctl("menu", { selector: sel })).items).toContain("forget");
  await ctl("click", { selector: '[data-menu="forget"]' });

  await until(
    "the territory to leave the wall",
    () => territories(),
    (names: string[]) => !names.includes("outlives"),
    3000,
  );
  expect((await snapshot()).fault).toBeNull();
});

/* ── the right-click ─────────────────────────────────────────────────── */

t("the wall answers a right-click itself, and Chromium never does", async () => {
  const ground = await ctl("menu", { selector: ".surface" });
  expect(ground.defaultPrevented).toBe(true);
  expect(ground.items).toEqual([
    "open",
    "adopt",
    "image",
    "fit",
    "tidy",
    /* The ground is what the ambience is drawn on, so this is where asking
       about it belongs. */
    "ambience",
  ]);

  const onCard = await ctl("menu", { selector: `[data-conv="${card}"]` });
  /* The session id is what `--resume` takes and this is the only place the UI
     parts with it, so losing this item would quietly close the one bridge
     between a card and a terminal. */
  expect(onCard.items).toContain("copy-resume");
  expect(onCard.items).toContain("close");

  /* Nothing worth offering: no menu, and still no native one. Both halves
     matter — "shows nothing" is the requirement, not "shows an empty box". */
  const bar = await ctl("menu", { selector: ".bar" });
  expect(bar.defaultPrevented).toBe(true);
  expect(bar.open).toBe(false);
  expect(bar.items).toEqual([]);

  await ctl("key", { key: "Escape" });
  expect((await ctl("dom", { selector: ".menu" })).count).toBe(0);
});

t("typing with a card in hand goes to the field, keystroke and all", async () => {
  await ctl("focus", { id: card });
  await ctl("type", { text: "" });

  /* Dispatched at the wall, not at the field — the point is that the field is
     not where the keystroke landed. */
  await ctl("key", { selector: ".surface", key: "h" });
  await ctl("key", { selector: ".surface", key: "i" });

  const snap = await snapshot();
  expect(snap.draft).toBe("hi");
  expect(snap.dom.focusedTag).toBe("TEXTAREA");

  await ctl("type", { text: "" });
});

t("an image brought to the front is in front of the cards", async () => {
  /* It never was: cards sat at 1000 and territory chips at 1001 in CSS, while
     an image's z-index was its own small z, so `bringToFront` only reordered
     images among themselves. */
  /* At `field` density the wall draws neither chips nor image nodes, so this
     needs a known camera rather than whatever the last test left. */
  const was = (await snapshot()).viewport;
  await ctl("viewport", { x: 0, y: 0, scale: 1 });

  /* `drop` reports counts, not ids — the id comes off the wall afterwards. */
  expect((await ctl("drop", { path: IMAGE, x: 200, y: 200 })).fault).toBeNull();
  const shots = (await snapshot()).images;
  const img = shots[shots.length - 1].id as string;
  expect(img).toBeTruthy();
  placed.push(img);

  const zOf = async (selector: string) =>
    Number(
      (await ctl("dom", { selector, styles: ["z-index"] })).nodes[0].styles["z-index"],
    );

  const behind = await zOf(`[data-image="${img}"]`);
  const cardZ = await zOf(`[data-conv="${card}"]`);
  expect(behind).toBeLessThan(cardZ); // a reference starts out of the way

  await ctl("menu", { selector: `[data-image="${img}"]` });
  await ctl("click", { selector: '[data-menu="front"]' });

  const front = await zOf(`[data-image="${img}"]`);
  expect(front).toBeGreaterThan(cardZ);
  expect(front).toBeGreaterThan(await zOf(".chips"));

  await ctl("viewport", was);
});

/* ── the wall's ambience ──────────────────────────────────────────────── */

/** Ambience profiles straight from SQLite. Same argument as `openRows`: "the
 *  panel says the layer is off" and "the row says so" are different claims. */
function ambienceRows(): { id: string; name: string; layers: string; active: number }[] {
  const db = new Database(DB, { readonly: true });
  try {
    return db
      .query("SELECT id, name, layers_json AS layers, active FROM ambience_profile")
      .all() as { id: string; name: string; layers: string; active: number }[];
  } finally {
    db.close();
  }
}

t("the backdrop covers the wall exactly and takes no events", async () => {
  const surface = (await ctl("dom", { selector: ".surface" })).nodes[0].rect;
  const back = (
    await ctl("dom", {
      selector: "canvas.backdrop",
      styles: ["pointer-events", "position"],
    })
  ).nodes[0];

  /* It once grew to twenty-two million pixels across: a canvas is a replaced
     element, so `inset: 0` does not size it, and measuring `clientWidth` to set
     `el.width` multiplied by the device pixel ratio on every resize the observer
     reported — which was every one it caused. */
  expect(back.rect.w).toBe(surface.w);
  expect(back.rect.h).toBe(surface.h);
  /* The wall pans and the cards are pressed. Nothing here may take an event. */
  expect(back.styles["pointer-events"]).toBe("none");
});

t("a wall with nothing on it stops drawing, and starts again", async () => {
  const was = (await snapshot()).ambience.activeId;
  try {
    await ctl("ambience.use", { id: null });
    let amb = (await snapshot()).ambience;
    /* The frame loop is stopped, not left clearing sixty times a second for
       nothing — nothing on this wall polls. The canvas stays; only the loop goes. */
    expect(amb.drawing).toBe(false);
    expect(amb.canvas).toBe(true);
    expect(amb.activeId).toBeNull();
    /* Having none showing is a state the database keeps, not the absence of one. */
    expect(ambienceRows().filter((r) => r.active).length).toBe(0);

    await ctl("ambience.use", { id: was });
    amb = (await snapshot()).ambience;
    expect(amb.activeId).toBe(was);
    expect(amb.drawing).toBe(true);
  } finally {
    await ctl("ambience.use", { id: was });
  }
});

t("a stack is built, reordered, and written down", async () => {
  const was = (await snapshot()).ambience.activeId;
  const { id: mine } = await ctl("ambience.profile", { do: "create", name: "wall test" });
  try {
    await ctl("ambience.layer", { do: "add", kind: "leaves" });
    await ctl("ambience.layer", { do: "add", kind: "footsteps" });

    const kinds = async () =>
      (await snapshot()).ambience.profiles
        .find((p: Reply) => p.id === mine)
        .layers.map((l: Reply) => l.kind);
    expect(await kinds()).toEqual(["leaves", "footsteps"]);

    /* Order is paint order, and it is what puts the leaves in front. */
    await ctl("ambience.layer", { do: "move", layer: "footsteps", by: -1 });
    expect(await kinds()).toEqual(["footsteps", "leaves"]);

    /* A layer switched off is kept, with everything it was set to — much better
       than deleting it to see the wall without it. */
    await ctl("ambience.layer", { do: "param", layer: "leaves", key: "count", value: 33 });
    await ctl("ambience.layer", { do: "set", layer: "leaves", on: false });

    const leaves = async () =>
      (await snapshot()).ambience.profiles
        .find((p: Reply) => p.id === mine)
        .layers.find((l: Reply) => l.kind === "leaves");
    expect((await leaves()).on).toBe(false);
    expect((await leaves()).params.count).toBe(33);

    /* Out of range is pulled back in rather than honoured — the slider's own
       bounds are the effect's, and the renderer must never see past them. */
    await ctl("ambience.layer", { do: "param", layer: "leaves", key: "count", value: 9999 });
    expect((await leaves()).params.count).toBeLessThanOrEqual(80);

    /* Saves are debounced, as every drag of a slider fires one. */
    const row = await until(
      "the stack to reach SQLite",
      async () => ambienceRows().find((r) => r.id === mine),
      (r) => !!r && JSON.parse(r.layers).length === 2,
    );
    const stored = JSON.parse(row!.layers);
    expect(stored.map((l: Reply) => l.kind)).toEqual(["footsteps", "leaves"]);
    expect(stored.find((l: Reply) => l.kind === "leaves").on).toBe(false);

    /* Exactly one profile is ever showing, whatever else has happened. */
    expect(ambienceRows().filter((r) => r.active).map((r) => r.id)).toEqual([mine]);
  } finally {
    /* Nothing this suite made may outlive it — the same rule the cards and the
       scratch territories follow. */
    await ctl("ambience.profile", { do: "delete", id: mine });
    await ctl("ambience.use", { id: was });
  }
});

/* ── the rails beside the transcript ─────────────────────────────────── */

t("the contents rail is one answer's shape, and clicking an entry goes there", async () => {
  const mine = await newCard();
  await ctl("focus", { id: mine });

  /* Far taller than the panel, or there is nowhere for a click to take us. */
  const filler = (what: string) =>
    Array.from({ length: 22 }, (_, i) => `${what} ${i}`).join("\n\n");

  await ctl("feed", {
    id: mine,
    event: {
      type: "assistant",
      message: {
        content: [
          {
            type: "text",
            text: [
              "the opening words of the answer",
              "",
              "## the first section",
              "",
              filler("first"),
              "",
              "- alpha, an item",
              "- beta, an item",
              "",
              "## the second section",
              "",
              filler("second"),
            ].join("\n"),
          },
        ],
      },
    },
  });

  const rail = 'nav[aria-label^="contents"] button';
  const shown = await until(
    "the contents rail to paint",
    () => ctl("dom", { selector: rail, styles: ["padding-left"] }),
    (r) => r.count >= 5,
  );

  /* Everything an answer is navigable by: where it starts, its headings, and
     the start of each of its list items. */
  expect(shown.nodes.map((n: Reply) => n.text)).toEqual([
    "the opening words of the answer",
    "the first section",
    "alpha, an item",
    "beta, an item",
    "the second section",
  ]);

  /* A list written under an h2 sits deeper than the h2 — the indent is carried
     along the run rather than read off the tag, which is the whole of `nest`. */
  const pad = (n: Reply) => parseFloat(n.styles["padding-left"]);
  expect(pad(shown.nodes[2])).toBeGreaterThan(pad(shown.nodes[1]));

  /* The panel is parked at the tail, so the first section is well above it. */
  const box = (await ctl("dom", { selector: ".detail .lines" })).nodes[0].rect;
  const heads = () => ctl("dom", { selector: ".detail .line.md .h" });
  expect((await heads()).nodes[0].rect.y).toBeLessThan(box.y);

  await ctl("click", { selector: rail, index: 1 });

  /* And it is carried to the top of the column. This is the whole gesture, and
     it failed silently once: the first scroll event of the animation still read
     as "parked at the tail", so the follow dragged the panel straight back down
     and clicking a rail entry did nothing at all. */
  const after = await until(
    "the panel to arrive at the section",
    heads,
    (r) => Math.abs(r.nodes[0].rect.y - box.y) < 40,
  );
  expect(after.nodes[0].rect.y).toBeGreaterThan(box.y - 40);

  /* The rail says where that left us, and says it about an entry it is showing. */
  const lit = await ctl("dom", { selector: `${rail}.on` });
  expect(lit.count).toBe(1);
  expect(lit.nodes[0].text).toBe("the first section");
  /* Longer than the default five seconds: this one spawns a card late in a run
     that has already spawned a dozen, and then waits on an animation. */
}, 20_000);

t("a second answer replaces the contents rail rather than lengthening it", async () => {
  const mine = await newCard();
  await ctl("focus", { id: mine });

  for (const [n, head] of [["one", "the older answer"], ["two", "the newer answer"]]) {
    await ctl("feed", {
      id: mine,
      event: {
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: [`## ${head}`, "", Array.from({ length: 22 }, (_, i) => `${n} ${i}`).join("\n\n")].join("\n"),
            },
          ],
        },
      },
    });
  }

  /* Parked at the tail, so the answer being read is the newer one — and the
     rail is that answer, not the transcript over again in a narrow column. */
  const rail = 'nav[aria-label^="contents"] button';
  const shown = await until(
    "the rail to follow the reader",
    () => ctl("dom", { selector: rail }),
    (r) => r.count > 0 && r.nodes.at(-1).text === "the newer answer",
  );
  expect(shown.nodes.map((n: Reply) => n.text)).not.toContain("the older answer");

  /* Which one, of how many — a scoped rail that says nothing about being scoped
     reads as an answer that lost half its headings. */
  const cap = await ctl("dom", { selector: 'nav[aria-label^="contents"] .cap' });
  expect(cap.nodes[0].text).toBe("contents · 2/2");

  /* What you said, by contrast, is the whole conversation and stays put. */
  await ctl("feed", {
    id: mine,
    event: {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "and what about the other one" }] },
      parent_tool_use_id: null,
      isReplay: true,
    },
  });
  const said = await until(
    "the conversation rail to carry it",
    () => ctl("dom", { selector: 'nav[aria-label="you said"] button' }),
    (r) => r.count > 0,
  );
  expect(said.nodes.at(-1).text).toBe("and what about the other one");
}, 20_000);

/* ── nothing broke on the way past ───────────────────────────────────── */

t("the page threw nothing while all of that happened", async () => {
  const snap = await snapshot();
  /* Silent front-end errors are the one class a screenshot cannot show, so the
     surface taps window.onerror and console.error and carries them along. */
  expect(snap.errors).toEqual([]);
  expect(snap.fault).toBeNull();
});
