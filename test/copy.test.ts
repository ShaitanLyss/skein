import { expect, test, describe } from "bun:test";
import { toMarkdown, type Bit } from "../src/lib/copy";

/* The fragment a selection clones, written by hand. `bitsOf` is the only part
   of copy.ts that has seen a DOM, and it does nothing but this. */
const t = (text: string): Bit => ({ text });
const e = (tag: string, kids: Bit[] = [], attr: Record<string, string> = {}): Bit => ({
  tag,
  attr,
  kids,
});
const p = (...kids: Bit[]) => e("P", kids);

describe("the marks come back", () => {
  test("bold, italic and struck text keep theirs", () => {
    expect(
      toMarkdown([
        p(e("STRONG", [t("My pick: #1.")]), t(" It's the deepest unbuilt thing.")),
      ]),
    ).toBe("**My pick: #1.** It's the deepest unbuilt thing.");
    expect(toMarkdown([p(e("EM", [t("design")]), t("-risk"))])).toBe("*design*-risk");
    expect(toMarkdown([p(e("DEL", [t("gone")]))])).toBe("~~gone~~");
  });

  test("a heading is drawn as a div and copied as its hashes", () => {
    expect(toMarkdown([e("DIV", [t("The event pipeline")], { "data-level": "3" })])).toBe(
      "### The event pipeline",
    );
  });

  test("blocks are separated the way a source file separates them", () => {
    expect(toMarkdown([p(t("one")), p(t("two"))])).toBe("one\n\ntwo");
  });

  /* The reason this exists at all: an ordered list copied as rendered text is
     six paragraphs that have lost their numbers. */
  test("a numbered list is still numbered, and from where it started", () => {
    const list = e(
      "OL",
      [e("LI", [p(t("first"))]), e("LI", [p(t("second"))])],
      { start: "4" },
    );
    expect(toMarkdown([list])).toBe("4. first\n\n5. second");
  });

  test("a bulleted list gets its dashes back — the em dash on screen is CSS", () => {
    expect(toMarkdown([e("UL", [e("LI", [p(t("a"))]), e("LI", [p(t("b"))])])])).toBe(
      "- a\n\n- b",
    );
  });

  /* Loose above, tight here: the class the panel already draws it by is the
     record of which it was. */
  test("a tight list comes back tight", () => {
    const list = e("UL", [e("LI", [p(t("a"))]), e("LI", [p(t("b"))])], {
      class: "tight",
    });
    expect(toMarkdown([list])).toBe("- a\n- b");
  });

  test("a nested list is indented under its marker, so it nests when read back", () => {
    const inner = e("UL", [e("LI", [p(t("deep"))])]);
    expect(toMarkdown([e("UL", [e("LI", [p(t("top")), inner])])])).toBe(
      "- top\n\n  - deep",
    );
  });

  test("a fence keeps its language and its lines", () => {
    const pre = e(
      "PRE",
      [e("SPAN", [t("rust")], { class: "lang" }), e("CODE", [t("let x = 1;\nlet y = 2;")])],
      { class: "code" },
    );
    /* The button is drawn inside its perch — a block element, so a fence
       followed by a paragraph must not gain an empty one in between. */
    const perch = e("DIV", [e("BUTTON", [t("copy")], { class: "copy" })], { class: "perch" });
    expect(toMarkdown([e("DIV", [pre, perch], { class: "fence" })])).toBe(
      "```rust\nlet x = 1;\nlet y = 2;\n```",
    );
    expect(toMarkdown([e("DIV", [pre, perch], { class: "fence" }), p(t("after"))])).toBe(
      "```rust\nlet x = 1;\nlet y = 2;\n```\n\nafter",
    );
  });

  test("a code span is fenced longer than the backticks inside it", () => {
    expect(toMarkdown([p(e("CODE", [t("a `b` c")]))])).toBe("``a `b` c``");
  });

  test("a link is a button with its destination on the title", () => {
    expect(
      toMarkdown([p(e("BUTTON", [t("the docs")], { class: "link", title: "https://x.dev" }))]),
    ).toBe("[the docs](https://x.dev)");
  });

  /* `[url](url)` is noise: a bare url pastes as a link everywhere it matters. */
  test("a url that is its own label is left bare", () => {
    expect(
      toMarkdown([
        p(e("BUTTON", [t("https://x.dev")], { class: "link", title: "https://x.dev" })),
      ]),
    ).toBe("https://x.dev");
  });

  test("a quote is prefixed line by line", () => {
    expect(toMarkdown([e("BLOCKQUOTE", [p(t("said")), p(t("and said"))])])).toBe(
      "> said\n>\n> and said",
    );
  });

  test("a table comes back as pipes, alignment included", () => {
    const row = (tag: string, cells: string[], align?: string) =>
      e(
        "TR",
        cells.map((c) => e(tag, [t(c)], align ? { style: `text-align: ${align};` } : {})),
      );
    const table = e("TABLE", [
      e("THEAD", [row("TH", ["tier", "means"], "center")]),
      e("TBODY", [row("TD", ["ask", "waiting"])]),
    ]);
    expect(toMarkdown([table])).toBe(
      "| tier | means |\n| :---: | :---: |\n| ask | waiting |",
    );
  });

  test("a pipe inside a cell is escaped, or it would split the row", () => {
    const table = e("TABLE", [
      e("TR", [e("TH", [t("a|b")])]),
      e("TR", [e("TD", [t("c")])]),
    ]);
    expect(toMarkdown([table])).toBe("| a\\|b |\n| --- |\n| c |");
  });
});

describe("what is drawn but was never said", () => {
  test("the panel's own furniture is not copied", () => {
    const line = e("DIV", [
      p(t("answering"), e("SPAN", [], { class: "caret" })),
      e("DIV", [e("SPAN", [t("earlier — read from the transcript")])], { class: "seam" }),
    ]);
    expect(toMarkdown([line])).toBe("answering");
  });

  /* A selection dragged across nothing but a copy button must leave the
     clipboard alone rather than empty it — the caller checks for "". */
  test("a fragment with nothing in it says nothing", () => {
    expect(toMarkdown([e("BUTTON", [t("copy")], { class: "copy" })])).toBe("");
    expect(toMarkdown([])).toBe("");
  });
});

describe("half a selection is half a document", () => {
  /* Chromium clones the ancestors it can see: dragging from the middle of one
     paragraph into the next gives two partial paragraphs and no more. */
  test("a run that starts mid-sentence keeps the marks it contains", () => {
    expect(
      toMarkdown([p(t("pick "), e("STRONG", [t("#1")]), t(".")), p(t("It's the"))]),
    ).toBe("pick **#1**.\n\nIt's the");
  });

  /* Selecting inside one bullet gives a fragment with no list in it — there is
     no marker to write, and inventing one would claim a shape that was not
     copied. */
  test("text taken from inside a list item is text", () => {
    expect(toMarkdown([t("the settle item")])).toBe("the settle item");
  });
});

describe("an opened tool call", () => {
  /** One row of a diff as `ToolCall.svelte` draws it: the gutter mark in its own
   *  span so it can be held at a fixed width, and the line beside it. */
  const row = (sign: string, text: string, kind = "row") =>
    e("DIV", [e("SPAN", [t(sign)], { class: "gut" }), t(text)], { class: kind });

  test("a diff comes out as a diff, not as one paragraph per line", () => {
    /* Every row is its own element so it can carry a background, which makes
       every one of them a block — and blocks are joined with a blank line, so
       an eight-line edit came back sixteen lines tall with the shape of the
       change gone. */
    const diff = e(
      "DIV",
      [
        row(" ", "const a = 1;"),
        row("-", "const b = 2;", "row out"),
        row("+", "const b = 3;", "row in"),
      ],
      { class: "diff" },
    );
    expect(toMarkdown([diff])).toBe(
      "```diff\n const a = 1;\n-const b = 2;\n+const b = 3;\n```",
    );
  });

  test("an argument is its label and its value on one line", () => {
    /* `dt`/`dd` are inline as far as this is concerned, so the pair reads as
       written rather than as two paragraphs with a gap between them. */
    const arg = e(
      "DIV",
      [e("DT", [t("file path")]), e("DD", [t(" src/lib/toolcall.ts")])],
      { class: "arg inline" },
    );
    expect(toMarkdown([arg])).toBe("file path src/lib/toolcall.ts");
  });

  test("what came back is a fence, like any other block of output", () => {
    expect(toMarkdown([e("PRE", [t("44 pass\n0 fail")], { class: "out" })])).toBe(
      "```\n44 pass\n0 fail\n```",
    );
  });

  test("the fold's own controls are not part of what was said", () => {
    /* The head that opens the call and the button asking for the rest of a
       result are furniture — the same rule the fence's copy button is under. */
    expect(
      toMarkdown([
        e("BUTTON", [t("▸ Read reading toolcall.ts")], { class: "head" }),
        e("PRE", [t("the file")], { class: "out" }),
        e("BUTTON", [t("the remaining 36 lines")], { class: "more" }),
      ]),
    ).toBe("```\nthe file\n```");
  });
});
