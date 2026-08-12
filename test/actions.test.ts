import { expect, test, describe } from "bun:test";
import {
  actionsFor,
  automationStep,
  liveCodingStep,
  managerFromField,
  progressFrom,
  scriptArgv,
  tallyNote,
  LIVE_CODING,
  NO_STATUS,
  NO_TALLY,
  type ProjectFacts,
  type ProjectStatus,
  type Step,
} from "../src/lib/actions";

const bare: ProjectFacts = {
  root: "C:\\atelier\\thing",
  manager: "pnpm",
  scripts: [],
  node: false,
  tauri: false,
  cargo: false,
  git: false,
  unreal: null,
};

const node = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({
  ...bare,
  node: true,
  scripts: ["dev", "build", "test"],
  ...over,
});

const unreal = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({
  ...bare,
  root: "C:\\atelier\\caravan",
  unreal: {
    uproject: "C:\\atelier\\caravan\\Caravan.uproject",
    name: "Caravan",
    engine: "C:\\Program Files\\Epic Games\\UE_5.8",
    mcpPort: 7245,
    log: "C:\\atelier\\caravan\\Saved\\Logs\\Caravan.log",
  },
  ...over,
});

const open: ProjectStatus = { ...NO_STATUS, editorPid: 4242 };

const ids = (f: ProjectFacts, s: ProjectStatus = NO_STATUS) =>
  actionsFor(f, s).map((a) => a.id);

const argvOf = (f: ProjectFacts, id: string, s: ProjectStatus = NO_STATUS) => {
  const step = actionsFor(f, s).find((a) => a.id === id)?.steps[0];
  return step && step.kind === "run" ? step.argv : null;
};

const kinds = (f: ProjectFacts, id: string, s: ProjectStatus = NO_STATUS) =>
  actionsFor(f, s)
    .find((a) => a.id === id)!
    .steps.map((x: Step) => x.kind);

describe("what a project offers", () => {
  test("a folder with nothing in it offers nothing", () => {
    expect(actionsFor(bare)).toEqual([]);
  });

  test("a node project offers the scripts it actually has", () => {
    expect(ids(node({ scripts: ["dev", "build"] }))).toEqual(["build"]);
    expect(ids(node({ scripts: ["dev"] }))).toEqual([]);
  });

  /* The default the user asked for out loud: pnpm unless the repo says
     otherwise, because npm is what gets typed by habit and not by choice. */
  test("pnpm is what a script runs as", () => {
    expect(argvOf(node(), "build")).toEqual(["pnpm", "run", "build"]);
    expect(argvOf(node({ manager: "bun" }), "test")).toEqual(["bun", "run", "test"]);
  });

  test("only npm needs the -- before forwarded arguments", () => {
    expect(scriptArgv("pnpm", "tauri", ["build"])).toEqual(["pnpm", "run", "tauri", "build"]);
    expect(scriptArgv("bun", "tauri", ["build"])).toEqual(["bun", "run", "tauri", "build"]);
    expect(scriptArgv("npm", "tauri", ["build"])).toEqual([
      "npm", "run", "tauri", "--", "build",
    ]);
    /* …and not when there is nothing to forward, or npm run build becomes
       `npm run build --`. */
    expect(scriptArgv("npm", "build")).toEqual(["npm", "run", "build"]);
  });

  test("packageManager pins the dialect, and anything unrecognised does not", () => {
    expect(managerFromField("pnpm@9.1.0")).toBe("pnpm");
    expect(managerFromField("yarn@4.0.0+sha512.deadbeef")).toBe("yarn");
    expect(managerFromField("corepack@1")).toBeNull();
    expect(managerFromField(null)).toBeNull();
  });

  /* A Tauri app's build and its bundle are hours apart; giving them the same
     word would make one of them a surprise. */
  test("a tauri app ships the bundle and builds the front end", () => {
    const f = node({ tauri: true, scripts: ["dev", "build", "test", "tauri"] });
    expect(ids(f)).toEqual(["build", "test", "ship"]);
    expect(argvOf(f, "build")).toEqual(["pnpm", "run", "build"]);
    expect(argvOf(f, "ship")).toEqual(["pnpm", "run", "tauri", "build"]);
  });

  test("a bare cargo project gets the three cargo verbs", () => {
    expect(ids({ ...bare, cargo: true })).toEqual(["build", "test", "ship"]);
    expect(argvOf({ ...bare, cargo: true }, "ship")).toEqual([
      "cargo", "build", "--release",
    ]);
  });
});

describe("push", () => {
  test("nothing ahead is still a button, just a quiet one", () => {
    const f = { ...bare, git: true };
    const s = { ...NO_STATUS, upstream: true, branch: "main" };
    const [push] = actionsFor(f, s);
    expect(push.id).toBe("push");
    expect(push.label).toBe("push");
    expect(push.quiet).toBe(true);
  });

  test("what is ahead is on the chip", () => {
    const [push] = actionsFor({ ...bare, git: true }, {
      ...NO_STATUS, upstream: true, ahead: 3, branch: "main",
    });
    expect(push.label).toBe("push ↑3");
    expect(push.quiet).toBeFalsy();
  });

  /* Where an untracked branch goes is a decision, and git guessing it is how
     work lands on the wrong remote. */
  test("a branch with no upstream is published rather than pushed", () => {
    expect(argvOf({ ...bare, git: true }, "push", { ...NO_STATUS, branch: "spike" })).toEqual([
      "git", "push", "-u", "origin", "HEAD",
    ]);
    expect(argvOf({ ...bare, git: true }, "push", { ...NO_STATUS, upstream: true })).toEqual([
      "git", "push",
    ]);
  });
});

describe("unreal", () => {
  test("with the editor closed everything is a process", () => {
    expect(ids(unreal())).toEqual(["editor", "build", "test", "ship"]);
    expect(kinds(unreal(), "editor")).toEqual(["launch-editor"]);
    expect(kinds(unreal(), "build")).toEqual(["run"]);
    expect(kinds(unreal(), "test")).toEqual(["run"]);
  });

  /* UBT refuses an external build of the editor target while the editor holds
     the Live Coding mutex, so with it open `build` has to mean something else
     entirely — and a headless test run would boot a second editor for nothing. */
  test("with the editor open, build and test go to the editor", () => {
    expect(ids(unreal(), open)).toEqual(["editor", "build", "cycle", "test", "ship"]);
    expect(kinds(unreal(), "build", open)).toEqual(["live-coding"]);
    expect(kinds(unreal(), "test", open)).toEqual(["automation"]);
    expect(kinds(unreal(), "editor", open)).toEqual(["focus-editor"]);
  });

  test("cycle exists only while there is an editor to cycle", () => {
    expect(ids(unreal())).not.toContain("cycle");
    expect(kinds(unreal(), "cycle", open)).toEqual([
      "close-editor", "run", "launch-editor",
    ]);
  });

  test("the build argv is the one UBT takes, with progress markers on", () => {
    const argv = argvOf(unreal(), "build")!;
    expect(argv[0]).toBe(
      "C:\\Program Files\\Epic Games\\UE_5.8\\Engine\\Build\\BatchFiles\\Build.bat",
    );
    expect(argv).toContain("CaravanEditor");
    expect(argv).toContain("-Project=C:\\atelier\\caravan\\Caravan.uproject");
    expect(argv).toContain("-Progress");
  });

  /* Every engine lives under `C:\Program Files\…`. An argv keeps that one
     token; a shell string would have to quote it, and cmd does not read the
     escaping a Windows argv is quoted with. */
  test("a path with a space in it stays one argument", () => {
    for (const id of ["build", "test", "ship"]) {
      const argv = argvOf(unreal(), id)!;
      expect(argv[0]).toContain("Program Files");
      expect(argv[0]).not.toContain('"');
    }
  });

  test("an engine that could not be resolved says so instead of pretending", () => {
    const f = unreal({
      unreal: { ...unreal().unreal!, engine: null },
      git: true,
    });
    expect(ids(f)).toEqual(["engine", "push"]);
    expect(actionsFor(f)[0].steps).toEqual([]);
  });
});

describe("reading progress out of the output", () => {
  test("a counted step is a fraction", () => {
    expect(progressFrom("[3/12] Compile [x64] CaravanCharacter.cpp")).toEqual({
      pct: 25,
      note: "Compile [x64] CaravanCharacter.cpp",
    });
  });

  test("UBT's own markers carry the message and the position", () => {
    expect(progressFrom("@progress 'Compiling C++ source code...' 40%")).toEqual({
      pct: 40,
      note: "Compiling C++ source code...",
    });
  });

  /* push/increment scope a sub-range: the number is a share of the whole, not a
     position in it. Read as absolute, the bar jumped to 5% and stopped. */
  test("a scoped marker never sets the position", () => {
    expect(progressFrom("@progress push 5%")?.pct ?? null).toBeNull();
    expect(progressFrom("@progress increment 1%")?.pct ?? null).toBeNull();
    expect(progressFrom("@progress pop")).toBeNull();
  });

  test("the cook counts itself", () => {
    expect(
      progressFrom(
        "LogCook: Display: Cooked packages 350 Packages Remain 350 Total 700",
      ),
    ).toEqual({ pct: 50, note: "cooked 350/700" });
  });

  test("no total is still a sign of life", () => {
    expect(progressFrom("   Compiling serde v1.0.203")).toEqual({
      pct: null,
      note: "Compiling serde v1.0.203",
    });
    expect(progressFrom("✓ 412 modules transformed.")).toEqual({
      pct: null,
      note: "412 modules transformed.",
    });
  });

  test("ordinary chatter says nothing", () => {
    expect(progressFrom("")).toBeNull();
    expect(progressFrom("  ➜  Local:   http://localhost:5173/")).toBeNull();
    expect(progressFrom("warning: unused variable `x`")).toBeNull();
  });

  test("a fraction never leaves 0..100", () => {
    const p = progressFrom("[14/12] Link Caravan.exe");
    expect(p?.pct).toBe(100);
  });
});

describe("what a running editor answers with", () => {
  const fold = (lines: string[]) => lines.reduce(liveCodingStep, LIVE_CODING);

  test("a patch that landed", () => {
    const v = fold([
      "LogLiveCoding: Display: Starting Live Coding compile",
      "LogLiveCoding: Display: Live coding succeeded",
    ]);
    expect(v).toMatchObject({ started: true, done: true, ok: true, stale: false });
  });

  /* A data-type change patches but does not take effect properly — saying
     "success" and nothing else is how you debug a stale editor for an hour. */
  test("a patch that changed data types is success with a warning", () => {
    const v = fold([
      "LogLiveCoding: Display: Starting Live Coding compile",
      "LogLiveCoding: Display: Live coding succeeded (data type changes detected)",
    ]);
    expect(v.ok).toBe(true);
    expect(v.stale).toBe(true);
    expect(v.note).toContain("cycle");
  });

  test("a failure is a failure whichever way it is worded", () => {
    for (const say of [
      "Live coding failed",
      "Live coding canceled",
      "Unable to start live coding",
    ]) {
      const v = fold([`LogLiveCoding: Error: ${say}`]);
      expect(v).toMatchObject({ done: true, ok: false });
    }
  });

  test("unrelated log chatter is not a verdict", () => {
    const v = fold(["LogTemp: Warning: Live coding succeeded"]);
    expect(v.done).toBe(false);
  });
});

describe("counting an automation run", () => {
  const fold = (lines: string[]) => lines.reduce(automationStep, NO_TALLY);

  test("a clean run", () => {
    const t = fold([
      "LogAutomationController: Found 3 automation tests based on 'Caravan'",
      "LogAutomationController: Test Completed. Result={Success} Name={A} Path={Caravan.A}",
      "LogAutomationController: Test Completed. Result={Success} Name={B} Path={Caravan.B}",
      "LogAutomationController: Test Completed. Result={Success} Name={C} Path={Caravan.C}",
      "LogAutomationController: Display: ...Automation Test Queue Empty",
    ]);
    expect(t).toMatchObject({ total: 3, passed: 3, done: true });
    expect(tallyNote(t)).toBe("3/3 passed");
  });

  test("a failure keeps its path and its file and line", () => {
    const t = fold([
      "LogAutomationController: Found 2 automation tests based on 'Caravan'",
      "LogAutomationController: Test Completed. Result={Success} Name={A} Path={Caravan.A}",
      "LogAutomationController: Error: Expected 3 but got 4 [D:\\c\\Tests\\Cart.cpp(88)]",
      "LogAutomationController: Test Completed. Result={Fail} Name={B} Path={Caravan.Cart}",
      "LogAutomationController: Display: ...Automation Test Queue Empty",
    ]);
    expect(t.failed).toEqual(["Caravan.Cart"]);
    expect(t.errors).toEqual(["D:\\c\\Tests\\Cart.cpp(88): Expected 3 but got 4"]);
    expect(tallyNote(t)).toBe("1/2 failed");
  });

  test("a filter that matched nothing is not a pass", () => {
    const t = fold(["LogAutomationController: Display: ...Automation Test Queue Empty"]);
    expect(t.done).toBe(true);
    expect(tallyNote(t)).toBe("no tests matched");
  });

  test("nothing accumulates after the queue empties", () => {
    const t = fold([
      "LogAutomationController: Found 1 automation tests based on 'Caravan'",
      "LogAutomationController: Display: ...Automation Test Queue Empty",
      "LogAutomationController: Test Completed. Result={Success} Name={Z} Path={Other.Z}",
    ]);
    expect(t.passed).toBe(0);
  });
});
