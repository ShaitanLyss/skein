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

  /* Newest first, and sorted here rather than trusted to the walk that filled
     the list. The order is not decoration: this panel opens showing everything,
     so what is at the top *is* the answer to "what was I just doing", and the
     filter below is for narrowing a list you can already read rather than a
     query you have to write before anything appears. A panel whose whole
     default state is an ordering should not hold that ordering somewhere else.

     A session with no last activity sorts last, which is where a transcript
     that never said when it was belongs. */
  const recent = $derived(
    [...sessions].sort((a, b) => (b.last_at ?? "").localeCompare(a.last_at ?? "")),
  );

  const shown = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return recent;
    return recent.filter(
      (s) =>
        (s.title ?? "").toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q) ||
        (s.branch ?? "").toLowerCase().includes(q),
    );
  });

  /** How long ago, in the coarsest unit that still says something.
   *
   *  Elapsed while elapsed is what you would use to find it — "20m ago" is how
   *  you recognise the thing you stepped away from — and a date once it is not.
   *  Past a fortnight the count stops being a way of remembering anything: "9w
   *  ago" is arithmetic you have to do backwards, where "3 jun" is a day you
   *  either recall or do not. Lowercase, like the rest of the prose here. */
  function ago(iso: string | null): string {
    if (!iso) return "—";
    const at = Date.parse(iso);
    if (Number.isNaN(at)) return "—";
    const secs = Math.max(0, (clock.t - at) / 1000);
    if (secs < 90) return "just now";
    const mins = Math.round(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    if (days < 14) return `${days}d ago`;
    const d = new Date(at);
    const month = d.toLocaleString("en-GB", { month: "short" }).toLowerCase();
    /* The year only when it is not this one — it is noise on the ones you are
       most likely to be looking for, and the whole answer on the rest. */
    return d.getFullYear() === new Date(clock.t).getFullYear()
      ? `${d.getDate()} ${month}`
      : `${d.getDate()} ${month} ${String(d.getFullYear()).slice(2)}`;
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
      Sessions Claude Code has recorded that no card points at, most recently
      spoken to first. Adopting one leaves the transcript where it is — the card
      resumes that same session, and a terminal can still pick it up afterwards.
    </p>

    <input
      class="filter"
      bind:value={filter}
      placeholder="narrow the list by title, folder or branch"
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
    grid-template-columns: minmax(0, 1fr) 18ch 10ch 4ch 9ch;
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
