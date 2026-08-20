import { describe, expect, test } from "bun:test";
import {
  FOLLOW,
  groupOptions,
  linesFor,
  latest,
  nameOf,
  standing,
  subjectOf,
  tail,
  type LogLine,
  type Reading,
} from "../src/lib/serverlog";

/* A group, as much of one as the log widget reads. Defaults are a healthy
   single-server group, so each test says only what it is about. */
function group(over: Partial<Reading> = {}): Reading {
  const servers = over.servers ?? [{ label: "web", port: 5173 }];
  return {
    id: "g1",
    label: "dev",
    project: "skein",
    running: true,
    overall: "up",
    servers,
    health: Object.fromEntries(servers.map((s) => [s.label, "up" as const])),
    log: [],
    ...over,
  };
}

const line = (label: string, text: string, stderr = false): LogLine => ({
  label,
  line: text,
  stderr,
});

/* ── which group a widget is about ─────────────────────────────────────── */

describe("a log names its subject or says why it has none", () => {
  test("a wall with no groups on it is an absence, not a blank pane", () => {
    expect(subjectOf(FOLLOW, [])).toEqual({ group: null, because: "none" });
  });

  test("following settles on what is running", () => {
    const idle = group({ id: "a", label: "api", running: false, overall: "idle" });
    const live = group({ id: "b", label: "web" });
    expect(subjectOf(FOLLOW, [idle, live]).group?.id).toBe("b");
  });

  /* A wall where nothing is up still has one honest answer, and a start button
     under it. Returning nothing here would make the widget useless precisely
     when it is most wanted. */
  test("following falls back to the first group when nothing is running", () => {
    const a = group({ id: "a", running: false, overall: "idle" });
    const b = group({ id: "b", running: false, overall: "idle" });
    expect(subjectOf(FOLLOW, [a, b]).group?.id).toBe("a");
  });

  test("a pinned group is shown even while another one is the busy one", () => {
    const pinned = group({ id: "a", running: false, overall: "idle" });
    const busy = group({ id: "b" });
    expect(subjectOf("a", [pinned, busy]).group?.id).toBe("a");
  });

  /* The one thing that must not be papered over: a widget pinned to a group
     that has been deleted must not quietly start showing somebody else's
     output. The lines would be another server's and nothing on the face would
     say so. */
  test("a group that is not on the wall any more is said, not substituted", () => {
    expect(subjectOf("gone", [group({ id: "a" })])).toEqual({
      group: null,
      because: "gone",
    });
  });

  test("a config with no group written in it follows, the way a fresh one does", () => {
    expect(subjectOf("", [group({ id: "a" })]).group?.id).toBe("a");
  });
});

/* ── what it shows ─────────────────────────────────────────────────────── */

describe("the tail, and what a filter keeps back", () => {
  const log = [
    line("web", "one"),
    line("web", "two", true),
    line("web", "three"),
  ];

  test("everything, in the order it arrived", () => {
    expect(tail(log, "all", 10).lines.map((l) => l.line)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  test("only what went to stderr, when that is what was asked", () => {
    expect(tail(log, "stderr", 10).lines.map((l) => l.line)).toEqual(["two"]);
  });

  /* An empty pane that cannot say why reads as a widget that has broken. A
     stderr reading of a server that printed two hundred clean lines is
     legitimately empty, and owes that sentence. */
  test("what the filter dropped is counted, so an empty pane can explain itself", () => {
    expect(tail(log, "stderr", 10).hidden).toBe(2);
    expect(tail(log, "all", 10).hidden).toBe(0);
  });

  /* Anchored to the newest, which is the whole point of a log on a wall: a
     widget that showed the first four lines a server ever printed would be a
     picture of its launch. */
  test("the tail is the end of the log, not the start of it", () => {
    const long = Array.from({ length: 50 }, (_, i) => line("web", `l${i}`));
    const cut = tail(long, "all", 4);
    expect(cut.lines).toHaveLength(4);
    expect(cut.lines.map((l) => l.line)).toEqual(["l46", "l47", "l48", "l49"]);
  });

  /* What did not fit needs no apology — it is simply older, and a taller widget
     shows more of it. Only the filter's omissions are a thing the face has to
     say out loud. */
  test("lines that did not fit are not counted as hidden", () => {
    const long = Array.from({ length: 50 }, (_, i) => line("web", `l${i}`));
    expect(tail(long, "all", 4).hidden).toBe(0);
  });

  /* The box you drag it to is the setting — and here that is load-bearing
     rather than tasteful: the wheel zooms the wall, so a pane on it cannot be
     scrolled, and a widget that overflowed would hide its newest lines behind a
     scrollbar nothing could move. */
  test("a taller log shows more of it, and the shortest still shows one", () => {
    expect(linesFor(300)).toBeGreaterThan(linesFor(150));
    expect(linesFor(90)).toBeGreaterThanOrEqual(1);
    expect(linesFor(0)).toBe(1);
  });
});

describe("the last thing each server said", () => {
  const servers = [
    { label: "web", port: 5173 },
    { label: "api", port: 3000 },
  ];
  const log = [
    line("web", "starting"),
    line("api", "listening on 3000"),
    line("web", "ready in 342ms"),
  ];

  test("one line each, most recent, in the group's own order", () => {
    expect(latest(servers, log, "all")).toEqual([
      { label: "web", line: "ready in 342ms", stderr: false },
      { label: "api", line: "listening on 3000", stderr: false },
    ]);
  });

  /* The silent one is the interesting one, so it gets a row rather than being
     left out of the reading. */
  test("a server that has said nothing still gets a row", () => {
    expect(latest(servers, [line("web", "up")], "all")).toEqual([
      { label: "web", line: "up", stderr: false },
      { label: "api", line: null, stderr: false },
    ]);
  });

  test("the filter reaches this reading too", () => {
    const withErr = [...log, line("api", "ECONNREFUSED", true)];
    expect(latest(servers, withErr, "stderr")).toEqual([
      { label: "web", line: null, stderr: false },
      { label: "api", line: "ECONNREFUSED", stderr: true },
    ]);
  });

  test("a line from a server that is not in this group is not shown", () => {
    expect(latest([{ label: "web", port: null }], [line("ghost", "hi")], "all")).toEqual(
      [{ label: "web", line: null, stderr: false }],
    );
  });
});

/* ── is it down, and what does the button say ──────────────────────────── */

describe("a group that is not saying anything says why", () => {
  test("one nobody has started offers a start", () => {
    const s = standing(group({ running: false, overall: "idle" }));
    expect(s).toEqual({ down: true, word: "not started", verb: "start" });
  });

  /* The half this would have got wrong. `running` is a flag the wall sets when
     it asks for a start, so a server that exited on its own comes back
     `running: true` — and a start button that appeared only for a group nobody
     had started would be missing from exactly the case you opened the log to
     understand. */
  test("one that exited on its own is down, whatever the running flag says", () => {
    const s = standing(
      group({ running: true, overall: "exited", health: { web: "exited" } }),
    );
    expect(s.down).toBe(true);
    expect(s.word).toBe("exited");
    expect(s.verb).toBe("start again");
  });

  test("a group half of which exited says so", () => {
    const s = standing(
      group({
        running: true,
        overall: "exited",
        servers: [
          { label: "web", port: 5173 },
          { label: "api", port: 3000 },
        ],
        health: { web: "up", api: "exited" },
      }),
    );
    expect(s.down).toBe(true);
    expect(s.word).toBe("one of them exited");
  });

  /* Up, and the reading is the lines. A widget narrating "it is running" over
     the top of its own output is a label on a window. */
  test("a running group is left to speak for itself", () => {
    expect(standing(group()).down).toBe(false);
    expect(standing(group()).word).toBeNull();
  });

  test("one still starting is not something to press a button about", () => {
    const s = standing(group({ overall: "starting", health: { web: "starting" } }));
    expect(s.down).toBe(false);
    expect(s.word).toBeNull();
  });
});

/* ── naming one ────────────────────────────────────────────────────────── */

describe("a group names itself the same way everywhere", () => {
  /* A widget belongs to no project, so a log has to say whose server it is
     showing — and a menu of five entries all reading `dev` is a menu that
     cannot be used. */
  test("the project, then the group", () => {
    expect(nameOf({ project: "skein", label: "dev" })).toBe("skein · dev");
  });

  test("a group with no project to name reads as itself", () => {
    expect(nameOf({ project: "", label: "dev" })).toBe("dev");
  });

  test("the menu offers every group, in the order the wall holds them", () => {
    expect(
      groupOptions([
        group({ id: "a", label: "dev", project: "skein" }),
        group({ id: "b", label: "api", project: "nova" }),
      ]),
    ).toEqual([
      { value: "a", label: "skein · dev" },
      { value: "b", label: "nova · api" },
    ]);
  });
});
