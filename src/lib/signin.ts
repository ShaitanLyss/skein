/* Reading what a sign-in is saying, so the panel can say it back.
 *
 * `signin.rs` spawns `claude auth login` on pipes and hands over its output in
 * chunks as they arrive — chunks rather than lines, because the prompt the paste
 * fallback depends on has no newline on it. So what reaches here is one growing
 * string, and this is what turns it into the four things a panel draws: has the
 * browser been opened, what is the URL to visit if it did not, is a code being
 * waited for, and has it gone wrong.
 *
 * **Matched loosely and on purpose.** Every pattern here is against wording in
 * somebody else's CLI, and the whole flow still works if all of it stops
 * matching: the browser is opened by the CLI itself and the callback completes
 * on localhost without anybody reading a word of this. What is lost when the
 * wording moves is the *fallback* — so these are written to fail soft, matching
 * the durable half of each sentence (`oauth/authorize`, `paste`) rather than the
 * sentence.
 *
 * Pure and tested (`test/signin.test.ts`), per the purity boundary in
 * CLAUDE.md — which is most of why the parsing is here rather than in the panel.
 */

/** What the panel needs to know, off the accumulated output. */
export type Progress = {
  /** The authorize URL to visit by hand, when the browser did not open itself.
   *  Null until it has been printed. */
  url: string | null;
  /** Whether the browser has been opened for you already. */
  opened: boolean;
  /** Whether the CLI is waiting to be handed a `code#state`. */
  prompting: boolean;
  /** What went wrong, where it said so. */
  fault: string | null;
};

/* The URL is matched by its *path* rather than by its host, because the host
   moves with the OAuth environment — `claude.com/cai/oauth/authorize` in prod,
   `localhost:4000/oauth/authorize` under `USE_LOCAL_OAUTH`, and a third under
   staging. The path is the same in all three. Trailing punctuation is trimmed
   below rather than excluded here, since a URL may legitimately end in almost
   anything. */
const AUTHORIZE = /https?:\/\/\S*oauth\/authorize\S*/gi;

/** Trailing characters that are sentence, not URL. A query string can end in a
 *  `.` or a `)` legitimately, so this is only stripped from the end and only
 *  where it is punctuation a printed line would have added. */
const TRAILING = /[).,;:'"\]]+$/;

/** Wording that means a browser was opened. */
const OPENED = /opening browser/i;

/** Wording that means a code is being waited for. The prompt is
 *  `Paste code here if prompted > `, and "paste" plus "code" is the part of it
 *  least likely to be reworded. */
const PROMPT = /paste\s+\S*\s*code|paste code/i;

/** Wording that means it went wrong. `Login failed:` and `Error:` are the two
 *  the CLI actually prints, plus the one the manual path answers a mistyped
 *  code with. */
const FAULTS = [/^\s*login failed:.*/im, /^\s*error:.*/im, /^\s*invalid code\..*/im];

/** Read the accumulated output of one sign-in. */
export function readSignin(out: string): Progress {
  const text = out ?? "";

  /* The *last* authorize URL, not the first. Only one is printed per sign-in,
     but a retried one appends a second, and the live challenge is the newer —
     handing back the older would send somebody to a URL whose `state` the CLI
     is no longer waiting on. */
  let url: string | null = null;
  for (const m of text.matchAll(AUTHORIZE)) url = m[0]!.replace(TRAILING, "");

  let fault: string | null = null;
  for (const pattern of FAULTS) {
    const m = text.match(pattern);
    if (m) fault = m[0]!.trim();
  }

  return {
    url,
    opened: OPENED.test(text),
    /* A fault ends the waiting: the prompt stays on screen above whatever went
       wrong, and a field still offering to take a code the flow has given up on
       is a field that cannot work. */
    prompting: !fault && PROMPT.test(text),
    fault,
  };
}

/** Turn whatever was pasted into the `code#state` the CLI is waiting for.
 *
 *  The flow asks for two values joined by a `#`, which is what the success page
 *  shows — but the thing most readily to hand is the whole callback URL out of
 *  the browser's address bar, and the CLI answers that with "Invalid code" and
 *  no hint as to why. Both are accepted here, because the difference between
 *  them is bookkeeping this can do and a person should not have to.
 *
 *  Anything unrecognised is handed over trimmed and unaltered — the CLI is the
 *  authority on what it will take, and its complaint is better than a guess of
 *  ours about what somebody meant. */
export function codeFrom(input: string): string {
  const raw = (input ?? "").trim();
  if (!raw) return "";

  /* A URL, from the address bar or the "copy" button on the callback page.
     Tried before the `#` check because such a URL may well contain a fragment
     of its own, which is not the separator being looked for. */
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      if (code && state) return `${code}#${state}`;
      if (code) return code;
    } catch {
      /* Not a URL after all, despite the prefix. Fall through and hand it over
         as typed rather than refusing it here. */
    }
  }

  return raw;
}

/** Whether what has been typed looks like it will be accepted — for a hint
 *  beside the field, never to *block* the sending of it.
 *
 *  The distinction matters more than it looks: this is a guess about a format
 *  somebody else's CLI defines, so a version of it that refused to submit would
 *  turn a wrong guess here into a sign-in nobody can finish. It only ever
 *  decides whether to show a nudge. */
export function looksLikeCode(input: string): boolean {
  const code = codeFrom(input);
  const at = code.indexOf("#");
  return at > 0 && at < code.length - 1;
}
