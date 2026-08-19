<script lang="ts">
  /* Asking before the wall is taken down.
   *
   * Quitting kills every card's process tree, background work included, and
   * that is settled — a job spared at shutdown is a process nothing can ever
   * reap (`turns.md`, "a row is not a handle"). What was wrong was that the
   * cost was paid in silence: you closed the window, and found out at the next
   * launch that a twenty-five-minute import had been stopped at eleven.
   *
   * So this is a sentence, not a gate. Three things it deliberately does not
   * do:
   *
   * - **It does not offer to keep the work running.** There is no such option;
   *   offering one would be the leak. The choice is quit now or quit later.
   * - **It does not default to quitting.** `stay` takes the focus, so a
   *   reflexive Enter on a dialog you did not read is the harmless answer, and
   *   Escape means the same thing. The destructive button has to be aimed at.
   * - **It does not block the close if it fails to paint.** Refusing a close is
   *   a budget of exactly one (`quit.rs`), so pressing close again exits
   *   whatever has happened to this component. An app you cannot quit is a
   *   worse bug than the one this fixes.
   *
   * The wording is `quitting.ts`, where it can be tested. */

  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { invoke } from "@tauri-apps/api/core";

  import { QUIT_NOTE, quitLines, quitTitle, type BusyCard } from "./quitting";

  let { cards, onstay }: { cards: BusyCard[]; onstay: () => void } = $props();

  const title = $derived(quitTitle(cards));
  const lines = $derived(quitLines(cards));

  let stayBtn = $state<HTMLButtonElement | null>(null);
  $effect(() => {
    stayBtn?.focus();
  });

  /* Closing again rather than calling some third command, so the confirmed path
     and the escape hatch of pressing close twice are the same path — there is no
     way for them to disagree about what "the user said yes" means. */
  function quitAnyway() {
    void getCurrentWindow().close();
  }

  function stay() {
    void invoke("stay").catch(() => {});
    onstay();
  }

  function onkey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      stay();
    }
  }
</script>

<svelte:window on:keydown|capture={onkey} />

<div class="quit" role="dialog" aria-modal="true" aria-label={title}>
  <div class="plate">
    <h1 class="title">{title}</h1>

    <ul class="jobs">
      {#each lines as line}
        <li>{line}</li>
      {/each}
    </ul>

    <p class="note">{QUIT_NOTE}</p>

    <div class="acts">
      <button class="act" bind:this={stayBtn} onclick={stay}>stay</button>
      <button class="act danger" onclick={quitAnyway}>quit anyway</button>
    </div>
  </div>
</div>

<style>
  .quit {
    position: fixed;
    inset: 0;
    /* Above the break, which otherwise claims to be the one thing above
       everything. It still is, for anything that *reports*; this is you acting,
       and a dialog holding the close shut has to be visible or the window has
       simply stopped closing for no reason you can see. */
    z-index: 9500;
    display: grid;
    place-items: center;
    background: color-mix(in srgb, var(--well) 82%, transparent);
    backdrop-filter: blur(6px) saturate(0.75);
    animation: settle 0.16s ease-out both;
  }

  /* Quick, unlike the break's long fade: this one is in the way of something
     you are trying to do. */
  @keyframes settle {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .plate {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    padding: 1.7rem 1.9rem 1.4rem;
    max-width: 32rem;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 6px;
    box-shadow: var(--raised);
  }

  .title {
    margin: 0;
    font-family: var(--display);
    font-size: 1.05rem;
    font-weight: 500;
    color: var(--paper);
    letter-spacing: 0.01em;
  }

  .jobs {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.28rem;
    font-family: var(--mono);
    font-size: 0.76rem;
    color: var(--paper-mute);
  }

  .jobs li {
    /* A long command is clipped rather than wrapped: the list is here to be
       recognised, not read, and a dialog that grows with its content is one
       that eventually does not fit. */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .note {
    margin: 0;
    font-family: var(--body);
    font-size: 0.82rem;
    line-height: 1.5;
    color: var(--paper-dim);
  }

  .acts {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 0.2rem;
  }

  .act {
    font-family: var(--util);
    font-size: 0.78rem;
    letter-spacing: 0.03em;
    color: var(--paper-mute);
    background: transparent;
    border: 1px solid var(--edge);
    border-radius: 4px;
    padding: 0.42rem 0.9rem;
    cursor: pointer;
    transition:
      color 0.18s ease,
      border-color 0.18s ease;
  }

  .act:hover,
  .act:focus-visible {
    color: var(--paper);
    border-color: var(--rule);
  }

  /* The one coloured thing here, and it is the status rust that means something
     broke — because on the other side of this button, something does. */
  .act.danger:hover,
  .act.danger:focus-visible {
    color: var(--st-fail);
    border-color: var(--st-fail);
  }
</style>
