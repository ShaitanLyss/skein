<script lang="ts">
  /* The order, the ceilings, and the state of the machine underneath them.
   *
   * This panel holds no policy: `standingOf` and `choose` in the pure
   * `accounts.ts` answer every question it draws, and `waterfall.svelte.ts` is
   * the reader behind it. What is local here is the three half-typed things —
   * a name being entered, a cap mid-edit, and a delete half-armed — which is
   * the same split `Themes.svelte` draws for the same reason.
   *
   * The order is the feature, so it is what the panel is arranged around: the
   * list reads top to bottom in the order work actually falls through it, and
   * the row that is next has the mark. See `.claude/rules/accounts.md`.
   */
  import { onDestroy, onMount } from "svelte";
  import { waterfall } from "./waterfall.svelte";
  import { sayBlocked, standingOf } from "./accounts";
  import { pct, said as windowSaid, until } from "./limits";

  let { onclose }: { onclose: () => void } = $props();

  const WATCHER = "accounts-panel";

  /** The name being typed for a new account. */
  let naming = $state("");
  /** Which account has a destructive gesture half-made, and which one. Armed
   *  rather than confirmed in a dialog: a second click on a button that has
   *  visibly changed its mind is a smaller interruption than a modal, and it
   *  disarms on any other press in the panel. */
  let arming = $state<string | null>(null);
  /** What the panel last said back, beside the thing that happened rather than
   *  in a bar at the top — the bargain `Themes.svelte` strikes with `said`. */
  let note = $state("");
  let noteTimer = 0;
  /** True while the installer is running, which is minutes rather than
   *  moments and must not look like a button that did nothing. */
  let installing = $state(false);
  /** Which account we are waiting on a sign-in terminal for. */
  let awaiting = $state<string | null>(null);
  let stopWatching: (() => void) | null = null;

  const now = $derived(Date.now());

  function say(word: string) {
    note = word;
    clearTimeout(noteTimer);
    noteTimer = window.setTimeout(() => (note = ""), 2600);
  }

  onMount(() => waterfall.attach(WATCHER));
  onDestroy(() => {
    waterfall.detach(WATCHER);
    stopWatching?.();
    clearTimeout(noteTimer);
  });

  /** Where each account stands, in the order work falls through them. Bypass is
   *  false here on purpose: this panel draws the ordinary state of the world,
   *  and a bypass is a property of one conversation rather than of the wall. */
  const standings = $derived(
    waterfall.list.map((a) => ({
      account: a,
      standing: standingOf(a, waterfall.allowances[a.label], false),
    })),
  );

  /** Which account the next new turn would go to, drawn as a mark on the row so
   *  the order is legible as a consequence rather than as a number. */
  const nextUp = $derived.by(() => {
    const c = waterfall.next();
    return c.kind === "use" ? c.label : null;
  });

  /** The window kinds worth offering a cap for on this account: the ones its
   *  allowance actually reports, plus any it already carries a cap for — so a
   *  cap set against a window the server has stopped mentioning stays visible
   *  and removable rather than becoming invisible and still in force. */
  function capKinds(label: string): string[] {
    const a = waterfall.allowances[label];
    const fromReport = a?.ok ? a.windows.map((w) => w.kind) : [];
    const acct = waterfall.list.find((x) => x.label === label);
    const fromCaps = Object.keys(acct?.caps ?? {});
    return [...new Set([...fromReport, ...fromCaps])];
  }

  function capOf(label: string, kind: string): number | null {
    const acct = waterfall.list.find((x) => x.label === label);
    const v = acct?.caps?.[kind];
    return typeof v === "number" ? v : null;
  }

  function usedOf(label: string, kind: string): number | null {
    const a = waterfall.allowances[label];
    if (!a?.ok) return null;
    return a.windows.find((w) => w.kind === kind)?.used ?? null;
  }

  function nameOf(label: string, kind: string): string {
    const a = waterfall.allowances[label];
    const w = a?.ok ? a.windows.find((x) => x.kind === kind) : null;
    return w ? windowSaid(w) : kind.replace(/_/g, " ");
  }

  async function setCap(label: string, kind: string, raw: string) {
    const acct = waterfall.list.find((x) => x.label === label);
    const caps: Record<string, number> = { ...(acct?.caps ?? {}) };
    const n = Number(raw);
    /* Blank clears the ceiling rather than setting zero — zero is a real and
       very different instruction ("never start work here"), so it has to be
       typed rather than arrived at by emptying a field. */
    if (raw.trim() === "" || !Number.isFinite(n)) delete caps[kind];
    else caps[kind] = Math.max(0, Math.min(100, Math.round(n)));
    await waterfall.setCaps(label, caps);
  }

  async function addAccount() {
    const label = naming.trim();
    if (!label) return;
    try {
      await waterfall.add(label);
      naming = "";
      say(`added ${label} — sign in to it next`);
    } catch (err) {
      say(String(err));
    }
  }

  async function signIn(label: string) {
    try {
      await waterfall.signIn(label);
      awaiting = label;
      stopWatching?.();
      stopWatching = waterfall.watchFor(label, () => {
        awaiting = null;
        say(`${label} is signed in`);
      });
      say("a terminal is open — finish signing in there");
    } catch (err) {
      say(String(err));
    }
  }

  async function install() {
    installing = true;
    try {
      say(await waterfall.install());
    } catch (err) {
      say(String(err));
    } finally {
      installing = false;
    }
  }
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onclose()} />

<!-- mousedown rather than click, so letting go of a drag that started inside the
     panel does not dismiss it — the same call Themes.svelte makes. -->
<div class="scrim" onmousedown={onclose} role="presentation">
  <div
    class="panel"
    onmousedown={(e) => {
      e.stopPropagation();
      arming = null;
    }}
    role="dialog"
    aria-label="accounts"
    tabindex="-1"
  >
    <div class="head">
      <span class="mark">accounts</span>
      <span class="grow"></span>
      {#if note}<span class="said">{note}</span>{/if}
      <button class="x" onclick={onclose} title="close">✕</button>
    </div>

    <p class="note">
      Work falls through these in order — the first account that is under its ceiling takes it,
      and the next one is only touched when that one is spent. A cap is <b>yours</b>: the
      account's own limit still applies underneath it, and nothing here can spend past that.
    </p>

    <!-- ── the machine ───────────────────────────────────────────────── -->
    <div class="cli" class:bad={waterfall.claude?.state === "missing"}>
      {#if !waterfall.claude}
        <span class="dim">looking for claude code…</span>
      {:else if waterfall.claude.state === "ready"}
        <span class="ok">claude code {waterfall.claude.version}</span>
        {#if !waterfall.claude.onPath}
          <span class="warn">
            not on PATH — found via {waterfall.claude.foundIn}, and spawned by full path
          </span>
        {/if}
      {:else}
        <span class="warn">claude code was not found on this machine</span>
        <button class="go" onclick={install} disabled={installing}>
          {installing ? "installing…" : "install it"}
        </button>
      {/if}
    </div>

    <div class="body">
      {#if !waterfall.ready}
        <p class="empty">reading the registry…</p>
      {:else if waterfall.list.length === 0}
        <p class="empty">
          No accounts yet. Add one below and sign in to it — until then every card spawns as
          whoever <code>claude</code> is signed in as, which is exactly how it worked before.
        </p>
      {/if}

      {#each standings as { account, standing }, i (account.label)}
        <div class="acct" class:off={!account.enabled} class:next={account.label === nextUp}>
          <div class="row">
            <span class="rank">{i + 1}</span>
            <span class="label">{account.label}</span>

            {#if account.label === nextUp}
              <span class="tag next-tag">next</span>
            {/if}

            {#if standing.state === "ready"}
              <span class="tag ready">ready</span>
            {:else if standing.state === "blocked"}
              <span class="tag held">{sayBlocked(standing.blockers)}</span>
              {#if standing.availableAt !== null}
                <span class="dim">back in {until(standing.availableAt - now)}</span>
              {:else}
                <span class="dim">no reset named</span>
              {/if}
            {:else}
              <span class="tag bad">{standing.why}</span>
            {/if}

            <span class="grow"></span>

            <button class="chip" disabled={i === 0} onclick={() => waterfall.move(account.label, -1)}
              title="earlier in the order">↑</button>
            <button
              class="chip"
              disabled={i === standings.length - 1}
              onclick={() => waterfall.move(account.label, 1)}
              title="later in the order">↓</button>
            <button
              class="chip"
              onclick={() => waterfall.setEnabled(account.label, !account.enabled)}
              title={account.enabled ? "stop using this account" : "use this account again"}
            >{account.enabled ? "on" : "off"}</button>
          </div>

          <!-- ── the ceilings ─────────────────────────────────────────── -->
          {#if account.hasToken}
            <div class="caps">
              {#each capKinds(account.label) as kind (kind)}
                {@const used = usedOf(account.label, kind)}
                {@const cap = capOf(account.label, kind)}
                <label class="cap">
                  <span class="capname">{nameOf(account.label, kind)}</span>
                  <span class="used">{used === null ? "—" : pct(used)}</span>
                  <span class="of">stop at</span>
                  <input
                    class="capin"
                    type="number"
                    min="0"
                    max="100"
                    placeholder="—"
                    value={cap ?? ""}
                    onchange={(e) => setCap(account.label, kind, e.currentTarget.value)}
                  />
                  <span class="pc">%</span>
                </label>
              {:else}
                <span class="dim">no windows read yet</span>
              {/each}
            </div>
          {/if}

          <div class="acts">
            {#if !account.hasToken}
              <button class="go" onclick={() => signIn(account.label)}>sign in</button>
              {#if awaiting === account.label}
                <span class="dim">waiting for the terminal…</span>
              {/if}
            {:else}
              <button class="chip" onclick={() => signIn(account.label)} title="replace the stored token">
                sign in again
              </button>
              <button
                class="chip danger"
                onmousedown={(e) => e.stopPropagation()}
                onclick={() => {
                  if (arming === `forget:${account.label}`) {
                    void waterfall.forget(account.label);
                    arming = null;
                    say(`forgot ${account.label}'s token`);
                  } else arming = `forget:${account.label}`;
                }}
              >{arming === `forget:${account.label}` ? "really forget the token?" : "forget token"}</button>
            {/if}
            <span class="grow"></span>
            <button
              class="chip danger"
              onmousedown={(e) => e.stopPropagation()}
              onclick={() => {
                if (arming === `remove:${account.label}`) {
                  void waterfall.remove(account.label);
                  arming = null;
                  say(`removed ${account.label} — its token is still stored`);
                } else arming = `remove:${account.label}`;
              }}
            >{arming === `remove:${account.label}` ? "really remove?" : "remove"}</button>
          </div>
        </div>
      {/each}

      <!-- ── tokens nobody registered ─────────────────────────────────── -->
      {#if waterfall.unregistered.length > 0}
        <div class="loose">
          <span class="dim">signed in elsewhere, not in the order:</span>
          {#each waterfall.unregistered as label (label)}
            <button class="chip" onclick={() => waterfall.add(label)}>add {label}</button>
          {/each}
        </div>
      {/if}
    </div>

    <div class="foot">
      <input
        class="namein"
        placeholder="a name for the account — work, perso, team"
        bind:value={naming}
        onkeydown={(e) => e.key === "Enter" && addAccount()}
      />
      <button class="go" onclick={addAccount} disabled={!naming.trim()}>add</button>
    </div>

    {#if waterfall.fault}
      <p class="fault">{waterfall.fault}</p>
    {/if}
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
    width: min(86ch, 94vw);
    max-height: 84vh;
    border: 1px solid var(--edge);
    border-radius: 5px;
    background: var(--surface);
    padding: 0.8rem 0.9rem 0.7rem;
    box-shadow: 0 24px 70px -30px rgba(0, 0, 0, 0.9);
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .mark {
    font-family: var(--util);
    font-size: 0.78rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--paper-dim);
  }
  .grow {
    flex: 1;
  }
  .said {
    font-family: var(--util);
    font-size: 0.72rem;
    color: var(--paper-mute);
  }
  .x {
    border: 0;
    background: none;
    color: var(--paper-mute);
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0 0.2rem;
  }
  .x:hover {
    color: var(--paper);
  }

  .note {
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.5;
    color: var(--paper-mute);
  }

  .cli {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--rule);
    border-radius: 4px;
    font-family: var(--util);
    font-size: 0.74rem;
  }
  .cli.bad {
    border-color: color-mix(in srgb, var(--st-fail) 50%, var(--rule));
  }
  .ok {
    color: var(--paper-dim);
  }
  .warn {
    color: var(--st-fail);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    overflow-y: auto;
    padding-right: 0.2rem;
  }
  .empty {
    margin: 0;
    font-size: 0.8rem;
    line-height: 1.5;
    color: var(--paper-mute);
  }

  .acct {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    border: 1px solid var(--rule);
    border-radius: 4px;
    padding: 0.45rem 0.55rem;
    background: var(--raised);
  }
  .acct.off {
    opacity: 0.55;
  }
  .acct.next {
    border-color: color-mix(in srgb, var(--st-work) 45%, var(--rule));
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    flex-wrap: wrap;
  }
  .rank {
    font-family: var(--util);
    font-size: 0.7rem;
    color: var(--paper-faint);
    min-width: 1ch;
  }
  .label {
    font-family: var(--util);
    font-size: 0.82rem;
    color: var(--paper);
  }

  .tag {
    font-family: var(--util);
    font-size: 0.68rem;
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
    border: 1px solid var(--rule);
    color: var(--paper-mute);
  }
  .next-tag {
    border-color: color-mix(in srgb, var(--st-work) 55%, var(--rule));
    color: var(--st-work);
  }
  .ready {
    color: var(--paper-dim);
  }
  .held {
    border-color: color-mix(in srgb, var(--st-ask) 50%, var(--rule));
    color: var(--st-ask);
  }
  .bad {
    border-color: color-mix(in srgb, var(--st-fail) 45%, var(--rule));
    color: var(--st-fail);
  }
  .dim {
    font-family: var(--util);
    font-size: 0.7rem;
    color: var(--paper-faint);
  }

  .caps {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 0.9rem;
    padding-left: 1.5ch;
  }
  .cap {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-family: var(--util);
    font-size: 0.7rem;
    color: var(--paper-mute);
  }
  .capname {
    color: var(--paper-dim);
  }
  .used {
    color: var(--paper);
    min-width: 3.5ch;
    text-align: right;
  }
  .of {
    color: var(--paper-faint);
  }
  .capin {
    width: 5ch;
    background: var(--well);
    border: 1px solid var(--rule);
    border-radius: 3px;
    color: var(--paper);
    font-family: var(--util);
    font-size: 0.7rem;
    padding: 0.05rem 0.2rem;
    text-align: right;
  }
  .pc {
    color: var(--paper-faint);
  }

  .acts {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
    padding-left: 1.5ch;
  }

  .chip {
    font-family: var(--util);
    font-size: 0.68rem;
    padding: 0.1rem 0.4rem;
    border: 1px solid var(--rule);
    border-radius: 3px;
    background: none;
    color: var(--paper-mute);
    cursor: pointer;
  }
  .chip:hover:not(:disabled) {
    color: var(--paper);
    border-color: var(--edge);
  }
  .chip:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .danger:hover:not(:disabled) {
    color: var(--st-fail);
    border-color: color-mix(in srgb, var(--st-fail) 50%, var(--rule));
  }

  .go {
    font-family: var(--util);
    font-size: 0.7rem;
    padding: 0.15rem 0.55rem;
    border: 1px solid var(--edge);
    border-radius: 3px;
    background: var(--raised);
    color: var(--paper);
    cursor: pointer;
  }
  .go:hover:not(:disabled) {
    border-color: var(--paper-faint);
  }
  .go:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .loose {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    padding: 0.3rem 0.1rem;
  }

  .foot {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    border-top: 1px solid var(--rule);
    padding-top: 0.5rem;
  }
  .namein {
    flex: 1;
    background: var(--well);
    border: 1px solid var(--rule);
    border-radius: 3px;
    color: var(--paper);
    font-family: var(--util);
    font-size: 0.74rem;
    padding: 0.2rem 0.4rem;
  }

  .fault {
    margin: 0;
    font-family: var(--util);
    font-size: 0.7rem;
    color: var(--st-fail);
  }
</style>
