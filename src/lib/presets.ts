/* What a card is set to before it has been asked anything.
 *
 * A conversation costs whatever the model and the effort behind it cost, and
 * both are decided *before* the first word — after that, changing them is a
 * `/model` and an `/effort` into a card that has already spent a full context
 * on its opening prompt. The wall's `+` opened every card on whatever Claude
 * Code happens to be configured for, which for most people is one setting doing
 * duty for a one-line question and a day-long refactor alike. One of those is
 * paying far too much and the other is being answered too cheaply, and you
 * cannot tell which from the card.
 *
 * So the `+` has a right-click, and these are what it offers. Each is a pairing
 * of a model with an effort and a sentence saying what it is for. There are
 * five on purpose: this is a menu to be read at the speed of starting work, and
 * a catalogue of every combination — six models against five levels — is a
 * decision rather than a shortcut.
 *
 * Pure, and the ids are what the store keeps, so a preset can be renamed
 * without orphaning the cards opened from it.
 */

import type { Effort } from "./commands";

export type Preset = {
  /** What a menu item and a stored row call it. Stable; the label is not. */
  id: string;
  /** In the menu, in the wall's voice: what you are about to start. */
  label: string;
  /** The pair itself, shown beside the label rather than described in it. The
   *  point of the menu is seeing what a card will cost before opening it. */
  note: string;
  /** What goes to `--model`.
   *
   *  An alias rather than a full id, deliberately: the CLI resolves it against
   *  whatever the newest model in that family is, so a preset does not go stale
   *  the week a new one ships. Probed 2026-08-20 against claude 2.1.233 —
   *  `opus` → `claude-opus-5`, `opus[1m]` → `claude-opus-5[1m]`, `sonnet[1m]` →
   *  `claude-sonnet-5[1m]`, `haiku` → `claude-haiku-4-5-20251001`, `fable` →
   *  `claude-fable-5`, each read back off `system/init`. The full id with its
   *  tier suffix round-trips too, which is what lets the resolved id be written
   *  to the row at the settling turn and passed straight back at the next wake. */
  model: string;
  effort: Effort;
};

/** The five, cheapest first.
 *
 * Ordered by what they cost rather than by how often they are wanted, because
 * the order is the only thing in the menu that says these are a scale. The two
 * axes are not the same question — the model is how good the answer can be, the
 * effort is how much thinking is spent getting there — and each of these is a
 * point where both answers agree about the work.
 */
export const PRESETS: Preset[] = [
  {
    id: "ask",
    label: "a quick question",
    note: "haiku · low",
    model: "haiku",
    effort: "low",
    /* A name, a flag, what a file does. The cheapest card the wall can open,
       and the one the default setting overpays for most often. */
  },
  {
    id: "work",
    label: "ordinary work",
    note: "sonnet · medium",
    model: "sonnet",
    effort: "medium",
    /* The everyday card: a small feature, a fix with its test, a rename across
       a few files. Where the `+` would land if it had one honest default. */
  },
  {
    id: "read",
    label: "reading a lot of it",
    note: "sonnet[1m] · medium",
    model: "sonnet[1m]",
    effort: "medium",
    /* Checking a claim across a codebase, or a long transcript held whole. The
       million-token window rather than a harder-thinking model: what this kind
       of work runs out of is room, and paying for effort instead buys a careful
       answer about the third of the material that fitted. */
  },
  {
    id: "bug",
    label: "a bug that has resisted",
    note: "opus · high",
    model: "opus",
    effort: "high",
    /* The obvious fix was not it. This is the first preset worth its cost —
       and it is deliberately not the 1M window, since a bug that needs the
       whole tree in front of it is the one below. */
  },
  {
    id: "deep",
    label: "the hard thing",
    note: "opus[1m] · max",
    model: "opus[1m]",
    effort: "max",
    /* Design, a migration, an audit — work where being wrong is expensive and
       the material does not fit in a small window. Everything it has, on
       purpose: this is the card you open knowing what it costs. */
  },
];

export function presetById(id: string | undefined): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** What the `+`'s right-click offers, in the shape `menu.ts` takes.
 *
 *  Built here rather than in `menu.ts` for the reason the widget catalogue is:
 *  that file's business is what a right-click offers, not what a preset *is*. */
export function presetPicks(): { id: string; label: string; note: string }[] {
  return PRESETS.map((p) => ({ id: p.id, label: p.label, note: p.note }));
}
