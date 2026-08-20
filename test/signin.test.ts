import { describe, expect, test } from "bun:test";
import { codeFrom, looksLikeCode, readSignin } from "../src/lib/signin";

/** What `claude auth login --claudeai` actually wrote on pipes, probed
 *  2026-08-20 against claude 2.1.235. The URL is the manual-redirect one, which
 *  is the one printed — the browser is opened to a localhost-callback variant
 *  that never appears in the output. */
const REAL = `Opening browser to sign in…
If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=GiURyoonhYZTlz8mfDIdJLMSAGNbLzl9ESUQsQy83ls&code_challenge_method=S256&state=0uKX7ifBkVS3XLfonT8xu-ODQ1XS3RAi0j51X8lpafk
Paste code here if prompted > `;

describe("reading a sign-in", () => {
  test("nothing said yet is nothing known", () => {
    const p = readSignin("");
    expect(p.url).toBeNull();
    expect(p.opened).toBe(false);
    expect(p.prompting).toBe(false);
    expect(p.fault).toBeNull();
  });

  test("the real output, whole", () => {
    const p = readSignin(REAL);
    expect(p.opened).toBe(true);
    expect(p.prompting).toBe(true);
    expect(p.fault).toBeNull();
    expect(p.url).toStartWith("https://claude.com/cai/oauth/authorize?code=true");
    expect(p.url).toContain("state=0uKX7ifBkVS3XLfonT8xu-ODQ1XS3RAi0j51X8lpafk");
  });

  /* The output arrives in chunks off a pipe, so every prefix of it is a state
     the panel will actually render. None of them may throw or claim more than
     has been said. */
  test("every prefix of it is readable", () => {
    for (let i = 0; i <= REAL.length; i++) {
      const p = readSignin(REAL.slice(0, i));
      expect(typeof p.opened).toBe("boolean");
      if (p.url !== null) expect(p.url).toStartWith("https://");
    }
  });

  test("the prompt is seen even with no newline after it", () => {
    /* The whole reason `signin.rs` pumps chunks rather than lines: this is the
       last thing written and it is unterminated. */
    expect(readSignin("Paste code here if prompted > ").prompting).toBe(true);
  });

  /* The host moves with the OAuth environment — prod, staging and
     USE_LOCAL_OAUTH are three different ones — so the path is what is matched. */
  test("a local oauth host is still found", () => {
    const p = readSignin("visit: http://localhost:4000/oauth/authorize?code=true&state=x");
    expect(p.url).toBe("http://localhost:4000/oauth/authorize?code=true&state=x");
  });

  test("a retry's newer url wins, since the older one's state is dead", () => {
    const p = readSignin(
      "visit: https://a.example/oauth/authorize?state=first\n" +
        "visit: https://a.example/oauth/authorize?state=second",
    );
    expect(p.url).toContain("state=second");
  });

  test("sentence punctuation is not part of the url", () => {
    const p = readSignin("go to https://a.example/oauth/authorize?state=x.");
    expect(p.url).toBe("https://a.example/oauth/authorize?state=x");
  });

  test("a failure is reported, and stops the waiting", () => {
    const p = readSignin(`${REAL}\nLogin failed: something went wrong`);
    expect(p.fault).toBe("Login failed: something went wrong");
    /* The prompt is still on screen above it, but a field offering to take a
       code the flow has given up on is a field that cannot work. */
    expect(p.prompting).toBe(false);
  });

  test("a mistyped code is a fault too", () => {
    const p = readSignin("Invalid code. Please make sure the full code was copied");
    expect(p.fault).toStartWith("Invalid code.");
  });
});

describe("what was pasted", () => {
  test("the code#state it asks for goes through untouched", () => {
    expect(codeFrom("abc#def")).toBe("abc#def");
  });

  test("trimmed, because a paste brings whitespace with it", () => {
    expect(codeFrom("  abc#def \n")).toBe("abc#def");
  });

  /* The thing most readily to hand is the address bar, and the CLI answers a
     whole URL with "Invalid code" and no hint as to why. */
  test("a callback url is turned into the code and state", () => {
    const got = codeFrom("https://platform.claude.com/oauth/code/callback?code=AAA&state=BBB");
    expect(got).toBe("AAA#BBB");
  });

  test("a url with only a code hands over the code", () => {
    expect(codeFrom("https://x.example/callback?code=AAA")).toBe("AAA");
  });

  test("a url with neither is handed over as typed, for the CLI to refuse", () => {
    const raw = "https://x.example/callback?nothing=here";
    expect(codeFrom(raw)).toBe(raw);
  });

  test("nothing is nothing", () => {
    expect(codeFrom("")).toBe("");
    expect(codeFrom("   ")).toBe("");
  });

  test("the hint knows a whole pair from half of one", () => {
    expect(looksLikeCode("abc#def")).toBe(true);
    expect(looksLikeCode("https://x.example/callback?code=A&state=B")).toBe(true);
    expect(looksLikeCode("abc")).toBe(false);
    expect(looksLikeCode("abc#")).toBe(false);
    expect(looksLikeCode("#def")).toBe(false);
    expect(looksLikeCode("")).toBe(false);
  });
});
