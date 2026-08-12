<script lang="ts">
  import { basename, windowForObserved } from "./classify";
  import { clock } from "./conversation.svelte";
  import type { Session } from "./skein.svelte";

  let {
    sessions,
    loading = false,
    onpick,
    onclose,
  }: {
    sessions: Session[];
    loading?: boolean;
    onpick: (s: Session) => void;
    onclose: () => void;
  } = $props();

  let filter = $state("");
  /** Ids picked in this sitting, so a row cannot be adopted twice while the
   *  list is still up — the wall updates behind the panel, not inside it. */
  let taken = $state<string[]>([]);

  const shown = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        (s.title ?? "").toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q) ||
        (s.branch ?? "").toLowerCase().includes(q),
    );
  });

  /** How long ago, in the coarsest unit that still says something. */
  function ago(iso: string | null): string {
    if (!iso) return "—";
    const secs = Math.max(0, (clock.t - Date.parse(iso)) / 1000);
    if (secs < 90) return "just now";
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return days < 14 ? `${days}d ago` : `${Math.round(days / 7)}w ago`;
  }

  const pct = (s: Session) =>
    Math.round((100 * s.ctx_tokens) / windowForObserved(s.model ?? undefined, s.ctx_tokens));

  function pick(s: Session) {
    taken = [...taken, s.id];
    onpick(s);
  }
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onclose()} />

<!-- The scrim is a click target, not a control: mousedown rather than click, so
     letting go of a drag that started inside the panel does not dismiss it. -->
<div class="scrim" onmousedown={onclose} role="presentation">
  <div class="panel" onmousedown={(e) => e.stopPropagation()} role="presentation">
    <div class="head">
      <span class="mark">Adopt a conversation</span>
      <span class="grow"></span>
      <button class="x" onclick={onclose} title="Close">✕</button>
    </div>

    <p class="note">
      Sessions Claude Code has recorded that no card points at. Adopting one
      leaves the transcript where it is — the card resumes that same session, and
      a terminal can still pick it up afterwards.
    </p>

    <input
      class="filter"
      bind:value={filter}
      placeholder="filter by title, folder or branch"
    />

    <div class="rows">
      {#if loading}
        <p class="empty">reading what claude has recorded…</p>
      {:else if !shown.length}
        <p class="empty">
          {sessions.length
            ? "nothing matches that."
            : "nothing to adopt — every recorded session is already on the wall."}
        </p>
      {/if}

      {#each shown as s (s.id)}
        <button
          class="row"
          disabled={taken.includes(s.id)}
          onclick={() => pick(s)}
          data-session={s.id}
        >
          <span class="title">{s.title ?? "untitled"}</span>
          <span class="where">
            {basename(s.cwd) || s.cwd}{#if s.branch}<span class="branch"
                >· {s.branch}</span
              >{/if}
          </span>
          <span class="when">{ago(s.last_at)}</span>
          <span class="ctx">{pct(s)}%</span>
          <span class="taken">{taken.includes(s.id) ? "on the wall" : ""}</span>
        </button>
      {/each}
    </div>

    <footer>
      <span>{shown.length} of {sessions.length}</span>
      <span class="grow"></span>
      {#if taken.length}<span>{taken.length} adopted</span>{/if}
    </footer>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--ink) 68%, transparent);
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    width: min(74ch, 92vw);
    max-height: 76vh;
    border: 1px solid var(--edge);
    border-radius: 5px;
    background: var(--surface);
    padding: 0.8rem 0.9rem 0.6rem;
    box-shadow: 0 24px 70px -30px rgba(0, 0, 0, 0.9);
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .mark {
    font-family: var(--util);
    font-size: 0.61rem;
    font-weight: 700;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    color: var(--paper-mute);
  }
  .grow {
    flex: 1 1 auto;
  }
  .x {
    background: none;
    border: none;
    color: var(--paper-faint);
    cursor: pointer;
    font-size: 0.75rem;
    padding: 0 0.2rem;
  }
  .x:hover {
    color: var(--paper);
  }

  .note {
    margin: 0;
    font-family: var(--util);
    font-size: 0.7rem;
    line-height: 1.5;
    color: var(--paper-faint);
    max-width: 66ch;
  }

  .filter {
    background: var(--ink);
    border: 1px solid var(--edge);
    border-radius: 3px;
    color: var(--paper);
    font-family: var(--body);
    font-size: 0.82rem;
    padding: 0.34rem 0.5rem;
  }
  .filter:focus {
    outline: none;
    border-color: var(--paper-faint);
  }
  .filter::placeholder {
    color: var(--paper-faint);
  }

  .rows {
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  /* One line per session, on a grid so the columns line up down the list
     rather than drifting with the length of each title. */
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 18ch 8ch 4ch 9ch;
    align-items: baseline;
    gap: 0.6rem;
    text-align: left;
    background: none;
    border: none;
    border-bottom: 1px solid var(--edge);
    padding: 0.42rem 0.3rem;
    cursor: pointer;
    font-family: var(--util);
    font-size: 0.74rem;
    color: var(--paper-mute);
  }
  .row:hover:not(:disabled) {
    background: var(--raised);
  }
  .row:disabled {
    cursor: default;
    opacity: 0.5;
  }
  .row .title {
    color: var(--paper);
    font-size: 0.8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row .where,
  .row .when,
  .row .ctx,
  .row .taken {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--paper-faint);
  }
  .row .branch {
    margin-left: 0.35rem;
  }
  .row .ctx {
    font-family: var(--mono);
    font-size: 0.68rem;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .empty {
    margin: 0;
    padding: 1.2rem 0.3rem;
    font-family: var(--util);
    font-size: 0.74rem;
    color: var(--paper-faint);
  }

  footer {
    display: flex;
    gap: 0.4rem;
    border-top: 1px solid var(--edge);
    padding-top: 0.4rem;
    font-family: var(--util);
    font-size: 0.66rem;
    color: var(--paper-faint);
    font-variant-numeric: tabular-nums;
  }
</style>
