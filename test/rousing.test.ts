import { describe, expect, test } from "bun:test";

import {
  RESUME_NOTE,
  ROUSE_GAP_MS,
  resumePrompt,
  rouseOrder,
} from "../src/lib/rousing";

/** A card, as much of one as the ordering reads. */
const card = (id: string, dormant: boolean, interrupted = false) => ({
  id,
  dormant,
  interrupted,
});

describe("rouseOrder", () => {
  test("a card with a process is left alone", () => {
    const awake = card("a", false);
    expect(rouseOrder([awake, card("b", true)]).map((c) => c.id)).toEqual(["b"]);
  });

  test("the ones that lost a turn go first", () => {
    const order = rouseOrder([
      card("quiet-1", true),
      card("lost", true, true),
      card("quiet-2", true),
    ]);
    expect(order.map((c) => c.id)).toEqual(["lost", "quiet-1", "quiet-2"]);
  });

  test("everything else keeps the wall's own order", () => {
    const order = rouseOrder([
      card("a", true),
      card("b", true),
      card("c", true),
    ]);
    expect(order.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  test("an interrupted card that is somehow already awake is not woken twice", () => {
    /* Not a hypothetical: the queue re-reads `dormant` when a card's turn comes
       up, and by then you may have spoken to it yourself. Whatever this returns
       is a list of spawn calls, and a spawn against a live child is an error. */
    expect(rouseOrder([card("a", false, true)])).toEqual([]);
  });

  test("a card put by is left where you put it", () => {
    /* `aside` says stop counting this as waiting. Handing it a process back at
       every launch is that instruction ignored — including when it lost a turn,
       since setting a card aside mid-turn is the gesture that says not now. */
    const order = rouseOrder([
      { id: "put-by", dormant: true, interrupted: false, aside: true },
      { id: "put-by-mid-turn", dormant: true, interrupted: true, aside: true },
      { id: "ordinary", dormant: true, interrupted: false },
    ]);
    expect(order.map((c) => c.id)).toEqual(["ordinary"]);
  });

  test("nothing on the wall is nothing to do", () => {
    expect(rouseOrder([])).toEqual([]);
  });

  /* The strongest thing setting a card aside means. Rousing spawns a process
     per dormant card; a card put by for later is exactly one you have said you
     are not carrying on with, so giving it a process back at every launch is
     that instruction ignored. */
  test("a card set aside is left where it was put", () => {
    const order = rouseOrder([
      { ...card("parked", true), aside: true },
      card("ordinary", true),
    ]);
    expect(order.map((c) => c.id)).toEqual(["ordinary"]);
  });

  test("and set aside outranks having lost a turn", () => {
    /* Setting a card aside mid-turn is precisely the gesture that says "not
       this, not now" — so it must not be resumed with the rest of them. */
    const order = rouseOrder([
      { ...card("parked", true, true), aside: true },
      card("lost", true, true),
    ]);
    expect(order.map((c) => c.id)).toEqual(["lost"]);
  });

  test("the order is a new list — the wall's own is not reshuffled", () => {
    const cards = [card("a", true), card("lost", true, true)];
    rouseOrder(cards);
    expect(cards.map((c) => c.id)).toEqual(["a", "lost"]);
  });
});

describe("the pacing", () => {
  test("there is a gap, and it is not so long the wall never finishes", () => {
    expect(ROUSE_GAP_MS).toBeGreaterThan(0);
    expect(ROUSE_GAP_MS).toBeLessThanOrEqual(2000);
  });
});

describe("resumePrompt", () => {
  const p = resumePrompt();

  test("it says why it is speaking", () => {
    expect(p).toContain("skein closed");
  });

  test("it sends the agent to look before it carries on", () => {
    expect(p).toContain("git status");
  });

  test("it says to stop rather than guess", () => {
    /* The load-bearing half. An agent that guesses at its own half-finished
       work produces something that looks finished, which is worse than the
       question it should have asked. */
    expect(p.toLowerCase()).toContain("stop");
    expect(p.toLowerCase()).toContain("guess");
  });

  test("it is wrapped, because the panel renders GFM breaks", () => {
    for (const line of p.split("\n")) expect(line.length).toBeLessThanOrEqual(78);
  });

  test("the note that introduces it says who is talking", () => {
    expect(RESUME_NOTE).toContain("skein");
  });
});
