---
paths:
  - "src/lib/naming.ts"
  - "test/naming.test.ts"
---

# What a card is called

### What a card is called

A title arrives in three stages: a card is opened with none, the first prompt cuts one out of
what you said, and once a turn lands Claude Code's own generated title replaces it
(`#adoptAiTitle`). The first stage used to be drawn as the literal word `untitled` — which is
the *sentinel's spelling*, not a label, and it said less about the card than any other state
on the wall at exactly the moment the card is asking to be given something to do.

`naming.ts` is pure and owns the whole vocabulary. The sentinel is unchanged and still means
what it meant (`store.rs`'s column default, the test in `#deliver` that decides whether the
first prompt gets to name the card); only what is *drawn* moved.

- **An unnamed card wears the draft you are typing at it.** Nothing is invented — it is the
  name it is about to have, shown a few seconds early, which is the same argument
  `Conversation.echo` makes for drawing a prompt before it has been delivered. With nothing
  typed it says `a new thread`, deliberately not "nothing said yet": the open density already
  says that about the transcript, and a card with two lines telling you the same absence twice
  has one thing to say.
- **`titleFromPrompt` is shared between the preview and the commit**, or the preview lies. A
  draft drawn in full and then stored as forty-one characters and an ellipsis is a card that
  renames itself the instant you press Enter.
- **Provisional is marked by slope, not colour** (`.title.provisional`, italic). Colour on this
  wall is status and "you have not named this" is not a status — and it has to be the slope,
  because an unnamed card is always dormant and the dormant rule already mutes every title.
- **App decides reach, `naming.ts` decides wording.** The draft goes to `Canvas` as text plus
  the target ids, so a keystroke touches only the cards it is aimed at; a card outside the
  gathering correctly shows the new-thread line, since it is not the one about to be named. App
  also withholds the draft while the palette is lit — `/clear` is about to be *run* rather than
  sent, and a card briefly calling itself `/clear` would be describing a prompt it never gets.
- **Three answers to "what is this card called", because the question differs.** `cardName` for
  the card face. `displayName` for the footprints and the process meter, which fall back to the
  project: read at a distance or out of context there is no room to explain an absence, and
  whereabouts is the more useful fact. `nameBesideProject` for the dock's target line, the peek
  and the ask panel, which print the project themselves and so fall back to nothing — falling
  back to the project there would say it twice.

