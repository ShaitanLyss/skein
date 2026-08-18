/** What you have typed and not yet sent, per card.
 *
 *  The dock is one field over a wall of cards, and it used to be one draft too:
 *  half a prompt written at one card was still sitting there after you clicked
 *  another, pointed at the new one, one Enter away from being said to whoever
 *  you happened to land on. That is the failure this exists to stop — a draft
 *  belongs to the card it was written at, and the field is only where it is
 *  being held.
 *
 *  So the field's text is parked under the card that is losing the focus and
 *  the next card's is handed back, which makes leaving a card and coming back
 *  to it a round trip rather than a loss. Nothing is written to the store: an
 *  unsent line is a thought in progress, and it lives as long as the window
 *  does.
 *
 *  **A draft with no card in hand is a draft too**, which is why the wall gets a
 *  bucket of its own rather than being a special case. Two states really have
 *  one: a marquee gathering, which is several cards selected with none focused
 *  and a live field aimed at all of them; and the moment after the card you were
 *  writing at is closed. Both leave text in the field belonging to no card — and
 *  with nowhere to park it, either the next card you click inherits it (the
 *  carry-over this class exists to stop) or it goes on the floor. Neither, now.
 *
 *  Pure, per the purity boundary — this is the bookkeeping, and `App.svelte`
 *  owns the field, the focus and the one effect that calls `switchTo`. */

/** The bucket for "no card in hand". Not an id and cannot collide with one:
 *  every conversation id is a non-empty uuid. */
const WALL = "";

export class Drafts {
  /** Card id (or `WALL`) → unsent text. Only non-empty drafts are kept, so a
   *  wall you have clicked across all afternoon holds nothing.
   *
   *  The held bucket's entry goes stale the moment a send clears the field, and
   *  deliberately so: nothing reads it until the next `switchTo`, which parks
   *  the field's real contents over it first. */
  #parked = new Map<string, string>();
  #holding = WALL;

  /** Is the field holding this card's draft? `null` asks about the wall.
   *
   *  The dock asks before swapping, because a swap is also where the palette and
   *  `!` dismissals are dropped — and dropping those on a focus that did not
   *  actually move would undo an Escape you had just pressed. */
  holds(id: string | null): boolean {
    return this.#holding === (id ?? WALL);
  }

  /** What a card has waiting, without disturbing anything. `null` is the wall's
   *  own. */
  peek(id: string | null): string {
    return this.#parked.get(id ?? WALL) ?? "";
  }

  /** Hand the field from whoever holds it to `id` — a card, or `null` for the
   *  wall: park what is in it, answer with what that one had.
   *
   *  `text` is the field's current contents and the return is what it should now
   *  say — the caller assigns it, so this stays a function of its inputs. */
  switchTo(id: string | null, text: string): string {
    const to = id ?? WALL;
    if (to === this.#holding) return text;
    this.#park(this.#holding, text);
    this.#holding = to;
    return this.peek(to);
  }

  /** The card is gone — closed, and closing deletes the row, so the id will
   *  never come round again.
   *
   *  Its parked draft goes with it, since there is nowhere left that text could
   *  ever be shown. A line still *in the field* does not: closing the card you
   *  were writing at is not a statement about the sentence you were writing, so
   *  the wall takes ownership of it and the focus landing on the next card parks
   *  it there rather than carrying it in.
   *
   *  Which leaves two lines wanting one bucket, when the wall already had a
   *  draft of its own. Answered the same way `switchTo` is, and for the same
   *  reason it takes the text as an argument: an empty field has nothing to hand
   *  over, so the wall keeps what it had and the field is given it to show — and
   *  a field with something in it hands that over, because it is the line you
   *  were writing a moment ago and the wall's was set down before it. */
  release(id: string, text: string): string {
    this.#parked.delete(id);
    if (this.#holding !== id) return text;
    this.#holding = WALL;
    if (!text) return this.peek(WALL);
    this.#park(WALL, text);
    return text;
  }

  #park(id: string, text: string): void {
    if (text) this.#parked.set(id, text);
    else this.#parked.delete(id);
  }
}
