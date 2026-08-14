/* Reference images pinned to the wall.
 *
 * Deliberately not tied to a project. A reference board is personal and spans
 * everything you are working on — a colour study sits next to a UI screenshot
 * next to a photo of a real object, and none of them belong to a repo.
 *
 * Unlike a card, an image is never auto-placed. It carries its own size and
 * rotation because *you* put it there, at that angle, at that size, and that
 * arrangement is the information. */

import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { nextBackZ, nextFrontZ } from "./layout";

export type RefImage = {
  id: string;
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  z: number;
  /** Where it is drawn if it has been stuck to the glass, in screen pixels, or
   *  null for one that is on the wall. Never a substitute for `x`/`y` — see the
   *  note at the top of `glass.ts`. */
  glassX: number | null;
  glassY: number | null;
};

/** Longest edge a freshly dropped image is scaled to, in canvas units. Big
 *  enough to read, small enough that dropping a 6000px photo doesn't swallow
 *  the studio. */
const DROP_MAX_EDGE = 420;

export class Board {
  images = $state<RefImage[]>([]);
  selected = $state<string | null>(null);
  fault = $state<string | null>(null);

  /** The z of everything else hand-placed on the wall — the widgets.
   *
   *  There is one stacking order for the whole wall (`layout.ts`), so "bring to
   *  front" has to mean in front of everything rather than in front of the
   *  other images. Injected because neither list may own the other. */
  others: () => number[] = () => [];

  #saveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async load() {
    try {
      this.images = await invoke<RefImage[]>("list_images");
    } catch (err) {
      this.fault = String(err);
    }
  }

  /** Where the file actually lives, as something an <img> can load. */
  src(img: RefImage): string {
    return convertFileSrc(img.path);
  }

  /** Read the intrinsic size so a dropped image arrives at its own aspect
   *  ratio rather than a guessed box. */
  async #measure(src: string): Promise<{ w: number; h: number }> {
    return new Promise((resolve) => {
      const el = new Image();
      el.onload = () => resolve({ w: el.naturalWidth, h: el.naturalHeight });
      el.onerror = () => resolve({ w: DROP_MAX_EDGE, h: DROP_MAX_EDGE });
      el.src = src;
    });
  }

  /** Import a file from disk and place it at a point in canvas space. */
  async add(srcPath: string, atX: number, atY: number): Promise<RefImage | null> {
    try {
      const stored = await invoke<string>("import_image", { src: srcPath });
      return await this.#place(stored, atX, atY);
    } catch (err) {
      this.fault = String(err);
      return null;
    }
  }

  /** Pin up bytes that came off the clipboard rather than out of a file.
   *
   *  A screenshot is the case this exists for: Windows' capture tools leave a
   *  bitmap on the clipboard and nothing on disk, so there is no path for `add`
   *  to copy. Rust writes the bytes into the same `references` directory and
   *  hands back a path, so from there on this *is* `add`. */
  async paste(
    bytes: ArrayBuffer,
    atX: number,
    atY: number,
  ): Promise<RefImage | null> {
    try {
      /* The bytes are the whole payload rather than a field in one — that is
         what puts them on Tauri's raw-body path instead of through a JSON array
         of numbers, which for a screenshot is millions of characters. */
      const stored = await invoke<string>("paste_image", bytes);
      return await this.#place(stored, atX, atY);
    } catch (err) {
      this.fault = String(err);
      return null;
    }
  }

  /** Everything after "there is now a file in our own storage": size it, put it
   *  on the wall, write the row. Shared, or a pasted image and a dropped one
   *  would arrive at different sizes and in different bands. */
  async #place(stored: string, atX: number, atY: number): Promise<RefImage> {
    const url = convertFileSrc(stored);
    const nat = await this.#measure(url);
    const scale = DROP_MAX_EDGE / Math.max(nat.w, nat.h);
    const w = Math.round(nat.w * Math.min(1, scale));
    const h = Math.round(nat.h * Math.min(1, scale));

    const img: RefImage = {
      id: crypto.randomUUID(),
      path: stored,
      /* Drop centred on the cursor — you aimed at a spot, not a corner. */
      x: atX - w / 2,
      y: atY - h / 2,
      w,
      h,
      rotation: 0,
      /* On the wall, like everything else that arrives. The glass is somewhere
         you put a thing on purpose, never somewhere a thing lands. */
      glassX: null,
      glassY: null,
      /* A reference lands behind the work by default — it is something to
         look at while you do the work, not something over it. */
      z: nextBackZ(this.#stack()),
    };
    this.images = [...this.images, img];
    await invoke("save_image", { image: img });
    this.selected = img.id;
    return img;
  }

  update(id: string, patch: Partial<RefImage>) {
    const i = this.images.findIndex((x) => x.id === id);
    if (i < 0) return;
    const next = { ...this.images[i], ...patch };
    this.images[i] = next;
    this.#saveSoon(next);
  }

  /** In front of everything on the wall — cards, territory chips and widgets
   *  included, which it could not manage while it only outranked other
   *  images. */
  bringToFront(id: string) {
    this.update(id, { z: nextFrontZ(this.#stack()) });
  }

  #stack(): number[] {
    return [...this.images.map((i) => i.z), ...this.others()];
  }

  /** Manipulating an image fires continuously; the database only needs the
   *  place it came to rest. */
  #saveSoon(img: RefImage) {
    clearTimeout(this.#saveTimers.get(img.id));
    this.#saveTimers.set(
      img.id,
      setTimeout(() => {
        void invoke("save_image", { image: $state.snapshot(img) }).catch(() => {});
      }, 250),
    );
  }

  async remove(id: string) {
    /* Drop any queued save first, or it lands *after* the delete and puts the
       row straight back — pointing at a file we have just removed. Selecting an
       image is itself an update (it comes to the front), so "click an image,
       press Delete" was enough: the image vanished, then came back as a broken
       rectangle on the next launch, and deleting it again did the same thing. */
    clearTimeout(this.#saveTimers.get(id));
    this.#saveTimers.delete(id);

    this.images = this.images.filter((i) => i.id !== id);
    if (this.selected === id) this.selected = null;
    try {
      await invoke("delete_image", { id });
    } catch (err) {
      this.fault = String(err);
    }
  }
}
