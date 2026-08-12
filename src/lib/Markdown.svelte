<script lang="ts">
  /* Blocks of markdown, drawn as themselves.
     Recursive — a quote and a list item hold blocks of their own.

     Parsing lives in ./markdown.ts (pure, tested); this file only turns nodes
     into elements. There is no `{@html}` on this path and there must not be:
     the text is whatever an agent wrote, and a transcript is not a document
     anybody chose to trust. */
  import Self from "./Markdown.svelte";
  import Inlines from "./Inlines.svelte";
  import type { Block } from "./markdown";

  let {
    blocks,
    caret = false,
    onlink,
  }: {
    blocks: Block[];
    /** Draw the streaming caret at the very end of the last thing written.
     *  It travels down the tree rather than sitting after the whole run,
     *  or a half-written list would blink a line below itself. */
    caret?: boolean;
    onlink?: (href: string) => void;
  } = $props();
</script>

{#each blocks as b, i (i)}
  {@const tip = caret && i === blocks.length - 1}
  {#if b.t === "p"}
    <p><Inlines kids={b.kids} {onlink} />{#if tip}<span class="caret"></span
        >{/if}</p>
  {:else if b.t === "h"}
    <!-- One shape for every level, sized by depth. An agent's `###` is a label
         over a paragraph, not a document outline, so none of them shout.
         `data-nav` is how the transcript's rail finds them — see outline.ts. -->
    <div class="h" data-nav="h" data-level={b.level}>
      <Inlines kids={b.kids} {onlink} />{#if tip}<span class="caret"></span
        >{/if}
    </div>
  {:else if b.t === "code"}
    <!-- No syntax highlighting, deliberately: colour on this wall is status,
         and a keyword is not a status. The mono face and the well do the work. -->
    <pre class="code" class:open={b.open}>{#if b.lang}<span class="lang"
          >{b.lang}</span
        >{/if}<code>{b.text}{#if tip}<span class="caret"></span>{/if}</code></pre>
  {:else if b.t === "quote"}
    <blockquote><Self blocks={b.kids} caret={tip} {onlink} /></blockquote>
  {:else if b.t === "hr"}
    <hr />
  {:else if b.t === "list"}
    {#if b.ordered}
      <ol class:tight={b.tight} start={b.start}>
        {#each b.items as item, j (j)}
          <li data-nav="li">
            <Self
              blocks={item}
              caret={tip && j === b.items.length - 1}
              {onlink}
            />
          </li>
        {/each}
      </ol>
    {:else}
      <!-- `data-nav` on the item, not the list: what the rail lists is the start
           of each item — see outline.ts. -->
      <ul class:tight={b.tight}>
        {#each b.items as item, j (j)}
          <li data-nav="li">
            <Self
              blocks={item}
              caret={tip && j === b.items.length - 1}
              {onlink}
            />
          </li>
        {/each}
      </ul>
    {/if}
  {:else if b.t === "table"}
    <!-- Its own scroller: a wide table must not widen the panel, which would
         push the transcript's own column out of shape. -->
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            {#each b.head as cell, c (c)}
              <th style:text-align={b.align[c] ?? "left"}>
                <Inlines kids={cell} {onlink} />
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each b.rows as row, r (r)}
            <tr>
              {#each row as cell, c (c)}
                <td style:text-align={b.align[c] ?? "left"}>
                  <Inlines kids={cell} {onlink} />
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
{/each}

<style>
  /* Blocks space themselves rather than being spaced by the column, so a line
     that is a single paragraph looks exactly as it did before markdown existed
     here. */
  :global(.md) > :first-child {
    margin-top: 0;
  }
  :global(.md) > :last-child {
    margin-bottom: 0;
  }

  p {
    margin: 0.55em 0;
    /* The parser keeps an agent's own line breaks; this is what shows them. */
    white-space: pre-wrap;
  }

  .h {
    margin: 1em 0 0.4em;
    font-family: var(--display);
    color: var(--paper);
    line-height: 1.3;
  }
  .h[data-level="1"] {
    font-size: 1.22em;
  }
  .h[data-level="2"] {
    font-size: 1.12em;
  }
  .h[data-level="3"] {
    font-size: 1.04em;
  }
  .h[data-level="4"],
  .h[data-level="5"],
  .h[data-level="6"] {
    font-size: 1em;
    font-family: var(--util);
    color: var(--paper-dim);
    letter-spacing: 0.02em;
  }

  .code {
    margin: 0.6em 0;
    padding: 0.5rem 0.6rem;
    background: var(--ink);
    border: 1px solid var(--edge);
    border-radius: 4px;
    overflow-x: auto;
    font-family: var(--mono);
    font-size: 0.78em;
    line-height: 1.5;
    color: var(--paper-dim);
    white-space: pre;
    tab-size: 2;
  }
  /* A fence with no closer yet is still being written. A dashed edge says so
     without adding one more moving thing to a card that is already moving. */
  .code.open {
    border-style: dashed;
  }
  .lang {
    float: right;
    font-family: var(--util);
    font-size: 0.82em;
    color: var(--paper-faint);
    user-select: none;
  }

  blockquote {
    margin: 0.6em 0;
    padding-left: 0.7rem;
    border-left: 2px solid var(--edge);
    color: var(--paper-mute);
  }

  hr {
    margin: 0.9em 0;
    border: 0;
    border-top: 1px solid var(--edge);
  }

  ul,
  ol {
    margin: 0.55em 0;
    padding-left: 1.35rem;
  }
  /* A tight list is one thought per line: it sits as close to its neighbours
     as the lines of a paragraph do. */
  ul.tight,
  ol.tight {
    margin: 0.45em 0;
  }
  li {
    margin: 0.15em 0;
  }
  :global(.md li > p) {
    margin: 0.2em 0;
  }
  /* An em dash rather than a disc: the wall's furniture is rules and dashes,
     and a bulleted list should read like the rest of it. */
  ul {
    list-style: none;
  }
  ul > li::before {
    content: "—";
    color: var(--paper-faint);
    margin-left: -1.1rem;
    margin-right: 0.35rem;
  }
  li::marker {
    color: var(--paper-faint);
  }

  .table-scroll {
    margin: 0.6em 0;
    overflow-x: auto;
    max-width: 100%;
  }
  table {
    border-collapse: collapse;
    font-size: 0.95em;
  }
  th,
  td {
    border: 1px solid var(--edge);
    padding: 0.25rem 0.5rem;
    vertical-align: top;
  }
  th {
    font-family: var(--util);
    font-size: 0.9em;
    font-weight: 600;
    color: var(--paper-dim);
    background: var(--surface);
    white-space: nowrap;
  }

  /* The turn is still being written. One caret, wherever the text has got to. */
  .caret {
    display: inline-block;
    width: 1px;
    height: 0.95em;
    background: var(--st-work);
    margin-left: 1px;
    vertical-align: text-bottom;
    animation: blink 1.1s steps(1) infinite;
  }
  @keyframes blink {
    0%,
    49% {
      opacity: 1;
    }
    50%,
    100% {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .caret {
      animation: none;
    }
  }
</style>
