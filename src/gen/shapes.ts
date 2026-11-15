import { BlockSpec } from "../core/block.js";
import { Vec3 } from "../core/geometry.js";
import { VoxelSet } from "../core/voxels.js";

/** Decides the block for each cell. Usually wraps Palette.at so mixes vary by position. */
export type Brush = (x: number, y: number, z: number) => BlockSpec | string;

export function solid(block: BlockSpec | string): Brush {
  return () => block;
}

function put(set: VoxelSet, x: number, y: number, z: number, brush: Brush) {
  set.set(x, y, z, brush(x, y, z));
}

export type BoxMode = "solid" | "hollow" | "walls" | "outline" | "floor" | "ceiling";

/** Box between two corners. hollow keeps the six faces, walls only the four sides, outline only the edges. */
export function box(set: VoxelSet, a: Vec3, b: Vec3, brush: Brush, mode: BoxMode = "solid", thickness = 1): void {
  const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
  const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
  const z1 = Math.min(a.z, b.z), z2 = Math.max(a.z, b.z);
  const t = Math.max(1, thickness);
  for (let y = y1; y <= y2; y++)
    for (let z = z1; z <= z2; z++)
      for (let x = x1; x <= x2; x++) {
        const ex = x < x1 + t || x > x2 - t;
        const ey = y < y1 + t || y > y2 - t;
        const ez = z < z1 + t || z > z2 - t;
        let on = true;
        if (mode === "hollow") on = ex || ey || ez;
        else if (mode === "walls") on = ex || ez;
        else if (mode === "outline") on = (ex ? 1 : 0) + (ey ? 1 : 0) + (ez ? 1 : 0) >= 2;
        else if (mode === "floor") on = y < y1 + t;
        else if (mode === "ceiling") on = y > y2 - t;
        if (on) put(set, x, y, z, brush);
      }
}

/** Ellipsoid around a center. hollow leaves a shell `thickness` blocks thick. half cuts it to a dome or bowl. */
export function ellipsoid(
  set: VoxelSet, c: Vec3, r: Vec3, brush: Brush,
  opt: { hollow?: boolean; thickness?: number; half?: "top" | "bottom" } = {},
): void {
  const th = opt.thickness ?? 1;
  const rx = Math.max(r.x, 0.5), ry = Math.max(r.y, 0.5), rz = Math.max(r.z, 0.5);
  for (let y = Math.floor(-ry); y <= Math.ceil(ry); y++) {
    if (opt.half === "top" && y < 0) continue;
    if (opt.half === "bottom" && y > 0) continue;
    for (let z = Math.floor(-rz); z <= Math.ceil(rz); z++)
      for (let x = Math.floor(-rx); x <= Math.ceil(rx); x++) {
        const d = (x / (rx + 0.5)) ** 2 + (y / (ry + 0.5)) ** 2 + (z / (rz + 0.5)) ** 2;
        if (d > 1) continue;
        if (opt.hollow) {
          const ix = rx + 0.5 - th, iy = ry + 0.5 - th, iz = rz + 0.5 - th;
          if (ix > 0 && iy > 0 && iz > 0 && (x / ix) ** 2 + (y / iy) ** 2 + (z / iz) ** 2 < 1) continue;
        }
        put(set, c.x + x, c.y + y, c.z + z, brush);
      }
  }
}

export function sphere(set: VoxelSet, c: Vec3, radius: number, brush: Brush, opt: { hollow?: boolean; thickness?: number; half?: "top" | "bottom" } = {}) {
  ellipsoid(set, c, { x: radius, y: radius, z: radius }, brush, opt);
}

type Axis = "x" | "y" | "z";

/** Cylinder from a base center along an axis. radius2 makes it a cone frustum. */
export function cylinder(
  set: VoxelSet, base: Vec3, radius: number, height: number, brush: Brush,
  opt: { axis?: Axis; hollow?: boolean; thickness?: number; radius2?: number; caps?: boolean } = {},
): void {
  const axis = opt.axis ?? "y";
  const th = opt.thickness ?? 1;
  const r2 = opt.radius2 ?? radius;
  for (let h = 0; h < height; h++) {
    const t = height <= 1 ? 0 : h / (height - 1);
    const r = radius + (r2 - radius) * t;
    const R = Math.ceil(r);
    const cap = opt.caps && (h === 0 || h === height - 1);
    for (let u = -R; u <= R; u++)
      for (let v = -R; v <= R; v++) {
        const d = Math.sqrt(u * u + v * v);
        if (d > r + 0.5) continue;
        if (opt.hollow && !cap && d < r + 0.5 - th) continue;
        const p = axis === "y" ? [u, h, v] : axis === "x" ? [h, u, v] : [u, v, h];
        put(set, base.x + p[0], base.y + p[1], base.z + p[2], brush);
      }
  }
}

export function cone(set: VoxelSet, base: Vec3, radius: number, height: number, brush: Brush, opt: { hollow?: boolean; axis?: Axis } = {}) {
  cylinder(set, base, radius, height, brush, { ...opt, radius2: 0 });
}

/** Square pyramid sitting on base (center). stepped gives the ziggurat look, hollow keeps only the faces. */
export function pyramid(set: VoxelSet, base: Vec3, halfSize: number, height: number, brush: Brush, opt: { hollow?: boolean; step?: number } = {}): void {
  const step = Math.max(1, opt.step ?? 1);
  for (let h = 0; h < height; h++) {
    const s = Math.round(halfSize - (Math.floor(h / step) * step * halfSize) / Math.max(1, height));
    if (s < 0) break;
    for (let z = -s; z <= s; z++)
      for (let x = -s; x <= s; x++) {
        if (opt.hollow && Math.abs(x) < s && Math.abs(z) < s && h < height - 1) continue;
        put(set, base.x + x, base.y + h, base.z + z, brush);
      }
  }
}

/** 3D line with an optional round thickness, handy for cables, beams and supports. */
export function line(set: VoxelSet, a: Vec3, b: Vec3, brush: Brush, radius = 0): void {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const n = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz), 1);
  const R = Math.ceil(radius);
  for (let i = 0; i <= n; i++) {
    const x = Math.round(a.x + (dx * i) / n), y = Math.round(a.y + (dy * i) / n), z = Math.round(a.z + (dz * i) / n);
    if (R === 0) put(set, x, y, z, brush);
    else
      for (let ox = -R; ox <= R; ox++) for (let oy = -R; oy <= R; oy++) for (let oz = -R; oz <= R; oz++)
        if (ox * ox + oy * oy + oz * oz <= radius * radius + 0.5) put(set, x + ox, y + oy, z + oz, brush);
  }
}

/** Points along a polyline, one per block, without repeating the joints. */
export function rasterPath(points: { x: number; z: number }[]): { x: number; z: number; dx: number; dz: number }[] {
  const out: { x: number; z: number; dx: number; dz: number }[] = [];
  for (let s = 0; s + 1 < points.length; s++) {
    const a = points[s], b = points[s + 1];
    const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.z - a.z), 1);
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    for (let i = s === 0 ? 0 : 1; i <= n; i++) {
      out.push({ x: Math.round(a.x + ((b.x - a.x) * i) / n), z: Math.round(a.z + ((b.z - a.z) * i) / n), dx: (b.x - a.x) / len, dz: (b.z - a.z) / len });
    }
  }
  return out;
}

/** Wall that follows a polyline on the xz plane, from y up `height` blocks, `thickness` wide. */
export function pathWall(set: VoxelSet, points: { x: number; z: number }[], y: number, height: number, thickness: number, brush: Brush): void {
  const half = (thickness - 1) / 2;
  for (const p of rasterPath(points)) {
    const nx = -p.dz, nz = p.dx;
    for (let t = -Math.floor(half); t <= Math.ceil(half); t++) {
      const x = Math.round(p.x + nx * t), z = Math.round(p.z + nz * t);
      for (let h = 0; h < height; h++) put(set, x, y + h, z, brush);
    }
  }
}

export function torus(set: VoxelSet, c: Vec3, major: number, minor: number, brush: Brush, axis: Axis = "y"): void {
  const R = Math.ceil(major + minor);
  const r = Math.ceil(minor);
  for (let u = -R; u <= R; u++)
    for (let v = -R; v <= R; v++)
      for (let w = -r; w <= r; w++) {
        const q = Math.sqrt(u * u + v * v) - major;
        if (q * q + w * w > (minor + 0.5) ** 2) continue;
        const p = axis === "y" ? [u, w, v] : axis === "x" ? [w, u, v] : [u, v, w];
        put(set, c.x + p[0], c.y + p[1], c.z + p[2], brush);
      }
}

/** Half ellipse arch between two feet on the same y, extruded `depth` blocks sideways. */
export function arch(set: VoxelSet, a: Vec3, b: Vec3, height: number, thickness: number, depth: number, brush: Brush): void {
  const alongX = Math.abs(b.x - a.x) >= Math.abs(b.z - a.z);
  const span = alongX ? b.x - a.x : b.z - a.z;
  const half = Math.abs(span) / 2;
  const sign = Math.sign(span) || 1;
  for (let i = 0; i <= Math.abs(span); i++) {
    const t = (i - half) / (half || 1);
    const yOuter = Math.sqrt(Math.max(0, 1 - t * t)) * height;
    for (let y = 0; y <= Math.ceil(yOuter); y++) {
      if (y < yOuter - thickness) continue;
      for (let d = 0; d < depth; d++) {
        const x = alongX ? a.x + sign * i : a.x + d;
        const z = alongX ? a.z + d : a.z + sign * i;
        put(set, x, a.y + y, z, brush);
      }
    }
  }
}

function insidePolygon(x: number, z: number, pts: { x: number; z: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Extrudes any polygon on the xz plane from y1 to y2. hollow keeps only the outline. */
export function prism(set: VoxelSet, pts: { x: number; z: number }[], y1: number, y2: number, brush: Brush, hollow = false): void {
  const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
  const minZ = Math.min(...pts.map((p) => p.z)), maxZ = Math.max(...pts.map((p) => p.z));
  const cells = new Set<string>();
  for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) if (insidePolygon(x + 0.5, z + 0.5, pts)) cells.add(`${x},${z}`);
  const edge = new Set<string>();
  if (hollow) for (const p of rasterPath([...pts, pts[0]])) edge.add(`${p.x},${p.z}`);
  for (const k of hollow ? edge : new Set([...cells, ...[...rasterPath([...pts, pts[0]])].map((p) => `${p.x},${p.z}`)])) {
    const [x, z] = k.split(",").map(Number);
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) put(set, x, y, z, brush);
  }
}
