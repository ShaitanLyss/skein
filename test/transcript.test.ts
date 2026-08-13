import { expect, test, describe } from "bun:test";
import { blocksOf, foldCount, foldSummary, MIN_FOLD } from "../src/lib/transcript";
import type { Line } from "../src/lib/conversation.svelte";

const you = (text: string): Line => ({ kind: "you", text });
const said = (text: string): Line => ({ kind: "text", text });
const tool = (text: string): Line => ({ kind: "tool", text });
const bad = (text: string): Line => ({ kind: "error", text });

/** What a column came out as, in one readable string: `t` for a line, and a
 *  folded group as its size. */
const shape = (lines: Line[]) =>
  blocksOf(lines)
    .map((b) => (b.kind === "line" ? b.line.kind : `[${b.lines.length}]`))
    .join(" ");

describe("a run of tool calls folds into one block", () => {
  test("an ordinary round: what you asked, the machinery, the answer", () => {
    expect(
      shape([
        you("fold the tool calls"),
        said("right — first, what is there"),
        tool("reading Transcript.svelte"),
        tool("reading outline.ts"),
        tool("editing Transcript.svelte"),
        said("done, and here is why"),
      ]),
    ).toBe("you text [3] text");
  });

  test("a lone call stays a line — folding it would cost more than it saves", () => {
    expect(shape([said("checking"), tool("reading foo.ts"), said("it's fine")])).toBe(
      "text tool text",
    );
    expect(MIN_FOLD).toBe(2);
  });

  test("speech between two runs keeps them apart", () => {
    expect(
      shape([
        tool("reading a"),
        tool("reading b"),
        said("now the store"),
        tool("editing c"),
        tool("editing d"),
      ]),
    ).toBe("[2] text [2]");
  });

  /* The whole reason the fold is safe: it cannot swallow anything that is not a
     tool call, so an error stays exactly where it happened. */
  test("an error breaks the run and is never folded away", () => {
    expect(
      shape([tool("reading a"), tool("reading b"), bad("exited 1"), tool("reading c")]),
    ).toBe("[2] error tool");
  });

  test("nothing folds nothing", () => {
    expect(blocksOf([])).toEqual([]);
  });

  test("a whole column of calls is one group", () => {
    expect(shape([tool("a"), tool("b"), tool("c"), tool("d")])).toBe("[4]");
  });

  test("the lines inside a group are the run, in order", () => {
    const blocks = blocksOf([you("go"), tool("reading a"), tool("reading b")]);
    const group = blocks[1];
    expect(group.kind).toBe("tools");
    if (group.kind !== "tools") return;
    expect(group.lines.map((l) => l.text)).toEqual(["reading a", "reading b"]);
  });
});

describe("a key that survives what happens to the column", () => {
  /* The live fold is capped and sliced off the front, so every index shifts. A
     group keyed by position would hand its open state to whatever landed on that
     index; keyed by its opening words it keeps it. */
  test("dropping lines off the front leaves a group's key alone", () => {
    const lines = [you("go"), said("ok"), tool("reading a"), tool("reading b")];
    const before = blocksOf(lines).find((b) => b.kind === "tools")!.key;
    const after = blocksOf(lines.slice(2)).find((b) => b.kind === "tools")!.key;
    expect(after).toBe(before);
  });

  test("a growing group keeps its key — a new call lands at the end", () => {
    const key = (ls: Line[]) => blocksOf(ls).find((b) => b.kind === "tools")!.key;
    expect(key([tool("reading a"), tool("reading b"), tool("editing c")])).toBe(
      key([tool("reading a"), tool("reading b")]),
    );
  });

  test("two runs opening with the same words are still two groups", () => {
    const keys = blocksOf([
      tool("running the suite"),
      tool("reading a"),
      said("again, then"),
      tool("running the suite"),
      tool("reading a"),
    ])
      .filter((b) => b.kind === "tools")
      .map((b) => b.key);
    expect(keys.length).toBe(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("the two columns share one namespace and must not collide", () => {
    const live = blocksOf([tool("a"), tool("b")], "l");
    const past = blocksOf([tool("a"), tool("b")], "h");
    expect(live[0].key).not.toBe(past[0].key);
  });

  test("a folded group cannot take a plain line's key", () => {
    const keys = blocksOf([said("x"), tool("a"), tool("b")]).map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("what the cap says", () => {
  test("open, it says how much is in there", () => {
    expect(foldCount([tool("a"), tool("b"), tool("c")])).toBe("3 tool calls");
    expect(foldCount([tool("a")])).toBe("1 tool call");
  });

  /* The last call, not the first: at the foot of a live turn that is the one
     happening now, so a folded group is still a status. */
  test("folded, it says how much and what is happening", () => {
    expect(foldSummary([tool("reading a"), tool("editing Transcript.svelte")])).toBe(
      "2 tool calls · editing Transcript.svelte",
    );
  });

  test("a long command is cut rather than pushed off the edge", () => {
    const long = "bun test test/transcript.test.ts -t 'a run of tool calls folds'";
    const out = foldSummary([tool("a"), tool(long)]);
    expect(out.startsWith("2 tool calls · ")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });
});
