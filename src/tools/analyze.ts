import { z } from "zod";
import { Box, Vec3, assertBoxInWorld, boxVolume, tileBox } from "../core/geometry.js";
import { readHeightmap, readRegion } from "../engine/read.js";
import { floatingGroups, reachable, standable, stats, symmetry } from "../analysis/checks.js";
import { renderHeightmap, renderIsometric, renderSlice, renderTopDown } from "../render/views.js";
import { Marker } from "../gen/common.js";
import { Ctx, Rich, boxArg, dimOf, dimension, registerTool, vec3 } from "./shared.js";

const VIEW_READ_LIMIT = 3_000_000;

export function registerAnalyze(ctx: Ctx) {
  const s = ctx.session;

  registerTool(ctx, "region_stats", "Count what's in a region of the world: block totals, the most used blocks and their share. Good for checking a palette or estimating materials.", {
    from: vec3, to: vec3, dimension,
  }, async (a) => {
    const box = boxArg(a.from, a.to);
    const { set } = await readRegion(s.requireBackend(), dimOf(a.dimension), box);
    return stats(set, box);
  }, { readOnlyHint: true });

  registerTool(ctx, "view", "Render a picture. source=last shows the last generated or imported build without touching the world; source=world reads a region. mode: iso (isometric 3D, view 0-3 picks the corner), top (top down), slice (vertical cut at slice_at along slice_axis), heightmap (terrain colours for big areas, cheap). Markers from the project can be drawn on top.", {
    source: z.enum(["last", "world"]).default("last"),
    mode: z.enum(["iso", "top", "slice", "heightmap"]).default("iso"),
    from: vec3.optional(), to: vec3.optional(),
    view: z.number().int().min(0).max(3).default(0),
    slice_axis: z.enum(["x", "z"]).default("z"),
    slice_at: z.number().int().optional(),
    max_size: z.number().int().min(128).max(2048).default(900),
    show_markers: z.boolean().default(true),
    dimension,
  }, async (a) => {
    let markers: Marker[] = [];
    if (a.show_markers) {
      if (a.source === "last") markers = ctx.last?.result.markers ?? [];
      else for (const m of Object.values(s.project.meta.markers ?? {})) markers.push(...(m.markers as Marker[]));
    }
    if (a.source === "world") {
      if (!a.from || !a.to) throw new Error("source=world needs from and to");
      const box = boxArg(a.from, a.to);
      const dim = dimOf(a.dimension);
      assertBoxInWorld(box, dim);
      const inside = (p: Vec3) => p.x >= box.min.x && p.x <= box.max.x && p.z >= box.min.z && p.z <= box.max.z;
      markers = markers.filter((m) => inside(m.pos));
      if (a.mode === "heightmap") {
        const h = await readHeightmap(s.requireBackend(), dim, box.min.x, box.min.z, box.max.x, box.max.z);
        return new Rich({ area: box, columns: h.width * h.depth }, [{ png: renderHeightmap(h, { x: box.min.x, z: box.min.z }, { maxSize: a.max_size, markers }), caption: "world heightmap, north up" }]);
      }
      if (boxVolume(box) > VIEW_READ_LIMIT) throw new Error(`that's ${boxVolume(box)} blocks to read, use mode=heightmap or a smaller box (limit ${VIEW_READ_LIMIT})`);
      const { set } = await readRegion(s.requireBackend(), dim, box);
      return render(set, a, markers, `world ${box.min.x},${box.min.y},${box.min.z} to ${box.max.x},${box.max.y},${box.max.z}`);
    }
    if (!ctx.last) throw new Error("nothing generated yet in this session, run generate (dry_run is fine) or use source=world");
    return render(ctx.last.result.set, a, markers, ctx.last.label);
  }, { readOnlyHint: true });

  registerTool(ctx, "find_blocks", "Find where certain blocks are inside a region (e.g. all chests, all diamond_ore, stray barrier blocks). Returns positions, capped by limit.", {
    from: vec3, to: vec3,
    blocks: z.array(z.string()).min(1),
    limit: z.number().int().min(1).max(5000).default(500),
    dimension,
  }, async (a) => {
    const b = s.requireBackend();
    const dim = dimOf(a.dimension);
    const box = boxArg(a.from, a.to);
    assertBoxInWorld(box, dim);
    const include = a.blocks.map((n: string) => (n.includes(":") ? n : `minecraft:${n}`));
    let total = 0;
    const positions: number[][] = [];
    let n = 0;
    for (const t of tileBox(box, { x: 64, y: 384, z: 64 })) {
      const release = b.caps.load ? await b.ensureLoaded(dim, t, `f${n++}`) : undefined;
      try {
        const r = await b.bridge<{ total: number; positions: number[][] }>("find", { dim, from: t.min, to: t.max, include, limit: a.limit - positions.length }, 300_000);
        total += r.total;
        positions.push(...r.positions);
      } finally {
        await release?.();
      }
    }
    return { total, shown: positions.length, positions };
  }, { readOnlyHint: true });

  registerTool(ctx, "list_entities", "Entities in a region (or everywhere loaded): type, id, name tag, position and tags.", {
    from: vec3.optional(), to: vec3.optional(), type: z.string().optional(),
    limit: z.number().int().min(1).max(2000).default(200),
    dimension,
  }, async (a) => {
    const b = s.requireBackend();
    const dim = dimOf(a.dimension);
    const box = a.from && a.to ? boxArg(a.from, a.to) : undefined;
    const release = box && b.caps.load && boxVolume({ min: { ...box.min, y: 0 }, max: { ...box.max, y: 0 } }) <= 256 * 256 ? await b.ensureLoaded(dim, box, "ents") : undefined;
    try {
      return await b.bridge("entities", { dim, from: box?.min, to: box?.max, type: a.type, limit: a.limit });
    } finally {
      await release?.();
    }
  }, { readOnlyHint: true });

  registerTool(ctx, "check_map", "Playability checks on a region: floating block groups, whether spawn points are safe (floor, headroom, no hazards), whether points can be reached on foot from a start (walk, step up, drop, sprint jumps), symmetry score for competitive maps, and dark spots where hostile mobs could spawn. Uses project markers as spawns when none are given.", {
    from: vec3, to: vec3,
    spawns: z.array(vec3).optional(),
    reach_from: vec3.optional(),
    reach_to: z.array(vec3).optional(),
    symmetry: z.enum(["mirror_x", "mirror_z", "rot180", "rot90", "none"]).default("none"),
    symmetry_exact: z.boolean().default(false).describe("compare block types too, not just shape (mixed palettes won't pass)"),
    dark_spots: z.boolean().default(false),
    light_threshold: z.number().int().min(1).max(15).default(1),
    dimension,
  }, async (a) => {
    const b = s.requireBackend();
    const dim = dimOf(a.dimension);
    const box: Box = boxArg(a.from, a.to);
    if (boxVolume(box) > 4_000_000) throw new Error("check_map reads every block, keep the box under 4M blocks");
    const { set } = await readRegion(b, dim, box);
    const out: Record<string, unknown> = { box, stats: stats(set, box).top.slice(0, 8) };
    out.floating = floatingGroups(set, box.min.y);
    let spawns: Vec3[] = a.spawns ?? [];
    if (!spawns.length) {
      for (const m of Object.values(s.project.meta.markers ?? {})) for (const mk of m.markers) if (mk.kind === "spawn") spawns.push(mk.pos);
      spawns = spawns.filter((p) => p.x >= box.min.x && p.x <= box.max.x && p.z >= box.min.z && p.z <= box.max.z && p.y >= box.min.y && p.y <= box.max.y);
    }
    out.spawns = spawns.map((p) => ({ pos: p, ...standable(set, p) }));
    if (a.reach_from && a.reach_to?.length) {
      const r = reachable(set, a.reach_from, a.reach_to);
      out.reachability = { startProblem: r.start, explored: r.explored, targets: a.reach_to.map((t: Vec3, i: number) => ({ pos: t, reachable: r.reached[i] ?? false })) };
    }
    if (a.symmetry !== "none") out.symmetry = symmetry(set, box, a.symmetry, a.symmetry_exact);
    if (a.dark_spots) {
      const dark: number[][] = [];
      let checked = 0, n = 0;
      for (const t of tileBox(box, { x: 32, y: 384, z: 32 })) {
        const release = b.caps.load ? await b.ensureLoaded(dim, t, `l${n++}`) : undefined;
        try {
          const r = await b.bridge<{ checked: number; dark: number[][] }>("light", { dim, from: t.min, to: t.max, threshold: a.light_threshold, limit: 500 }, 300_000);
          checked += r.checked;
          dark.push(...r.dark.slice(0, 500 - dark.length));
        } finally {
          await release?.();
        }
      }
      out.darkSpots = { walkableChecked: checked, below: a.light_threshold, count: dark.length, sample: dark.slice(0, 40), note: "Bedrock hostile mobs spawn on surfaces with block light 0" };
    }
    return out;
  }, { readOnlyHint: true });

  registerTool(ctx, "markers", "Markers saved from earlier builds in this project (spawns, doors, chests, checkpoints, portals...), grouped by the op that made them.", {}, async () => s.project.meta.markers ?? {}, { readOnlyHint: true });
}

function render(set: import("../core/voxels.js").VoxelSet, a: { mode: string; view: number; slice_axis: "x" | "z"; slice_at?: number; max_size: number }, markers: Marker[], label: string) {
  if (a.mode === "top" || a.mode === "heightmap") {
    const r = renderTopDown(set, { maxSize: a.max_size, markers });
    return new Rich({ label, blocks: set.size, legend: r.legend }, [{ png: r.png }]);
  }
  if (a.mode === "slice") {
    const b = set.bounds();
    const at = a.slice_at ?? (b ? Math.round(((a.slice_axis === "x" ? b.min.x + b.max.x : b.min.z + b.max.z)) / 2) : 0);
    const r = renderSlice(set, a.slice_axis, at, a.max_size);
    return new Rich({ label, legend: r.legend }, [{ png: r.png }]);
  }
  const r = renderIsometric(set, { maxSize: a.max_size, view: a.view, markers });
  return new Rich({ label, legend: r.legend }, [{ png: r.png }]);
}
