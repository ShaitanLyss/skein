import { expect, test, describe } from "bun:test";
import {
  parseInline,
  parseMarkdown,
  runIn,
  safeHref,
  type Block,
  type Inline,
} from "../src/lib/markdown";

/** Flatten a tree back to its words, so a test can say what a block *reads* as
 *  without spelling out every node. */
function words(kids: Inline[]): string {
  return kids
    .map((k) =>
      k.t === "text" ? k.v : k.t === "code" ? k.v : words((k as any).kids),
    )
    .join("");
}

const p = (b: Block) => (b.t === "p" ? words(b.kids) : `«${b.t}»`);

describe("blocks", () => {
  test("plain prose is one paragraph", () => {
    const [b] = parseMarkdown("just a sentence.");
    expect(b).toMatchObject({ t: "p" });
    expect(p(b)).toBe("just a sentence.");
  });

  test("a blank line separates paragraphs", () => {
    const bs = parseMarkdown("one\n\ntwo");
    expect(bs.map(p)).toEqual(["one", "two"]);
  });

  test("a single newline stays inside the paragraph", () => {
    /* GFM's `breaks`: an agent's own line breaks carry meaning in a chat
       transcript, so they survive rather than collapsing to a space. */
    const bs = parseMarkdown("one\ntwo");
    expect(bs).toHaveLength(1);
    expect(p(bs[0])).toBe("one\ntwo");
  });

  test("atx headings carry their level", () => {
    const bs = parseMarkdown("# one\n\n### three");
    expect(bs[0]).toMatchObject({ t: "h", level: 1 });
    expect(bs[1]).toMatchObject({ t: "h", level: 3 });
    expect(words((bs[1] as any).kids)).toBe("three");
  });

  test("a closing run of hashes is decoration", () => {
    const [b] = parseMarkdown("## title ##");
    expect(words((b as any).kids)).toBe("title");
  });

  test("#hashtag is not a heading", () => {
    expect(parseMarkdown("#nope")[0].t).toBe("p");
  });

  test("thematic breaks", () => {
    expect(parseMarkdown("---")[0]).toEqual({ t: "hr" });
    expect(parseMarkdown("***")[0]).toEqual({ t: "hr" });
    expect(parseMarkdown("- - -")[0]).toEqual({ t: "hr" });
  });

  test("a fenced block keeps its text verbatim", () => {
    const [b] = parseMarkdown("```ts\nconst a = 1;\n*not em*\n```");
    expect(b).toEqual({
      t: "code",
      lang: "ts",
      text: "const a = 1;\n*not em*",
      open: false,
    });
  });

  test("an unclosed fence is a code block already, and says so", () => {
    /* Mid-stream this is the ordinary state. Waiting for the closer would make
       every code block appear first as a paragraph of literal backticks. */
    const [b] = parseMarkdown("```\nhalf a fun");
    expect(b).toMatchObject({ t: "code", text: "half a fun", open: true });
  });

  test("a fence is de-indented by its own margin", () => {
    const [b] = parseMarkdown("  ```\n  indented\n  ```");
    expect((b as any).text).toBe("indented");
  });

  test("tildes fence too, and backticks inside them are text", () => {
    const [b] = parseMarkdown("~~~\n```\n~~~");
    expect(b).toMatchObject({ t: "code", text: "```", open: false });
  });

  test("blockquotes nest their own blocks", () => {
    const [b] = parseMarkdown("> quoted **hard**\n> still");
    expect(b.t).toBe("quote");
    expect(p((b as any).kids[0])).toBe("quoted hard\nstill");
  });
});

describe("lists", () => {
  test("bullets become items", () => {
    const [b] = parseMarkdown("- one\n- two\n- three");
    expect(b).toMatchObject({ t: "list", ordered: false, tight: true });
    expect((b as any).items.map((it: Block[]) => p(it[0]))).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  test("an ordered list remembers where it starts", () => {
    const [b] = parseMarkdown("3. three\n4. four");
    expect(b).toMatchObject({ t: "list", ordered: true, start: 3 });
    expect((b as any).items).toHaveLength(2);
  });

  test("blank lines between items make it loose", () => {
    const [b] = parseMarkdown("- one\n\n- two");
    expect(b).toMatchObject({ t: "list", tight: false });
    expect((b as any).items).toHaveLength(2);
  });

  test("an indented list is nested inside its item", () => {
    const [b] = parseMarkdown("- outer\n  - inner\n  - also\n- next");
    const items = (b as any).items as Block[][];
    expect(items).toHaveLength(2);
    expect(p(items[0][0])).toBe("outer");
    expect(items[0][1]).toMatchObject({ t: "list" });
    expect((items[0][1] as any).items).toHaveLength(2);
  });

  test("a wrapped item keeps its continuation", () => {
    const [b] = parseMarkdown("- one that runs\n  on a bit\n- two");
    expect(p((b as any).items[0][0])).toBe("one that runs\non a bit");
  });

  test("switching marker kind starts a new list", () => {
    const bs = parseMarkdown("- a\n1. b");
    expect(bs.map((x) => x.t)).toEqual(["list", "list"]);
    expect(bs[1]).toMatchObject({ ordered: true });
  });

  test("a fence inside an item is that item's code", () => {
    const [b] = parseMarkdown("- run this:\n  ```\n  bun test\n  ```\n- then that");
    const items = (b as any).items as Block[][];
    expect(items).toHaveLength(2);
    expect(items[0][1]).toMatchObject({ t: "code", text: "bun test" });
  });

  test("prose after a list is not swallowed by it", () => {
    const bs = parseMarkdown("- a\n- b\n\nafter");
    expect(bs.map((x) => x.t)).toEqual(["list", "p"]);
    expect(p(bs[1])).toBe("after");
  });
});

describe("tables", () => {
  const src = [
    "| file | what |",
    "| --- | ---: |",
    "| `a.ts` | one |",
    "| b.ts | two |",
  ].join("\n");

  test("a delimiter row makes the rows above and below a table", () => {
    const [b] = parseMarkdown(src);
    expect(b.t).toBe("table");
    const t = b as any;
    expect(t.head.map(words)).toEqual(["file", "what"]);
    expect(t.align).toEqual([null, "right"]);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0].map(words)).toEqual(["a.ts", "one"]);
  });

  test("cells are inline-parsed", () => {
    const [b] = parseMarkdown(src);
    expect((b as any).rows[0][0][0]).toEqual({ t: "code", v: "a.ts" });
  });

  test("outer pipes are optional and ragged rows are padded", () => {
    const [b] = parseMarkdown("a | b\n--- | ---\n1");
    expect(b.t).toBe("table");
    expect((b as any).rows[0]).toHaveLength(2);
  });

  test("a pipe in prose is not a table", () => {
    expect(parseMarkdown("run a | b and see")[0].t).toBe("p");
  });

  test("a table interrupts the paragraph above it", () => {
    const bs = parseMarkdown("here:\n| a |\n| --- |\n| 1 |");
    expect(bs.map((x) => x.t)).toEqual(["p", "table"]);
  });
});

describe("inline", () => {
  test("emphasis and strong", () => {
    expect(parseInline("*a*")).toEqual([{ t: "em", kids: [{ t: "text", v: "a" }] }]);
    expect(parseInline("**a**")).toEqual([
      { t: "strong", kids: [{ t: "text", v: "a" }] },
    ]);
    expect(parseInline("***a***")).toEqual([
      { t: "strong", kids: [{ t: "em", kids: [{ t: "text", v: "a" }] }] },
    ]);
  });

  test("strong nests inside emphasis without tearing", () => {
    const [em] = parseInline("*a **b** c*");
    expect(em.t).toBe("em");
    expect((em as any).kids[1]).toMatchObject({ t: "strong" });
  });

  test("strikethrough", () => {
    expect(parseInline("~~gone~~")[0]).toMatchObject({ t: "del" });
    expect(parseInline("~one~")[0]).toEqual({ t: "text", v: "~one~" });
  });

  test("underscores do not fire inside a word", () => {
    /* Every file the agent names would otherwise go half-italic. */
    expect(parseInline("read_ai_title runs")).toEqual([
      { t: "text", v: "read_ai_title runs" },
    ]);
    expect(parseInline("_yes_ it does")[0]).toMatchObject({ t: "em" });
  });

  test("an asterisk with space around it is arithmetic, not emphasis", () => {
    expect(parseInline("2 * 3 * 4")).toEqual([{ t: "text", v: "2 * 3 * 4" }]);
  });

  test("an unmatched marker stays literal", () => {
    expect(parseInline("**half typed")).toEqual([{ t: "text", v: "**half typed" }]);
    expect(parseInline("a ` b")).toEqual([{ t: "text", v: "a ` b" }]);
  });

  test("code spans win over everything inside them", () => {
    expect(parseInline("`a *b* _c_`")).toEqual([{ t: "code", v: "a *b* _c_" }]);
  });

  test("a code span may hold backticks", () => {
    expect(parseInline("`` a ` b ``")).toEqual([{ t: "code", v: "a ` b" }]);
  });

  test("escapes", () => {
    expect(parseInline("\\*not em\\*")).toEqual([{ t: "text", v: "*not em*" }]);
  });

  test("links", () => {
    expect(parseInline("[docs](https://example.com/x)")).toEqual([
      {
        t: "link",
        href: "https://example.com/x",
        kids: [{ t: "text", v: "docs" }],
      },
    ]);
  });

  test("a link title is dropped, not printed", () => {
    const [l] = parseInline('[a](https://e.com "why")');
    expect(l).toMatchObject({ t: "link", href: "https://e.com" });
  });

  test("a bare url is clickable and stops before the full stop", () => {
    const kids = parseInline("see https://example.com/a. thanks");
    expect(kids[1]).toMatchObject({ t: "link", href: "https://example.com/a" });
    expect(kids[2]).toEqual({ t: "text", v: ". thanks" });
  });

  test("an autolink in angle brackets", () => {
    expect(parseInline("<https://e.com>")[0]).toMatchObject({
      t: "link",
      href: "https://e.com",
    });
  });

  test("an image renders as its alt text, never as a fetch", () => {
    const kids = parseInline("![a cat](https://e.com/cat.png)");
    expect(kids).toEqual([
      { t: "link", href: "https://e.com/cat.png", kids: [{ t: "text", v: "a cat" }] },
    ]);
  });

  test("an unsafe destination is not a link at all", () => {
    expect(parseInline("[click](javascript:alert(1))")).toEqual([
      { t: "text", v: "click" },
    ]);
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("www.example.com")).toBe("https://www.example.com");
  });
});

describe("streaming", () => {
  /* Every prefix of a real answer has to parse into something showable — the
     panel re-parses the streaming line on every text delta. */
  const answer = [
    "Here is **the** plan:",
    "",
    "1. read `store.rs`",
    "2. add a migration",
    "",
    "```rust",
    "let x = 1;",
    "```",
    "",
    "> and then stop",
  ].join("\n");

  test("no prefix throws, and none is empty", () => {
    for (let n = 1; n <= answer.length; n++) {
      const bs = parseMarkdown(answer.slice(0, n));
      expect(Array.isArray(bs)).toBe(true);
      expect(bs.length).toBeGreaterThan(0);
    }
  });

  test("the whole thing folds into the blocks it looks like", () => {
    expect(parseMarkdown(answer).map((b) => b.t)).toEqual([
      "p",
      "list",
      "code",
      "quote",
    ]);
  });
});

/* The heading an agent actually writes. `##` is the exception in practice —
   a section's name arrives in bold at the head of its paragraph. */
describe("run-in headings", () => {
  const lead = (src: string) => runIn(parseMarkdown(src)[0].kids as Inline[]);

  test("a bold opening is the paragraph's name", () => {
    expect(lead("**1. The impact pipeline.** The largest unbuilt system left.")).toBe(
      "1. The impact pipeline.",
    );
  });

  test("a whole paragraph in bold is a label too", () => {
    expect(lead("**My pick: #1.**")).toBe("My pick: #1.");
  });

  test("bold in the middle of a sentence is emphasis, and starts no section", () => {
    expect(lead("it is the **deepest** unbuilt thing.")).toBe(null);
  });

  test("a plain paragraph has no label", () => {
    expect(lead("six, ordered by what I'd pick.")).toBe(null);
  });

  /* Bold used for weight rather than as a name: a rail entry that is the
     paragraph again is not a table of contents. */
  test("a first sentence written in bold is not a label", () => {
    expect(
      lead(
        "**every card is a long-lived child process and there is no terminal emulator anywhere on the path.** that is the whole design.",
      ),
    ).toBe(null);
  });

  test("the marks inside the label come off — a rail draws words", () => {
    expect(lead("**`SetTargetAlpha` has no caller.** The natural one is nearby.")).toBe(
      "SetTargetAlpha has no caller.",
    );
  });

  test("an indented paragraph still opens with its bold", () => {
    expect(lead(" **3. Seamless travel.** small, mechanical.")).toBe(
      "3. Seamless travel.",
    );
  });

  /* Mid-stream every prefix of an answer has to parse into something showable,
     and half a bold opening is not a heading yet. */
  test("a half-written label is not one", () => {
    expect(lead("**4. Moving parts")).toBe(null);
  });
});
