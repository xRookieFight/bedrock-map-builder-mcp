import { AIR } from "../core/block.js";
import { transformSet } from "../core/transform.js";
import { VoxelSet } from "../core/voxels.js";
import { Facing, GenResult, combine, place, result, shift, slab, stairs, withState } from "./common.js";
import { Palette } from "./palette.js";
import { box, cone, cylinder, rasterPath } from "./shapes.js";

export type RoofKind = "gable" | "hip" | "flat" | "dome" | "none";

export interface HouseOptions {
  width: number;
  depth: number;
  floors?: number;
  floorHeight?: number;
  roof?: RoofKind;
  windowSpacing?: number;
  furnish?: boolean;
  /** Timber frame look: pillars on corners and beams at every floor line. */
  frame?: boolean;
}

const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

/** Gable roof with the ridge along x. Stairs on both slopes, gable ends filled with wall. */
function gableRoof(set: VoxelSet, p: Palette, w: number, d: number, y0: number, overhang = 1) {
  const x1 = -overhang, x2 = w - 1 + overhang;
  for (let i = 0; ; i++) {
    const zs = i - overhang, zn = d - 1 - i + overhang;
    if (zs > zn) break;
    const y = y0 + i;
    if (zs === zn) {
      for (let x = x1; x <= x2; x++) set.set(x, y, zs, slab(p, "roof_slab", x, y, zs));
      break;
    }
    if (zn - zs === 1) {
      for (let x = x1; x <= x2; x++) {
        set.set(x, y, zs, stairs(p, "roof_stairs", x, y, zs, "south"));
        set.set(x, y, zn, stairs(p, "roof_stairs", x, y, zn, "north"));
      }
      break;
    }
    for (let x = x1; x <= x2; x++) {
      // the north edge slope climbs toward the south ridge and vice versa
      set.set(x, y, zs, stairs(p, "roof_stairs", x, y, zs, "south"));
      set.set(x, y, zn, stairs(p, "roof_stairs", x, y, zn, "north"));
      if (x > x1 && x < x2) for (let z = zs + 1; z < zn; z++) set.set(x, y, z, AIR);
    }
    // close the triangle at both gable ends
    for (let z = Math.max(zs + 1, 0); z <= Math.min(zn - 1, d - 1); z++) {
      set.set(0, y, z, p.at("wall", 0, y, z));
      set.set(w - 1, y, z, p.at("wall", w - 1, y, z));
    }
  }
}

function hipRoof(set: VoxelSet, p: Palette, w: number, d: number, y0: number) {
  for (let i = 0; ; i++) {
    const x1 = i - 1, x2 = w - i, z1 = i - 1, z2 = d - i;
    if (x1 > x2 || z1 > z2) break;
    const y = y0 + i;
    if (x2 - x1 <= 1 || z2 - z1 <= 1) {
      for (let x = x1; x <= x2; x++) for (let z = z1; z <= z2; z++) set.set(x, y, z, slab(p, "roof_slab", x, y, z));
      break;
    }
    for (let x = x1; x <= x2; x++) {
      set.set(x, y, z1, stairs(p, "roof_stairs", x, y, z1, "south"));
      set.set(x, y, z2, stairs(p, "roof_stairs", x, y, z2, "north"));
    }
    for (let z = z1 + 1; z < z2; z++) {
      set.set(x1, y, z, stairs(p, "roof_stairs", x1, y, z, "east"));
      set.set(x2, y, z, stairs(p, "roof_stairs", x2, y, z, "west"));
    }
  }
}

function flatRoof(set: VoxelSet, p: Palette, w: number, d: number, y: number) {
  box(set, { x: 0, y, z: 0 }, { x: w - 1, y, z: d - 1 }, (x, yy, z) => p.at("roof", x, yy, z));
  box(set, { x: 0, y: y + 1, z: 0 }, { x: w - 1, y: y + 1, z: d - 1 }, (x, yy, z) => p.at("trim", x, yy, z), "walls");
}

/**
 * A house facing south: foundation, walls with windows, a door in the middle of the front, inner floors
 * with a staircase, lights and an optional roof. Interior is cleared to air so it can be dropped into terrain.
 */
export function house(p: Palette, o: HouseOptions): GenResult {
  const w = clampInt(o.width, 5, 64), d = clampInt(o.depth, 5, 64);
  const floors = clampInt(o.floors ?? 1, 1, 20);
  const fh = clampInt(o.floorHeight ?? 4, 3, 8);
  const spacing = clampInt(o.windowSpacing ?? 3, 2, 8);
  const frame = o.frame ?? true;
  const r = result();
  const set = r.set;
  const top = floors * fh;

  box(set, { x: 0, y: 0, z: 0 }, { x: w - 1, y: 0, z: d - 1 }, (x, y, z) => p.at("foundation", x, y, z));
  box(set, { x: 1, y: 1, z: 1 }, { x: w - 2, y: top, z: d - 2 }, () => AIR);
  box(set, { x: 0, y: 1, z: 0 }, { x: w - 1, y: top, z: d - 1 }, (x, y, z) => p.at("wall", x, y, z), "walls");

  for (let f = 0; f < floors; f++) {
    const fy = f * fh;
    if (f > 0) box(set, { x: 1, y: fy, z: 1 }, { x: w - 2, y: fy, z: d - 2 }, (x, y, z) => p.at("floor", x, y, z));
    else box(set, { x: 1, y: 0, z: 1 }, { x: w - 2, y: 0, z: d - 2 }, (x, y, z) => p.at("floor", x, y, z));
    if (frame) {
      box(set, { x: 0, y: fy + fh, z: 0 }, { x: w - 1, y: fy + fh, z: d - 1 }, (x, y, z) => p.at("wall_accent", x, y, z, { pillar_axis: "x" }), "walls");
    }
    // windows two tall, skipping the corners and the door column
    const wy = fy + 2;
    const doorX = Math.floor(w / 2);
    for (let x = 2; x <= w - 3; x += spacing) {
      for (const z of [0, d - 1]) {
        if (f === 0 && z === d - 1 && Math.abs(x - doorX) <= 1) continue;
        for (let k = 0; k < Math.min(2, fh - 2); k++) set.set(x, wy + k, z, p.at("window", x, wy + k, z));
      }
    }
    for (let z = 2; z <= d - 3; z += spacing) {
      for (const x of [0, w - 1]) for (let k = 0; k < Math.min(2, fh - 2); k++) set.set(x, wy + k, z, p.at("window", x, wy + k, z));
    }
    // hanging light in the middle of each floor
    const cx = Math.floor(w / 2), cz = Math.floor(d / 2);
    const light = p.at("light", cx, fy + fh - 1, cz);
    set.set(cx, fy + fh - 1, cz, light.name === "minecraft:lantern" || light.name === "minecraft:soul_lantern" ? withState(light, { hanging: true }) : light);

    // straight stair along the west wall up to the next floor
    if (f < floors - 1) {
      for (let s = 0; s < fh; s++) {
        const z = d - 2 - s - 1;
        if (z < 1) break;
        set.set(1, fy + 1 + s, z, stairs(p, "stairs", 1, fy + 1 + s, z, "north"));
        for (let k = 1; k <= 3; k++) if (fy + 1 + s + k < fy + fh) set.set(1, fy + 1 + s + k, z, AIR);
        if (fy + 1 + s >= fy + fh - 3) set.set(1, fy + fh, z, AIR);
      }
    }
  }
  if (frame) {
    for (const [x, z] of [[0, 0], [w - 1, 0], [0, d - 1], [w - 1, d - 1]]) {
      for (let y = 1; y <= top; y++) set.set(x, y, z, p.at("pillar", x, y, z, { pillar_axis: "y" }));
    }
  }

  const doorX = Math.floor(w / 2);
  const door = p.at("door", doorX, 1, d - 1);
  set.set(doorX, 1, d - 1, withState(door, { "minecraft:cardinal_direction": "south", upper_block_bit: false }));
  set.set(doorX, 2, d - 1, withState(door, { "minecraft:cardinal_direction": "south", upper_block_bit: true }));
  set.set(doorX, 0, d, stairs(p, "stairs", doorX, 0, d, "north"));
  r.markers.push({ kind: "door", pos: { x: doorX, y: 1, z: d } });
  r.markers.push({ kind: "spawn", name: "inside", pos: { x: doorX, y: 1, z: d - 2 } });

  if (o.furnish ?? true) {
    const items = ["chest", "crafting_table", "furnace", "bookshelf", "barrel"];
    let x = w - 2;
    for (const it of items) {
      if (x < 2) break;
      if (Math.abs(x - doorX) > 0) set.set(x, 1, 1, { name: `minecraft:${it}`, states: it === "chest" || it === "furnace" ? { "minecraft:cardinal_direction": "south" } : {} });
      x--;
    }
    if (w >= 7 && d >= 7) set.set(Math.floor(w / 2), 1, Math.floor(d / 2), p.at("carpet", 0, 0, 0));
    r.markers.push({ kind: "chest", pos: { x: w - 2, y: 1, z: 1 } });
  }

  const roof = o.roof ?? "gable";
  if (roof === "gable") {
    if (w >= d) gableRoof(set, p, w, d, top + 1);
    else {
      // build the roof rotated so the ridge always runs along the long side
      const tmp = new VoxelSet();
      gableRoof(tmp, p, d, w, top + 1);
      const rot = transformSet(tmp, { rotate: 1, pivot: { x: 0, y: 0, z: 0 } });
      set.merge(rot, { x: w - 1, y: 0, z: 0 });
    }
  } else if (roof === "hip") hipRoof(set, p, w, d, top + 1);
  else if (roof === "flat") flatRoof(set, p, w, d, top + 1);
  else if (roof === "dome") {
    const rr = Math.min(w, d) / 2;
    box(set, { x: 0, y: top + 1, z: 0 }, { x: w - 1, y: top + 1, z: d - 1 }, (x, y, z) => p.at("roof", x, y, z));
    domeOver(set, p, (w - 1) / 2, top + 2, (d - 1) / 2, rr);
  } else box(set, { x: 0, y: top + 1, z: 0 }, { x: w - 1, y: top + 1, z: d - 1 }, (x, y, z) => p.at("ceiling", x, y, z));
  r.notes.push(`house ${w}x${d}, ${floors} floor(s), ${roof} roof`);
  return r;
}

function domeOver(set: VoxelSet, p: Palette, cx: number, y0: number, cz: number, r: number) {
  for (let y = 0; y <= r; y++)
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++)
      for (let z = Math.floor(cz - r); z <= Math.ceil(cz + r); z++) {
        const d = Math.hypot(x - cx, y, z - cz);
        if (d <= r + 0.3 && d >= r - 1) set.set(x, y0 + y, z, p.at("roof", x, y0 + y, z));
      }
}

export interface TowerOptions {
  radius: number;
  height: number;
  shape?: "round" | "square";
  top?: "battlements" | "cone" | "flat" | "dome";
  floorEvery?: number;
  stairs?: boolean;
}

/** Tower centred on 0,0 with its base at y 0. Spiral stairs around the inside wall, slits every few blocks. */
export function tower(p: Palette, o: TowerOptions): GenResult {
  const R = clampInt(o.radius, 2, 32), H = clampInt(o.height, 4, 300);
  const shape = o.shape ?? "round";
  const r = result();
  const set = r.set;
  const inside = (x: number, z: number, rad: number) => (shape === "round" ? Math.hypot(x, z) <= rad + 0.5 : Math.max(Math.abs(x), Math.abs(z)) <= rad);
  for (let y = 0; y < H; y++)
    for (let x = -R; x <= R; x++)
      for (let z = -R; z <= R; z++) {
        if (!inside(x, z, R)) continue;
        const wall = !inside(x, z, R - 1);
        if (y === 0) set.set(x, y, z, p.at("foundation", x, y, z));
        else if (wall) {
          const slit = y % 5 === 2 && (x === 0 || z === 0) && y < H - 1;
          set.set(x, y, z, slit ? AIR : p.at(y % 8 === 0 ? "wall_accent" : "wall", x, y, z));
        } else set.set(x, y, z, AIR);
      }
  const every = clampInt(o.floorEvery ?? 0, 0, 50);
  if (every) for (let y = every; y < H - 1; y += every) for (let x = -R + 1; x <= R - 1; x++) for (let z = -R + 1; z <= R - 1; z++) if (inside(x, z, R - 1)) set.set(x, y, z, p.at("floor", x, y, z));

  const stairTop: { x: number; z: number }[] = [];
  if ((o.stairs ?? true) && R >= 3) {
    // walk the ring just inside the wall and climb one block per step
    const ring: { x: number; z: number; a: number }[] = [];
    for (let x = -R; x <= R; x++)
      for (let z = -R; z <= R; z++) if (inside(x, z, R - 1) && !inside(x, z, R - 2)) ring.push({ x, z, a: Math.atan2(z, x) });
    ring.sort((a, b) => a.a - b.a);
    stairTop.length = 0;
    for (let y = 1; y < H - 1; y++) {
      const c = ring[(y - 1) % ring.length];
      const n = ring[y % ring.length];
      const dx = n.x - c.x, dz = n.z - c.z;
      const dir: Facing = Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? "east" : "west") : dz > 0 ? "south" : "north";
      set.set(c.x, y, c.z, stairs(p, "stairs", c.x, y, c.z, dir));
      // headroom, which also cuts the stair hole through any floor above
      for (let k = 1; k <= 3 && y + k < H; k++) set.set(c.x, y + k, c.z, AIR);
      stairTop.push(c);
    }
  } else if (o.stairs ?? true) {
    for (let y = 1; y < H; y++) set.set(0, y, -R + 1, { name: "minecraft:ladder", states: { facing_direction: 3 } });
  }

  const topY = H;
  const topKind = o.top ?? "battlements";
  if (topKind === "battlements") {
    for (let x = -R; x <= R; x++) for (let z = -R; z <= R; z++) {
      if (!inside(x, z, R)) continue;
      set.set(x, topY - 1, z, p.at("floor", x, topY - 1, z));
      if (!inside(x, z, R - 1)) {
        set.set(x, topY, z, p.at("battlement", x, topY, z));
        if ((x + z) % 2 === 0) set.set(x, topY + 1, z, p.at("battlement", x, topY + 1, z));
      }
    }
    // hatch above the last steps so the stairs actually come out on the roof
    for (const c of stairTop.slice(-3)) set.set(c.x, topY - 1, c.z, AIR);
    set.set(0, topY, 0, p.at("light", 0, topY, 0));
  } else if (topKind === "cone") {
    cone(set, { x: 0, y: topY, z: 0 }, R + 1, Math.round(R * 2.2), (x, y, z) => p.at("roof", x, y, z), { hollow: true });
  } else if (topKind === "dome") {
    domeOver(set, p, 0, topY, 0, R);
  } else box(set, { x: -R, y: topY - 1, z: -R }, { x: R, y: topY - 1, z: R }, (x, y, z) => (inside(x, z, R) ? p.at("roof", x, y, z) : AIR));
  for (let y = 1; y <= 2; y++) set.set(0, y, R, AIR);
  r.markers.push({ kind: "door", pos: { x: 0, y: 1, z: R } });
  r.markers.push({ kind: "lookout", pos: { x: 0, y: topY, z: 0 } });
  return r;
}

export interface WallOptions {
  points: { x: number; z: number }[];
  height: number;
  thickness?: number;
  battlements?: boolean;
  towerEvery?: number;
  towerRadius?: number;
  closed?: boolean;
}

/** Defensive wall along a polyline with a walkway, crenellations and optional towers on the way. */
export function wall(p: Palette, o: WallOptions, y0: number): GenResult {
  const r = result();
  const set = r.set;
  const H = clampInt(o.height, 2, 200), T = clampInt(o.thickness ?? 3, 1, 9);
  const pts = o.closed ? [...o.points, o.points[0]] : o.points;
  const path = rasterPath(pts);
  const half = (T - 1) / 2;
  for (const s of path) {
    const nx = -s.dz, nz = s.dx;
    for (let t = -Math.floor(half); t <= Math.ceil(half); t++) {
      const x = Math.round(s.x + nx * t), z = Math.round(s.z + nz * t);
      for (let h = 0; h < H; h++) set.set(x, y0 + h, z, p.at(h === 0 ? "foundation" : "wall", x, y0 + h, z));
      if (o.battlements ?? true) {
        const edge = Math.abs(t) >= half - 0.01 && T > 1;
        if (edge) {
          set.set(x, y0 + H, z, p.at("battlement", x, y0 + H, z));
          if ((s.x + s.z) % 2 === 0) set.set(x, y0 + H + 1, z, p.at("battlement", x, y0 + H + 1, z));
        }
      }
    }
  }
  const every = o.towerEvery ?? 0;
  const tr = o.towerRadius ?? Math.max(3, Math.ceil(T / 2) + 2);
  const towerAt: { x: number; z: number }[] = [...o.points];
  if (every > 0) for (let i = every; i < path.length; i += every) towerAt.push(path[i]);
  for (const t of towerAt) {
    r.set.merge(tower(p, { radius: tr, height: H + 5, top: "battlements" }).set, { x: t.x, y: y0, z: t.z });
    r.markers.push({ kind: "tower", pos: { x: t.x, y: y0, z: t.z } });
  }
  r.notes.push(`wall of ${path.length} blocks with ${towerAt.length} towers`);
  return r;
}

export interface CastleOptions {
  size: number;
  wallHeight?: number;
  keepFloors?: number;
}

/** Square castle centred on 0,0: curtain wall, corner towers, gatehouse on the south side and a keep. */
export function castle(p: Palette, o: CastleOptions): GenResult {
  const S = clampInt(o.size, 24, 400);
  const half = Math.floor(S / 2);
  const H = clampInt(o.wallHeight ?? 10, 5, 60);
  const corners = [{ x: -half, z: -half }, { x: half, z: -half }, { x: half, z: half }, { x: -half, z: half }];
  const walls = wall(p, { points: corners, closed: true, height: H, thickness: 3, battlements: true, towerRadius: Math.max(4, Math.round(S / 14)) }, 0);
  const set = walls.set;
  // courtyard floor and a path from the gate to the keep
  for (let x = -half + 2; x <= half - 2; x++) for (let z = -half + 2; z <= half - 2; z++) if (set.get(x, 0, z) < 0) set.set(x, 0, z, p.at("path", x, 0, z));
  // gate: carve through the south wall and frame it
  const gw = 2, gh = Math.min(H - 2, 5);
  for (let x = -gw; x <= gw; x++) for (let y = 1; y <= gh; y++) for (let z = half - 2; z <= half + 2; z++) set.set(x, y, z, AIR);
  for (let z = half - 2; z <= half + 2; z++) {
    set.set(-gw - 1, gh + 1, z, p.at("wall_accent", -gw - 1, gh + 1, z));
    set.set(gw + 1, gh + 1, z, p.at("wall_accent", gw + 1, gh + 1, z));
    for (let x = -gw; x <= gw; x++) set.set(x, gh + 1, z, p.at("trim", x, gh + 1, z));
  }
  const gate = combine(
    shift(tower(p, { radius: 3, height: H + 6, shape: "square" }), { x: -gw - 4, y: 0, z: half }),
    shift(tower(p, { radius: 3, height: H + 6, shape: "square" }), { x: gw + 4, y: 0, z: half }),
  );
  set.merge(gate.set);
  for (let x = -gw; x <= gw; x++) for (let y = 1; y <= gh; y++) for (let z = half - 2; z <= half + 2; z++) set.set(x, y, z, AIR);

  const kw = Math.max(9, Math.round(S / 3)) | 1;
  const keep = place(house(p, { width: kw, depth: kw, floors: o.keepFloors ?? 3, floorHeight: 5, roof: "flat", frame: false, furnish: true }), { x: -Math.floor(kw / 2), y: 0, z: -Math.floor(kw / 2) - Math.round(S / 10) }, "south");
  set.merge(keep.set);
  for (let z = keep.set.bounds()!.max.z + 1; z <= half - 2; z++) for (let x = -1; x <= 1; x++) set.set(x, 0, z, p.at("path_edge", x, 0, z));
  const r = result(set);
  r.markers.push(...walls.markers, ...keep.markers);
  r.markers.push({ kind: "gate", pos: { x: 0, y: 1, z: half + 3 } });
  r.markers.push({ kind: "spawn", name: "courtyard", pos: { x: 0, y: 1, z: Math.round(half / 2) } });
  r.notes.push(`castle ${S}x${S}, walls ${H} high, keep ${kw}x${kw}`);
  return r;
}

export interface BridgeOptions {
  from: { x: number; y: number; z: number };
  to: { x: number; y: number; z: number };
  width?: number;
  railing?: "fence" | "wall" | "none";
  arches?: boolean;
  supportDepth?: number;
}

/** Deck from one point to another with railings, lamps and arches hanging under it. Ramps if the ends differ in height. */
export function bridge(p: Palette, o: BridgeOptions): GenResult {
  const r = result();
  const set = r.set;
  const W = clampInt(o.width ?? 5, 1, 21);
  const path = rasterPath([o.from, o.to].map((q) => ({ x: q.x, z: q.z })));
  const n = path.length;
  const depth = clampInt(o.supportDepth ?? 12, 0, 120);
  path.forEach((s, i) => {
    const y = Math.round(o.from.y + ((o.to.y - o.from.y) * i) / Math.max(1, n - 1));
    const nx = -s.dz, nz = s.dx;
    const half = (W - 1) / 2;
    for (let t = -Math.ceil(half) - 1; t <= Math.ceil(half) + 1; t++) {
      const x = Math.round(s.x + nx * t), z = Math.round(s.z + nz * t);
      const edge = Math.abs(t) > half;
      set.set(x, y, z, p.at(edge ? "trim" : "floor", x, y, z));
      for (let k = 1; k <= 3; k++) if (!edge) set.set(x, y + k, z, AIR);
      if (edge && o.railing !== "none") {
        const rail = o.railing === "wall" ? p.at("battlement", x, y + 1, z) : p.at("fence", x, y + 1, z);
        set.set(x, y + 1, z, rail);
        if (i % 8 === 0) set.set(x, y + 2, z, withState(p.at("light", x, y + 2, z), {}));
      }
      if ((o.arches ?? true) && depth > 0) {
        // arch: deeper at the supports, shallow at mid span
        const period = 16;
        const ph = (i % period) / period;
        const d = Math.round(1 + (depth - 1) * Math.pow(Math.abs(ph - 0.5) * 2, 3));
        for (let k = 1; k <= d; k++) if (edge || k <= 1 || i % period === 0) set.set(x, y - k, z, p.at("wall", x, y - k, z));
      }
    }
  });
  r.markers.push({ kind: "end", pos: o.from }, { kind: "end", pos: o.to });
  r.notes.push(`bridge ${n} blocks long, ${W} wide`);
  return r;
}

export interface RoadOptions {
  points: { x: number; y: number; z: number }[];
  width?: number;
  lampEvery?: number;
  clearance?: number;
}

/** Road along a polyline. Interpolates height between points, clears headroom and adds lamp posts. */
export function road(p: Palette, o: RoadOptions): GenResult {
  const r = result();
  const set = r.set;
  const W = clampInt(o.width ?? 5, 1, 41);
  const lamp = o.lampEvery ?? 12;
  const clear = clampInt(o.clearance ?? 4, 0, 30);
  let idx = 0;
  for (let s = 0; s + 1 < o.points.length; s++) {
    const a = o.points[s], b = o.points[s + 1];
    const seg = rasterPath([a, b]);
    seg.forEach((q, i) => {
      if (s > 0 && i === 0) return;
      const y = Math.round(a.y + ((b.y - a.y) * i) / Math.max(1, seg.length - 1));
      const nx = -q.dz, nz = q.dx, half = (W - 1) / 2;
      for (let t = -Math.ceil(half); t <= Math.ceil(half); t++) {
        for (const off of [0, 0.5]) {
          const x = Math.round(q.x + nx * (t + off * Math.sign(t || 1))), z = Math.round(q.z + nz * (t + off * Math.sign(t || 1)));
          const edge = Math.abs(t) >= half && W > 2;
          set.set(x, y, z, p.at(edge ? "path_edge" : "path", x, y, z));
          for (let k = 1; k <= clear; k++) set.set(x, y + k, z, AIR);
        }
      }
      if (lamp > 0 && idx % lamp === 0) {
        const x = Math.round(q.x + nx * (Math.ceil(half) + 1)), z = Math.round(q.z + nz * (Math.ceil(half) + 1));
        set.set(x, y, z, p.at("path_edge", x, y, z));
        for (let k = 1; k <= 3; k++) set.set(x, y + k, z, p.at("fence", x, y + k, z));
        set.set(x, y + 4, z, p.at("light", x, y + 4, z));
      }
      idx++;
    });
  }
  r.notes.push(`road ${idx} blocks long`);
  return r;
}

export interface SkyscraperOptions {
  width: number;
  depth: number;
  floors: number;
  floorHeight?: number;
  setbackEvery?: number;
  antenna?: boolean;
}

/** Glass tower with a frame grid, floor slabs, ceiling lights, a lobby entrance and optional setbacks. */
export function skyscraper(p: Palette, o: SkyscraperOptions): GenResult {
  const r = result();
  const set = r.set;
  let w = clampInt(o.width, 7, 64), d = clampInt(o.depth, 7, 64);
  const F = clampInt(o.floors, 2, 90), fh = clampInt(o.floorHeight ?? 4, 3, 8);
  const setback = o.setbackEvery ?? 0;
  let x0 = 0, z0 = 0;
  box(set, { x: -1, y: 0, z: -1 }, { x: w, y: 0, z: d }, (x, y, z) => p.at("foundation", x, y, z));
  for (let f = 0; f < F; f++) {
    if (setback && f > 0 && f % setback === 0 && w > 9 && d > 9) {
      x0 += 1; z0 += 1; w -= 2; d -= 2;
      box(set, { x: x0 - 1, y: f * fh, z: z0 - 1 }, { x: x0 + w, y: f * fh, z: z0 + d }, (x, y, z) => p.at("trim", x, y, z), "walls");
    }
    const y1 = f * fh;
    box(set, { x: x0, y: y1, z: z0 }, { x: x0 + w - 1, y: y1, z: z0 + d - 1 }, (x, y, z) => p.at("floor", x, y, z));
    box(set, { x: x0 + 1, y: y1 + 1, z: z0 + 1 }, { x: x0 + w - 2, y: y1 + fh - 1, z: z0 + d - 2 }, () => AIR);
    for (let y = y1 + 1; y < y1 + fh; y++) {
      box(set, { x: x0, y, z: z0 }, { x: x0 + w - 1, y, z: z0 + d - 1 }, (x, yy, z) => {
        const col = (x - x0) % 4 === 0 || (z - z0) % 4 === 0 || x === x0 + w - 1 || z === z0 + d - 1;
        return col ? p.at("pillar", x, yy, z) : p.at("window", x, yy, z);
      }, "walls");
    }
    for (let x = x0 + 2; x < x0 + w - 2; x += 4) for (let z = z0 + 2; z < z0 + d - 2; z += 4) set.set(x, y1 + fh - 1, z, p.at("light", x, y1 + fh - 1, z));
  }
  const topY = F * fh;
  box(set, { x: x0, y: topY, z: z0 }, { x: x0 + w - 1, y: topY, z: z0 + d - 1 }, (x, y, z) => p.at("roof", x, y, z));
  box(set, { x: x0, y: topY + 1, z: z0 }, { x: x0 + w - 1, y: topY + 1, z: z0 + d - 1 }, (x, y, z) => p.at("battlement", x, y, z), "walls");
  if (o.antenna ?? true) {
    const ax = x0 + Math.floor(w / 2), az = z0 + Math.floor(d / 2);
    for (let y = topY + 1; y < topY + 1 + Math.max(4, Math.round(F / 2)); y++) set.set(ax, y, az, { name: "minecraft:iron_bars", states: {} });
    set.set(ax, topY + 1 + Math.max(4, Math.round(F / 2)), az, { name: "minecraft:redstone_lamp", states: {} });
  }
  // lobby entrance on the south face
  const ex = Math.floor((o.width - 1) / 2);
  for (let x = ex - 1; x <= ex + 1; x++) for (let y = 1; y <= 3; y++) set.set(x, y, o.depth - 1, AIR);
  r.markers.push({ kind: "door", pos: { x: ex, y: 1, z: o.depth } }, { kind: "roof", pos: { x: x0 + 1, y: topY + 1, z: z0 + 1 } });
  r.notes.push(`skyscraper ${o.width}x${o.depth}, ${F} floors, ${topY} blocks tall`);
  return r;
}
