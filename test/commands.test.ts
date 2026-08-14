import { expect, test, describe } from "bun:test";
import {
  COMMANDS,
  cliCommand,
  completionFor,
  completionForChoice,
  matchChoices,
  matchCommands,
  resolveCommand,
  typingChoice,
  typingName,
} from "../src/lib/commands";

const names = (draft: string) => matchCommands(draft).map((c) => c.name);
const values = (draft: string) => matchChoices(draft).map((c) => c.value);
const named = (name: string) => COMMANDS.find((c) => c.name === name)!;

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

  test("the choosing of a name is over once there is a space", () => {
    expect(typingName("/clear ")).toBeNull();
    expect(names("/clear the deck")).toEqual([]);
  });

  test("a command whose argument is prose closes it, as everything used to", () => {
    /* `/compact` takes free text. Left open over it the palette would be
       claiming a choice is still to be made while you write a sentence. */
    expect(names("/compact focus on the auth work")).toEqual([]);
    expect(typingChoice("/compact focus")).toBeNull();
    expect(values("/compact ")).toEqual([]);
  });
});

describe("a command that takes a value keeps the palette up", () => {
  test("the space opens the values instead of closing the palette", () => {
    /* The rule it bends: the palette is for choosing, and `/model` alone is not
       a thing that can be run — so the choosing is not over at the space. */
    expect(values("/model ")).toEqual([
      "opus",
      "opus[1m]",
      "sonnet",
      "sonnet[1m]",
      "haiku",
      "fable",
    ]);
    expect(values("/effort ")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("typing narrows the values the way it narrows the names", () => {
    expect(values("/model son")).toEqual(["sonnet", "sonnet[1m]"]);
    /* `max` contains an x, so it follows the one that starts with it. */
    expect(values("/effort x")).toEqual(["xhigh", "max"]);
    expect(values("/model zzz")).toEqual([]);
  });

  test("a prefix outranks a mere containing match", () => {
    /* `[1m]` contains `1m`, and so would sort in on a contains-match; the
       prefixes must still come first. */
    expect(values("/model opus")).toEqual(["opus", "opus[1m]"]);
  });

  test("the choosing really is over at the second space", () => {
    expect(typingChoice("/model sonnet ")).toBeNull();
    expect(values("/model sonnet please")).toEqual([]);
  });

  test("only a command that has values gets a second stage", () => {
    expect(typingChoice("/clear ")).toBeNull();
    expect(typingChoice("/zzz ")).toBeNull();
    expect(typingChoice("/model ")?.cmd.name).toBe("model");
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
    /* Nor is one with arguments, while no Skein command takes any: reading
       `/clear` out of it would throw away the rest of what was typed. */
    expect(resolveCommand("/clear everything")).toBeNull();
  });

  test("a slash inside a sentence is never a command", () => {
    expect(resolveCommand("run the /clear command for me")).toBeNull();
  });

  /* The whole point of `by`. Carrying out a CLI command *is* sending it, so
     there is nothing for `send` to intercept — it has to fall through to the
     ordinary prompt path exactly as `/commit` does. Intercepting it would mean
     Skein re-implementing a thing the agent already answers. */
  test("a CLI command is not intercepted either", () => {
    expect(resolveCommand("/compact")).toBeNull();
    expect(resolveCommand("/model sonnet")).toBeNull();
    expect(resolveCommand("/effort high")).toBeNull();
  });
});

describe("knowing a CLI command without taking custody of it", () => {
  /* Nothing is intercepted on the strength of this. It answers the two places
     the difference shows: what an unnamed card gets called, and what the card
     face previews while you type. */
  test("it recognises one with or without its argument", () => {
    expect(cliCommand("/compact")?.name).toBe("compact");
    expect(cliCommand("/compact focus on the auth work")?.name).toBe("compact");
    expect(cliCommand("/model sonnet")?.name).toBe("model");
    expect(cliCommand("  /effort high  ")?.name).toBe("effort");
  });

  test("it is not Skein's commands and not anybody else's", () => {
    expect(cliCommand("/clear")).toBeNull();
    expect(cliCommand("/commit")).toBeNull();
    expect(cliCommand("compact the context please")).toBeNull();
    expect(cliCommand("/compacting")).toBeNull();
  });
});

describe("what the keys put in the field", () => {
  test("completion is the whole name, ready to send", () => {
    const clear = named("clear");
    expect(completionFor(clear)).toBe("/clear");
    /* Completing and then sending has to reach the same command the palette
       was lit on, or Tab would be a way to lose your place. */
    expect(resolveCommand(completionFor(clear))).toBe(clear);
  });

  test("a command that takes a value is completed with its space", () => {
    /* Or completing it would leave you sitting on a name that cannot be run,
       with the values one keystroke away and nothing saying so. */
    expect(completionFor(named("model"))).toBe("/model ");
    expect(typingChoice(completionFor(named("model")))?.cmd.name).toBe("model");
  });

  test("completing a value gives the whole line", () => {
    const model = named("model");
    const opus1m = model.choices!.find((c) => c.value === "opus[1m]")!;
    expect(completionForChoice(model, opus1m)).toBe("/model opus[1m]");
    /* And what it gives has to be a thing the CLI will read as its own. */
    expect(cliCommand(completionForChoice(model, opus1m))).toBe(model);
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
    }
  });

  test("every command is carried out by somebody", () => {
    for (const c of COMMANDS) {
      if (c.by === "skein") expect(resolveCommand(`/${c.name}`)).toBe(c);
      else expect(cliCommand(`/${c.name}`)).toBe(c);
    }
  });

  test("every value can be typed, and says what it buys", () => {
    for (const c of COMMANDS) {
      if (!c.choices) continue;
      /* A command with an empty list would open a palette with nothing in it. */
      expect(c.choices.length).toBeGreaterThan(0);
      for (const v of c.choices) {
        expect(v.value).toMatch(/^\S+$/);
        expect(v.summary).toBe(v.summary.toLowerCase());
        expect(matchChoices(`/${c.name} ${v.value}`)).toContain(v);
      }
      expect(new Set(c.choices.map((v) => v.value)).size).toBe(c.choices.length);
    }
  });

  test("no two commands share a name", () => {
    expect(new Set(COMMANDS.map((c) => c.name)).size).toBe(COMMANDS.length);
  });
});
