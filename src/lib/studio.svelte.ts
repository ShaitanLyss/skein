/* The canvas viewport: where you are looking, and what you have pinned.
 * The placement rules themselves are pure and live in ./layout.ts. */

import {
  MAX_SCALE,
  MIN_SCALE,
  clamp,
  fitViewport,
  lodFor,
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

  /** How wide the transcript panel is, in screen pixels.
   *
   *  Null until you drag its edge: `panelDefault` answers until then, so a
   *  panel nobody has an opinion about goes on tracking the window the way the
   *  `32vw` in the CSS used to. Held unclamped — `clampPanel` is applied where
   *  it is drawn, against the window as it is *now*. */
  panel = $state<number | null>(null);

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
      /* Null is a real value here and means "never chosen", so only a number
         is taken — anything else leaves the default in charge. */
      if (typeof s.panel === "number") this.panel = s.panel;
    } catch {
      /* a corrupt viewport is not worth failing to start over */
    }
  }

  /** Only the viewport lives here — and the panel's edge, which is the same
   *  kind of thing.
   *
   *  Placements are studio data and belong in SQLite alongside the
   *  conversations they key on — keeping a copy in localStorage too would give
   *  us two sources of truth and a guaranteed drift. Where you are *looking*,
   *  by contrast, is pure UI state: per-machine, disposable, and not worth a
   *  database round trip on every frame of a pan. How wide you like the column
   *  you read in is a property of this screen and this pair of eyes, not of the
   *  wall, so it belongs on the same side of that line. */
  save() {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          x: this.x,
          y: this.y,
          scale: this.scale,
          panel: this.panel,
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
