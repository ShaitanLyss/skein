/** What you have typed at a card and not yet sent.
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
 *  Pure, per the purity boundary — this is the bookkeeping, and `App.svelte`
 *  owns the field, the focus and the one effect that calls `switchTo`. */

/** The card whose draft the field holds, or `null` for nobody — before the
 *  first card is focused, and after the held card is closed. */
type Holder = string | null;

export class Drafts {
  /** Card id → unsent text. Only non-empty drafts are kept, so a wall you have
   *  clicked across all afternoon holds nothing.
   *
   *  The held card's entry goes stale the moment a send clears the field, and
   *  deliberately so: nothing reads it until the next `switchTo`, which parks
   *  the field's real contents over it first. */
  #parked = new Map<string, string>();
  #holding: Holder = null;

  /** Whose draft the field is holding, for the control surface and the tests. */
  get holding(): Holder {
    return this.#holding;
  }

  /** What a card has waiting, without disturbing anything. */
  peek(id: string): string {
    return this.#parked.get(id) ?? "";
  }

  /** Hand the field from whoever holds it to `id`: park what is in it, answer
   *  with what that card had.
   *
   *  `text` is the field's current contents and the return is what it should
   *  now say — the caller assigns it, so this stays a function of its inputs.
   *
   *  Two cases are deliberately not a swap. Focusing nothing (Escape, a click
   *  on the ground) leaves the field exactly as it is and the holder standing:
   *  letting go of a card is not a statement about the sentence you were
   *  writing at it, and blanking the dock there would be the loss this class
   *  exists to prevent, one gesture over. And text held by *nobody* — the first
   *  thing typed after launch, before any card is focused — is adopted by the
   *  card that takes the focus rather than thrown away, since it was plainly
   *  meant for whatever you were about to click. */
  switchTo(id: string | null, text: string): string {
    if (id === null || id === this.#holding) return text;
    if (this.#holding === null) {
      const had = this.peek(id);
      this.#holding = id;
      if (had) return had;
      this.#park(id, text);
      return text;
    }
    this.#park(this.#holding, text);
    this.#holding = id;
    return this.peek(id);
  }

  /** The card is gone. Its draft goes with it — an unsent line at a closed card
   *  has nowhere to be said, and handing it to the next card to take the focus
   *  would be the carry-over this class exists to stop, wearing a different
   *  hat. */
  forget(id: string): void {
    this.#parked.delete(id);
    if (this.#holding === id) this.#holding = null;
  }

  #park(id: string, text: string): void {
    if (text) this.#parked.set(id, text);
    else this.#parked.delete(id);
  }
}
