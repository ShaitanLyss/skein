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
    expect(d.holds("a")).toBe(true);
  });

  test("the wall keeps one of its own", () => {
    const d = new Drafts();
    /* A marquee gathering: several cards selected, none focused, and the field
       live and aimed at all of them. */
    expect(d.switchTo(null, "")).toBe("");
    expect(d.switchTo("a", "say this to all five")).toBe("");
    expect(d.switchTo(null, "")).toBe("say this to all five");
  });

  test("the field starts on the wall", () => {
    const d = new Drafts();
    expect(d.holds(null)).toBe(true);
    /* So the first card focused takes the field rather than inheriting it. */
    expect(d.switchTo("a", "typed with nothing in hand")).toBe("");
    expect(d.peek(null)).toBe("typed with nothing in hand");
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

describe("release", () => {
  test("a line still being written survives the card it was written at", () => {
    const d = new Drafts();
    d.switchTo("a", "");
    /* Closing the card is not a statement about the sentence, so the wall takes
       the line on and the field goes on showing it. */
    expect(d.release("a", "mid sentence")).toBe("mid sentence");
    expect(d.holds(null)).toBe(true);
    /* The focus landing on the next card parks it on the wall rather than
       carrying it in — which is the whole point. */
    expect(d.switchTo("b", "mid sentence")).toBe("");
    expect(d.peek(null)).toBe("mid sentence");
    expect(d.peek("b")).toBe("");
  });

  test("what the card had parked goes with the card", () => {
    const d = new Drafts();
    d.switchTo("a", "");
    d.switchTo("b", "for a");
    /* `a` is closed from the wall while `b` holds the field. There is nowhere
       left that its draft could ever be shown, and the field is not `a`'s to
       disturb. */
    expect(d.release("a", "for b")).toBe("for b");
    expect(d.peek("a")).toBe("");
    expect(d.holds("b")).toBe(true);
  });

  test("an empty field does not clear the wall's own draft", () => {
    const d = new Drafts();
    d.switchTo(null, "");
    d.switchTo("a", "for the gathering");
    /* Nothing was being written at `a`, so there is nothing to hand over — and
       the field is given the wall's own to show rather than wiping it. */
    expect(d.release("a", "")).toBe("for the gathering");
    expect(d.switchTo("b", "for the gathering")).toBe("");
    expect(d.peek(null)).toBe("for the gathering");
  });

  test("but a line in it wins, being the newer of the two", () => {
    const d = new Drafts();
    d.switchTo(null, "");
    d.switchTo("a", "for the gathering");
    expect(d.release("a", "mid sentence")).toBe("mid sentence");
    expect(d.peek(null)).toBe("mid sentence");
  });
});
