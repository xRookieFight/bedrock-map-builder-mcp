import { BlockSpec } from "../core/block.js";
import { Rng, Simplex } from "../core/noise.js";
import { Vec3 } from "../core/geometry.js";
import { VoxelSet } from "../core/voxels.js";
import { GenResult, result } from "./common.js";
import { ellipsoid, line } from "./shapes.js";

export type TreeKind = "oak" | "big_oak" | "spruce" | "birch" | "jungle" | "palm" | "cherry" | "dark_oak" | "dead" | "bush";

const leaves = (t: string): BlockSpec => ({ name: `minecraft:${t}_leaves`, states: { persistent_bit: true } });
const log = (t: string, axis: "x" | "y" | "z" = "y"): BlockSpec => ({ name: `minecraft:${t}_log`, states: { pillar_axis: axis } });

/** One tree with its trunk base at `at`. Sizes vary with the seed so a forest doesn't look stamped. */
export function tree(set: VoxelSet, kind: TreeKind, at: Vec3, seed: number, scale = 1): void {
  const rng = new Rng(seed);
  const s = Math.max(0.5, Math.min(3, scale));
  const put = (x: number, y: number, z: number, b: BlockSpec, overwrite = true) => {
    if (!overwrite && set.get(x, y, z) >= 0) return;
    set.set(x, y, z, b);
  };
  const canopy = (c: Vec3, r: number, t: string, squash = 0.7) =>
    ellipsoid(set, c, { x: r, y: r * squash, z: r }, () => leaves(t), {});
  const trunk = (h: number, t: string) => {
    for (let y = 0; y < h; y++) put(at.x, at.y + y, at.z, log(t));
  };
  switch (kind) {
    case "bush": {
      canopy({ x: at.x, y: at.y, z: at.z }, 1 + rng.int(0, 1) * s, "oak", 0.6);
      put(at.x, at.y, at.z, log("oak"));
      return;
    }
    case "oak":
    case "birch": {
      const h = Math.round((kind === "birch" ? 6 : 5) * s) + rng.int(0, 2);
      canopy({ x: at.x, y: at.y + h - 1, z: at.z }, Math.round(2.5 * s), kind, 0.8);
      trunk(h, kind);
      return;
    }
    case "big_oak":
    case "dark_oak": {
      const t = kind === "big_oak" ? "oak" : "dark_oak";
      const h = Math.round(9 * s) + rng.int(0, 3);
      trunk(h, t);
      if (kind === "dark_oak") for (const [dx, dz] of [[1, 0], [0, 1], [1, 1]]) for (let y = 0; y < h - 2; y++) put(at.x + dx, at.y + y, at.z + dz, log(t));
      const branches = 3 + rng.int(0, 2);
      for (let b = 0; b < branches; b++) {
        const a = (b / branches) * Math.PI * 2 + rng.next();
        const len = Math.round((3 + rng.int(0, 2)) * s);
        const by = at.y + Math.round(h * (0.55 + 0.3 * rng.next()));
        const end = { x: at.x + Math.round(Math.cos(a) * len), y: by + Math.round(len / 2), z: at.z + Math.round(Math.sin(a) * len) };
        canopy(end, Math.round(2.5 * s), t, 0.7);
        line(set, { x: at.x, y: by, z: at.z }, end, () => log(t, Math.abs(Math.cos(a)) > 0.7 ? "x" : Math.abs(Math.sin(a)) > 0.7 ? "z" : "y"));
      }
      canopy({ x: at.x, y: at.y + h, z: at.z }, Math.round(3.5 * s), t, 0.6);
      trunk(h, t);
      return;
    }
    case "spruce": {
      const h = Math.round(10 * s) + rng.int(0, 4);
      for (let y = 2; y <= h; y++) {
        const r = Math.max(0, Math.round(((h - y) / h) * 3.5 * s - ((y % 2) * 0.8)));
        for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) if (x * x + z * z <= r * r + 1) put(at.x + x, at.y + y, at.z + z, leaves("spruce"), false);
      }
      put(at.x, at.y + h + 1, at.z, leaves("spruce"));
      trunk(h, "spruce");
      return;
    }
    case "jungle": {
      const h = Math.round(14 * s) + rng.int(0, 5);
      trunk(h, "jungle");
      canopy({ x: at.x, y: at.y + h, z: at.z }, Math.round(4 * s), "jungle", 0.5);
      for (let y = 2; y < h; y += 2) if (rng.chance(0.4)) put(at.x + 1, at.y + y, at.z, { name: "minecraft:vine", states: { vine_direction_bits: 8 } }, false);
      return;
    }
    case "palm": {
      const h = Math.round(7 * s) + rng.int(0, 3);
      const lean = rng.pick([[1, 0], [-1, 0], [0, 1], [0, -1]]);
      let x = at.x, z = at.z;
      for (let y = 0; y < h; y++) {
        if (y === Math.floor(h / 2)) { x += lean[0]; z += lean[1]; }
        put(x, at.y + y, z, log("jungle"));
      }
      const top = { x, y: at.y + h, z };
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        for (let k = 1; k <= Math.round(3 * s); k++) put(top.x + dx * k, top.y - (k > 2 ? 1 : 0), top.z + dz * k, leaves("jungle"));
      }
      put(top.x, top.y, top.z, leaves("jungle"));
      return;
    }
    case "cherry": {
      const h = Math.round(5 * s) + rng.int(0, 2);
      trunk(h, "cherry");
      canopy({ x: at.x, y: at.y + h, z: at.z }, Math.round(3.5 * s), "cherry", 0.55);
      put(at.x, at.y + h - 1, at.z, log("cherry"));
      return;
    }
    case "dead": {
      const h = Math.round(5 * s) + rng.int(0, 3);
      for (let y = 0; y < h; y++) put(at.x, at.y + y, at.z, { name: "minecraft:stripped_oak_log", states: { pillar_axis: "y" } });
      for (let b = 0; b < 3; b++) {
        const a = rng.next() * Math.PI * 2;
        line(set, { x: at.x, y: at.y + h - 1 - b, z: at.z }, { x: at.x + Math.round(Math.cos(a) * 3), y: at.y + h + 1 - b, z: at.z + Math.round(Math.sin(a) * 3) }, () => ({ name: "minecraft:stripped_oak_log", states: { pillar_axis: "y" } }));
      }
      return;
    }
  }
}

export function rock(set: VoxelSet, at: Vec3, size: number, seed: number) {
  const n = new Simplex(seed);
  const r = Math.max(1, size);
  for (let x = -r; x <= r; x++)
    for (let y = -1; y <= r; y++)
      for (let z = -r; z <= r; z++) {
        const d = Math.hypot(x, y * 1.4, z) + n.noise3(x / 2, y / 2, z / 2) * 0.8;
        if (d <= r) set.set(at.x + x, at.y + y, at.z + z, n.noise3(x, y, z) > 0.3 ? "minecraft:mossy_cobblestone" : n.noise3(z, x, y) > 0 ? "minecraft:andesite" : "minecraft:stone");
      }
}

const PLANTS: BlockSpec[] = [
  { name: "minecraft:short_grass", states: {} },
  { name: "minecraft:short_grass", states: {} },
  { name: "minecraft:short_grass", states: {} },
  { name: "minecraft:fern", states: {} },
  { name: "minecraft:poppy", states: {} },
  { name: "minecraft:dandelion", states: {} },
  { name: "minecraft:azure_bluet", states: {} },
  { name: "minecraft:cornflower", states: {} },
  { name: "minecraft:oxeye_daisy", states: {} },
];

export interface ScatterOptions {
  kinds: (TreeKind | "rock" | "plants")[];
  /** Objects per 100 surface blocks. */
  density: number;
  /** Keep this far from each other, trees look awful when they merge. */
  spacing?: number;
  seed?: number;
  scale?: number;
}

/**
 * Drops trees, rocks and plants onto a surface. `surface(x, z)` returns the y of the ground block
 * (or null to skip), and `canGrow(x, z)` can veto spots like sand or water.
 */
export function scatter(area: { x1: number; z1: number; x2: number; z2: number }, surface: (x: number, z: number) => number | null, o: ScatterOptions, canGrow: (x: number, z: number) => boolean = () => true): GenResult {
  const r = result();
  const rng = new Rng(o.seed ?? 7);
  const spacing = Math.max(1, o.spacing ?? 5);
  const taken: { x: number; z: number }[] = [];
  const cells = (area.x2 - area.x1 + 1) * (area.z2 - area.z1 + 1);
  const count = Math.round((cells * o.density) / 100);
  let placed = 0;
  for (let i = 0; i < count * 3 && placed < count; i++) {
    const x = rng.int(area.x1, area.x2), z = rng.int(area.z1, area.z2);
    const y = surface(x, z);
    if (y === null || !canGrow(x, z)) continue;
    const kind = rng.pick(o.kinds);
    if (kind === "plants") {
      if (r.set.get(x, y + 1, z) < 0) r.set.set(x, y + 1, z, rng.pick(PLANTS));
      placed++;
      continue;
    }
    if (taken.some((t) => Math.abs(t.x - x) < spacing && Math.abs(t.z - z) < spacing)) continue;
    taken.push({ x, z });
    if (kind === "rock") rock(r.set, { x, y: y + 1, z }, 1 + rng.int(0, 2), rng.int(0, 1e9));
    else tree(r.set, kind, { x, y: y + 1, z }, rng.int(0, 1e9), o.scale ?? 1);
    placed++;
  }
  r.notes.push(`scattered ${placed} objects`);
  return r;
}
