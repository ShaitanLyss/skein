import { describe, expect, test } from "bun:test";
import {
  backupSettled,
  repairWorthTrying,
  REPAIR_SETTLE_TURNS,
  sayCommand,
  sayNothingToRepair,
  sayRepair,
  type RepairReport,
} from "../src/lib/repair";

/** The real one, from the session this was written for. */
const real: RepairReport = {
  records: 1,
  chars_removed: 4383,
  nuls: 1222,
  undecodable: 100,
  commands: [
    'Bash cd /c/Users/lyss.delprat/.local/bin && echo "=== oauth prompt strings ==="; ' +
      'grep -aoE "(Paste|paste)[^\\"]{0,70}" claude.exe | sort -u | head -12',
  ],
  backup: "C:/Users/x/.claude/projects/p/s.jsonl.skein-bak",
};

describe("when a repair is worth reaching for", () => {
  test("only the truncated body", () => {
    expect(repairWorthTrying("malformed")).toBe(true);
  });

  test("not an overload, which is somebody else's weather", () => {
    /* There is nothing in this conversation to mend; a repair here would
       rewrite a session to fix a queue somewhere else. */
    expect(repairWorthTrying("overloaded")).toBe(false);
    expect(repairWorthTrying(null)).toBe(false);
  });
});

describe("what the card says about one", () => {
  test("the counts are named, because the card rewrote somebody else's file", () => {
    const said = sayRepair(real);
    expect(said).toContain("1,222 nul characters");
    expect(said).toContain("100 undecodable");
  });

  test("and the tool call, so the reader can judge it", () => {
    expect(sayRepair(real)).toContain("grep -aoE");
  });

  test("one result reads as one, not as a figure", () => {
    expect(sayRepair(real)).toContain("one tool result");
    expect(sayRepair({ ...real, records: 3 })).toContain("3 tool results");
  });

  test("a report with no command still reads as a sentence", () => {
    const said = sayRepair({ ...real, commands: [] });
    expect(said).toContain("repaired —");
    expect(said).not.toContain("undefined");
    expect(said).not.toContain("``");
  });

  test("only the counts that happened are mentioned", () => {
    const said = sayRepair({ ...real, undecodable: 0 });
    expect(said).toContain("nul characters");
    expect(said).not.toContain("undecodable");
  });

  test("falls back to a character count when neither kind was counted", () => {
    const said = sayRepair({ ...real, nuls: 0, undecodable: 0 });
    expect(said).toContain("4,383 characters");
  });

  test("the prose is lowercase, like the rest of the wall", () => {
    expect(sayRepair(real)[0]).toBe(sayRepair(real)[0]!.toLowerCase());
    expect(sayNothingToRepair()[0]).toBe(sayNothingToRepair()[0]!.toLowerCase());
  });

  test("a clean conversation is a finding, and says so without naming a cause it did not check", () => {
    expect(sayNothingToRepair()).toContain("nothing corrupt");
    expect(sayNothingToRepair()).not.toContain("too large");
  });
});

describe("shortening a command", () => {
  test("the front is kept, because that is what identifies it", () => {
    expect(sayCommand("grep -aoE pattern claude.exe", 100)).toBe("grep -aoE pattern claude.exe");
    expect(sayCommand("grep -aoE pattern claude.exe", 12)).toBe("grep -aoE p…");
  });

  test("newlines and runs of space flatten, so it sits on one line", () => {
    expect(sayCommand("a\n\n  b\tc")).toBe("a b c");
  });

  test("the navigation is dropped, because it is not what identifies the call", () => {
    /* The bug this catches: sixty characters off the front of the real command
       named a directory and never reached the `grep` that broke the session. */
    expect(sayCommand("Bash cd /c/Users/lyss/.local/bin && grep -aoE x claude.exe")).toBe(
      "Bash grep -aoE x claude.exe",
    );
  });

  test("a cd that is the whole command is left alone", () => {
    /* No `&&`, so nothing was preamble to anything — dropping it would leave
       an empty line where a real tool call should be. */
    expect(sayCommand("Bash cd /some/where")).toBe("Bash cd /some/where");
  });
});

describe("keeping the original until the repair has proved itself", () => {
  test("not straight away — a bad repair shows up as the next turn failing", () => {
    expect(backupSettled(0)).toBe(false);
    expect(backupSettled(1)).toBe(false);
  });

  test("two good turns is the evidence", () => {
    expect(backupSettled(REPAIR_SETTLE_TURNS)).toBe(true);
    expect(backupSettled(9)).toBe(true);
  });
});
