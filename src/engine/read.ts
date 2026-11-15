import { Box, Dimension, Vec3, assertBoxInWorld, boxVolume, tileBox } from "../core/geometry.js";
import { VoxelSet } from "../core/voxels.js";
import { Backend, HeightmapResult, UnsupportedError } from "./backend.js";
import { newId } from "./project.js";

// reads are one getBlock per cell on the script side, so keep tiles small enough to answer in a few seconds
const READ_TILE: Vec3 = { x: 32, y: 128, z: 32 };
export const MAX_READ_VOLUME = 8_000_000;

/** Reads a box of any size: loads each tile, reads it, releases it, and stitches the results together. */
export async function readRegion(backend: Backend, dim: Dimension, box: Box): Promise<{ set: VoxelSet; waterlogged: Vec3[] }> {
  if (!backend.caps.read) throw new UnsupportedError(`${backend.kind} connections can't read blocks back, use a BDS world for this`);
  assertBoxInWorld(box, dim);
  if (boxVolume(box) > MAX_READ_VOLUME) {
    throw new UnsupportedError(`reading ${boxVolume(box)} blocks at once is too much, stay under ${MAX_READ_VOLUME} or read in parts`);
  }
  const out = new VoxelSet();
  const waterlogged: Vec3[] = [];
  const job = newId("r");
  let n = 0;
  for (const t of tileBox(box, READ_TILE)) {
    const release = backend.caps.load ? await backend.ensureLoaded(dim, t, `${job}_${n++}`) : undefined;
    try {
      const r = await backend.read(dim, t);
      out.merge(r.set);
      waterlogged.push(...r.waterlogged);
    } finally {
      await release?.();
    }
  }
  return { set: out, waterlogged };
}

/** Top block per column over an xz rectangle, loading as it goes. */
export async function readHeightmap(backend: Backend, dim: Dimension, x1: number, z1: number, x2: number, z2: number): Promise<HeightmapResult> {
  if (!backend.caps.read) throw new UnsupportedError(`${backend.kind} connections can't read the terrain`);
  const minX = Math.min(x1, x2), maxX = Math.max(x1, x2), minZ = Math.min(z1, z2), maxZ = Math.max(z1, z2);
  const w = maxX - minX + 1, d = maxZ - minZ + 1;
  if (w * d > 1_000_000) throw new UnsupportedError("heightmaps over 1000x1000 columns are too big for one call");
  const heights: (number | null)[] = new Array(w * d).fill(null);
  const tops: (string | null)[] = new Array(w * d).fill(null);
  const job = newId("h");
  let n = 0;
  for (const t of tileBox({ min: { x: minX, y: 0, z: minZ }, max: { x: maxX, y: 0, z: maxZ } }, { x: 64, y: 1, z: 64 })) {
    const loadBox = { min: { x: t.min.x, y: 0, z: t.min.z }, max: { x: t.max.x, y: 0, z: t.max.z } };
    const release = backend.caps.load ? await backend.ensureLoaded(dim, loadBox, `${job}_${n++}`) : undefined;
    try {
      const r = await backend.heightmap(dim, t.min.x, t.min.z, t.max.x, t.max.z);
      for (let z = 0; z < r.depth; z++)
        for (let x = 0; x < r.width; x++) {
          const gi = (t.min.z - minZ + z) * w + (t.min.x - minX + x);
          heights[gi] = r.heights[z * r.width + x];
          tops[gi] = r.tops[z * r.width + x];
        }
    } finally {
      await release?.();
    }
  }
  return { heights, tops, width: w, depth: d };
}
