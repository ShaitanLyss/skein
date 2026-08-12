<script lang="ts">
  /* One run of inline markdown. Recursive: emphasis nests, and a link's label
     is inline markdown of its own.

     Nodes, not html — nothing here interpolates a string into the DOM, so a
     transcript containing `<script>` renders as the words it is.

     The markup below is one unbroken line on purpose. Svelte keeps template
     whitespace, so indenting the branches of this `{#each}` would insert a
     space between every word and the emphasis next to it. */
  import Self from "./Inlines.svelte";
  import type { Inline } from "./markdown";

  let {
    kids,
    onlink,
  }: {
    kids: Inline[];
    /** Routed out rather than invoked: a link leaves the app, and `skein` is
     *  the only thing that talks to Rust. */
    onlink?: (href: string) => void;
  } = $props();
</script>

<!-- A link is a button with no href: this window has no address bar and no way
     back, so a real navigation would take the studio somewhere it cannot return
     from. The click is a command that opens the link where links belong. -->
{#each kids as k, i (i)}{#if k.t === "text"}{k.v}{:else if k.t === "code"}<code
      >{k.v}</code
    >{:else if k.t === "strong"}<strong><Self kids={k.kids} {onlink} /></strong
    >{:else if k.t === "em"}<em><Self kids={k.kids} {onlink} /></em
    >{:else if k.t === "del"}<del><Self kids={k.kids} {onlink} /></del
    >{:else if k.t === "link"}<button
      type="button"
      class="link"
      title={k.href}
      onclick={() => onlink?.(k.href)}><Self kids={k.kids} {onlink} /></button
    >{/if}{/each}

<style>
  code {
    font-family: var(--mono);
    font-size: 0.86em;
    background: var(--surface);
    border: 1px solid var(--edge);
    border-radius: 3px;
    padding: 0.05em 0.3em;
    /* A path or an identifier may be longer than the column; break it rather
       than widen the panel. */
    overflow-wrap: anywhere;
  }

  strong {
    color: var(--paper);
    font-weight: 600;
  }

  em {
    font-style: italic;
  }

  del {
    text-decoration: line-through;
    color: var(--paper-mute);
  }

  /* A button that reads as prose. Underlined rather than coloured — colour on
     this wall means status, and a link is not a status. */
  .link {
    font: inherit;
    color: var(--paper);
    background: none;
    border: 0;
    padding: 0;
    margin: 0;
    text-align: left;
    text-decoration: underline;
    text-decoration-color: var(--paper-faint);
    text-underline-offset: 2px;
    cursor: pointer;
  }
  .link:hover {
    text-decoration-color: var(--paper);
  }
</style>
