import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import { AIR, isAir } from "../core/block.js";
import { Box, Vec3, assertBoxInWorld, boxSize, boxVolume } from "../core/geometry.js";
import { decodeMcStructure, encodeMcStructure } from "../core/mcstructure.js";
import { blockStateInfo, javaAlias, registryVersion, searchBlocks, suggestBlocks, validateBlock } from "../core/registry.js";
import { transformSet } from "../core/transform.js";
import { VoxelSet } from "../core/voxels.js";
import { applyVoxels, ApplyReport } from "../engine/apply.js";
import { readHeightmap, readRegion } from "../engine/read.js";
import { GenResult } from "../gen/common.js";
import { Material, Palette, STYLES } from "../gen/palette.js";
import { GENERATORS, generatorHelp, getGenerator } from "../gen/registry.js";
import { box as drawBox } from "../gen/shapes.js";
import { renderIsometric, renderTopDown } from "../render/views.js";
import { Ctx, Rich, boxArg, dimOf, dimension, registerTool, validateSet, vec3 } from "./shared.js";

const MAX_EDIT = 20_000_000;
const facing = z.enum(["north", "east", "south", "west"]).default("south");
const material = z.union([z.string(), z.record(z.string(), z.number())]);

function previewImages(r: GenResult, mode: string | undefined, label: string) {
  if (!mode || mode === "none") return [];
  if (r.set.size > 6_000_000) return [{ png: renderTopDown(r.set, { markers: r.markers }).png, caption: `${label}: top down (too big for isometric)` }];
  if (mode === "top") return [{ png: renderTopDown(r.set, { markers: r.markers }).png, caption: `${label}: top down, north up` }];
  if (mode === "both") {
    return [
      { png: renderIsometric(r.set, { markers: r.markers }).png, caption: `${label}: isometric from the south east` },
      { png: renderTopDown(r.set, { markers: r.markers }).png, caption: `${label}: top down, north up` },
    ];
  }
  return [{ png: renderIsometric(r.set, { markers: r.markers }).png, caption: `${label}: isometric from the south east` }];
}

function summarize(set: VoxelSet) {
  const b = set.bounds();
  const h = set.histogram();
  return {
    blocks: set.size,
    bounds: b,
    size: b ? boxSize(b) : null,
    materials: [...h.entries()].sort((a, c) => c[1] - a[1]).slice(0, 15).map(([i, n]) => `${set.palette[i].name.replace("minecraft:", "")} x${n}`),
  };
}

export async function applyResult(ctx: Ctx, r: GenResult, label: string, dim: ReturnType<typeof dimOf>, opts: { undo?: boolean; filter?: { include?: string[]; exclude?: string[] }; resume?: string; verify?: number }): Promise<ApplyReport> {
  const backend = ctx.session.requireBackend();
  return applyVoxels(backend, ctx.session.project, r.set, { label, dim, undo: opts.undo, filter: opts.filter, resumeOpId: opts.resume, verifySamples: opts.verify });
}

export function registerBuild(ctx: Ctx) {
  const s = ctx.session;

  registerTool(ctx, "generator_help", "List the generators with what they build and how origin is used, or the full argument schema of one generator.", {
    generator: z.string().optional(),
  }, async (a) => ({ generators: generatorHelp(a.generator), styles: Object.values(STYLES).map((x) => `${x.name}: ${x.description}`) }), { readOnlyHint: true });

  registerTool(ctx, "generate", `Build something with a generator and write it into the world (undoable), or preview it with dry_run (no world needed). Generators: ${GENERATORS.map((g) => g.name).join(", ")}. Call generator_help for arguments. Returns markers (spawns, doors, chests, checkpoints...) for follow up steps like set_spawn or fill_container. preview adds a rendered image.`, {
    generator: z.string(),
    args: z.record(z.string(), z.any()).default({}),
    origin: vec3.optional(),
    facing,
    dimension,
    dry_run: z.boolean().default(false),
    preview: z.enum(["iso", "top", "both", "none"]).optional(),
    undo: z.boolean().default(true),
    label: z.string().max(80).optional(),
    resume_op: z.string().optional().describe("op id of an interrupted run of the exact same call, finished tiles are skipped"),
  }, async (a) => {
    const g = getGenerator(a.generator);
    const parsed = g.schema.safeParse(a.args);
    if (!parsed.success) {
      throw new Error(`bad args for ${g.name}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Origin: ${g.origin}`);
    }
    const dim = dimOf(a.dimension);
    const origin: Vec3 = a.origin ?? { x: 0, y: 0, z: 0 };
    const res = await g.run(parsed.data, {
      dim,
      origin,
      facing: a.facing,
      palette: (style = "rustic", overrides = {}, seed = 0) => new Palette(style, { ...s.project.meta.palette, ...overrides }, seed),
      heightmap: (x1, z1, x2, z2) => readHeightmap(s.requireBackend(), dim, x1, z1, x2, z2),
    });
    const v = validateSet(res.set);
    res.set = v.set;
    res.notes.push(...v.notes);
    if (res.set.size > MAX_EDIT) throw new Error(`${res.set.size} blocks is over the ${MAX_EDIT} per call limit, split it into parts or a plan`);
    const label = a.label ?? `${g.name}${a.origin ? ` at ${origin.x} ${origin.y} ${origin.z}` : ""}`;
    ctx.last = { label, result: res };
    const b = res.set.bounds();
    if (b) assertBoxInWorld(b, dim);
    const info = { generator: g.name, ...summarize(res.set), markers: res.markers, notes: res.notes };
    if (a.dry_run) return new Rich({ dryRun: true, ...info }, previewImages(res, a.preview ?? "iso", label));
    const report = await applyResult(ctx, res, label, dim, { undo: a.undo, resume: a.resume_op });
    if (res.markers.length) {
      s.project.meta.markers = { ...(s.project.meta.markers ?? {}), [report.opId]: { label, markers: res.markers } };
      s.project.saveMeta();
    }
    return new Rich({ ...report, markers: res.markers, notes: res.notes }, previewImages(res, a.preview, label));
  });

  registerTool(ctx, "place_blocks", "Set individual blocks at exact coordinates (up to 20000). Block names are checked first; states use the [state=value] form.", {
    blocks: z.array(z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int(), block: z.string() })).min(1).max(20000),
    dimension,
    undo: z.boolean().default(true),
  }, async (a) => {
    const set = new VoxelSet();
    for (const b of a.blocks) set.set(b.x, b.y, b.z, validateBlock(b.block).block);
    return applyResult(ctx, { set, markers: [], notes: [] }, `place ${a.blocks.length} blocks`, dimOf(a.dimension), { undo: a.undo });
  });

  registerTool(ctx, "fill_region", "Fill a box with a block, a weighted mix ({\"stone\":3,\"andesite\":1}) or a palette role (@wall). mode: solid, hollow, walls, outline, floor, ceiling. only_replace limits the fill to those block types, keep protects them.", {
    from: vec3,
    to: vec3,
    block: material,
    mode: z.enum(["solid", "hollow", "walls", "outline", "floor", "ceiling"]).default("solid"),
    thickness: z.number().int().min(1).max(32).default(1),
    only_replace: z.array(z.string()).optional(),
    keep: z.array(z.string()).optional(),
    style: z.string().optional(),
    dimension,
    undo: z.boolean().default(true),
  }, async (a) => {
    const box = boxArg(a.from, a.to);
    const dim = dimOf(a.dimension);
    assertBoxInWorld(box, dim);
    if (boxVolume(box) > MAX_EDIT) throw new Error(`box has ${boxVolume(box)} cells, over the ${MAX_EDIT} limit`);
    const p = new Palette(a.style ?? "rustic", s.project.meta.palette);
    const set = new VoxelSet();
    drawBox(set, box.min, box.max, (x, y, z) => p.at(a.block as Material, x, y, z), a.mode, a.thickness);
    const v = validateSet(set);
    const norm = (l?: string[]) => l?.map((n) => validateBlock(n).block.name);
    const filter = a.only_replace || a.keep ? { include: norm(a.only_replace), exclude: norm(a.keep) } : undefined;
    const r = await applyResult(ctx, { set: v.set, markers: [], notes: [] }, `fill ${a.mode} ${JSON.stringify(a.block)}`, dim, { undo: a.undo, filter });
    return { ...r, notes: v.notes };
  });

  registerTool(ctx, "replace_blocks", "Swap one or more block types for another block or mix inside a box, leaving everything else alone. Matches by block type, states are ignored when matching.", {
    from: vec3,
    to: vec3,
    find: z.array(z.string()).min(1),
    replace_with: material,
    dimension,
    undo: z.boolean().default(true),
  }, async (a) => {
    const h = ctx.handlers.get("fill_region")!;
    return h({ from: a.from, to: a.to, block: a.replace_with, mode: "solid", only_replace: a.find, dimension: a.dimension, undo: a.undo });
  });

  registerTool(ctx, "clear_region", "Set a box to air (keep lets some blocks survive, e.g. bedrock).", {
    from: vec3,
    to: vec3,
    keep: z.array(z.string()).optional(),
    dimension,
    undo: z.boolean().default(true),
  }, async (a) => ctx.handlers.get("fill_region")!({ from: a.from, to: a.to, block: "air", keep: a.keep, dimension: a.dimension, undo: a.undo }));

  registerTool(ctx, "copy_region", "Copy, move, rotate, mirror or repeat a region. dest is where the source's min corner ends up. rotate is quarter turns clockwise (block facing rotates too). repeat > 1 stacks copies every `step`. move clears the source. skip_air leaves the destination's existing blocks where the source has air. Chest contents and other block entity data are not copied.", {
    from: vec3,
    to: vec3,
    dest: vec3,
    rotate: z.number().int().min(0).max(3).default(0),
    mirror: z.enum(["none", "x", "z"]).default("none"),
    repeat: z.number().int().min(1).max(256).default(1),
    step: vec3.optional(),
    move: z.boolean().default(false),
    skip_air: z.boolean().default(false),
    dimension,
    undo: z.boolean().default(true),
  }, async (a) => {
    const dim = dimOf(a.dimension);
    const src: Box = boxArg(a.from, a.to);
    const backend = s.requireBackend();
    const { set } = await readRegion(backend, dim, src);
    let t = transformSet(set, { rotate: a.rotate, mirror: a.mirror, pivot: src.min });
    if (a.skip_air) {
      const solid = new VoxelSet();
      t.forEach((x, y, z, i) => { if (!isAir(t.palette[i])) solid.set(x, y, z, t.palette[i]); });
      t = solid;
    }
    const tb = t.bounds();
    const out = new VoxelSet();
    if (a.move) for (let y = src.min.y; y <= src.max.y; y++) for (let z = src.min.z; z <= src.max.z; z++) for (let x = src.min.x; x <= src.max.x; x++) out.set(x, y, z, AIR);
    if (tb) {
      const step = a.step ?? { x: boxSize(src).x, y: 0, z: 0 };
      for (let k = 0; k < a.repeat; k++) {
        out.merge(t, { x: a.dest.x - tb.min.x + step.x * k, y: a.dest.y - tb.min.y + step.y * k, z: a.dest.z - tb.min.z + step.z * k });
      }
    }
    if (out.size > MAX_EDIT) throw new Error(`result has ${out.size} blocks, over the ${MAX_EDIT} limit`);
    ctx.last = { label: "copy", result: { set: out, markers: [], notes: [] } };
    return applyResult(ctx, { set: out, markers: [], notes: [] }, `${a.move ? "move" : "copy"} ${src.min.x},${src.min.y},${src.min.z} -> ${a.dest.x},${a.dest.y},${a.dest.z}`, dim, { undo: a.undo });
  });

  registerTool(ctx, "structure_export", "Save a region of the world as a .mcstructure file (the format structure blocks and /structure load use).", {
    from: vec3,
    to: vec3,
    file: z.string().min(1),
    dimension,
  }, async (a) => {
    if (!isAbsolute(a.file) || !a.file.endsWith(".mcstructure")) throw new Error("file must be an absolute path ending in .mcstructure");
    const dim = dimOf(a.dimension);
    const src = boxArg(a.from, a.to);
    const size = boxSize(src);
    if (size.x > 1024 || size.y > 384 || size.z > 1024) throw new Error("structures above 1024x384x1024 aren't supported");
    const { set, waterlogged } = await readRegion(s.requireBackend(), dim, src);
    const local = new VoxelSet().merge(set, { x: -src.min.x, y: -src.min.y, z: -src.min.z });
    const secondary = new VoxelSet();
    for (const w of waterlogged) secondary.set(w.x - src.min.x, w.y - src.min.y, w.z - src.min.z, "minecraft:water[liquid_depth=0]");
    const buf = encodeMcStructure({ size, origin: src.min, blocks: local, secondary });
    mkdirSync(dirname(a.file), { recursive: true });
    writeFileSync(a.file, buf);
    return { file: a.file, bytes: buf.length, size, blocks: set.size, note: "block entity data (chest contents, sign text) isn't included" };
  });

  registerTool(ctx, "structure_import", "Place a .mcstructure file into the world at origin (its min corner), optionally rotated or mirrored. Structure void cells leave the world alone. preview_only renders it without writing.", {
    file: z.string().min(1),
    origin: vec3.optional(),
    rotate: z.number().int().min(0).max(3).default(0),
    mirror: z.enum(["none", "x", "z"]).default("none"),
    skip_air: z.boolean().default(false),
    preview_only: z.boolean().default(false),
    dimension,
    undo: z.boolean().default(true),
  }, async (a) => {
    const st = decodeMcStructure(readFileSync(a.file));
    let set = transformSet(st.blocks, { rotate: a.rotate, mirror: a.mirror, pivot: { x: 0, y: 0, z: 0 } });
    if (a.skip_air) {
      const solid = new VoxelSet();
      set.forEach((x, y, z, i) => { if (!isAir(set.palette[i])) solid.set(x, y, z, set.palette[i]); });
      set = solid;
    }
    const b = set.bounds();
    const origin = a.origin ?? st.origin;
    const placed = b ? new VoxelSet().merge(set, { x: origin.x - b.min.x, y: origin.y - b.min.y, z: origin.z - b.min.z }) : set;
    const v = validateSet(placed);
    const r: GenResult = { set: v.set, markers: [], notes: v.notes };
    ctx.last = { label: a.file, result: r };
    const info = { file: a.file, structureSize: st.size, savedOrigin: st.origin, ...summarize(v.set), notes: v.notes, blockEntitiesSkipped: Object.keys(st.blockEntities).length };
    if (a.preview_only) return new Rich(info, previewImages(r, "iso", a.file));
    return { ...info, ...(await applyResult(ctx, r, `import ${a.file}`, dimOf(a.dimension), { undo: a.undo })) };
  });

  registerTool(ctx, "block_search", "Find Bedrock block ids by substring, e.g. 'stairs', 'copper', 'glass'.", {
    query: z.string().min(1),
    limit: z.number().int().min(1).max(300).default(60),
  }, async (a) => ({ version: registryVersion(), blocks: searchBlocks(a.query, a.limit) }), { readOnlyHint: true });

  registerTool(ctx, "block_info", "States and allowed values of a block, with the Bedrock name for Java ids and suggestions for typos.", {
    block: z.string().min(1),
  }, async (a) => {
    const name = a.block.includes(":") ? a.block : `minecraft:${a.block}`;
    const info = blockStateInfo(name);
    if (info) return { block: name, ...info };
    const alias = javaAlias(name);
    return { block: name, known: false, bedrockName: alias ?? null, aliasInfo: alias ? blockStateInfo(alias) : null, suggestions: suggestBlocks(name) };
  }, { readOnlyHint: true });

  registerTool(ctx, "palette_set", "Set project wide palette roles (wall, roof, floor, trim, light, path, ...) so every later build keeps the same look. Values are blocks or weighted mixes. Pass null to remove a role.", {
    roles: z.record(z.string(), z.union([material, z.null()])),
  }, async (a) => {
    const pal = { ...s.project.meta.palette } as Record<string, unknown>;
    for (const [k, v] of Object.entries(a.roles)) {
      if (v === null) delete pal[k];
      else {
        for (const n of typeof v === "string" ? [v] : Object.keys(v as Record<string, number>)) validateBlock(n);
        pal[k] = v;
      }
    }
    s.project.meta.palette = pal as never;
    s.project.saveMeta();
    return { palette: s.project.meta.palette };
  });
}
