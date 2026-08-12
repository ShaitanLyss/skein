/* Markdown, as an agent actually writes it.
 *
 * Claude speaks markdown — headings, lists, fenced code, tables — and the
 * transcript showed all of it as literal asterisks and hashes. This turns one
 * `text` line into a small tree the panel renders as elements.
 *
 * It is a parser, not a renderer: nothing here produces a string of HTML, so
 * there is no escaping to get wrong and no `{@html}` anywhere on the path. The
 * component walks the tree and Svelte does the escaping.
 *
 * Deliberately not CommonMark-complete. What is here is what agent prose
 * contains; what is left out is either absent from it (reference links, setext
 * headings, HTML blocks, footnotes) or wrong for this surface (raw HTML, images
 * — the panel has no business fetching from the network).
 *
 * Pure, so it is tested directly — see test/markdown.test.ts. */

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; kids: Inline[] }
  | { t: "em"; kids: Inline[] }
  | { t: "del"; kids: Inline[] }
  | { t: "link"; href: string; kids: Inline[] };

export type Align = "left" | "center" | "right" | null;

export type Block =
  | { t: "p"; kids: Inline[] }
  | { t: "h"; level: number; kids: Inline[] }
  /** `open` marks a fence with no closer yet — the ordinary state mid-stream,
   *  and the reason a code block doesn't flicker into being a paragraph first. */
  | { t: "code"; lang: string | null; text: string; open: boolean }
  | { t: "quote"; kids: Block[] }
  | { t: "list"; ordered: boolean; start: number; tight: boolean; items: Block[][] }
  | { t: "hr" }
  | { t: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] };

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/;
const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const BULLET = /^([ \t]*)([-*+])([ \t]+)(.*)$/;
const ORDERED = /^([ \t]*)(\d{1,9})([.)])([ \t]+)(.*)$/;
/** Escapable ASCII punctuation, per CommonMark. */
const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

export function parseMarkdown(src: string): Block[] {
  return parseBlocks(src.replace(/\r\n?/g, "\n").split("\n"));
}

/** Does this line begin a block of its own? Used to decide where a paragraph
 *  or a lazy continuation stops. */
function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    HR.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line)
  );
}

type Marker = {
  ordered: boolean;
  indent: number;
  num: number;
  content: string;
  /** The column the item's content starts at — what continuation lines are
   *  measured against, and what tells a nested list from the next item. */
  col: number;
};

function markerAt(line: string): Marker | null {
  /* `* * *` is a rule, not three empty bullets. HR wins, as it does in every
     renderer, or every thematic break becomes a list. */
  if (HR.test(line)) return null;
  const b = BULLET.exec(line);
  if (b) {
    const indent = b[1].length;
    return {
      ordered: false,
      indent,
      num: 1,
      content: b[4],
      col: indent + 1 + b[3].length,
    };
  }
  const o = ORDERED.exec(line);
  if (o) {
    const indent = o[1].length;
    return {
      ordered: true,
      indent,
      num: Number(o[2]),
      content: o[5],
      col: indent + o[2].length + 1 + o[4].length,
    };
  }
  return null;
}

function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    /* A backtick fence's info string can't itself contain a backtick — that is
       what keeps `` `a` and `b` `` from opening a code block. */
    if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
      const marker = fence[1][0];
      const len = fence[1].length;
      const indent = line.length - line.trimStart().length;
      const info = fence[2].trim();
      const close = new RegExp(`^ {0,3}\\${marker}{${len},}[ \\t]*$`);
      const body: string[] = [];
      let open = true;
      i++;
      while (i < lines.length) {
        if (close.test(lines[i])) {
          open = false;
          i++;
          break;
        }
        /* The opening fence's indentation is the block's left edge, not part of
           the code. Removing more than a line has is not an error. */
        body.push(lines[i].slice(0, indent).trim() ? lines[i] : lines[i].slice(indent));
        i++;
      }
      out.push({
        t: "code",
        lang: info.split(/\s+/)[0] || null,
        text: body.join("\n"),
        open,
      });
      continue;
    }

    if (HR.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      out.push({
        t: "h",
        level: h[1].length,
        // `## title ##` — a closing run of hashes is decoration, not text.
        kids: parseInline((h[2] ?? "").replace(/[ \t]+#+$/, "")),
      });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (QUOTE.test(l)) {
          buf.push(l.replace(QUOTE, ""));
          i++;
        } else if (l.trim() && !startsBlock(l)) {
          // Lazy continuation: a wrapped quote line often loses its `>`.
          buf.push(l);
          i++;
        } else break;
      }
      out.push({ t: "quote", kids: parseBlocks(buf) });
      continue;
    }

    const mk = markerAt(line);
    if (mk) {
      i = readList(lines, i, mk, out);
      continue;
    }

    const table = readTable(lines, i);
    if (table) {
      out.push(table.block);
      i = table.next;
      continue;
    }

    /* A paragraph runs to the first blank line or the first line that is
       something else. Its own newlines are kept: an agent's line breaks in
       prose are meaningful (a wrapped list of names, an address, a short
       stanza), and collapsing them the way CommonMark does reads as a bug in a
       chat transcript. Same choice GFM's `breaks` makes. */
    const buf = [line.replace(/[ \t]+$/, "")];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !readTable(lines, i)) {
      buf.push(lines[i].replace(/[ \t]+$/, ""));
      i++;
    }
    out.push({ t: "p", kids: parseInline(buf.join("\n")) });
  }

  return out;
}

/** Consume one list starting at `at`, push it, and return the next index. */
function readList(lines: string[], at: number, first: Marker, out: Block[]): number {
  const ordered = first.ordered;
  const items: string[][] = [];
  let tight = true;
  let cur: string[] | null = null;
  let col = 0;
  let blanks = 0;
  let i = at;

  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      blanks++;
      i++;
      continue;
    }

    const mk = markerAt(l);
    /* A marker indented past the current item's content column belongs *to*
       that item — it is a nested list, and is parsed when the item is. */
    if (mk && (cur === null || mk.indent < col)) {
      if (mk.ordered !== ordered) break;
      if (blanks) tight = false;
      cur = [mk.content];
      items.push(cur);
      col = mk.col;
      blanks = 0;
      i++;
      continue;
    }
    if (!cur) break;

    const indent = l.length - l.trimStart().length;
    if (indent >= col) {
      if (blanks) {
        cur.push("");
        tight = false;
      }
      cur.push(l.slice(col));
      blanks = 0;
      i++;
      continue;
    }
    /* An unindented continuation only continues an item while nothing has
       interrupted it — after a blank line, or at anything block-shaped, the
       list is over. */
    if (blanks === 0 && !startsBlock(l) && !readTable(lines, i)) {
      cur.push(l.trim());
      i++;
      continue;
    }
    break;
  }

  out.push({
    t: "list",
    ordered,
    start: first.num,
    tight,
    items: items.map((it) => parseBlocks(it)),
  });
  return i;
}

/** Split one table row into cells. Pipes inside code spans still split — GFM
 *  says so, and `\|` is the escape. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (/(^|[^\\])\|$/.test(s)) s = s.slice(0, -1);
  const cells: string[] = [];
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      buf += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(buf.trim());
      buf = "";
    } else buf += s[i];
  }
  cells.push(buf.trim());
  return cells;
}

function readTable(
  lines: string[],
  at: number,
): { block: Block; next: number } | null {
  const head = lines[at];
  const spec = lines[at + 1];
  if (!head?.includes("|") || !spec?.includes("|")) return null;
  const cols = splitRow(head);
  const rule = splitRow(spec);
  if (rule.length !== cols.length) return null;
  if (!rule.every((c) => /^:?-+:?$/.test(c))) return null;

  const align: Align[] = rule.map((c) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    return l && r ? "center" : r ? "right" : l ? "left" : null;
  });

  const rows: Inline[][][] = [];
  let i = at + 2;
  /* Rows run to the first blank line or the first line that is something else
     — a row without pipes is still a row, which is what GFM says and what a
     one-column table needs. */
  while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
    const cells = splitRow(lines[i]);
    // Ragged rows are common in hand-written tables; pad rather than refuse.
    rows.push(
      Array.from({ length: cols.length }, (_, c) => parseInline(cells[c] ?? "")),
    );
    i++;
  }

  return {
    block: { t: "table", align, head: cols.map(parseInline), rows },
    next: i,
  };
}

/** Where a `href` may point. Everything else renders as plain text: this window
 *  is the app, so a `javascript:` or `data:` destination has nothing legitimate
 *  to do in a transcript. */
export function safeHref(raw: string): string | null {
  const href = raw.trim().replace(/^<|>$/g, "");
  // A space or a control character in a destination means it was never one.
  if (!href || href.split("").some((ch) => ch <= " ")) return null;
  if (/^(https?:\/\/|mailto:)/i.test(href)) return href;
  if (/^www\./i.test(href)) return `https://${href}`;
  return null;
}

function runAt(src: string, i: number, ch: string): number {
  let n = 0;
  while (src[i + n] === ch) n++;
  return n;
}

/** The next run of exactly `len` `ch`s that could close a span opened at
 *  `from`. Exactly, not at least: `*a **b** c*` closes on the final single
 *  asterisk, and taking the first run of two would tear the nesting apart.
 *  Code spans are skipped whole, so `**a `b*` c**` still works. */
function findCloser(src: string, from: number, ch: string, len: number): number {
  let i = from;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") {
      const run = runAt(src, i, "`");
      const end = src.indexOf("`".repeat(run), i + run);
      i = end === -1 ? i + run : end + run;
      continue;
    }
    if (c === ch) {
      const run = runAt(src, i, ch);
      const before = src[i - 1];
      if (run === len && before && !/\s/.test(before)) return i;
      i += run;
      continue;
    }
    i++;
  }
  return -1;
}

/** The matching `]` for the `[` at `open`, honouring nesting and code spans. */
function closeBracket(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "`") {
      const run = runAt(src, i, "`");
      const end = src.indexOf("`".repeat(run), i + run);
      i = end === -1 ? i + run - 1 : end + run - 1;
      continue;
    }
    if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return i;
  }
  return -1;
}

function matchLink(src: string, at: number): { nodes: Inline[]; end: number } | null {
  const image = src[at] === "!";
  const open = image ? at + 1 : at;
  const close = closeBracket(src, open);
  if (close === -1 || src[close + 1] !== "(") return null;

  let depth = 0;
  let end = -1;
  for (let i = close + 1; i < src.length; i++) {
    if (src[i] === "\\") {
      i++;
      continue;
    }
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  const label = src.slice(open + 1, close);
  // `(url "title")` — the title is a tooltip nobody asked for; the url is all we take.
  const href = safeHref(src.slice(close + 2, end).trim().split(/\s+/)[0] ?? "");
  const kids = parseInline(label);

  /* An image is rendered as a link to it. The panel does not fetch anything —
     reference images are a deliberate, hand-placed thing on the wall (see
     images.svelte.ts), and a transcript that quietly reached the network would
     be a different app. */
  if (!href) return { nodes: kids.length ? kids : [{ t: "text", v: label }], end: end + 1 };
  return {
    nodes: [{ t: "link", href, kids: kids.length ? kids : [{ t: "text", v: href }] }],
    end: end + 1,
  };
}

function matchEmphasis(src: string, at: number): { node: Inline; end: number } | null {
  const ch = src[at];
  const run = runAt(src, at, ch);
  const len = ch === "~" ? 2 : Math.min(run, 3);
  if (ch === "~" && run < 2) return null;
  if (len > run) return null;

  // An opener is glued to what it opens: `a * b` is arithmetic, not emphasis.
  const after = src[at + len];
  if (!after || /\s/.test(after)) return null;
  /* `_` never fires inside a word, or every `snake_case_name` in prose turns
     into italics halfway through. `*` may, which is what makes `a**b**c` bold. */
  if (ch === "_" && /[\p{L}\p{N}]/u.test(src[at - 1] ?? "")) return null;

  const close = findCloser(src, at + len, ch, len);
  if (close === -1) return null;
  if (ch === "_" && /[\p{L}\p{N}]/u.test(src[close + len] ?? "")) return null;

  const kids = parseInline(src.slice(at + len, close));
  const end = close + len;
  if (ch === "~") return { node: { t: "del", kids }, end };
  if (len === 3) return { node: { t: "strong", kids: [{ t: "em", kids }] }, end };
  return { node: { t: len === 2 ? "strong" : "em", kids }, end };
}

/* A bare url ends before the punctuation that ends the sentence it sits in.
   A closing paren counts only if the url opened one — wikipedia links do. */
function trimUrl(url: string): string {
  let s = url;
  while (s.length) {
    const last = s[s.length - 1];
    if (".,;:!?'\"".includes(last)) s = s.slice(0, -1);
    else if (last === ")" && (s.match(/\(/g)?.length ?? 0) < (s.match(/\)/g)?.length ?? 0))
      s = s.slice(0, -1);
    else break;
  }
  return s;
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];

    if (c === "\\" && PUNCT.test(src[i + 1] ?? "")) {
      buf += src[i + 1];
      i += 2;
      continue;
    }

    if (c === "`") {
      const run = runAt(src, i, "`");
      const close = src.indexOf("`".repeat(run), i + run);
      /* Only a *matched* run is code. An unmatched backtick is a literal one —
         which is also what keeps a half-typed span from swallowing the rest of
         a streaming line. */
      if (close !== -1 && runAt(src, close, "`") === run) {
        flush();
        let v = src.slice(i + run, close);
        if (v.length > 2 && v.startsWith(" ") && v.endsWith(" ")) v = v.slice(1, -1);
        out.push({ t: "code", v });
        i = close + run;
        continue;
      }
    }

    if (c === "<") {
      const m = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/.exec(src.slice(i));
      if (m) {
        flush();
        out.push({
          t: "link",
          href: m[1],
          kids: [{ t: "text", v: m[1].replace(/^mailto:/i, "") }],
        });
        i += m[0].length;
        continue;
      }
    }

    if (c === "[" || (c === "!" && src[i + 1] === "[")) {
      const link = matchLink(src, i);
      if (link) {
        flush();
        out.push(...link.nodes);
        i = link.end;
        continue;
      }
    }

    if (c === "*" || c === "_" || c === "~") {
      const em = matchEmphasis(src, i);
      if (em) {
        flush();
        out.push(em.node);
        i = em.end;
        continue;
      }
    }

    /* Bare urls. Agents write them unadorned far more often than they write
       `[label](url)`, and an unlinked one is the single most common thing you
       want to click in a transcript. */
    if ((c === "h" || c === "w") && !/[\p{L}\p{N}]/u.test(src[i - 1] ?? "")) {
      const m = /^(?:https?:\/\/|www\.)[^\s<>"'`\]]+/.exec(src.slice(i));
      if (m) {
        const url = trimUrl(m[0]);
        const href = safeHref(url);
        if (href) {
          flush();
          out.push({ t: "link", href, kids: [{ t: "text", v: url }] });
          i += url.length;
          continue;
        }
      }
    }

    buf += c;
    i++;
  }

  flush();
  return out;
}
