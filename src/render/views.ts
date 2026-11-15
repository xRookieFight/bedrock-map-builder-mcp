import { HeightmapResult } from "../engine/backend.js";
import { Marker } from "../gen/common.js";
import { VoxelSet } from "../core/voxels.js";
import { Canvas } from "./png.js";
import { blockColor, isPartial } from "./colors.js";

type RGB = [number, number, number];

const MARKER_COLORS: Record<string, RGB> = {
  spawn: [255, 40, 40], checkpoint: [255, 215, 0], finish: [0, 200, 255], start: [0, 255, 120], chest: [255, 140, 0],
  boss: [180, 0, 255], portal: [255, 0, 200], door: [255, 255, 255], center: [255, 255, 0],
};

function shade(c: readonly number[], f: number): RGB {
  return [Math.min(255, Math.max(0, Math.round(c[0] * f))), Math.min(255, Math.max(0, Math.round(c[1] * f))), Math.min(255, Math.max(0, Math.round(c[2] * f)))];
}

function drawMarkers(cv: Canvas, markers: Marker[], toPx: (x: number, y: number, z: number) => [number, number], size: number) {
  for (const m of markers) {
    const [px, py] = toPx(m.pos.x, m.pos.y, m.pos.z);
    const c = MARKER_COLORS[m.kind] ?? [255, 255, 255];
    const r = Math.max(2, Math.round(size));
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const d = dx * dx + dy * dy;
      if (d <= r * r) cv.set(px + dx, py + dy, d >= (r - 1) * (r - 1) ? [0, 0, 0] : c);
    }
  }
}

/** Top down map: the highest block of each column, shaded by height so slopes and walls read clearly. */
export function renderTopDown(set: VoxelSet, opt: { maxSize?: number; markers?: Marker[] } = {}): { png: Buffer; scale: number; legend: string } {
  const b = set.bounds();
  if (!b) return { png: new Canvas(1, 1).png(), scale: 1, legend: "empty" };
  const w = b.max.x - b.min.x + 1, d = b.max.z - b.min.z + 1;
  const scale = Math.max(1, Math.min(16, Math.floor((opt.maxSize ?? 768) / Math.max(w, d))));
  const top = new Int32Array(w * d).fill(-1e9);
  const col: (readonly number[] | null)[] = new Array(w * d).fill(null);
  set.forEach((x, y, z, i) => {
    const k = (z - b.min.z) * w + (x - b.min.x);
    if (y <= top[k]) return;
    const c = blockColor(set.palette[i].name);
    if (!c) return;
    top[k] = y;
    col[k] = c;
  });
  const cv = new Canvas(w * scale, d * scale, [24, 24, 28, 255]);
  const span = Math.max(1, b.max.y - b.min.y);
  for (let z = 0; z < d; z++)
    for (let x = 0; x < w; x++) {
      const k = z * w + x;
      const c = col[k];
      if (!c) continue;
      const north = z > 0 ? top[k - w] : top[k];
      const hill = north > -1e8 ? Math.max(-0.25, Math.min(0.25, (top[k] - north) * 0.06)) : 0;
      const f = 0.75 + 0.35 * ((top[k] - b.min.y) / span) + hill;
      cv.rect(x * scale, z * scale, scale, scale, shade(c, f));
    }
  if (opt.markers) drawMarkers(cv, opt.markers, (x, _y, z) => [Math.round((x - b.min.x + 0.5) * scale), Math.round((z - b.min.z + 0.5) * scale)], scale * 0.8 + 1);
  return { png: cv.png(), scale, legend: `top down, north up, ${scale}px per block, x ${b.min.x}..${b.max.x}, z ${b.min.z}..${b.max.z}` };
}

/** Same idea from a world heightmap, for areas too big to read block by block. */
export function renderHeightmap(h: HeightmapResult, origin: { x: number; z: number }, opt: { maxSize?: number; markers?: Marker[] } = {}): Buffer {
  const scale = Math.max(1, Math.min(16, Math.floor((opt.maxSize ?? 768) / Math.max(h.width, h.depth))));
  const cv = new Canvas(h.width * scale, h.depth * scale, [24, 24, 28, 255]);
  const vals = h.heights.filter((v): v is number => v !== null);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  for (let z = 0; z < h.depth; z++)
    for (let x = 0; x < h.width; x++) {
      const k = z * h.width + x;
      const y = h.heights[k];
      const name = h.tops[k];
      if (y === null || !name) continue;
      const c = blockColor(name) ?? [255, 0, 255, 255];
      const north = z > 0 ? h.heights[k - h.width] ?? y : y;
      const f = 0.75 + 0.35 * ((y - lo) / Math.max(1, hi - lo)) + Math.max(-0.25, Math.min(0.25, (y - north) * 0.06));
      cv.rect(x * scale, z * scale, scale, scale, shade(c, f));
    }
  if (opt.markers) drawMarkers(cv, opt.markers, (x, _y, z) => [Math.round((x - origin.x + 0.5) * scale), Math.round((z - origin.z + 0.5) * scale)], scale * 0.8 + 1);
  return cv.png();
}

/**
 * Isometric view from the south east (or any of the four corners with `view`). Only cells with an open
 * face toward the camera get drawn, so even big builds render quickly.
 */
export function renderIsometric(set: VoxelSet, opt: { maxSize?: number; view?: number; markers?: Marker[] } = {}): { png: Buffer; legend: string } {
  const b = set.bounds();
  if (!b) return { png: new Canvas(1, 1).png(), legend: "empty" };
  const view = (((opt.view ?? 0) % 4) + 4) % 4;
  const w = b.max.x - b.min.x + 1, d = b.max.z - b.min.z + 1;
  // rotate into a local frame where the camera always sits at +x +z
  const rot = (x: number, z: number): [number, number] => {
    const lx = x - b.min.x, lz = z - b.min.z;
    switch (view) {
      case 1: return [lz, w - 1 - lx];
      case 2: return [w - 1 - lx, d - 1 - lz];
      case 3: return [d - 1 - lz, lx];
      default: return [lx, lz];
    }
  };
  const cells: number[] = [];
  const solidAt = (x: number, y: number, z: number) => {
    const i = set.get(x, y, z);
    if (i < 0) return false;
    const n = set.palette[i].name;
    const c = blockColor(n);
    return !!c && c[3] === 255 && !isPartial(n);
  };
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
  set.forEach((x, y, z, i) => {
    if (!blockColor(set.palette[i].name)) return;
    for (const [dx, dy, dz] of dirs) if (!solidAt(x + dx, y + dy, z + dz)) { cells.push(x, y, z, i); break; }
  });
  const h = b.max.y - b.min.y + 1;
  const [rw, rd] = view % 2 ? [d, w] : [w, d];
  const max = opt.maxSize ?? 900;
  const s = Math.max(1, Math.min(12, Math.floor(max / (rw + rd + h * 1.2))));
  const W = (rw + rd) * s * 2 + 4, H = (rw + rd) * s + h * s * 2 + s * 3 + 4;
  const cv = new Canvas(W, H, [24, 24, 28, 255]);
  const toPx = (x: number, y: number, z: number): [number, number] => {
    const [lx, lz] = rot(x, z);
    // standard 2:1 iso: x goes right and down, z goes left and down, y goes straight up
    return [(lx - lz) * s * 2 + rd * s * 2 + 2, (lx + lz) * s - (y - b.min.y) * s * 2 + h * s * 2 + s + 2];
  };
  const order: { k: number; idx: number }[] = [];
  for (let n = 0; n < cells.length; n += 4) {
    const [lx, lz] = rot(cells[n], cells[n + 2]);
    order.push({ k: lx + lz + (cells[n + 1] - b.min.y) * 0.999, idx: n });
  }
  order.sort((a, c) => a.k - c.k);
  for (const { idx } of order) {
    const x = cells[idx], y = cells[idx + 1], z = cells[idx + 2], pi = cells[idx + 3];
    const name = set.palette[pi].name;
    const c = blockColor(name)!;
    const [px, py] = toPx(x, y, z);
    const partial = isPartial(name);
    const top = c[3] < 255 ? [...shade(c, 1.1), c[3]] as [number, number, number, number] : shade(c, 1.1);
    const left = c[3] < 255 ? [...shade(c, 0.8), c[3]] as [number, number, number, number] : shade(c, 0.8);
    const right = c[3] < 255 ? [...shade(c, 0.62), c[3]] as [number, number, number, number] : shade(c, 0.62);
    const drop = partial ? s : 0;
    // top diamond
    for (let r = 0; r < s; r++) {
      const half = (r + 1) * 2;
      for (let q = -half; q < half; q++) cv.set(px + q, py - s + r + drop, top);
      for (let q = -half; q < half; q++) cv.set(px + q, py + s - 1 - r + drop, top);
    }
    // side faces
    for (let r = 0; r < s * 2 - drop; r++) {
      for (let q = 0; q < s * 2; q++) {
        const off = Math.floor(q / 2);
        cv.set(px - s * 2 + q, py + off + r + drop, left);
        cv.set(px + q, py + s - off + r + drop - 1, right);
      }
    }
  }
  if (opt.markers) drawMarkers(cv, opt.markers, toPx, s + 1);
  const names = ["south east", "south west", "north west", "north east"];
  return { png: cv.png(), legend: `isometric from the ${names[view]}, ${set.size} blocks, ${cells.length / 4} visible` };
}

/** Vertical cut through the set at one x or z, like a blueprint elevation. */
export function renderSlice(set: VoxelSet, axis: "x" | "z", at: number, maxSize = 768): { png: Buffer; legend: string } {
  const b = set.bounds();
  if (!b) return { png: new Canvas(1, 1).png(), legend: "empty" };
  const along = axis === "x" ? [b.min.z, b.max.z] : [b.min.x, b.max.x];
  const w = along[1] - along[0] + 1, h = b.max.y - b.min.y + 1;
  const s = Math.max(1, Math.min(16, Math.floor(maxSize / Math.max(w, h))));
  const cv = new Canvas(w * s, h * s, [24, 24, 28, 255]);
  for (let u = 0; u < w; u++)
    for (let y = 0; y < h; y++) {
      const x = axis === "x" ? at : along[0] + u, z = axis === "x" ? along[0] + u : at;
      const i = set.get(x, b.min.y + y, z);
      if (i < 0) continue;
      const c = blockColor(set.palette[i].name);
      if (c) cv.rect(u * s, (h - 1 - y) * s, s, s, c);
    }
  return { png: cv.png(), legend: `slice at ${axis}=${at}, looking ${axis === "x" ? "from the east" : "from the south"}, ${s}px per block` };
}
