import { BlockSpec, blockKey, parseBlock } from "./block.js";
import { Box, MAX_FILL_VOLUME, Vec3, boxSize } from "./geometry.js";

const SUB = 16;
const SUB_VOL = SUB * SUB * SUB;
const OFF = 2 ** 21;

// ok so the key packs chunk x/z in 22 bits each and the sub chunk y in 5 bits. that covers ±30M horizontally
// and y -64..447, plenty for every dimension, and it all stays under 2^53 so plain numbers work as Map keys
function subKey(cx: number, cy: number, cz: number): number {
  return (cx + OFF) * 2 ** 27 + (cz + OFF) * 32 + (cy + 4);
}

function unpackSubKey(k: number): [number, number, number] {
  const cy = (k % 32) - 4;
  const rest = Math.floor(k / 32);
  const cz = (rest % 2 ** 22) - OFF;
  const cx = Math.floor(rest / 2 ** 22) - OFF;
  return [cx, cy, cz];
}

export interface Cuboid {
  min: Vec3;
  max: Vec3;
  /** Index into the palette of the set that produced it. */
  block: number;
}

/**
 * Sparse block buffer in world coordinates. Generators write into it, the apply engine reads it back
 * in tiles. Cells are either unset (left alone in the world) or point at a palette entry, and air is a
 * normal palette entry so "clear this" and "don't touch this" stay different things.
 */
export class VoxelSet {
  readonly palette: BlockSpec[] = [];
  private readonly paletteIndex = new Map<string, number>();
  private readonly subs = new Map<number, Uint16Array>();
  private counts = new Map<number, number>();
  private total = 0;

  indexOf(block: BlockSpec | string): number {
    const spec = parseBlock(block);
    const key = blockKey(spec);
    let i = this.paletteIndex.get(key);
    if (i === undefined) {
      if (this.palette.length >= 65534) throw new Error("palette is full (65534 distinct blocks)");
      i = this.palette.length;
      this.palette.push(spec);
      this.paletteIndex.set(key, i);
    }
    return i;
  }

  set(x: number, y: number, z: number, block: BlockSpec | string | number): void {
    const idx = typeof block === "number" ? block : this.indexOf(block);
    const cx = Math.floor(x / SUB), cy = Math.floor(y / SUB), cz = Math.floor(z / SUB);
    const k = subKey(cx, cy, cz);
    let arr = this.subs.get(k);
    if (!arr) {
      arr = new Uint16Array(SUB_VOL);
      this.subs.set(k, arr);
      this.counts.set(k, 0);
    }
    const i = ((y - cy * SUB) * SUB + (z - cz * SUB)) * SUB + (x - cx * SUB);
    if (arr[i] === 0) {
      this.total++;
      this.counts.set(k, this.counts.get(k)! + 1);
    }
    arr[i] = idx + 1;
  }

  get(x: number, y: number, z: number): number {
    const cx = Math.floor(x / SUB), cy = Math.floor(y / SUB), cz = Math.floor(z / SUB);
    const arr = this.subs.get(subKey(cx, cy, cz));
    if (!arr) return -1;
    return arr[((y - cy * SUB) * SUB + (z - cz * SUB)) * SUB + (x - cx * SUB)] - 1;
  }

  getBlock(x: number, y: number, z: number): BlockSpec | undefined {
    const i = this.get(x, y, z);
    return i < 0 ? undefined : this.palette[i];
  }

  unset(x: number, y: number, z: number): void {
    const cx = Math.floor(x / SUB), cy = Math.floor(y / SUB), cz = Math.floor(z / SUB);
    const k = subKey(cx, cy, cz);
    const arr = this.subs.get(k);
    if (!arr) return;
    const i = ((y - cy * SUB) * SUB + (z - cz * SUB)) * SUB + (x - cx * SUB);
    if (arr[i] === 0) return;
    arr[i] = 0;
    this.total--;
    const c = this.counts.get(k)! - 1;
    if (c === 0) {
      this.subs.delete(k);
      this.counts.delete(k);
    } else this.counts.set(k, c);
  }

  get size(): number {
    return this.total;
  }

  forEach(cb: (x: number, y: number, z: number, block: number) => void): void {
    for (const [k, arr] of this.subs) {
      const [cx, cy, cz] = unpackSubKey(k);
      const bx = cx * SUB, by = cy * SUB, bz = cz * SUB;
      for (let i = 0; i < SUB_VOL; i++) {
        const v = arr[i];
        if (v === 0) continue;
        cb(bx + (i & 15), by + (i >> 8), bz + ((i >> 4) & 15), v - 1);
      }
    }
  }

  bounds(): Box | null {
    if (this.total === 0) return null;
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    this.forEach((x, y, z) => {
      if (x < min.x) min.x = x;
      if (y < min.y) min.y = y;
      if (z < min.z) min.z = z;
      if (x > max.x) max.x = x;
      if (y > max.y) max.y = y;
      if (z > max.z) max.z = z;
    });
    return { min, max };
  }

  /** Copies another set on top of this one, the other set wins where both have a block. */
  merge(other: VoxelSet, offset: Vec3 = { x: 0, y: 0, z: 0 }): this {
    const remap = other.palette.map((b) => this.indexOf(b));
    other.forEach((x, y, z, i) => this.set(x + offset.x, y + offset.y, z + offset.z, remap[i]));
    return this;
  }

  /** New set holding only the cells inside the box. */
  crop(box: Box): VoxelSet {
    const out = new VoxelSet();
    const remap = new Map<number, number>();
    this.forEach((x, y, z, i) => {
      if (x < box.min.x || x > box.max.x || y < box.min.y || y > box.max.y || z < box.min.z || z > box.max.z) return;
      let j = remap.get(i);
      if (j === undefined) {
        j = out.indexOf(this.palette[i]);
        remap.set(i, j);
      }
      out.set(x, y, z, j);
    });
    return out;
  }

  /** Groups occupied cells by tile (aligned to `origin`) so the apply engine can load and write one area at a time. */
  splitByTiles(tile: Vec3, origin: Vec3 = { x: 0, y: 0, z: 0 }): Map<string, { box: Box; set: VoxelSet }> {
    const out = new Map<string, { box: Box; set: VoxelSet }>();
    const remaps = new Map<VoxelSet, Map<number, number>>();
    this.forEach((x, y, z, i) => {
      const tx = Math.floor((x - origin.x) / tile.x), ty = Math.floor((y - origin.y) / tile.y), tz = Math.floor((z - origin.z) / tile.z);
      const key = `${tx},${ty},${tz}`;
      let t = out.get(key);
      if (!t) {
        const min = { x: origin.x + tx * tile.x, y: origin.y + ty * tile.y, z: origin.z + tz * tile.z };
        t = {
          box: { min, max: { x: min.x + tile.x - 1, y: min.y + tile.y - 1, z: min.z + tile.z - 1 } },
          set: new VoxelSet(),
        };
        out.set(key, t);
        remaps.set(t.set, new Map());
      }
      const remap = remaps.get(t.set)!;
      let j = remap.get(i);
      if (j === undefined) {
        j = t.set.indexOf(this.palette[i]);
        remap.set(i, j);
      }
      t.set.set(x, y, z, j);
    });
    return out;
  }

  /** Block count per palette entry, handy for summaries and material estimates. */
  histogram(): Map<number, number> {
    const h = new Map<number, number>();
    this.forEach((_x, _y, _z, i) => h.set(i, (h.get(i) ?? 0) + 1));
    return h;
  }

  /**
   * Greedy merges cells into as few boxes as possible so a 10k block wall turns into a handful of fills.
   * Each box stays under the 32768 fill limit. Works on a dense copy of the bounds, so call it per tile.
   */
  toCuboids(maxVolume = MAX_FILL_VOLUME): Cuboid[] {
    const b = this.bounds();
    if (!b) return [];
    const s = boxSize(b);
    if (s.x * s.y * s.z > 64 * 64 * 400) {
      throw new Error("toCuboids works per tile, split the set first (splitByTiles)");
    }
    const dense = new Int32Array(s.x * s.y * s.z).fill(-1);
    const at = (x: number, y: number, z: number) => (y * s.z + z) * s.x + x;
    this.forEach((x, y, z, i) => {
      dense[at(x - b.min.x, y - b.min.y, z - b.min.z)] = i;
    });
    const out: Cuboid[] = [];
    for (let y = 0; y < s.y; y++) {
      for (let z = 0; z < s.z; z++) {
        for (let x = 0; x < s.x; x++) {
          const v = dense[at(x, y, z)];
          if (v < 0) continue;
          let x2 = x;
          while (x2 + 1 < s.x && dense[at(x2 + 1, y, z)] === v && x2 + 2 - x <= maxVolume) x2++;
          const w = x2 - x + 1;
          let z2 = z;
          grow_z: while (z2 + 1 < s.z && w * (z2 + 2 - z) <= maxVolume) {
            for (let xi = x; xi <= x2; xi++) if (dense[at(xi, y, z2 + 1)] !== v) break grow_z;
            z2++;
          }
          const area = w * (z2 - z + 1);
          let y2 = y;
          grow_y: while (y2 + 1 < s.y && area * (y2 + 2 - y) <= maxVolume) {
            for (let zi = z; zi <= z2; zi++)
              for (let xi = x; xi <= x2; xi++) if (dense[at(xi, y2 + 1, zi)] !== v) break grow_y;
            y2++;
          }
          for (let yi = y; yi <= y2; yi++)
            for (let zi = z; zi <= z2; zi++) for (let xi = x; xi <= x2; xi++) dense[at(xi, yi, zi)] = -1;
          out.push({
            min: { x: b.min.x + x, y: b.min.y + y, z: b.min.z + z },
            max: { x: b.min.x + x2, y: b.min.y + y2, z: b.min.z + z2 },
            block: v,
          });
        }
      }
    }
    return out;
  }

  /** RLE of palette indices over the box in y, z, x order (x fastest). Unset cells come out as -1. */
  toRuns(box: Box): string {
    const out: string[] = [];
    let last = -2, count = 0;
    for (let y = box.min.y; y <= box.max.y; y++)
      for (let z = box.min.z; z <= box.max.z; z++)
        for (let x = box.min.x; x <= box.max.x; x++) {
          const v = this.get(x, y, z);
          if (v === last) count++;
          else {
            if (count) out.push(count === 1 ? String(last) : `${last}*${count}`);
            last = v;
            count = 1;
          }
        }
    if (count) out.push(count === 1 ? String(last) : `${last}*${count}`);
    return out.join(",");
  }

  clone(): VoxelSet {
    return new VoxelSet().merge(this);
  }
}
