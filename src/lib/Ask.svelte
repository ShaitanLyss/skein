<script lang="ts">
  import type { Conversation } from "./conversation.svelte";
  import { clock } from "./conversation.svelte";

  let {
    conv,
    onanswer,
  }: { conv: Conversation; onanswer: (text: string) => void } = $props();

  let free = $state("");

  const ask = $derived(conv.pendingAsk!);

  /* Ten minutes and the agent gives up waiting and proceeds on its own
     judgement, so the countdown is real information, not decoration. */
  const left = $derived(
    Math.max(0, 600 - Math.floor((clock.t - ask.since) / 1000)),
  );
  const mins = $derived(Math.floor(left / 60));
  const secs = $derived(String(left % 60).padStart(2, "0"));

  function submit() {
    const t = free.trim();
    if (!t) return;
    free = "";
    onanswer(t);
  }
</script>

<div class="ask">
  <div class="head">
    <span class="mark">Waiting on you</span>
    <span class="who">{conv.project} · {conv.title}</span>
    <span class="grow"></span>
    <span class="clockleft" class:urgent={left < 120}>{mins}:{secs}</span>
  </div>

  <p class="q">{ask.question}</p>

  {#if ask.options.length}
    <div class="options">
      {#each ask.options as o}
        <button class="opt" onclick={() => onanswer(o.label)}>
          <span class="lbl">{o.label}</span>
          {#if o.detail}<span class="det">{o.detail}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}

  <div class="free">
    <input
      bind:value={free}
      onkeydown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        }
      }}
      placeholder={ask.options.length ? "…or say something else" : "Your answer"}
    />
    <button class="send" onclick={submit} disabled={!free.trim()}>↵</button>
  </div>
</div>

<style>
  .ask {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    border: 1px solid color-mix(in srgb, var(--st-ask) 55%, var(--edge));
    border-radius: 4px;
    background: color-mix(in srgb, var(--st-ask) 7%, var(--well));
    padding: 0.6rem 0.7rem;
    /* The one place in the app that genuinely blocks an agent, so it is also
       the one place that gets to glow. */
    box-shadow: 0 8px 30px -16px rgba(233, 161, 59, 0.7);
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-family: var(--util);
    font-size: 0.66rem;
  }
  .mark {
    font-size: 0.61rem;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--st-ask);
  }
  .who {
    color: var(--paper-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 40ch;
  }
  .grow {
    flex: 1 1 auto;
  }
  .clockleft {
    font-family: var(--mono);
    font-size: 0.64rem;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }
  .clockleft.urgent {
    color: var(--st-ask);
  }

  .q {
    margin: 0;
    font-size: 0.95rem;
    line-height: 1.5;
    color: var(--paper);
    max-width: 76ch;
  }

  .options {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .opt {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.12rem;
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.35rem 0.6rem;
    cursor: pointer;
    max-width: 34ch;
  }
  .opt:hover {
    border-color: color-mix(in srgb, var(--st-ask) 60%, var(--edge));
    background: var(--raised);
  }
  .opt .lbl {
    font-family: var(--util);
    font-size: 0.78rem;
    color: var(--paper);
  }
  .opt .det {
    font-family: var(--util);
    font-size: 0.68rem;
    line-height: 1.35;
    color: var(--paper-mute);
  }

  .free {
    display: flex;
    gap: 0.4rem;
  }
  .free input {
    flex: 1 1 auto;
    background: var(--ink);
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper);
    font-family: var(--body);
    font-size: 0.86rem;
    padding: 0.38rem 0.55rem;
  }
  .free input:focus {
    outline: none;
    border-color: var(--paper-faint);
  }
  .free input::placeholder {
    color: var(--paper-faint);
  }
  .send {
    font-family: var(--mono);
    font-size: 0.7rem;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper);
    padding: 0 0.6rem;
    cursor: pointer;
  }
  .send:disabled {
    color: var(--paper-faint);
    cursor: default;
  }
</style>
