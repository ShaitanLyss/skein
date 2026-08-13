/* The widgets standing on the wall.
 *
 * The same shape `Board` has for reference images — load, place, adjust, save
 * on a debounce, remove — because they are the same kind of thing to the wall:
 * hand-placed furniture that belongs to no project and never enters the
 * auto-layout. What differs is that a widget is *drawn* rather than loaded, so
 * what persists is a kind and a config rather than a path.
 *
 * All the vocabulary is in `widgets.ts`, which is pure. This file only owns the
 * copies on the wall and the round trip to SQLite. */

import { invoke } from "@tauri-apps/api/core";
import { nextBackZ, nextFrontZ } from "./layout";
import {
  newWidget,
  normalizeWidget,
  specFor,
  type Widget,
  type WidgetKind,
} from "./widgets";

export class Widgets {
  items = $state<Widget[]>([]);
  selected = $state<string | null>(null);
  fault = $state<string | null>(null);

  /** The z of everything else standing on the wall — the reference images.
   *
   *  There is one stacking order for the whole wall (see `layout.ts`), so
   *  "bring to front" has to mean in front of *everything*, not in front of the
   *  other widgets. Injected rather than imported because the board and the
   *  widgets each hold their own list and neither may own the other. */
  others: () => number[] = () => [];

  #saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async load() {
    try {
      const rows = await invoke<unknown[]>("list_widgets");
      /* Normalised on every read: a knob renamed or a variant retired since a
         row was written degrades to a widget that draws, and a kind this build
         has never heard of is left off the wall rather than guessed at. */
      this.items = rows.map(normalizeWidget).filter((w): w is Widget => !!w);
    } catch (err) {
      this.fault = String(err);
    }
  }

  #stack(): number[] {
    return [...this.items.map((w) => w.z), ...this.others()];
  }

  /** Hang one on the wall, centred on a point in canvas space. */
  async add(kind: WidgetKind, atX: number, atY: number): Promise<Widget | null> {
    if (!specFor(kind)) {
      this.fault = `no such widget: ${kind}`;
      return null;
    }
    /* Behind the cards, for the reason a reference image is: the wall is a
       working surface first, and nothing hung on it should cover live work.
       The menu's "bring to front" is there for when you mean the opposite. */
    const w = newWidget(kind, atX, atY, nextBackZ(this.#stack()));
    this.items = [...this.items, w];
    this.selected = w.id;
    await this.#save(w);
    return w;
  }

  update(id: string, patch: Partial<Widget>) {
    const i = this.items.findIndex((w) => w.id === id);
    if (i < 0) return;
    const next = { ...this.items[i], ...patch };
    this.items[i] = next;
    this.#saveSoon(next);
  }

  /** Turn one knob. Config is replaced whole rather than merged in place, so a
   *  `$state` array element is always a fresh object and the widget repaints. */
  set(id: string, key: string, value: string | number | boolean) {
    const w = this.items.find((w) => w.id === id);
    if (!w) return;
    this.update(id, { config: { ...w.config, [key]: value } });
  }

  bringToFront(id: string) {
    this.update(id, { z: nextFrontZ(this.#stack()) });
  }

  async remove(id: string) {
    /* Drop any queued save first, or it lands *after* the delete and puts the
       row straight back — the bug reference images shipped with, where taking
       one down brought it back on the next launch. */
    clearTimeout(this.#saveTimers.get(id));
    this.#saveTimers.delete(id);

    this.items = this.items.filter((w) => w.id !== id);
    if (this.selected === id) this.selected = null;
    try {
      await invoke("delete_widget", { id });
    } catch (err) {
      this.fault = String(err);
    }
  }

  /** Is any widget of this kind on the wall? What tells the performance
   *  sampler whether anybody is asking. */
  has(kind: WidgetKind): boolean {
    return this.items.some((w) => w.kind === kind);
  }

  async #save(w: Widget) {
    try {
      await invoke("save_widget", { widget: $state.snapshot(w) });
    } catch (err) {
      this.fault = String(err);
    }
  }

  /** Dragging one fires continuously; the database only needs where it came to
   *  rest. */
  #saveSoon(w: Widget) {
    clearTimeout(this.#saveTimers.get(w.id));
    this.#saveTimers.set(
      w.id,
      setTimeout(() => void this.#save(w), 250),
    );
  }
}
