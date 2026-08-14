/* Scratch: what control_request subtypes does the installed `claude` know?
   Reads the compiled binary as latin1 and prints the neighbourhood of a needle.

     bun tools/probe-control.ts <needle> [needle...]      # 400 chars either side
     SPAN=1200 bun tools/probe-control.ts <needle>        # wider
*/
/* The installed binary, wherever it is — `claude` is compiled with bun, so the
   whole app is embedded in it as latin1-readable strings and its dispatchers
   can be read without spending a turn. */
const p = Bun.which("claude") ?? `${process.env.USERPROFILE}/.local/bin/claude.exe`;
const buf = await Bun.file(p).arrayBuffer();
const s = new TextDecoder("latin1").decode(new Uint8Array(buf));

const SPAN = Number(process.env.SPAN ?? 400);
const MAX = Number(process.env.MAX ?? 3);

function show(needle: string) {
  let i = -1;
  let n = 0;
  while ((i = s.indexOf(needle, i + 1)) !== -1 && n < MAX) {
    n++;
    console.log(`=== ${needle} @${i} ===`);
    console.log(s.slice(i - SPAN, i + SPAN).replace(/[^\x20-\x7e]+/g, " "));
    console.log("");
  }
  if (!n) console.log(`(no hit) ${needle}`);
}

for (const needle of Bun.argv.slice(2)) show(needle);
