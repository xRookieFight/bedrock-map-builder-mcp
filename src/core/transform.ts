import { BlockSpec, StateValue } from "./block.js";
import { Vec3 } from "./geometry.js";
import { VoxelSet } from "./voxels.js";

type Dir = "north" | "east" | "south" | "west";
const CW: Dir[] = ["north", "east", "south", "west"];

function rotDir(d: Dir, turns: number): Dir {
  return CW[(CW.indexOf(d) + turns + 400) % 4];
}

function mirDir(d: Dir, axis: "x" | "z"): Dir {
  if (axis === "x") return d === "east" ? "west" : d === "west" ? "east" : d;
  return d === "north" ? "south" : d === "south" ? "north" : d;
}

// yeah, Bedrock has like five ways to say "which way is this facing". each table maps the raw value to a
// compass direction and back so rotate/mirror only has to think in compass terms
const WEIRDO: Record<number, Dir> = { 0: "east", 1: "west", 2: "south", 3: "north" };
const FACING6: Record<number, Dir | "down" | "up"> = { 0: "down", 1: "up", 2: "north", 3: "south", 4: "west", 5: "east" };
// legacy "direction" on doors, gates, beds and friends goes south, west, north, east
const DIRECTION4: Record<number, Dir> = { 0: "south", 1: "west", 2: "north", 3: "east" };

function invert<K extends string | number, V extends string>(m: Record<K, V>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(m)) out[v as string] = Number(k);
  return out;
}
const WEIRDO_INV = invert(WEIRDO);
const FACING6_INV = invert(FACING6);
const DIRECTION4_INV = invert(DIRECTION4);

type DirFn = (d: Dir) => Dir;

function mapState(key: string, value: StateValue, f: DirFn, swapXZ: boolean, signFn: (n: number) => number): StateValue {
  switch (key) {
    case "weirdo_direction":
      return typeof value === "number" && WEIRDO[value] ? WEIRDO_INV[f(WEIRDO[value])] : value;
    case "facing_direction": {
      if (typeof value !== "number") return value;
      const d = FACING6[value];
      return d && d !== "up" && d !== "down" ? FACING6_INV[f(d)] : value;
    }
    case "direction":
      return typeof value === "number" && DIRECTION4[value] ? DIRECTION4_INV[f(DIRECTION4[value])] : value;
    case "minecraft:cardinal_direction":
    case "minecraft:facing_direction":
    case "minecraft:block_face":
    case "torch_facing_direction":
      return typeof value === "string" && CW.includes(value as Dir) ? f(value as Dir) : value;
    case "pillar_axis":
      return swapXZ && (value === "x" || value === "z") ? (value === "x" ? "z" : "x") : value;
    case "ground_sign_direction":
      return typeof value === "number" ? signFn(value) : value;
    default:
      return value;
  }
}

function mapBlock(b: BlockSpec, f: DirFn, swapXZ: boolean, signFn: (n: number) => number): BlockSpec {
  const states: Record<string, StateValue> = {};
  for (const [k, v] of Object.entries(b.states)) states[k] = mapState(k, v, f, swapXZ, signFn);
  return { name: b.name, states };
}

/** Rotates a block's facing states clockwise (seen from above) by `turns` quarter turns. */
export function rotateBlock(b: BlockSpec, turns: number): BlockSpec {
  const t = ((turns % 4) + 4) % 4;
  if (!t) return b;
  return mapBlock(b, (d) => rotDir(d, t), t % 2 === 1, (n) => (n + 4 * t) % 16);
}

export function mirrorBlock(b: BlockSpec, axis: "x" | "z"): BlockSpec {
  // the 16 step sign rotation starts at south and goes clockwise, so mirroring x is 16-n and z is 8-n
  return mapBlock(b, (d) => mirDir(d, axis), false, (n) => (axis === "x" ? (16 - n) % 16 : (24 - n) % 16));
}

export interface TransformOptions {
  /** Quarter turns clockwise seen from above. */
  rotate?: number;
  mirror?: "x" | "z" | "none";
  /** Point the rotation and mirror happen around. Defaults to the min corner of the set. */
  pivot?: Vec3;
  /** Added after rotating. */
  offset?: Vec3;
}

/** Returns a new set rotated, mirrored and moved, block states included. */
export function transformSet(src: VoxelSet, opt: TransformOptions): VoxelSet {
  const b = src.bounds();
  const out = new VoxelSet();
  if (!b) return out;
  const p = opt.pivot ?? b.min;
  const t = (((opt.rotate ?? 0) % 4) + 4) % 4;
  const m = opt.mirror && opt.mirror !== "none" ? opt.mirror : null;
  const o = opt.offset ?? { x: 0, y: 0, z: 0 };
  const remap = src.palette.map((blk) => {
    let r = m ? mirrorBlock(blk, m) : blk;
    r = rotateBlock(r, t);
    return out.indexOf(r);
  });
  src.forEach((x, y, z, i) => {
    let dx = x - p.x, dz = z - p.z;
    if (m === "x") dx = -dx;
    if (m === "z") dz = -dz;
    for (let k = 0; k < t; k++) {
      // clockwise from above with +x east and +z south: (x, z) -> (-z, x)
      const nx = -dz;
      dz = dx;
      dx = nx;
    }
    out.set(p.x + dx + o.x, y + o.y, p.z + dz + o.z, remap[i]);
  });
  return out;
}

/** Nearest neighbour scale, fine for blocky upscales like 2x or 3x of a small build. */
export function scaleSet(src: VoxelSet, factor: Vec3, anchor?: Vec3): VoxelSet {
  const out = new VoxelSet();
  const b = src.bounds();
  if (!b) return out;
  const a = anchor ?? b.min;
  const remap = src.palette.map((blk) => out.indexOf(blk));
  const s = b.max;
  const nx = Math.round((s.x - b.min.x + 1) * factor.x);
  const ny = Math.round((s.y - b.min.y + 1) * factor.y);
  const nz = Math.round((s.z - b.min.z + 1) * factor.z);
  for (let y = 0; y < ny; y++)
    for (let z = 0; z < nz; z++)
      for (let x = 0; x < nx; x++) {
        const i = src.get(b.min.x + Math.floor(x / factor.x), b.min.y + Math.floor(y / factor.y), b.min.z + Math.floor(z / factor.z));
        if (i >= 0) out.set(a.x + x, a.y + y, a.z + z, remap[i]);
      }
  return out;
}
