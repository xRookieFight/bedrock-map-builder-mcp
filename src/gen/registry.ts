import { z } from "zod";
import { Dimension, Vec3 } from "../core/geometry.js";
import { transformSet } from "../core/transform.js";
import { VoxelSet } from "../core/voxels.js";
import { HeightmapResult } from "../engine/backend.js";
import * as B from "./buildings.js";
import { Facing, GenResult, place, result, turnsFromSouth } from "./common.js";
import * as G from "./game.js";
import * as N from "./nature.js";
import { Material, Palette } from "./palette.js";
import { runScript } from "./script.js";
import * as S from "./shapes.js";
import * as T from "./terrain.js";

export interface GenContext {
  dim: Dimension;
  origin: Vec3;
  facing: Facing;
  palette: (style?: string, overrides?: Record<string, Material>, seed?: number) => Palette;
  /** Current terrain under an area. Only works with a world that can be read. */
  heightmap: (x1: number, z1: number, x2: number, z2: number) => Promise<HeightmapResult>;
}

export interface Generator {
  name: string;
  summary: string;
  /** How `origin` is used, shown in the help so the caller places things right the first time. */
  origin: string;
  schema: z.ZodType;
  run: (args: any, ctx: GenContext) => Promise<GenResult> | GenResult;
}

const xz = z.object({ x: z.number().int(), z: z.number().int() });
const xyz = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() });
const material = z.union([z.string(), z.record(z.string(), z.number())]);
const style = { style: z.string().optional().describe("palette style: medieval, castle, modern, skyscraper, fantasy, scifi, desert, nordic, japanese, nether, rustic, ice"), palette: z.record(z.string(), material).optional().describe("role overrides, e.g. {\"wall\":\"bricks\",\"roof\":{\"deepslate_tiles\":3,\"cobbled_deepslate\":1}}"), seed: z.number().int().optional() };

/** Rotates a result built around local 0,0,0 (centre or start point) and moves that point onto origin. */
function orient(r: GenResult, origin: Vec3, facing: Facing): GenResult {
  const t = turnsFromSouth(facing);
  const set = t ? transformSet(r.set, { rotate: t, pivot: { x: 0, y: 0, z: 0 } }) : r.set;
  const out = new VoxelSet().merge(set, origin);
  const rot = (p: Vec3): Vec3 => {
    let x = p.x, zz = p.z;
    for (let k = 0; k < t; k++) [x, zz] = [-zz, x];
    return { x: x + origin.x, y: p.y + origin.y, z: zz + origin.z };
  };
  return { set: out, markers: r.markers.map((m) => ({ ...m, pos: rot(m.pos) })), notes: r.notes };
}

const pal = (a: any, ctx: GenContext, fallback: string) => ctx.palette(a.style ?? fallback, a.palette, a.seed);

const shapeSchema = z.object({
  type: z.enum(["box", "sphere", "ellipsoid", "cylinder", "cone", "pyramid", "line", "torus", "arch", "prism", "wall"]),
  block: material.describe("block, weighted mix, or @role from the palette. Use air to carve"),
  from: xyz.optional(), to: xyz.optional(), center: xyz.optional(), base: xyz.optional(),
  radius: z.number().optional(), radii: xyz.optional(), height: z.number().optional(),
  mode: z.enum(["solid", "hollow", "walls", "outline", "floor", "ceiling"]).optional(),
  hollow: z.boolean().optional(), thickness: z.number().optional(), half: z.enum(["top", "bottom"]).optional(),
  axis: z.enum(["x", "y", "z"]).optional(), radius2: z.number().optional(), minor: z.number().optional(),
  depth: z.number().optional(), points: z.array(xz).optional(), y1: z.number().optional(), y2: z.number().optional(), step: z.number().optional(),
});

export const GENERATORS: Generator[] = [
  {
    name: "shapes",
    summary: "Any mix of primitives (box, sphere, ellipsoid, cylinder, cone, pyramid, line, torus, arch, prism, wall) in absolute coordinates. Later shapes overwrite earlier ones, so carve with block 'air' last.",
    origin: "ignored, every shape carries absolute coordinates",
    schema: z.object({ shapes: z.array(shapeSchema).min(1), ...style }),
    run(a, ctx) {
      const p = pal(a, ctx, "rustic");
      const r = result();
      for (const s of a.shapes as z.infer<typeof shapeSchema>[]) {
        const m = s.block;
        const brush: S.Brush = (x, y, zz) => p.at(m as Material, x, y, zz);
        const need = <T>(v: T | undefined, what: string): T => {
          if (v === undefined) throw new Error(`${s.type} needs ${what}`);
          return v;
        };
        switch (s.type) {
          case "box": S.box(r.set, need(s.from, "from"), need(s.to, "to"), brush, s.mode ?? "solid", s.thickness); break;
          case "sphere": S.sphere(r.set, need(s.center, "center"), need(s.radius, "radius"), brush, { hollow: s.hollow, thickness: s.thickness, half: s.half }); break;
          case "ellipsoid": S.ellipsoid(r.set, need(s.center, "center"), need(s.radii, "radii"), brush, { hollow: s.hollow, thickness: s.thickness, half: s.half }); break;
          case "cylinder": S.cylinder(r.set, need(s.base, "base"), need(s.radius, "radius"), need(s.height, "height"), brush, { axis: s.axis, hollow: s.hollow, thickness: s.thickness, radius2: s.radius2 }); break;
          case "cone": S.cone(r.set, need(s.base, "base"), need(s.radius, "radius"), need(s.height, "height"), brush, { hollow: s.hollow, axis: s.axis }); break;
          case "pyramid": S.pyramid(r.set, need(s.base, "base"), need(s.radius, "radius (half size)"), need(s.height, "height"), brush, { hollow: s.hollow, step: s.step }); break;
          case "line": S.line(r.set, need(s.from, "from"), need(s.to, "to"), brush, s.radius ?? 0); break;
          case "torus": S.torus(r.set, need(s.center, "center"), need(s.radius, "radius"), need(s.minor, "minor"), brush, s.axis); break;
          case "arch": S.arch(r.set, need(s.from, "from"), need(s.to, "to"), need(s.height, "height"), s.thickness ?? 1, s.depth ?? 1, brush); break;
          case "prism": S.prism(r.set, need(s.points, "points"), need(s.y1, "y1"), need(s.y2, "y2"), brush, s.hollow); break;
          case "wall": S.pathWall(r.set, need(s.points, "points"), need(s.y1, "y1"), need(s.height, "height"), s.thickness ?? 1, brush); break;
        }
      }
      return r;
    },
  },
  {
    name: "script",
    summary: "Free form JS for anything else. API: set(x,y,z,block), get, clear, box(from,to,block,mode), sphere, ellipsoid, cylinder, cone, pyramid, line, torus, arch, prism, tree(kind,at,seed,scale), palette(role,x,y,z), marker(kind,pos,name), note(text), noise.noise2/noise3/fbm2/ridged2, rng.next/int/pick/chance, Math. Blocks may be '@role'. 20 s timeout, 5M block cap.",
    origin: "available to the script as the variable origin {x,y,z}",
    schema: z.object({ code: z.string().min(1), ...style }),
    run(a, ctx) {
      const code = `const origin = ${JSON.stringify(ctx.origin)};\n${a.code}`;
      return runScript(code, pal(a, ctx, "rustic"), a.seed ?? 1);
    },
  },
  {
    name: "house",
    summary: "House with foundation, walls, windows, front door, floors with stairs, lights, furniture and a gable/hip/flat/dome/none roof.",
    origin: "min corner of the footprint at ground level (the foundation layer sits at origin.y). facing = side with the door",
    schema: z.object({ width: z.number().int().min(5).max(64), depth: z.number().int().min(5).max(64), floors: z.number().int().min(1).max(20).optional(), floorHeight: z.number().int().min(3).max(8).optional(), roof: z.enum(["gable", "hip", "flat", "dome", "none"]).optional(), windowSpacing: z.number().int().optional(), furnish: z.boolean().optional(), frame: z.boolean().optional(), ...style }),
    run: (a, ctx) => place(B.house(pal(a, ctx, "medieval"), a), ctx.origin, ctx.facing),
  },
  {
    name: "tower",
    summary: "Round or square tower with spiral stairs, arrow slits, optional floors and battlements/cone/dome/flat top.",
    origin: "centre of the base",
    schema: z.object({ radius: z.number().int().min(2).max(32), height: z.number().int().min(4).max(300), shape: z.enum(["round", "square"]).optional(), top: z.enum(["battlements", "cone", "flat", "dome"]).optional(), floorEvery: z.number().int().optional(), stairs: z.boolean().optional(), ...style }),
    run: (a, ctx) => orient(B.tower(pal(a, ctx, "castle"), a), ctx.origin, ctx.facing),
  },
  {
    name: "wall",
    summary: "Defensive wall along a polyline with walkway, crenellations and towers at every vertex (and every N blocks).",
    origin: "only origin.y is used (base height); points are absolute x/z",
    schema: z.object({ points: z.array(xz).min(2), height: z.number().int().min(2).max(200), thickness: z.number().int().min(1).max(9).optional(), battlements: z.boolean().optional(), towerEvery: z.number().int().optional(), towerRadius: z.number().int().optional(), closed: z.boolean().optional(), ...style }),
    run: (a, ctx) => B.wall(pal(a, ctx, "castle"), a, ctx.origin.y),
  },
  {
    name: "castle",
    summary: "Square castle: curtain wall, corner towers, gatehouse with two towers, keep and courtyard paths.",
    origin: "centre of the courtyard at ground level. facing = side with the gate",
    schema: z.object({ size: z.number().int().min(24).max(400), wallHeight: z.number().int().optional(), keepFloors: z.number().int().optional(), ...style }),
    run: (a, ctx) => orient(B.castle(pal(a, ctx, "castle"), a), ctx.origin, ctx.facing),
  },
  {
    name: "bridge",
    summary: "Bridge deck between two absolute points with railings, lamps and arches below. Ramps when the ends differ in height.",
    origin: "ignored, uses from/to",
    schema: z.object({ from: xyz, to: xyz, width: z.number().int().optional(), railing: z.enum(["fence", "wall", "none"]).optional(), arches: z.boolean().optional(), supportDepth: z.number().int().optional(), ...style }),
    run: (a, ctx) => B.bridge(pal(a, ctx, "castle"), a),
  },
  {
    name: "road",
    summary: "Road along absolute x/y/z points with edges, lamp posts and cleared headroom.",
    origin: "ignored, uses points",
    schema: z.object({ points: z.array(xyz).min(2), width: z.number().int().optional(), lampEvery: z.number().int().optional(), clearance: z.number().int().optional(), ...style }),
    run: (a, ctx) => B.road(pal(a, ctx, "rustic"), a),
  },
  {
    name: "skyscraper",
    summary: "Glass and frame tower with floors, ceiling lights, setbacks, roof parapet, antenna and a lobby entrance.",
    origin: "min corner of the footprint. facing = entrance side",
    schema: z.object({ width: z.number().int().min(7).max(64), depth: z.number().int().min(7).max(64), floors: z.number().int().min(2).max(90), floorHeight: z.number().int().optional(), setbackEvery: z.number().int().optional(), antenna: z.boolean().optional(), ...style }),
    run: (a, ctx) => place(B.skyscraper(pal(a, ctx, "skyscraper"), a), ctx.origin, ctx.facing),
  },
  {
    name: "city",
    summary: "Road grid city: towers grow toward the centre, houses at the edges, random parks, lamps. Varies styles per lot.",
    origin: "min corner of the city area at street level",
    schema: z.object({ width: z.number().int().min(40).max(600), depth: z.number().int().min(40).max(600), blockSize: z.number().int().optional(), roadWidth: z.number().int().optional(), maxFloors: z.number().int().optional(), parkChance: z.number().optional(), ...style }),
    run: (a, ctx) => place(G.city(pal(a, ctx, "modern"), a), ctx.origin, "south"),
  },
  {
    name: "arena",
    summary: "PvP/FFA/KitPvP arena: circle or square, team spawn pads in team colours (teams=1 gives FFA spawns around the edge), rotationally symmetric cover, floor patterns, seating, optional barrier roof.",
    origin: "centre of the arena floor",
    schema: z.object({ radius: z.number().int().min(8).max(150), shape: z.enum(["circle", "square"]).optional(), teams: z.number().int().min(1).max(8).optional(), wallHeight: z.number().int().optional(), cover: z.enum(["pillars", "walls", "mixed", "none"]).optional(), coverDensity: z.number().optional(), floorPattern: z.enum(["rings", "checker", "plain", "noise"]).optional(), seating: z.boolean().optional(), roofBarrier: z.boolean().optional(), ...style }),
    run: (a, ctx) => orient(G.arena(pal(a, ctx, "castle"), a), ctx.origin, ctx.facing),
  },
  {
    name: "parkour",
    summary: "Jump course with start and finish platforms and checkpoint plates. Jumps stay within sprint jump reach for the difficulty.",
    origin: "start platform; the course runs toward facing",
    schema: z.object({ jumps: z.number().int().min(1).max(500), difficulty: z.enum(["easy", "medium", "hard", "expert"]).optional(), checkpointEvery: z.number().int().optional(), blocks: z.array(z.string()).optional(), ...style }),
    run: (a, ctx) => orient(G.parkour(pal(a, ctx, "modern"), a), ctx.origin, ctx.facing),
  },
  {
    name: "lobby",
    summary: "Round spawn lobby with fountain, paths to named portal gates (pressure plate markers), trees and lights.",
    origin: "centre of the lobby floor",
    schema: z.object({ radius: z.number().int().min(8).max(120), portals: z.number().int().optional(), portalNames: z.array(z.string()).optional(), fountain: z.boolean().optional(), ...style }),
    run: (a, ctx) => orient(G.lobby(pal(a, ctx, "fantasy"), a), ctx.origin, ctx.facing),
  },
  {
    name: "dungeon",
    summary: "Rooms and corridors carved from a solid block (put it underground), chest and boss room markers, stairs up from the entrance.",
    origin: "min corner of the dungeon floor",
    schema: z.object({ width: z.number().int().min(20).max(300), depth: z.number().int().min(20).max(300), rooms: z.number().int().optional(), roomHeight: z.number().int().optional(), ...style }),
    run: (a, ctx) => place(G.dungeon(pal(a, ctx, "castle"), { ...a, seed: a.seed }), ctx.origin, ctx.facing),
  },
  {
    name: "tree",
    summary: "One tree: oak, big_oak, spruce, birch, jungle, palm, cherry, dark_oak, dead, bush.",
    origin: "base of the trunk (first log block)",
    schema: z.object({ kind: z.enum(["oak", "big_oak", "spruce", "birch", "jungle", "palm", "cherry", "dark_oak", "dead", "bush"]), scale: z.number().optional(), seed: z.number().int().optional() }),
    run(a, ctx) {
      const r = result();
      N.tree(r.set, a.kind, ctx.origin, a.seed ?? 1, a.scale ?? 1);
      return r;
    },
  },
  {
    name: "vegetation",
    summary: "Scatter trees, rocks and plants on the real ground of an area (reads the world heightmap), or on a flat y when ground_y is given. Skips water and sand by default.",
    origin: "ignored, uses area",
    schema: z.object({ area: z.object({ x1: z.number().int(), z1: z.number().int(), x2: z.number().int(), z2: z.number().int() }), kinds: z.array(z.enum(["oak", "big_oak", "spruce", "birch", "jungle", "palm", "cherry", "dark_oak", "dead", "bush", "rock", "plants"])).min(1), density: z.number().min(0).max(100), spacing: z.number().int().optional(), scale: z.number().optional(), groundY: z.number().int().optional(), onlyOn: z.array(z.string()).optional(), seed: z.number().int().optional() }),
    async run(a, ctx) {
      const ar = a.area;
      if (a.groundY !== undefined) return N.scatter(ar, () => a.groundY, a);
      const h = await ctx.heightmap(ar.x1, ar.z1, ar.x2, ar.z2);
      const w = h.width;
      const x0 = Math.min(ar.x1, ar.x2), z0 = Math.min(ar.z1, ar.z2);
      const only: string[] = (a.onlyOn ?? ["minecraft:grass_block", "minecraft:dirt", "minecraft:podzol", "minecraft:coarse_dirt", "minecraft:moss_block"]).map((s: string) => (s.includes(":") ? s : `minecraft:${s}`));
      return N.scatter(ar, (x, zz) => h.heights[(zz - z0) * w + (x - x0)] ?? null, a, (x, zz) => only.includes(h.tops[(zz - z0) * w + (x - x0)] ?? ""));
    },
  },
  {
    name: "terrain",
    summary: "New terrain over an area: plains, hills, mountains, islands, dunes, plateau, canyon, flat. Beaches, snow line, stone on steep slopes, optional water level. blend > 0 reads the current ground and fades into it at the edges.",
    origin: "ignored, uses area and baseY",
    schema: z.object({ area: z.object({ x1: z.number().int(), z1: z.number().int(), x2: z.number().int(), z2: z.number().int() }), kind: z.enum(["plains", "hills", "mountains", "islands", "dunes", "plateau", "canyon", "flat"]), baseY: z.number().int(), amplitude: z.number().optional(), scale: z.number().optional(), waterLevel: z.number().int().nullable().optional(), bottomY: z.number().int().optional(), clearToY: z.number().int().optional(), blend: z.number().int().optional(), materials: z.record(z.string(), z.union([z.string(), z.number()])).optional(), seed: z.number().int().optional() }),
    async run(a, ctx) {
      const ar = { x1: Math.min(a.area.x1, a.area.x2), z1: Math.min(a.area.z1, a.area.z2), x2: Math.max(a.area.x1, a.area.x2), z2: Math.max(a.area.z1, a.area.z2) };
      let edge;
      if (a.blend) {
        const h = await ctx.heightmap(ar.x1, ar.z1, ar.x2, ar.z2);
        edge = { heights: h.heights, blend: a.blend };
      }
      return T.generateTerrain(ar, { ...a, dim: ctx.dim, edge });
    },
  },
  {
    name: "sculpt",
    summary: "Edit the existing ground in a circle or square: raise, lower, flatten/level to targetY, or smooth. Reads the world heightmap and keeps each column's own top block.",
    origin: "ignored, uses center",
    schema: z.object({ mode: z.enum(["raise", "lower", "flatten", "smooth", "level"]), center: xz, radius: z.number().int().min(1).max(500), amount: z.number().optional(), targetY: z.number().int().optional(), falloff: z.number().min(0).max(1).optional(), square: z.boolean().optional() }),
    async run(a, ctx) {
      const R = a.radius;
      const h = await ctx.heightmap(a.center.x - R, a.center.z - R, a.center.x + R, a.center.z + R);
      return T.sculpt(h, { x: a.center.x - R, z: a.center.z - R }, a, ctx.dim);
    },
  },
  {
    name: "river",
    summary: "Carve a meandering river along x/z points with sloped sandy banks, water surface at surfaceY - 1.",
    origin: "ignored",
    schema: z.object({ points: z.array(xz).min(2), surfaceY: z.number().int(), width: z.number().int().optional(), depth: z.number().int().optional(), meander: z.number().optional(), seed: z.number().int().optional() }),
    run: (a) => T.river(a),
  },
  {
    name: "lake",
    summary: "Bowl shaped lake (or lava lake) with a noisy shoreline.",
    origin: "centre of the lake surface (origin.y is the water surface + 1)",
    schema: z.object({ radius: z.number().min(2).max(200), depth: z.number().int().min(1).max(60), liquid: z.enum(["water", "lava"]).optional(), seed: z.number().int().optional() }),
    run: (a, ctx) => T.lake(ctx.origin, a.radius, a.depth, a.seed, a.liquid),
  },
  {
    name: "caves",
    summary: "Worm cave tunnels carved through an area between yMin and yMax, optional lava below a level.",
    origin: "ignored",
    schema: z.object({ area: z.object({ x1: z.number().int(), z1: z.number().int(), x2: z.number().int(), z2: z.number().int() }), yMin: z.number().int(), yMax: z.number().int(), count: z.number().int().optional(), length: z.number().int().optional(), radius: z.number().optional(), lavaBelow: z.number().int().optional(), seed: z.number().int().optional() }),
    run: (a) => T.caves(a.area, a.yMin, a.yMax, a),
  },
  {
    name: "mountain",
    summary: "Single ridged mountain or volcano rising from origin.y.",
    origin: "centre of the base",
    schema: z.object({ radius: z.number().min(5).max(300), height: z.number().int().min(3).max(380), volcano: z.boolean().optional(), snowLine: z.number().int().optional(), seed: z.number().int().optional() }),
    run: (a, ctx) => T.mountain(ctx.origin, a.radius, a.height, a),
  },
];

export function getGenerator(name: string): Generator {
  const g = GENERATORS.find((x) => x.name === name);
  if (!g) throw new Error(`unknown generator "${name}". Generators: ${GENERATORS.map((x) => x.name).join(", ")}`);
  return g;
}

export function generatorHelp(name?: string): unknown {
  const list = name ? [getGenerator(name)] : GENERATORS;
  return list.map((g) => ({ name: g.name, summary: g.summary, origin: g.origin, args: name ? z.toJSONSchema(g.schema) : undefined }));
}
