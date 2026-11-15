import { AIR, BlockSpec, parseBlock } from "../core/block.js";
import { Dimension, HEIGHT_LIMITS } from "../core/geometry.js";
import { Simplex } from "../core/noise.js";
import { VoxelSet } from "../core/voxels.js";
import { GenResult, result } from "./common.js";
import { rasterPath } from "./shapes.js";

export type TerrainKind = "plains" | "hills" | "mountains" | "islands" | "dunes" | "plateau" | "canyon" | "flat";

export interface Area {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
}

export interface TerrainOptions {
  kind: TerrainKind;
  baseY: number;
  /** Height variation in blocks above or below baseY. */
  amplitude?: number;
  /** Bigger means wider features. */
  scale?: number;
  seed?: number;
  waterLevel?: number | null;
  /** Columns are filled down to this y, so the terrain is solid but doesn't dig to bedrock. */
  bottomY?: number;
  /** Air is written above the new surface up to here, which flattens whatever was there. */
  clearToY?: number;
  /** Lerp toward these heights near the border, usually the current heightmap, so the edit blends in. */
  edge?: { heights: (number | null)[]; blend: number };
  materials?: Partial<SurfaceMaterials>;
  dim?: Dimension;
}

export interface SurfaceMaterials {
  top: string;
  under: string;
  stone: string;
  beach: string;
  snow: string;
  snowLine: number;
  mountainTop: string;
  seabed: string;
}

const DEFAULT_MATERIALS: SurfaceMaterials = {
  top: "grass_block",
  under: "dirt",
  stone: "stone",
  beach: "sand",
  snow: "snow",
  snowLine: 140,
  mountainTop: "stone",
  seabed: "gravel",
};

export const clampY = (y: number, dim: Dimension = "overworld") => Math.max(HEIGHT_LIMITS[dim].minY, Math.min(HEIGHT_LIMITS[dim].maxY, y));

/** Height for one column. Exported so previews and tests can sample it without building blocks. */
export function terrainHeight(o: TerrainOptions, n: Simplex, x: number, z: number, area: Area): number {
  const amp = o.amplitude ?? (o.kind === "mountains" ? 60 : o.kind === "hills" ? 16 : o.kind === "plains" ? 4 : o.kind === "islands" ? 14 : 10);
  const sc = (o.scale ?? 1) * (o.kind === "mountains" ? 140 : o.kind === "plains" ? 120 : 70);
  const u = x / sc, v = z / sc;
  let h: number;
  switch (o.kind) {
    case "flat":
      h = 0;
      break;
    case "plains":
      h = n.fbm2(u, v, 3) * amp;
      break;
    case "hills":
      h = n.fbm2(u, v, 5) * amp;
      break;
    case "mountains": {
      const ridge = n.ridged2(u, v, 5);
      const mask = (n.fbm2(u * 0.4 + 9, v * 0.4 + 9, 2) + 1) / 2;
      h = (ridge * mask * 1.4 - 0.15) * amp;
      break;
    }
    case "islands": {
      const cx = (area.x1 + area.x2) / 2, cz = (area.z1 + area.z2) / 2;
      const rx = (area.x2 - area.x1) / 2, rz = (area.z2 - area.z1) / 2;
      const d = Math.hypot((x - cx) / rx, (z - cz) / rz);
      const blob = n.fbm2(u, v, 4) * 0.6 + 0.55 - d * 0.9;
      h = blob * amp * 1.6;
      break;
    }
    case "dunes": {
      const wave = Math.sin(u * 9 + n.noise2(u * 2, v * 2) * 2.5);
      h = (wave * 0.5 + n.fbm2(u, v, 2) * 0.5) * amp;
      break;
    }
    case "plateau": {
      const raw = n.fbm2(u, v, 4);
      h = (raw > 0.1 ? 1 : raw < -0.05 ? -0.2 : (raw + 0.05) / 0.15) * amp;
      h = Math.round(h / 4) * 4;
      break;
    }
    case "canyon": {
      const c = Math.abs(n.fbm2(u * 0.7, v * 0.7, 3));
      h = (c < 0.08 ? -1.4 + c * 8 : 0.6 + n.fbm2(u, v, 3) * 0.3) * amp;
      h = Math.round(h / 3) * 3;
      break;
    }
  }
  return o.baseY + h;
}

/**
 * Fills an area with new terrain columns. Tops change with height (beach near water, snow above the
 * snow line, bare stone on steep slopes) and the borders can blend into the existing ground.
 */
export function generateTerrain(area: Area, o: TerrainOptions): GenResult {
  const m = { ...DEFAULT_MATERIALS, ...(o.materials ?? {}) };
  const dim = o.dim ?? "overworld";
  const n = new Simplex(o.seed ?? 1);
  const r = result();
  const set = r.set;
  const w = area.x2 - area.x1 + 1, d = area.z2 - area.z1 + 1;
  const H = new Float64Array(w * d);
  for (let z = 0; z < d; z++)
    for (let x = 0; x < w; x++) {
      let h = terrainHeight(o, n, area.x1 + x, area.z1 + z, area);
      if (o.edge) {
        const e = o.edge.heights[z * w + x];
        const dist = Math.min(x, z, w - 1 - x, d - 1 - z);
        const t = Math.min(1, dist / Math.max(1, o.edge.blend));
        const s = t * t * (3 - 2 * t);
        if (e !== null && e !== undefined) h = e + (h - e) * s;
      }
      H[z * w + x] = clampY(Math.round(h), dim);
    }
  const top = parseBlock(m.top), under = parseBlock(m.under), stone = parseBlock(m.stone);
  const beach = parseBlock(m.beach), snow = parseBlock(m.snow), seabed = parseBlock(m.seabed), peak = parseBlock(m.mountainTop);
  const water = parseBlock("water");
  const wl = o.waterLevel ?? null;
  const bottom = clampY(o.bottomY ?? Math.min(...H) - 6, dim);
  const clearTo = o.clearToY !== undefined ? clampY(o.clearToY, dim) : undefined;
  for (let z = 0; z < d; z++)
    for (let x = 0; x < w; x++) {
      const h = H[z * w + x];
      const at = (dx: number, dz: number) => H[Math.min(d - 1, Math.max(0, z + dz)) * w + Math.min(w - 1, Math.max(0, x + dx))];
      const slope = Math.max(Math.abs(at(1, 0) - at(-1, 0)), Math.abs(at(0, 1) - at(0, -1))) / 2;
      const wx = area.x1 + x, wz = area.z1 + z;
      let surface: BlockSpec = top;
      if (wl !== null && h <= wl + 1) surface = h < wl ? seabed : beach;
      else if (h >= m.snowLine) surface = snow;
      else if (slope >= 2.2) surface = h > m.snowLine - 20 ? peak : stone;
      for (let y = bottom; y <= h; y++) {
        const depth = h - y;
        let b: BlockSpec = stone;
        if (depth === 0) b = surface;
        else if (depth <= 3 && surface !== stone && surface !== peak) b = surface === beach || surface === seabed ? beach : under;
        set.set(wx, y, wz, b);
      }
      if (wl !== null) for (let y = h + 1; y <= wl; y++) set.set(wx, y, wz, water);
      if (clearTo !== undefined) for (let y = Math.max(h, wl ?? -1e9) + 1; y <= clearTo; y++) set.set(wx, y, wz, AIR);
    }
  r.notes.push(`${o.kind} terrain ${w}x${d}, heights ${Math.min(...H)}..${Math.max(...H)}`);
  return r;
}

export type SculptMode = "raise" | "lower" | "flatten" | "smooth" | "level";

export interface SculptOptions {
  mode: SculptMode;
  center: { x: number; z: number };
  radius: number;
  /** Blocks to raise or lower at the center (raise, lower). */
  amount?: number;
  /** Target height for flatten and level. */
  targetY?: number;
  /** 0 is a hard edge, 1 fades over the whole radius. */
  falloff?: number;
  square?: boolean;
}

/**
 * Turns a heightmap edit into column writes. Raised columns reuse the column's own top block so grass stays
 * grass and sand stays sand, lowered columns get air above the new top.
 */
export function sculpt(heights: { heights: (number | null)[]; tops: (string | null)[]; width: number; depth: number }, origin: { x: number; z: number }, o: SculptOptions, dim: Dimension = "overworld"): GenResult {
  const r = result();
  const set = r.set;
  const { width: w, depth: d } = heights;
  const R = Math.max(1, o.radius);
  const fall = Math.max(0, Math.min(1, o.falloff ?? 0.5));
  const get = (x: number, z: number) => heights.heights[Math.min(d - 1, Math.max(0, z)) * w + Math.min(w - 1, Math.max(0, x))];
  let changed = 0;
  for (let z = 0; z < d; z++)
    for (let x = 0; x < w; x++) {
      const wx = origin.x + x, wz = origin.z + z;
      const h = heights.heights[z * w + x];
      if (h === null) continue;
      const dist = o.square ? Math.max(Math.abs(wx - o.center.x), Math.abs(wz - o.center.z)) : Math.hypot(wx - o.center.x, wz - o.center.z);
      if (dist > R) continue;
      const inner = R * (1 - fall);
      const k = dist <= inner ? 1 : 1 - (dist - inner) / Math.max(1e-6, R - inner);
      const s = k * k * (3 - 2 * k);
      let target = h;
      switch (o.mode) {
        case "raise": target = h + (o.amount ?? 5) * s; break;
        case "lower": target = h - (o.amount ?? 5) * s; break;
        case "flatten":
        case "level": target = h + ((o.targetY ?? h) - h) * s; break;
        case "smooth": {
          let sum = 0, cnt = 0;
          for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
            const v = get(x + dx, z + dz);
            if (v !== null) { sum += v; cnt++; }
          }
          target = h + (sum / cnt - h) * s;
          break;
        }
      }
      const t = clampY(Math.round(target), dim);
      if (t === h) continue;
      changed++;
      const topName = heights.tops[z * w + x] ?? "minecraft:grass_block";
      const topBlock = parseBlock(/water|lava/.test(topName) ? "minecraft:stone" : topName);
      const fillUnder = /grass|mycelium|podzol/.test(topName) ? parseBlock("dirt") : topBlock;
      if (t > h) {
        for (let y = h; y < t; y++) set.set(wx, y, wz, fillUnder);
        set.set(wx, t, wz, topBlock);
      } else {
        for (let y = t + 1; y <= h; y++) set.set(wx, y, wz, AIR);
        set.set(wx, t, wz, topBlock);
      }
    }
  r.notes.push(`${o.mode}: ${changed} columns changed`);
  return r;
}

export interface RiverOptions {
  points: { x: number; z: number }[];
  surfaceY: number;
  width?: number;
  depth?: number;
  meander?: number;
  seed?: number;
}

/** Carves a riverbed along a path with sloped banks and fills it with water up to surfaceY - 1. */
export function river(o: RiverOptions): GenResult {
  const r = result();
  const set = r.set;
  const W = Math.max(1, o.width ?? 7), D = Math.max(1, o.depth ?? 3);
  const n = new Simplex(o.seed ?? 3);
  const mz = o.meander ?? 4;
  const path = rasterPath(o.points);
  const water = parseBlock("water"), sand = parseBlock("sand"), gravel = parseBlock("gravel");
  path.forEach((p, i) => {
    const off = n.noise2(i / 40, 0.5) * mz;
    const cx = p.x + -p.dz * off, cz = p.z + p.dx * off;
    const R = W / 2 + 2;
    for (let dx = -Math.ceil(R); dx <= Math.ceil(R); dx++)
      for (let dz = -Math.ceil(R); dz <= Math.ceil(R); dz++) {
        const dist = Math.hypot(dx, dz);
        if (dist > R) continue;
        const x = Math.round(cx + dx), z = Math.round(cz + dz);
        const t = Math.max(0, 1 - dist / (W / 2));
        const bed = Math.round(o.surfaceY - 1 - D * Math.sqrt(t));
        if (dist <= W / 2) {
          for (let y = bed + 1; y <= o.surfaceY + 2; y++) set.set(x, y, z, y <= o.surfaceY - 1 ? water : AIR);
          set.set(x, bed, z, n.noise2(x / 3, z / 3) > 0.2 ? gravel : sand);
        } else if (set.get(x, o.surfaceY - 1, z) < 0) {
          set.set(x, o.surfaceY - 1, z, sand);
          for (let y = o.surfaceY; y <= o.surfaceY + 2; y++) if (set.get(x, y, z) < 0) set.set(x, y, z, AIR);
        }
      }
  });
  r.notes.push(`river ${path.length} blocks long`);
  return r;
}

/** Bowl shaped lake with a noisy shore. */
export function lake(center: { x: number; y: number; z: number }, radius: number, depth: number, seed = 5, liquid = "water"): GenResult {
  const r = result();
  const n = new Simplex(seed);
  const fluid = parseBlock(liquid);
  const shore = parseBlock(liquid === "lava" ? "basalt" : "sand");
  const R = Math.ceil(radius * 1.3);
  for (let dx = -R; dx <= R; dx++)
    for (let dz = -R; dz <= R; dz++) {
      const a = Math.atan2(dz, dx);
      const edge = radius * (1 + 0.25 * n.noise2(Math.cos(a) * 2, Math.sin(a) * 2));
      const dist = Math.hypot(dx, dz);
      const x = center.x + dx, z = center.z + dz;
      if (dist <= edge) {
        const bed = Math.round(center.y - 1 - depth * Math.sqrt(1 - dist / edge));
        r.set.set(x, bed, z, shore);
        for (let y = bed + 1; y <= center.y + 3; y++) r.set.set(x, y, z, y < center.y ? fluid : AIR);
      } else if (dist <= edge + 2) r.set.set(x, center.y - 1, z, shore);
    }
  return r;
}

/** Worm tunnels through solid ground. Only carves, so pair it with an area that's already underground. */
export function caves(area: Area, yMin: number, yMax: number, o: { count?: number; length?: number; radius?: number; seed?: number; lavaBelow?: number } = {}): GenResult {
  const r = result();
  const n = new Simplex(o.seed ?? 11);
  const count = o.count ?? 4, len = o.length ?? 120, rad = o.radius ?? 2.5;
  const air = AIR, lava = parseBlock("lava");
  for (let c = 0; c < count; c++) {
    let x = area.x1 + ((area.x2 - area.x1) * (c + 0.5)) / count;
    let z = (area.z1 + area.z2) / 2 + n.noise2(c, 0) * (area.z2 - area.z1) * 0.3;
    let y = (yMin + yMax) / 2;
    let yaw = n.noise2(c, 1) * Math.PI * 2, pitch = 0;
    for (let i = 0; i < len; i++) {
      yaw += n.noise2(c * 10, i / 15) * 0.25;
      pitch = n.noise2(c * 10 + 5, i / 20) * 0.5;
      x += Math.cos(yaw) * Math.cos(pitch);
      z += Math.sin(yaw) * Math.cos(pitch);
      y = Math.max(yMin + rad, Math.min(yMax - rad, y + Math.sin(pitch)));
      if (x < area.x1 || x > area.x2 || z < area.z1 || z > area.z2) break;
      const rr = rad * (0.8 + 0.5 * (n.noise2(i / 10, c) + 1) / 2);
      for (let dx = -Math.ceil(rr); dx <= Math.ceil(rr); dx++)
        for (let dy = -Math.ceil(rr); dy <= Math.ceil(rr); dy++)
          for (let dz = -Math.ceil(rr); dz <= Math.ceil(rr); dz++) {
            if (dx * dx + dy * dy * 1.6 + dz * dz > rr * rr) continue;
            const yy = Math.round(y + dy);
            r.set.set(Math.round(x + dx), yy, Math.round(z + dz), o.lavaBelow !== undefined && yy <= o.lavaBelow ? lava : air);
          }
    }
  }
  r.notes.push(`${count} cave tunnels`);
  return r;
}

/** Single mountain or volcano with ridged flanks, centred on a point. */
export function mountain(center: { x: number; y: number; z: number }, radius: number, height: number, o: { seed?: number; volcano?: boolean; snowLine?: number } = {}): GenResult {
  const n = new Simplex(o.seed ?? 21);
  const r = result();
  const R = Math.ceil(radius);
  const snowLine = o.snowLine ?? center.y + height * 0.75;
  for (let dx = -R; dx <= R; dx++)
    for (let dz = -R; dz <= R; dz++) {
      const dist = Math.hypot(dx, dz) / radius;
      if (dist > 1) continue;
      const ridge = n.ridged2(dx / 25, dz / 25, 4);
      let h = Math.pow(1 - dist, 1.6) * height * (0.75 + 0.35 * ridge);
      if (o.volcano && dist < 0.15) h = height * (0.75 - (0.15 - dist) * 2);
      const top = Math.round(center.y + h);
      const x = center.x + dx, z = center.z + dz;
      for (let y = center.y; y <= top; y++) {
        let b = "minecraft:stone";
        if (o.volcano) b = y === top && dist < 0.15 ? "minecraft:lava" : dist < 0.4 ? "minecraft:basalt" : "minecraft:blackstone";
        else if (y === top) b = top >= snowLine ? "minecraft:snow" : dist > 0.7 ? "minecraft:grass_block" : "minecraft:stone";
        else if (top - y <= 2 && !o.volcano && dist > 0.7) b = "minecraft:dirt";
        r.set.set(x, y, z, b);
      }
    }
  r.notes.push(`${o.volcano ? "volcano" : "mountain"} ${Math.round(radius * 2)} wide, ${height} tall`);
  return r;
}

/** Writes air over a box, the "clear the site" step before a build. */
export function clear(set: VoxelSet, area: Area, y1: number, y2: number) {
  for (let y = y1; y <= y2; y++) for (let z = area.z1; z <= area.z2; z++) for (let x = area.x1; x <= area.x2; x++) set.set(x, y, z, AIR);
}
