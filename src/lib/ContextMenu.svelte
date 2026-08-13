<script lang="ts">
  import type { MenuItem } from "./menu";

  let {
    x,
    y,
    items,
    onpick,
    onclose,
  }: {
    /** Where the click was, in viewport coordinates. */
    x: number;
    y: number;
    items: MenuItem[];
    onpick: (id: string) => void;
    onclose: () => void;
  } = $props();

  let el: HTMLDivElement | undefined = $state();
  /** Measured after mount, so the menu can be nudged back inside the window
   *  rather than opening half off the edge near the bottom of the wall. */
  let box = $state({ w: 0, h: 0 });

  $effect(() => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    box = { w: r.width, h: r.height };
  });

  const PAD = 6;
  const left = $derived(
    Math.max(PAD, Math.min(x, window.innerWidth - box.w - PAD)),
  );
  const top = $derived(
    Math.max(PAD, Math.min(y, window.innerHeight - box.h - PAD)),
  );
</script>

<svelte:window
  onkeydown={(e) => e.key === "Escape" && onclose()}
  onresize={onclose}
/>

<!-- The catcher takes the next press anywhere, which is what closes the menu.
     `pointerdown` rather than `click`, so the menu is gone before the thing
     underneath decides what that press meant. -->
<div class="catch" onpointerdown={onclose} oncontextmenu={onclose} role="presentation">
  <div
    class="menu"
    bind:this={el}
    style:left="{left}px"
    style:top="{top}px"
    onpointerdown={(e) => e.stopPropagation()}
    role="menu"
    tabindex="-1"
  >
    {#each items as it, i (i)}
      {#if it.kind === "sep"}
        <div class="sep"></div>
      {:else}
        <button
          class="row"
          class:danger={it.danger}
          class:pick={it.on !== undefined}
          class:on={it.on}
          data-menu={it.id}
          role={it.on === undefined ? "menuitem" : "menuitemradio"}
          aria-checked={it.on}
          onclick={() => onpick(it.id)}
        >
          {it.label}
        </button>
      {/if}
    {/each}
  </div>
</div>

<style>
  .catch {
    position: fixed;
    inset: 0;
    z-index: 60;
  }

  .menu {
    position: fixed;
    min-width: 15ch;
    padding: 0.22rem;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--edge);
    border-radius: 4px;
    background: var(--surface);
    box-shadow: 0 18px 44px -22px rgba(0, 0, 0, 0.9);
  }

  .row {
    text-align: left;
    background: none;
    border: none;
    border-radius: 3px;
    color: var(--paper);
    font-family: var(--util);
    font-size: 0.74rem;
    padding: 0.3rem 0.7rem 0.32rem 0.55rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .row:hover {
    background: var(--raised);
  }
  /* Colour is status, so the one warm thing here is the one that destroys
     something — and only on hover, where the intent is already formed. */
  .row.danger:hover {
    color: var(--st-fail);
  }

  /* Which of several is in force. The mark is drawn in CSS rather than typed:
     a "✓" falls through to Segoe UI Emoji here and comes out blue, the same
     trap the ambience panel's layer-order buttons and the dock's stop button
     avoid. The gutter is reserved on every item of the group so the labels
     stay on one edge whichever one is marked. */
  .row.pick {
    padding-left: 1.5rem;
    position: relative;
  }
  .row.pick.on::before {
    content: "";
    position: absolute;
    left: 0.62rem;
    top: 50%;
    width: 5px;
    height: 5px;
    margin-top: -2.5px;
    border-radius: 50%;
    background: var(--paper-dim);
  }
  .row.pick.on {
    color: var(--paper);
  }

  .sep {
    height: 1px;
    margin: 0.22rem 0.3rem;
    background: var(--edge);
  }
</style>
