import { describe, expect, test } from "bun:test";

import {
  HISTORY,
  SCROLLBACK,
  type ShellLine,
  promptPath,
  pushLines,
  recall,
  remember,
} from "../src/lib/shell";

const out = (text: string): ShellLine => ({ text, kind: "out" });

describe("pushLines", () => {
  test("output arrives in the order it was written", () => {
    const lines = pushLines([], [out("a"), out("b")]);
    expect(lines.map((l) => l.text)).toEqual(["a", "b"]);
  });

  test("the oldest goes once the cap is passed", () => {
    const lines = pushLines([out("1"), out("2"), out("3")], [out("4")], 3);
    expect(lines.map((l) => l.text)).toEqual(["2", "3", "4"]);
  });

  test("a single push longer than the cap keeps its tail", () => {
    /* A build that prints ten thousand lines between two frames arrives as one
       batch, and the interesting end of it is the last one. */
    const flood = Array.from({ length: 20 }, (_, i) => out(String(i)));
    const lines = pushLines([out("old")], flood, 5);
    expect(lines).toHaveLength(5);
    expect(lines.map((l) => l.text)).toEqual(["15", "16", "17", "18", "19"]);
  });

  test("nothing is dropped while there is room", () => {
    const lines = pushLines([out("a")], [out("b")], SCROLLBACK);
    expect(lines).toHaveLength(2);
  });

  test("the array it was given is left alone", () => {
    const before: ShellLine[] = [out("a")];
    pushLines(before, [out("b")], 10);
    expect(before).toHaveLength(1);
  });
});

describe("remember", () => {
  test("a command goes on the end", () => {
    expect(remember(["ls"], "git status")).toEqual(["ls", "git status"]);
  });

  test("saying the same thing twice running is one entry", () => {
    const once = remember([], "git status");
    expect(remember(once, "git status")).toEqual(["git status"]);
    // Trimmed first, so a stray space is not a different command.
    expect(remember(once, "  git status  ")).toEqual(["git status"]);
  });

  test("a repeat further back is kept where it was", () => {
    /* Moving it would reorder the list under your hand while Up is walking
       through it, which is worse than carrying a duplicate. */
    expect(remember(["git status", "ls"], "git status")).toEqual([
      "git status",
      "ls",
      "git status",
    ]);
  });

  test("blank lines are not commands", () => {
    expect(remember(["ls"], "")).toEqual(["ls"]);
    expect(remember(["ls"], "   ")).toEqual(["ls"]);
  });

  test("the oldest goes once the cap is passed", () => {
    let h: string[] = [];
    for (let i = 0; i < 5; i++) h = remember(h, `cmd${i}`, 3);
    expect(h).toEqual(["cmd2", "cmd3", "cmd4"]);
  });

  test("the real cap is a session's worth, not a screenful", () => {
    expect(HISTORY).toBeGreaterThan(50);
  });
});

describe("recall", () => {
  test("up walks back from the draft", () => {
    // Three commands, so 3 is the live draft and 2 is the newest.
    expect(recall(3, 3, -1)).toBe(2);
    expect(recall(3, 2, -1)).toBe(1);
  });

  test("down comes back out to the draft", () => {
    expect(recall(3, 2, 1)).toBe(3);
  });

  test("both ends clamp rather than wrap", () => {
    /* Holding Up must stop at the oldest command, not loop round to the draft
       and start again — a list you cannot get out of. */
    expect(recall(3, 0, -1)).toBe(0);
    expect(recall(3, 3, 1)).toBe(3);
  });

  test("with no history there is nowhere to go", () => {
    expect(recall(0, 0, -1)).toBe(0);
    expect(recall(0, 0, 1)).toBe(0);
  });
});

describe("promptPath", () => {
  const home = "C:\\Users\\flori";

  test("home is a tilde", () => {
    expect(promptPath("C:\\Users\\flori", home)).toBe("~");
    expect(promptPath("C:\\Users\\flori\\atelier", home)).toBe("~\\atelier");
  });

  test("Windows hands the same directory back in either case", () => {
    expect(promptPath("c:\\users\\flori\\atelier", home)).toBe("~\\atelier");
  });

  test("a sibling that merely starts with the same letters is not inside home", () => {
    /* Only a whole segment counts, or `flori2` would read as somewhere inside
       `flori` — and the tilde is a claim about which account's files these are. */
    expect(promptPath("C:\\Users\\flori2", home)).toBe("C:\\Users\\flori2");
    expect(promptPath("C:\\Users\\flori2\\work", home)).toBe("C:\\Users\\flori2\\work");
  });

  test("a deep path is cut from the front, where the news is not", () => {
    expect(promptPath("C:\\atelier\\skein\\src\\lib\\widgets", home)).toBe(
      "…\\skein\\src\\lib\\widgets",
    );
  });

  test("the drive does not spend the whole budget", () => {
    /* Four rather than three because `C:` is a segment: at three this came out
       as `…\atelier\skein\src-tauri`, which hides the one part of an absolute
       path nobody can infer from the rest. */
    expect(promptPath("C:\\atelier\\skein\\src-tauri", home)).toBe(
      "C:\\atelier\\skein\\src-tauri",
    );
  });

  test("a short path is left exactly as it is", () => {
    expect(promptPath("C:\\atelier\\skein", home)).toBe("C:\\atelier\\skein");
  });

  test("posix separators survive being posix", () => {
    expect(promptPath("/home/lyss/atelier/skein", "/home/lyss")).toBe(
      "~/atelier/skein",
    );
    expect(promptPath("/usr/local/share/doc/thing/deeper", "/home/lyss")).toBe(
      "…/share/doc/thing/deeper",
    );
  });

  test("a home with a trailing separator means the same directory", () => {
    expect(promptPath("C:\\Users\\flori\\atelier", "C:\\Users\\flori\\")).toBe(
      "~\\atelier",
    );
  });

  test("no home at all is not every path's prefix", () => {
    /* An empty string starts every string, and a prompt reading `~` for the
       drive root would be a lie about where the shell is. */
    expect(promptPath("C:\\atelier", "")).toBe("C:\\atelier");
  });
});
