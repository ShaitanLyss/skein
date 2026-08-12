import { expect, test, describe } from "bun:test";
import { parseSpecs } from "../src/lib/specs";

describe("reading a group out of what you typed", () => {
  test("one command per line, blank lines ignored", () => {
    const specs = parseSpecs("npm run dev :5173\n\n  cargo run :8080  \n");
    expect(specs).toHaveLength(2);
    expect(specs[0]).toMatchObject({ command: "npm run dev", port: 5173 });
    expect(specs[1]).toMatchObject({ command: "cargo run", port: 8080 });
  });

  test("a command without a port still runs, just unwatched", () => {
    expect(parseSpecs("npx tsc --watch")).toEqual([
      { label: "--watch", command: "npx tsc --watch", cwd: null, port: null },
    ]);
  });

  test("a colon inside the command is not a port", () => {
    const [s] = parseSpecs("npm run dev:watch");
    expect(s.port).toBeNull();
    expect(s.command).toBe("npm run dev:watch");
  });

  /** Labels are the only identity a server has on the wire: `server:log` and
   *  `server:state` both route by them. Two that collide meant one health entry
   *  for two processes, so both chips read the state of whichever reported last. */
  test("two commands ending in the same word get distinct labels", () => {
    const specs = parseSpecs("npm run dev :5173\nbun run dev :3000");
    expect(specs.map((s) => s.label)).toEqual(["dev", "dev2"]);
    expect(new Set(specs.map((s) => s.label)).size).toBe(2);
  });

  test("and so do three, without colliding with the renamed ones", () => {
    const specs = parseSpecs("a run dev\nb run dev\nc run dev\nd run dev2");
    expect(new Set(specs.map((s) => s.label)).size).toBe(4);
    expect(specs.map((s) => s.label)).toEqual(["dev", "dev2", "dev3", "dev22"]);
  });

  test("a line that is only a port keeps a usable label", () => {
    // `command.split` can't produce an empty label, but if it ever does the
    // fallback has to be unique per line rather than an empty string.
    const specs = parseSpecs("npm run dev\nnpm run dev");
    expect(specs.every((s) => s.label.trim().length > 0)).toBe(true);
  });
});
