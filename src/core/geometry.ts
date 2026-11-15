export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Inclusive axis aligned box, the same convention /fill uses. */
export interface Box {
  min: Vec3;
  max: Vec3;
}

export type Dimension = "overworld" | "nether" | "the_end";

export const DIMENSIONS: Dimension[] = ["overworld", "nether", "the_end"];

/** Vanilla build limits per dimension. Bedrock clamps commands to these. */
export const HEIGHT_LIMITS: Record<Dimension, { minY: number; maxY: number }> = {
  overworld: { minY: -64, maxY: 319 },
  nether: { minY: 0, maxY: 127 },
  the_end: { minY: 0, maxY: 255 },
};

// past roughly 30 million the game stops generating and movement gets weird, so treat it as the hard edge
export const HORIZONTAL_LIMIT = 30_000_000;

/** Max blocks a single /fill or Dimension.fillBlocks may touch, measured on BDS 1.26.61. */
export const MAX_FILL_VOLUME = 32768;

/** Max structure size for /structure save and StructureManager.createFromWorld. */
export const MAX_STRUCTURE_SIZE: Vec3 = { x: 64, y: 384, z: 64 };

export function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function boxOf(a: Vec3, b: Vec3): Box {
  return {
    min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) },
    max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) },
  };
}

export function boxSize(b: Box): Vec3 {
  return { x: b.max.x - b.min.x + 1, y: b.max.y - b.min.y + 1, z: b.max.z - b.min.z + 1 };
}

export function boxVolume(b: Box): number {
  const s = boxSize(b);
  return s.x * s.y * s.z;
}

export function boxContains(b: Box, p: Vec3): boolean {
  return p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z;
}

export function boxIntersect(a: Box, b: Box): Box | null {
  const min = { x: Math.max(a.min.x, b.min.x), y: Math.max(a.min.y, b.min.y), z: Math.max(a.min.z, b.min.z) };
  const max = { x: Math.min(a.max.x, b.max.x), y: Math.min(a.max.y, b.max.y), z: Math.min(a.max.z, b.max.z) };
  if (min.x > max.x || min.y > max.y || min.z > max.z) return null;
  return { min, max };
}

export function boxUnion(a: Box, b: Box): Box {
  return {
    min: { x: Math.min(a.min.x, b.min.x), y: Math.min(a.min.y, b.min.y), z: Math.min(a.min.z, b.min.z) },
    max: { x: Math.max(a.max.x, b.max.x), y: Math.max(a.max.y, b.max.y), z: Math.max(a.max.z, b.max.z) },
  };
}

export function translateBox(b: Box, d: Vec3): Box {
  return {
    min: { x: b.min.x + d.x, y: b.min.y + d.y, z: b.min.z + d.z },
    max: { x: b.max.x + d.x, y: b.max.y + d.y, z: b.max.z + d.z },
  };
}

/** Splits a box into tiles no bigger than `size`. Tiles come out in x, z, y order so neighbours stay close. */
export function tileBox(b: Box, size: Vec3): Box[] {
  const out: Box[] = [];
  for (let x = b.min.x; x <= b.max.x; x += size.x) {
    for (let z = b.min.z; z <= b.max.z; z += size.z) {
      for (let y = b.min.y; y <= b.max.y; y += size.y) {
        out.push({
          min: { x, y, z },
          max: {
            x: Math.min(x + size.x - 1, b.max.x),
            y: Math.min(y + size.y - 1, b.max.y),
            z: Math.min(z + size.z - 1, b.max.z),
          },
        });
      }
    }
  }
  return out;
}

export class GeometryError extends Error {}

/** Throws a readable error when a box leaves the dimension's build range or the horizontal world edge. */
export function assertBoxInWorld(b: Box, dim: Dimension): void {
  const lim = HEIGHT_LIMITS[dim];
  if (!lim) throw new GeometryError(`unknown dimension "${dim}"`);
  for (const v of [b.min, b.max]) {
    for (const k of ["x", "y", "z"] as const) {
      if (!Number.isInteger(v[k])) throw new GeometryError(`coordinate ${k}=${v[k]} is not an integer`);
    }
  }
  if (b.min.y < lim.minY || b.max.y > lim.maxY) {
    throw new GeometryError(
      `y range ${b.min.y}..${b.max.y} is outside ${dim} build limits ${lim.minY}..${lim.maxY}`,
    );
  }
  const h = Math.max(Math.abs(b.min.x), Math.abs(b.max.x), Math.abs(b.min.z), Math.abs(b.max.z));
  if (h > HORIZONTAL_LIMIT) throw new GeometryError(`horizontal coordinate ${h} is beyond ±${HORIZONTAL_LIMIT}`);
}

export function clampBoxToWorld(b: Box, dim: Dimension): Box | null {
  const lim = HEIGHT_LIMITS[dim];
  return boxIntersect(b, {
    min: { x: -HORIZONTAL_LIMIT, y: lim.minY, z: -HORIZONTAL_LIMIT },
    max: { x: HORIZONTAL_LIMIT, y: lim.maxY, z: HORIZONTAL_LIMIT },
  });
}

export function formatBox(b: Box): string {
  return `${b.min.x} ${b.min.y} ${b.min.z} -> ${b.max.x} ${b.max.y} ${b.max.z}`;
}
