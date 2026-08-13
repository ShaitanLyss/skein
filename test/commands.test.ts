import { expect, test, describe } from "bun:test";
import {
  COMMANDS,
  completionFor,
  matchCommands,
  resolveCommand,
  typingName,
} from "../src/lib/commands";

const names = (draft: string) => matchCommands(draft).map((c) => c.name);

describe("the palette opens on a slash and closes on a space", () => {
  test("a bare slash offers everything there is", () => {
    expect(names("/")).toEqual(COMMANDS.map((c) => c.name));
  });

  test("typing narrows it", () => {
    expect(names("/cl")).toContain("clear");
    expect(names("/zzz")).toEqual([]);
  });

  test("prose is not a command, however many slashes it has", () => {
    expect(names("what about src/lib/clear.ts")).toEqual([]);
    expect(names("")).toEqual([]);
    /* Leading whitespace says this is a line that happens to start with a
       slash, not a command being typed. */
    expect(names(" /clear")).toEqual([]);
  });

  test("the choosing is over once there is a space", () => {
    /* The palette is for picking a command. Left open while arguments are
       being typed it would sit there claiming a choice is still to be made. */
    expect(typingName("/clear ")).toBeNull();
    expect(names("/clear the deck")).toEqual([]);
  });
});

describe("only Skein's own commands are Skein's", () => {
  test("an exact name resolves", () => {
    expect(resolveCommand("/clear")?.name).toBe("clear");
    expect(resolveCommand("/CLEAR")?.name).toBe("clear");
    /* Trailing space is still just the command. */
    expect(resolveCommand("/clear ")?.name).toBe("clear");
  });

  /* The load-bearing one. `claude` has slash commands of its own — the built-ins
     and everything in `.claude/commands/` — and they work in `--print` mode, so
     a prompt starting with a slash is ordinary traffic. Swallowing an unknown
     name would silently break every custom command anybody has written, and it
     would look like the agent ignoring them. */
  test("an unknown command is not intercepted, so it reaches the agent", () => {
    expect(resolveCommand("/commit")).toBeNull();
    expect(resolveCommand("/review the diff")).toBeNull();
    expect(names("/commit")).toEqual([]);
  });

  test("a name that merely starts with ours is not ours", () => {
    expect(resolveCommand("/clearing")).toBeNull();
    /* Nor is one with arguments, while no command takes any: reading `/clear`
       out of it would throw away the rest of what was typed. */
    expect(resolveCommand("/clear everything")).toBeNull();
  });

  test("a slash inside a sentence is never a command", () => {
    expect(resolveCommand("run the /clear command for me")).toBeNull();
  });
});

describe("what the keys put in the field", () => {
  test("completion is the whole name, ready to send", () => {
    const clear = COMMANDS.find((c) => c.name === "clear")!;
    expect(completionFor(clear)).toBe("/clear");
    /* Completing and then sending has to reach the same command the palette
       was lit on, or Tab would be a way to lose your place. */
    expect(resolveCommand(completionFor(clear))).toBe(clear);
  });
});

describe("the catalogue is shaped for the dock", () => {
  test("every command can be typed, and says what it does", () => {
    for (const c of COMMANDS) {
      expect(c.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(c.summary.length).toBeGreaterThan(0);
      /* Lowercase, like the rest of the prose in this UI. */
      expect(c.summary).toBe(c.summary.toLowerCase());
      expect(c.detail.length).toBeGreaterThan(0);
      /* Every entry must be reachable by typing its own name. */
      expect(matchCommands(`/${c.name}`)).toContain(c);
      expect(resolveCommand(`/${c.name}`)).toBe(c);
    }
  });

  test("no two commands share a name", () => {
    expect(new Set(COMMANDS.map((c) => c.name)).size).toBe(COMMANDS.length);
  });
});
