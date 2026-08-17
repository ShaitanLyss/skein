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
    expect(resolveCommand("/clear")?.cmd.name).toBe("clear");
    expect(resolveCommand("/CLEAR")?.cmd.name).toBe("clear");
    /* Trailing space is still just the command. */
    expect(resolveCommand("/clear ")?.cmd.name).toBe("clear");
    /* And a command that takes nothing is given nothing, rather than the
       empty string standing in for an argument it never has. */
    expect(resolveCommand("/clear")?.arg).toBe("");
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
    /* Nor is one carrying an argument to a command that takes none: reading
       `/clear` out of it would throw away the rest of what was typed. */
    expect(resolveCommand("/clear everything")).toBeNull();
    expect(resolveCommand("/renamed the file")).toBeNull();
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

/* `/rename` is the first Skein command whose argument is the point of it. The
   exact-and-whole rule is inverted for exactly that clause and nothing else:
   what follows the name is not the rest of a sentence that happened to start
   with a slash, it is the name you are giving the card. */
describe("a command that takes the rest of the line", () => {
  test("the argument comes back with the command", () => {
    const found = resolveCommand("/rename the auth work");
    expect(found?.cmd.name).toBe("rename");
    expect(found?.arg).toBe("the auth work");
  });

  test("the name is taken whole, punctuation and slashes included", () => {
    /* Anything after the command's own name is the name being given, so
       nothing in it can be read as a second command or a second argument. */
    expect(resolveCommand("/rename src/lib — the wire")?.arg).toBe(
      "src/lib — the wire",
    );
    expect(resolveCommand("/rename /clear")?.arg).toBe("/clear");
  });

  test("the space between is the separator, not part of the name", () => {
    expect(resolveCommand("/rename   spaced out  ")?.arg).toBe("spaced out");
  });

  test("a bare name resolves to nothing, because it would name nothing", () => {
    /* The same position `/model` is in with no value typed: incomplete rather
       than wrong. The palette holds Enter back before this is reached (it
       completes to `/rename ` instead), so what this covers is the draft that
       arrives with the palette dismissed — which falls through and goes to the
       agent as the words it is, exactly as `/commit` does. */
    expect(resolveCommand("/rename")).toBeNull();
    expect(resolveCommand("/rename ")).toBeNull();
    expect(resolveCommand("/rename    ")).toBeNull();
  });

  test("it is still only ours, and still only by its own name", () => {
    expect(resolveCommand("/renaming this card")).toBeNull();
    expect(resolveCommand("please /rename this card")).toBeNull();
    expect(resolveCommand(" /rename this card")).toBeNull();
    expect(cliCommand("/rename this card")).toBeNull();
  });

  test("the palette closes at the space, as it does for any prose", () => {
    /* Free text, so there is nothing to offer: the same answer `/compact`
       gets, and for the same reason — a palette left up over a name being
       written would be claiming a choice is still to be made. */
    expect(names("/rename the auth work")).toEqual([]);
    expect(typingChoice("/rename the")).toBeNull();
    expect(values("/rename ")).toEqual([]);
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
    expect(resolveCommand(completionFor(clear))?.cmd).toBe(clear);
  });

  test("a command that takes prose is completed with its space too", () => {
    /* For `/model`'s reason one step along: completing to `/rename` alone
       would leave the cursor against a name that cannot be run, with the thing
       it is waiting for one keystroke away and nothing saying so. */
    const rename = named("rename");
    expect(completionFor(rename)).toBe("/rename ");
    /* And what it gives is deliberately *not* runnable yet — a completion that
       resolved would be a Tab that renamed a card to nothing. */
    expect(resolveCommand(completionFor(rename))).toBeNull();
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
      if (c.by !== "skein") {
        expect(cliCommand(`/${c.name}`)).toBe(c);
        continue;
      }
      /* One that takes prose is only itself once it has some — its bare name
         is incomplete, the way `/model` is. So it is asked with an argument,
         which is the only form of it that can ever be run. */
      const typed = c.takesText ? `/${c.name} something` : `/${c.name}`;
      expect(resolveCommand(typed)?.cmd).toBe(c);
    }
  });

  test("a command takes a fixed set of values or free prose, never both", () => {
    /* They are the two halves of "this is not finished being chosen", and the
       palette answers them differently — it offers the values for one and
       closes at the space for the other. A command claiming both would be a
       palette that has to decide which it is at every keystroke. */
    for (const c of COMMANDS) expect(!!c.choices && !!c.takesText).toBe(false);
  });

  test("only Skein's own commands take prose", () => {
    /* A `cli` command's argument is the CLI's business — `/compact focus on
       auth` is sent verbatim, and nothing here reads it. `takesText` exists so
       that Skein can act on what was typed, which is only ever true of a
       command Skein carries out. */
    for (const c of COMMANDS) if (c.takesText) expect(c.by).toBe("skein");
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
