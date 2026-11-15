import { AIR, parseBlock } from "../core/block.js";
import { Rng } from "../core/noise.js";
import { transformSet } from "../core/transform.js";
import { VoxelSet } from "../core/voxels.js";
import { GenResult, TEAM_COLORS, combine, place, result, shift, stairs } from "./common.js";
import { house, skyscraper, road } from "./buildings.js";
import { Palette } from "./palette.js";
import { box, cylinder } from "./shapes.js";
import { tree } from "./nature.js";

const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));

export interface ArenaOptions {
  shape?: "circle" | "square";
  radius: number;
  teams?: number;
  wallHeight?: number;
  /** pillars, walls, mixed or none. Cover is generated in one slice and rotated so every team gets the same. */
  cover?: "pillars" | "walls" | "mixed" | "none";
  coverDensity?: number;
  floorPattern?: "rings" | "checker" | "plain" | "noise";
  seating?: boolean;
  roofBarrier?: boolean;
  seed?: number;
}

/**
 * Arena centred on 0,0 with the floor at y 0. Spawns sit evenly around the edge, and cover is built in one
 * sector then copied around with rotation, so the map is fair for every team by construction.
 */
export function arena(p: Palette, o: ArenaOptions): GenResult {
  const R = clampInt(o.radius, 8, 150);
  const teams = clampInt(o.teams ?? 2, 1, 8);
  const H = clampInt(o.wallHeight ?? 6, 2, 40);
  const shape = o.shape ?? "circle";
  const rng = new Rng(o.seed ?? 42);
  const r = result();
  const set = r.set;
  const inside = (x: number, z: number, rad: number) => (shape === "circle" ? Math.hypot(x, z) <= rad + 0.5 : Math.max(Math.abs(x), Math.abs(z)) <= rad);
  const pattern = o.floorPattern ?? "rings";
  for (let x = -R - 1; x <= R + 1; x++)
    for (let z = -R - 1; z <= R + 1; z++) {
      if (!inside(x, z, R + 1)) continue;
      set.set(x, -1, z, p.at("foundation", x, -1, z));
      if (!inside(x, z, R)) {
        for (let y = 0; y <= H; y++) set.set(x, y, z, p.at(y === H ? "battlement" : "wall", x, y, z));
        continue;
      }
      let role: "floor" | "trim" | "wall_accent" = "floor";
      if (pattern === "rings" && Math.round(Math.hypot(x, z)) % 6 === 0) role = "trim";
      if (pattern === "checker" && (Math.floor(x / 3) + Math.floor(z / 3)) % 2 === 0) role = "trim";
      if (pattern === "noise" && rng.chance(0.15)) role = "wall_accent";
      set.set(x, 0, z, p.at(role, x, 0, z));
      for (let y = 1; y <= H + 3; y++) set.set(x, y, z, AIR);
      if (o.roofBarrier) set.set(x, H + 4, z, parseBlock("barrier"));
    }

  // cover: one sector, then rotated copies. with 2 or 4 teams we can use exact 90/180 rotations
  const cover = o.cover ?? "mixed";
  if (cover !== "none") {
    const sector = new VoxelSet();
    const density = o.coverDensity ?? 1;
    const n = Math.round((R * R * 0.012 * density) / Math.max(1, teams === 1 ? 4 : teams));
    const quarter = teams === 3 ? (2 * Math.PI) / 3 : teams >= 5 ? (2 * Math.PI) / teams : teams === 1 ? Math.PI / 2 : (2 * Math.PI) / Math.max(2, teams === 2 ? 2 : 4);
    for (let i = 0; i < n; i++) {
      const dist = R * (0.25 + 0.55 * rng.next());
      const ang = rng.next() * quarter;
      const cx = Math.round(Math.cos(ang) * dist), cz = Math.round(Math.sin(ang) * dist);
      const kind = cover === "mixed" ? rng.pick(["pillars", "walls", "walls"] as const) : cover;
      const h = rng.int(2, 3);
      if (kind === "pillars") box(sector, { x: cx, y: 1, z: cz }, { x: cx + 1, y: h + 1, z: cz + 1 }, (x, y, z) => p.at("pillar", x, y, z, { pillar_axis: "y" }));
      else {
        const along = rng.chance(0.5);
        const len = rng.int(3, 5);
        box(sector, { x: cx, y: 1, z: cz }, along ? { x: cx + len, y: h, z: cz } : { x: cx, y: h, z: cz + len }, (x, y, z) => p.at("wall", x, y, z));
      }
    }
    const copies = teams === 2 ? 2 : teams === 3 ? 3 : teams >= 5 ? teams : 4;
    for (let k = 0; k < copies; k++) {
      if (copies === 2 || copies === 4) {
        set.merge(transformSet(sector, { rotate: (k * 4) / copies, pivot: { x: 0, y: 0, z: 0 } }));
      } else {
        // odd team counts can't use block exact rotation, so rotate positions and keep blocks as they are
        const a = (k * 2 * Math.PI) / copies;
        sector.forEach((x, y, z, i) => {
          const nx = Math.round(x * Math.cos(a) - z * Math.sin(a)), nz = Math.round(x * Math.sin(a) + z * Math.cos(a));
          if (inside(nx, nz, R - 2)) set.set(nx, y, nz, sector.palette[i]);
        });
      }
    }
    if (copies !== 2 && copies !== 4) r.notes.push(`${teams} teams: cover uses rounded rotation, symmetry is close but not block exact`);
  }

  // spawn pads in team colours, plus a light ring
  for (let t = 0; t < teams; t++) {
    const a = (t / teams) * Math.PI * 2 + Math.PI / 2;
    const sx = Math.round(Math.cos(a) * (R - 4)), sz = Math.round(Math.sin(a) * (R - 4));
    const color = TEAM_COLORS[t % TEAM_COLORS.length];
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      set.set(sx + dx, 0, sz + dz, parseBlock(`${color}_concrete`));
      for (let y = 1; y <= 3; y++) set.set(sx + dx, y, sz + dz, AIR);
    }
    r.markers.push({ kind: "spawn", name: teams > 1 ? `team_${color}` : "spawn", pos: { x: sx, y: 1, z: sz }, data: { team: t, color, facingCenter: true } });
  }
  if (teams === 1) {
    // FFA: spread spawns around the ring instead of one pad
    r.markers.length = 0;
    const count = Math.max(4, Math.round(R / 3));
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const sx = Math.round(Math.cos(a) * (R - 3)), sz = Math.round(Math.sin(a) * (R - 3));
      for (let y = 1; y <= 3; y++) set.set(sx, y, sz, AIR);
      set.set(sx, 0, sz, p.at("wall_accent", sx, 0, sz));
      r.markers.push({ kind: "spawn", name: `ffa_${i}`, pos: { x: sx, y: 1, z: sz } });
    }
  }
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const lx = Math.round(Math.cos(a) * (R - 1)), lz = Math.round(Math.sin(a) * (R - 1));
    set.set(lx, 0, lz, p.at("light", lx, 0, lz));
  }
  set.set(0, 0, 0, p.at("wall_accent", 0, 0, 0));
  r.markers.push({ kind: "center", pos: { x: 0, y: 1, z: 0 } });

  if (o.seating ?? true) {
    const rows = Math.min(6, Math.round(R / 6));
    for (let row = 0; row < rows; row++) {
      const rr = R + 2 + row;
      const y = H + 1 + row - 4;
      for (let x = -rr - 1; x <= rr + 1; x++)
        for (let z = -rr - 1; z <= rr + 1; z++) {
          if (!inside(x, z, rr) || inside(x, z, rr - 1)) continue;
          for (let yy = -1; yy < y; yy++) set.set(x, yy, z, p.at("foundation", x, yy, z));
          set.set(x, y, z, p.at("slab", x, y, z));
        }
    }
    r.markers.push({ kind: "spectator", pos: { x: 0, y: H + rows, z: R + 2 + rows } });
  }
  r.notes.push(`${shape} arena r=${R}, ${teams === 1 ? "FFA" : teams + " teams"}, walls ${H}`);
  return r;
}

export interface ParkourOptions {
  jumps: number;
  difficulty?: "easy" | "medium" | "hard" | "expert";
  checkpointEvery?: number;
  seed?: number;
  blocks?: string[];
}

// sprint jumps clear a 4 block gap flat and 3 going up one. the course stays a step inside that so nobody needs pixel perfect jumps
const REACH: Record<string, { gap: [number, number]; up: number; down: number }> = {
  easy: { gap: [1, 2], up: 0.25, down: 0.2 },
  medium: { gap: [1, 3], up: 0.35, down: 0.25 },
  hard: { gap: [2, 3], up: 0.4, down: 0.3 },
  expert: { gap: [3, 4], up: 0.3, down: 0.35 },
};

/**
 * Jump course heading south from 0,0,0. Every jump stays inside what a sprinting player can make, the course
 * winds left and right, and a checkpoint plate shows up every few jumps.
 */
export function parkour(p: Palette, o: ParkourOptions): GenResult {
  const rng = new Rng(o.seed ?? 9);
  const diff = REACH[o.difficulty ?? "medium"];
  const r = result();
  const set = r.set;
  const blocks = (o.blocks?.length ? o.blocks : ["quartz_block", "lime_concrete", "light_blue_concrete", "yellow_concrete", "pink_concrete"]).map((b) => parseBlock(b));
  const every = o.checkpointEvery ?? 8;
  box(set, { x: -2, y: 0, z: -4 }, { x: 2, y: 0, z: 0 }, (x, y, z) => p.at("floor", x, y, z));
  r.markers.push({ kind: "start", pos: { x: 0, y: 1, z: -2 } });
  let x = 0, y = 0, z = 0, sway = 0;
  for (let j = 0; j < clampInt(o.jumps, 1, 500); j++) {
    let dy = 0;
    const roll = rng.next();
    if (roll < diff.up) dy = 1;
    else if (roll < diff.up + diff.down) dy = -1;
    let gap = rng.int(diff.gap[0], diff.gap[1]);
    if (dy === 1) gap = Math.min(gap, o.difficulty === "expert" ? 3 : 2);
    if (dy === -1) gap = Math.min(gap + 1, 4);
    // side step makes a diagonal jump, keep total distance inside the reach
    sway += rng.int(-1, 1);
    sway = Math.max(-3, Math.min(3, sway));
    const side = gap <= 2 ? Math.sign(sway) * rng.int(0, 1) : 0;
    x += side;
    z += gap + 1;
    y = Math.max(-20, Math.min(60, y + dy));
    const b = blocks[j % blocks.length];
    const checkpoint = every > 0 && (j + 1) % every === 0;
    if (checkpoint) {
      box(set, { x: x - 1, y, z: z - 1 }, { x: x + 1, y, z: z + 1 }, (xx, yy, zz) => p.at("floor", xx, yy, zz));
      set.set(x, y + 1, z, parseBlock("light_weighted_pressure_plate"));
      r.markers.push({ kind: "checkpoint", name: `cp_${(j + 1) / every}`, pos: { x, y: y + 1, z } });
    } else set.set(x, y, z, b);
    for (let k = 1; k <= 3; k++) set.set(x, y + k, z, AIR);
  }
  z += 2;
  box(set, { x: x - 2, y, z }, { x: x + 2, y, z: z + 4 }, (xx, yy, zz) => p.at("floor", xx, yy, zz));
  set.set(x, y + 1, z + 2, parseBlock("heavy_weighted_pressure_plate"));
  r.markers.push({ kind: "finish", pos: { x, y: y + 1, z: z + 2 } });
  r.notes.push(`${o.jumps} jumps, ${o.difficulty ?? "medium"}, ends ${y >= 0 ? "+" : ""}${y} blocks from the start height`);
  return r;
}

export interface LobbyOptions {
  radius: number;
  portals?: number;
  portalNames?: string[];
  fountain?: boolean;
}

/** Round spawn lobby: central fountain or spawn pad, paths out to named game portals, lights and trees. */
export function lobby(p: Palette, o: LobbyOptions): GenResult {
  const R = clampInt(o.radius, 8, 120);
  const n = clampInt(o.portals ?? 4, 0, 12);
  const r = result();
  const set = r.set;
  for (let x = -R; x <= R; x++)
    for (let z = -R; z <= R; z++) {
      const d = Math.hypot(x, z);
      if (d > R + 0.5) continue;
      set.set(x, -1, z, p.at("foundation", x, -1, z));
      set.set(x, 0, z, p.at(d > R - 1 ? "trim" : Math.round(d) % 5 === 0 ? "path_edge" : "floor", x, 0, z));
      for (let y = 1; y <= 6; y++) set.set(x, y, z, AIR);
      if (d > R - 0.5) set.set(x, 1, z, p.at("fence", x, 1, z));
    }
  if (o.fountain ?? true) {
    cylinder(set, { x: 0, y: 0, z: 0 }, 3, 2, (x, y, z) => p.at("trim", x, y, z), { hollow: true });
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) if (Math.hypot(x, z) < 2.5) set.set(x, 1, z, parseBlock("water"));
    for (let y = 1; y <= 4; y++) set.set(0, y, 0, p.at("pillar", 0, y, 0, { pillar_axis: "y" }));
    set.set(0, 5, 0, p.at("light", 0, 5, 0));
  }
  r.markers.push({ kind: "spawn", name: "lobby", pos: { x: 0, y: 1, z: 5 } });
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const px = Math.round(Math.cos(a) * (R - 4)), pz = Math.round(Math.sin(a) * (R - 4));
    for (let k = 4; k < R - 4; k++) {
      const x = Math.round(Math.cos(a) * k), z = Math.round(Math.sin(a) * k);
      for (let w = -1; w <= 1; w++) set.set(x + Math.round(-Math.sin(a) * w), 0, z + Math.round(Math.cos(a) * w), p.at("path", x, 0, z));
    }
    // portal frame: a small gate the player walks into, with a pressure plate as the trigger spot
    for (let y = 1; y <= 4; y++) for (const w of [-2, 2]) set.set(px + Math.round(-Math.sin(a) * w), y, pz + Math.round(Math.cos(a) * w), p.at("pillar", px, y, pz, { pillar_axis: "y" }));
    for (let w = -2; w <= 2; w++) set.set(px + Math.round(-Math.sin(a) * w), 5, pz + Math.round(Math.cos(a) * w), p.at("wall_accent", px, 5, pz));
    set.set(px, 1, pz, parseBlock("stone_pressure_plate"));
    const name = o.portalNames?.[i] ?? `game_${i + 1}`;
    r.markers.push({ kind: "portal", name, pos: { x: px, y: 1, z: pz } });
    const tx = Math.round(Math.cos(a + Math.PI / n) * (R - 6)), tz = Math.round(Math.sin(a + Math.PI / n) * (R - 6));
    tree(set, p.main("log").includes("cherry") ? "cherry" : "oak", { x: tx, y: 1, z: tz }, i * 17 + 3);
    set.set(tx, 0, tz, parseBlock("grass_block"));
  }
  r.notes.push(`lobby r=${R} with ${n} portals`);
  return r;
}

export interface DungeonOptions {
  width: number;
  depth: number;
  rooms?: number;
  roomHeight?: number;
  seed?: number;
}

interface Room { x: number; z: number; w: number; d: number }

/**
 * Rooms and corridors carved out of a solid block, meant to sit underground. Rooms get lights and chest
 * markers, the biggest room is the boss room, and every room is reachable since corridors follow a spanning tree.
 */
export function dungeon(p: Palette, o: DungeonOptions): GenResult {
  const W = clampInt(o.width, 20, 300), D = clampInt(o.depth, 20, 300);
  const rh = clampInt(o.roomHeight ?? 5, 3, 12);
  const rng = new Rng(o.seed ?? 13);
  const target = clampInt(o.rooms ?? Math.round((W * D) / 250), 2, 80);
  const r = result();
  const set = r.set;
  box(set, { x: -1, y: -1, z: -1 }, { x: W, y: rh + 1, z: D }, (x, y, z) => p.at("foundation", x, y, z));
  const rooms: Room[] = [];
  for (let tries = 0; tries < target * 40 && rooms.length < target; tries++) {
    const w = rng.int(5, 12), d = rng.int(5, 12);
    const x = rng.int(1, W - w - 2), z = rng.int(1, D - d - 2);
    if (rooms.some((q) => x < q.x + q.w + 2 && x + w + 2 > q.x && z < q.z + q.d + 2 && z + d + 2 > q.z)) continue;
    rooms.push({ x, z, w, d });
  }
  const center = (q: Room) => ({ x: q.x + Math.floor(q.w / 2), z: q.z + Math.floor(q.d / 2) });
  const carve = (x: number, z: number, h: number) => {
    set.set(x, 0, z, p.at("floor", x, 0, z));
    for (let y = 1; y <= h; y++) set.set(x, y, z, AIR);
  };
  for (const q of rooms) for (let x = q.x; x < q.x + q.w; x++) for (let z = q.z; z < q.z + q.d; z++) carve(x, z, rh);
  // prim style spanning tree on centre distance, then a couple of extra loops so it's not a pure tree
  const linked = new Set([0]);
  const edges: [number, number][] = [];
  while (linked.size < rooms.length) {
    let best: [number, number, number] | null = null;
    for (const i of linked) for (let j = 0; j < rooms.length; j++) {
      if (linked.has(j)) continue;
      const a = center(rooms[i]), b = center(rooms[j]);
      const dd = Math.abs(a.x - b.x) + Math.abs(a.z - b.z);
      if (!best || dd < best[2]) best = [i, j, dd];
    }
    if (!best) break;
    linked.add(best[1]);
    edges.push([best[0], best[1]]);
  }
  for (let k = 0; k < Math.floor(rooms.length / 4); k++) edges.push([rng.int(0, rooms.length - 1), rng.int(0, rooms.length - 1)]);
  for (const [i, j] of edges) {
    if (i === j) continue;
    const a = center(rooms[i]), b = center(rooms[j]);
    for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) for (const dz of [0, 1]) carve(x, a.z + dz, 3);
    for (let z = Math.min(a.z, b.z); z <= Math.max(a.z, b.z); z++) for (const dx of [0, 1]) carve(b.x + dx, z, 3);
  }
  let boss = rooms[0];
  for (const q of rooms) if (q.w * q.d > boss.w * boss.d) boss = q;
  rooms.forEach((q, i) => {
    const c = center(q);
    set.set(c.x, rh, c.z, { ...p.at("light", c.x, rh, c.z), states: p.main("light").includes("lantern") ? { hanging: true } : {} });
    if (q === boss) {
      r.markers.push({ kind: "boss", pos: { x: c.x, y: 1, z: c.z } });
      for (const [dx, dz] of [[1, 1], [-1, -1], [1, -1], [-1, 1]]) set.set(c.x + dx * Math.floor(q.w / 2 - 1), 1, c.z + dz * Math.floor(q.d / 2 - 1), p.at("pillar", 0, 0, 0, { pillar_axis: "y" }));
    } else if (i === 0) r.markers.push({ kind: "entrance", pos: { x: c.x, y: 1, z: c.z } });
    if (q !== boss && rng.chance(0.5)) {
      const chest = { x: q.x, y: 1, z: q.z };
      set.set(chest.x, chest.y, chest.z, { name: "minecraft:chest", states: { "minecraft:cardinal_direction": "south" } });
      r.markers.push({ kind: "chest", pos: chest, data: { tier: rng.pick(["common", "common", "rare"]) } });
    }
  });
  // stairwell up from the entrance room
  const e = center(rooms[0]);
  for (let s = 0; s <= rh + 1; s++) {
    set.set(e.x + s, s, e.z - 1, stairs(p, "stairs", e.x + s, s, e.z - 1, "east"));
    for (let k = 1; k <= 3; k++) set.set(e.x + s, s + k, e.z - 1, AIR);
  }
  r.markers.push({ kind: "stairs_top", pos: { x: e.x + rh + 1, y: rh + 2, z: e.z - 1 } });
  r.notes.push(`dungeon ${W}x${D}, ${rooms.length} rooms, ${edges.length} corridors`);
  return r;
}

export interface CityOptions {
  width: number;
  depth: number;
  blockSize?: number;
  roadWidth?: number;
  maxFloors?: number;
  parkChance?: number;
  seed?: number;
}

/**
 * City on a road grid. Lots near the middle get taller towers, the edges get houses, and some lots become
 * parks so it doesn't read as a copy pasted grid.
 */
export function city(p: Palette, o: CityOptions): GenResult {
  const W = clampInt(o.width, 40, 600), D = clampInt(o.depth, 40, 600);
  const bs = clampInt(o.blockSize ?? 24, 14, 64), rw = clampInt(o.roadWidth ?? 5, 3, 11);
  const rng = new Rng(o.seed ?? 101);
  const parts: GenResult[] = [];
  const roads = new Palette("modern", { path: { gray_concrete: 6, light_gray_concrete: 1 }, path_edge: "smooth_stone", fence: "iron_bars", light: "sea_lantern" });
  for (let x = 0; x <= W; x += bs + rw) parts.push(road(roads, { points: [{ x: x + Math.floor(rw / 2), y: 0, z: 0 }, { x: x + Math.floor(rw / 2), y: 0, z: D }], width: rw, lampEvery: 14, clearance: 0 }));
  for (let z = 0; z <= D; z += bs + rw) parts.push(road(roads, { points: [{ x: 0, y: 0, z: z + Math.floor(rw / 2) }, { x: W, y: 0, z: z + Math.floor(rw / 2) }], width: rw, lampEvery: 14, clearance: 0 }));
  const maxF = clampInt(o.maxFloors ?? 30, 2, 90);
  const cx = W / 2, cz = D / 2;
  const styles = ["modern", "skyscraper", "modern", "scifi"];
  let lots = 0;
  for (let lx = rw; lx + bs <= W; lx += bs + rw)
    for (let lz = rw; lz + bs <= D; lz += bs + rw) {
      lots++;
      const dist = Math.hypot(lx + bs / 2 - cx, lz + bs / 2 - cz) / Math.hypot(cx, cz);
      const lp = new Palette(rng.pick(styles), {}, rng.int(0, 999));
      if (rng.chance(o.parkChance ?? 0.12)) {
        const park = result();
        for (let x = 0; x < bs; x++) for (let z = 0; z < bs; z++) park.set.set(x, 0, z, parseBlock(x === Math.floor(bs / 2) || z === Math.floor(bs / 2) ? "grass_path" : "grass_block"));
        for (let k = 0; k < 4; k++) tree(park.set, rng.pick(["oak", "birch", "cherry"]), { x: rng.int(2, bs - 3), y: 1, z: rng.int(2, bs - 3) }, rng.int(0, 1e6));
        park.markers.push({ kind: "park", pos: { x: Math.floor(bs / 2), y: 1, z: Math.floor(bs / 2) } });
        parts.push(shift(park, { x: lx, y: 0, z: lz }));
        continue;
      }
      const floors = Math.max(2, Math.round(maxF * Math.pow(1 - dist, 2) * (0.6 + 0.6 * rng.next())));
      const facing = rng.pick(["north", "south", "east", "west"] as const);
      const margin = rng.int(1, 3);
      const size = bs - margin * 2;
      const b = floors > 5
        ? skyscraper(lp, { width: size, depth: size - rng.int(0, 4), floors, setbackEvery: floors > 15 ? rng.int(6, 10) : 0 })
        : house(lp, { width: size - 2, depth: size - 4, floors: Math.min(3, floors), roof: "flat", frame: false });
      parts.push(place(b, { x: lx + margin, y: 0, z: lz + margin }, facing));
    }
  const all = combine(...parts);
  all.notes = [`city ${W}x${D}, ${lots} lots, block ${bs}, roads ${rw} wide`];
  return all;
}
