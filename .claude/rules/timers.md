---
paths:
  - "src/lib/timing.ts"
  - "src/lib/cycle.svelte.ts"
  - "src/lib/Timer.svelte"
  - "src/lib/Pomodoro.svelte"
  - "src/lib/Rest.svelte"
---

# Timers, and the pomodoro

#### Timers, and the pomodoro

Lifted from `life-to-the-fullest` (a Tauri app of the same author's, whose `Timer`,
`Countdown` and `Pomodoro` are the reference) and rebuilt against this wall's rules.
`timing.ts` is pure and holds the whole of it: the run arithmetic, the spans, the named
lengths and cadences, the phase machine, and what a snooze means. Two widgets draw it —
`timer` (variant: up, down, duo) and `pomodoro` (variant: ring, beads, digits).

- **A timer is an epoch and a number of banked seconds, never a counter.** Elapsed is
  `banked + (now - since)`, read off the one-second `clock` rune the wall already runs on.
  So there is no interval to run, no drift, and no second wake-up on an idle machine — the
  reference implementation drove each timer from a `setInterval(…, 20)`, fifty wake-ups a
  second each. It also means the state survives a restart by being *written down* rather
  than reconstructed.
- **State rides in the widget's own `config`**, which is what the opaque `config_json`
  column was for: persisting a running timer costs no migration and no new command. It does
  mean `widgets.ts` grows a second list — `params` is the vocabulary of the menu, `state` is
  the vocabulary of the instrument. State is checked for being a finite number and otherwise
  left alone; emphatically **not** clamped the way a `number` knob is, since an epoch has no
  range a catalogue could know and rounding one to a step would move a timer's start every
  time it was read back.
- **Nothing writes while a timer merely runs**, because the reading is derived — so a row
  saved when a timer started says nothing about how far it got. `Widgets.beat` and
  `Cycle.tick` bank the earned seconds about once a minute, which bounds what a crash can
  lose to a minute rather than to the length of the run.
- **A timer running at shutdown comes back held.** The app not running is not the same as
  the timer running: a stopwatch here measures your attention on something, and that stopped
  when the window did, so "you have been at this for sixteen hours" is a reading nobody wants
  and nobody can correct. A countdown whose length passed inside the gap comes back `rung`,
  which falls out of `standing` and is right — it did ring, you just were not there.
- **A rung countdown joins the attention ladder** rather than getting a notification path of
  its own. It is the same question the ladder already answers, and the alternative ends in a
  Windows toast, which the note at the top of `attention.svelte.ts` exists to refuse.
  `PeekItem.kind` gains `rang`, wearing the same amber a blocked card does — both are waiting
  to be noticed, and inventing a second hue to keep them apart would be colour meaning two
  things. It gets no `GRACE_S`: you set the thing yourself and asked to be told. The peek's
  headline says "things" rather than "cards" for the same reason.
- **And it is the one rung on that ladder that sounds while you are looking.** Joining the
  ladder was right and inheriting *all* of its conditions was not: `Attention.sync` returns
  early when the window has focus, so a countdown reaching zero at the wall went amber and
  said nothing — which is not an alarm, it is a colour. Everything else on the ladder is a
  report of what you missed while away, and the peek is right to stay hidden while you are
  here; the amber face *is* that report, on screen, where you already are. A sound is not,
  and "tell me when this reaches zero" is the whole of why anybody sets one. So `#alarm` runs
  ahead of the focus check.
  - **It ignores `chime`**, which is the header switch for cards. A card speaks on its own
    schedule and a sound for it is an interruption you opt into; a countdown makes noise
    because you asked it to — the same argument that already exempts one from `GRACE_S`.
    Staying quiet about something you set by hand, on the grounds of a switch about something
    else, reads as broken rather than as restrained.
  - **Its figure is its own** — three rising notes against the house two — because telling an
    alarm from a card *without looking* is the entire point of a sound. The peek's chime is
    suppressed on a tick the alarm already rang: one piece of news, one bell.
  - **When it may ring is arithmetic, in `timing.ts::ring`**, so both traps are testable
    rather than discovered on a wall. It rings **once** however long it stands
    unacknowledged, since the ladder runs on the one-second tick; and it does **not** ring
    for a countdown that ran out before the window was up — one whose length passed while
    Skein was closed comes back `rung` (see `settle`), and a bell at launch for last night's
    appointment is noise. That second rule compares the overrun against uptime rather than
    priming a set on the first tick: **the widgets arrive from SQLite several ticks after the
    ladder is built**, so a first-tick prime would look at an empty wall and suppress
    nothing. What is carried forward is what is ringing *now*, not everything ever rung, so
    pressing `done` and setting the thing again is a second appointment.
  - `snapshot.attention.sounded` reports it, apart from `chime` — nothing in the DOM records
    a sound, so a bell that never rang is otherwise invisible from outside. Same argument as
    `meter.sampling`.
- **Durations are named, never typed.** `twenty-five minutes`, `fifty on, ten off` — the
  catalogue's "no numbers among the knobs" rule, and not merely a concession to it: nobody
  has ever wanted a countdown of thirty-seven minutes. There is no text field on any widget
  on this wall, so timers get no names either; the duo's lanes are `on` and `off`, which is
  the pair anybody actually wanted.
- **A guarded knob is hidden, not lost.** `only: { key, is }` on a param — a stopwatch has no
  length to count down from, and a menu offering one is worse than a missing knob because it
  reads as broken rather than absent. Declarative rather than a predicate so the catalogue
  stays data. The value is still stored while hidden, so flipping to counting down and back
  does not lose what you chose.
- **The duo's constraint is the instrument.** Exactly one lane runs, so the pair always sums
  to the time since you started and the share between them is a real reading rather than two
  unrelated numbers side by side — which is the thing the reference implementation's double
  timer was missing. Clicking the running lane holds both: the way out is to stop, not to
  have to start a third thing.

##### The cycle is one per studio

`cycle.svelte.ts` owns it — named for its class, since `pomodoro.svelte.ts` beside
`Pomodoro.svelte` is the *same file* on this filesystem, exactly as `meter.svelte.ts` is
beside `Perf.svelte`. It is **not** a widget's config: hang two pomodoro widgets up and they
are two readings of one afternoon, so a second one holding its own phase would be two clocks
telling different times. Schema v8, one row or none, `state_json` opaque for the reason
`widget.config_json` and `ambience_profile.layers_json` are. A `pomodoro` widget's config is
therefore its face and nothing else, and its cadence is reached through the same right-click
but written through to the cycle — which is why `App.svelte` builds that menu's options by
hand rather than off `optionsOf`.

The phase count is a single number: focus is an even `done`, a break is odd, and the break
after every `per`-th pomodoro is the long one. One thing to persist and one thing that can be
wrong, rather than an `isOnBreak` flag beside a `pomodoroNumber` that can disagree with it.

**A cycle runs only while a pomodoro widget is on the wall** (`Cycle.watched`, injected from
`App.svelte` the way `Attention.instruments` and `Widgets.others` are). Exactly the rule the
process sampler already has — it samples only while a `performance` widget is up — and for
the same reason: an instrument you took down should not still be running the room, least of
all one whose breaks take the whole window with nothing anywhere to explain why.

This was the other way round first, on the worry that removing a widget would become a way to
skip a break. It isn't one: `end the cycle` is already an unrestricted exit on the rest screen
itself, so the enforcement was never "you cannot stop" but "you cannot skip a break and keep
the cycle" — and taking the last view down is that same statement made with a different
gesture.

Removing the last one **pauses**, and the difference from ending is load-bearing twice.
Rearranging the wall must not throw away the afternoon, so hanging one back up and pressing
`carry on` picks the same phase up where it was; and a break you owed is still owed when you
do, which is the promise `push` makes as well — a break is delayed by getting out of its way,
never spent. That is also what the row buys over a per-widget config: the phase survives the
widget. `watched` is checked in `resting` as well as in `tick`, because the tick is what does
the pausing and it runs once a second — without it the rest screen would sit over the window
for up to a second after the last view came down.

##### Breaks are taken, not offered

The point of the feature is enforcement, so `Rest.svelte` comes over the whole window — wall,
panel and dock — when a break falls due. Four things about it are the opposite of the obvious
choice:

- **A break is *owed* when the focus rings, and its clock runs only while the wall is
  resting.** In the reference implementation the break starts counting the moment the focus
  ends, whether or not anybody noticed — which is the exact failure the feature exists to fix,
  since a break you did not notice starting is a break you did not take, and it then
  interrupts the work you carried on doing to send you back to work. All the transitions are
  `timing.ts::step`, which returns the *same object* when nothing is due — that is what lets
  the studio call it every second and write only on a real change.
- **The work carries on behind it.** The scrim is translucent and blurred, not black: cards
  stream, dev servers build, the ambience drifts. Nothing is paused except you. A screen that
  blacked the wall out would be telling you your work had stopped, which is a lie and an
  anxious one — and watching six agents get on with it is a better argument for stepping away
  than an empty rectangle.
- **There is no skip.** `push it back` delays the break and banks the part already taken, so
  three snoozes do not each restart a five-minute break — you are delaying what is left, which
  is what was promised. `end the cycle` is the other way out, and it means you have finished
  working this way rather than that you are skipping the rest and carrying on. A button that
  *spent* a break would make the whole feature optional. The push count is shown
  (`pushed back twice`) and never enforced: a lock with no way out is dangerous in a tool
  hosting agents with `--dangerously-skip-permissions`.
- **It is quiet and it does not count.** How long is left is said in words that change about
  once a minute (`said`), not ticked down to the second — a rest screen you can watch is a
  rest screen you *do* watch, and then you have spent your break looking at a timer. The ring
  is achromatic: colour here is status, and a break is not a fault.

Keys are swallowed at the overlay with a capture-phase listener rather than by teaching every
binding in `onGlobalKey` about the break — one rule in one place, and the two buttons stay
reachable by Tab because they are the only focusable things under it.

**A cycle read back at launch is always paused.** Same argument as a stopwatch's, with more
force: one that rolled forward across a night would come back four pomodoros deep and owing a
long break for work nobody did.

The control surface has `timer.set` (which drives the same `Widgets.update` the face's buttons
do — the seam, not a parallel path) and `pomodoro`, whose `do` is the gesture. `snapshot`
carries `pomodoro`, and `posture` is the field that matters: a break pushed back, a break
being taken and a focus running all have an `on` cycle with an odd-or-even `done`, so telling
them apart from outside by arithmetic would mean re-implementing `timing.ts` in the harness.
`watched` is reported apart from the widget count for the reason `meter.sampling` is: a cycle
nobody has a view of and one paused by hand look identical from outside, and only one of them
starts again by itself when a widget goes back up.

