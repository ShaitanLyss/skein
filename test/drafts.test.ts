import { describe, expect, test } from "bun:test";

import { Drafts } from "../src/lib/drafts";

describe("switchTo", () => {
  test("a draft stays with the card it was written at", () => {
    const d = new Drafts();
    /* Landing on the first card with an empty field: nothing to carry. */
    expect(d.switchTo("a", "")).toBe("");
    /* Type at it, then click another — the field comes back empty rather than
       pointing what you wrote at whoever you landed on. */
    expect(d.switchTo("b", "half a prompt")).toBe("");
    /* And come back to it. */
    expect(d.switchTo("a", "")).toBe("half a prompt");
  });

  test("both cards keep their own", () => {
    const d = new Drafts();
    d.switchTo("a", "");
    d.switchTo("b", "for a");
    d.switchTo("a", "for b");
    expect(d.peek("a")).toBe("for a");
    expect(d.peek("b")).toBe("for b");
  });

  test("landing where you already are changes nothing", () => {
    const d = new Drafts();
    d.switchTo("a", "");
    expect(d.switchTo("a", "still typing")).toBe("still typing");
  });

  test("focusing nothing leaves the field and the holder alone", () => {
    const d = new Drafts();
    d.switchTo("a", "");
    /* Escape, or a click on the ground. Letting go of a card says nothing
       about the sentence you were writing at it. */
    expect(d.switchTo(null, "mid sentence")).toBe("mid sentence");
    expect(d.holding).toBe("a");
    /* So the editing that follows still belongs to that card. */
    expect(d.switchTo("b", "mid sentence, finished")).toBe("");
    expect(d.peek("a")).toBe("mid sentence, finished");
  });

  test("text held by nobody is adopted by the card that takes the focus", () => {
    const d = new Drafts();
    /* Typed on a bare wall at launch — plainly meant for whatever you were
       about to click, so clicking it must not swallow it. */
    expect(d.switchTo("a", "the first thing")).toBe("the first thing");
    expect(d.peek("a")).toBe("the first thing");
  });

  test("but not over a draft that card already had", () => {
    const d = new Drafts();
    d.switchTo("a", "");
    d.switchTo("b", "for a");
    d.forget("b");
    expect(d.switchTo("a", "loose")).toBe("for a");
  });

  test("an emptied draft is not kept", () => {
    const d = new Drafts();
    d.switchTo("a", "");
    d.switchTo("b", "said and sent");
    /* The send cleared the field; coming back parks the truth over the copy. */
    d.switchTo("a", "");
    expect(d.peek("b")).toBe("");
    expect(d.switchTo("b", "")).toBe("");
  });
});

describe("forget", () => {
  test("a closed card's line goes with it", () => {
    const d = new Drafts();
    d.switchTo("a", "");
    d.switchTo("b", "for a");
    d.forget("a");
    expect(d.peek("a")).toBe("");
    expect(d.switchTo("a", "")).toBe("");
  });

  test("closing the card the field is holding drops the hold", () => {
    const d = new Drafts();
    d.switchTo("a", "");
    d.forget("a");
    expect(d.holding).toBe(null);
    /* And the next card takes what is left in the field, which the dock has
       cleared — so nothing of the closed card reaches it. */
    expect(d.switchTo("b", "")).toBe("");
    expect(d.peek("b")).toBe("");
  });
});
