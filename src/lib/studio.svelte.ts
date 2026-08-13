/* The canvas viewport: where you are looking, and what you have pinned.
 * The placement rules themselves are pure and live in ./layout.ts. */

import {
  MAX_SCALE,
  MIN_SCALE,
  clamp,
  fitViewport,
  lodFor,
  readingScale,
  type Lod,
  type Placement,
  type Region,
} from "./layout";

export * from "./layout";

const STORE_KEY = "skein.studio.v1";

export class Studio {
  /* viewport, in screen pixels */
  x = $state(0);
  y = $state(0);
  scale = $state(1);

  /** How wide the reading panel has been dragged, in screen pixels, or null
   *  while nobody has touched it — see `panelWidth`. Kept here because it is
   *  the other half of how the window is divided, and because it is the same
   *  kind of thing as the viewport: per-machine, disposable, and no business
   *  being in the database. */
  panelW = $state<number | null>(null);

  /** How large the transcript is drawn, as a multiplier, or null while nobody
   *  has changed it — see `readingScale`. Here for exactly the reasons
   *  `panelW` is: it is how this window has been set up to be read from,
   *  per-machine and disposable, and not a thing you made. Independent of the
   *  width on purpose — see the note in layout.ts. */
  readScale = $state<number | null>(null);

  /** Placements by conversation id. Only pinned entries actually matter —
   *  unpinned cards are recomputed by the layout every time. */
  placements = $state<Record<string, Placement>>({});

  /** Semantic zoom. One continuous gesture, three densities: the constellation
   *  you take in at a glance, the working wall, and a card opened far enough
   *  to read. */
  lod = $derived<Lod>(lodFor(this.scale));

  /** Cards gathered for a broadcast. An array rather than a Set because
   *  Svelte's reactivity tracks assignment, and order is the order you picked
   *  them — which is the order the dock lists them in. */
  selected = $state<string[]>([]);

  isSelected(id: string): boolean {
    return this.selected.includes(id);
  }

  toggle(id: string) {
    this.selected = this.isSelected(id)
      ? this.selected.filter((s) => s !== id)
      : [...this.selected, id];
  }

  selectOnly(id: string) {
    this.selected = [id];
  }

  clearSelection() {
    this.selected = [];
  }

  constructor() {
    this.#load();
  }

  #load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (typeof s.x === "number") this.x = s.x;
      if (typeof s.y === "number") this.y = s.y;
      if (typeof s.scale === "number") {
        this.scale = clamp(s.scale, MIN_SCALE, MAX_SCALE);
      }
      /* Not clamped here: what it is worth depends on the window it is read
         back into, which `panelWidth` is asked on every paint anyway. */
      if (typeof s.panelW === "number") this.panelW = s.panelW;
      /* Clamped on read, unlike the width: what it is worth does not depend on
         the window, so `readingScale` is the whole of the answer and there is
         no reason to carry an out-of-range number around. */
      if (typeof s.readScale === "number") {
        this.readScale = readingScale(s.readScale);
      }
    } catch {
      /* a corrupt viewport is not worth failing to start over */
    }
  }

  /** Only the viewport lives here.
   *
   *  Placements are studio data and belong in SQLite alongside the
   *  conversations they key on — keeping a copy in localStorage too would give
   *  us two sources of truth and a guaranteed drift. Where you are *looking*,
   *  by contrast, is pure UI state: per-machine, disposable, and not worth a
   *  database round trip on every frame of a pan. */
  save() {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          x: this.x,
          y: this.y,
          scale: this.scale,
          panelW: this.panelW,
          readScale: this.readScale,
        }),
      );
    } catch {}
  }

  pin(id: string, x: number, y: number) {
    this.placements = { ...this.placements, [id]: { x, y, pinned: true } };
  }

  unpin(id: string) {
    const next = { ...this.placements };
    delete next[id];
    this.placements = next;
  }

  zoomAt(screenX: number, screenY: number, factor: number) {
    const next = clamp(this.scale * factor, MIN_SCALE, MAX_SCALE);
    if (next === this.scale) return;
    /* Keep the point under the cursor fixed while the world scales around it. */
    const worldX = (screenX - this.x) / this.scale;
    const worldY = (screenY - this.y) / this.scale;
    this.scale = next;
    this.x = screenX - worldX * next;
    this.y = screenY - worldY * next;
  }

  fit(regions: Region[], viewW: number, viewH: number) {
    const v = fitViewport(regions, viewW, viewH);
    this.x = v.x;
    this.y = v.y;
    this.scale = v.scale;
  }
}
