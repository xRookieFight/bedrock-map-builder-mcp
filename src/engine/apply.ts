import { createHash } from "node:crypto";
import { blockKey } from "../core/block.js";
import { Box, Dimension, HEIGHT_LIMITS, MAX_STRUCTURE_SIZE, assertBoxInWorld, boxIntersect, formatBox } from "../core/geometry.js";
import { VoxelSet } from "../core/voxels.js";
import { Backend } from "./backend.js";
import { OpRecord, Project, ProjectError, TileRecord, newId } from "./project.js";

export interface ApplyOptions {
  label: string;
  dim: Dimension;
  /** Snapshot the area first so op_undo can put it back. On by default. */
  undo?: boolean;
  /** Only overwrite blocks of these types (or skip these), which is how replace works. */
  filter?: { include?: string[]; exclude?: string[] };
  /** Continue an op that stopped halfway, tiles already done are skipped. */
  resumeOpId?: string;
  /** Read back this many random cells afterwards and compare. 0 turns it off. */
  verifySamples?: number;
  onProgress?: (doneTiles: number, totalTiles: number) => void;
}

export interface ApplyReport {
  opId: string;
  label: string;
  blocks: number;
  placed: number;
  tiles: number;
  fills: number;
  bounds: Box | null;
  undoable: boolean;
  status: OpRecord["status"];
  errors: string[];
  verify?: { checked: number; mismatched: number; examples: string[] };
  ms: number;
}

const FILL_BATCH = 1500;

export function digestSet(set: VoxelSet): string {
  const h = createHash("sha1");
  h.update(set.palette.map(blockKey).join("|"));
  const buf: number[] = [];
  set.forEach((x, y, z, i) => {
    buf.push(x, y, z, i);
    if (buf.length > 4096) {
      h.update(buf.join(","));
      buf.length = 0;
    }
  });
  h.update(buf.join(","));
  return h.digest("hex").slice(0, 16);
}

/**
 * Writes a voxel set into the world. Splits it into structure sized tiles, loads each tile, saves an undo
 * snapshot, then sends merged fills. Every step lands in the journal before it happens, so an interrupted
 * op can be resumed or undone instead of leaving a mystery half build.
 */
export async function applyVoxels(backend: Backend, project: Project, set: VoxelSet, opt: ApplyOptions): Promise<ApplyReport> {
  const t0 = Date.now();
  const bounds = set.bounds();
  const undo = (opt.undo ?? true) && backend.caps.snapshot;
  if (!bounds) {
    return { opId: "", label: opt.label, blocks: 0, placed: 0, tiles: 0, fills: 0, bounds: null, undoable: false, status: "done", errors: [], ms: 0 };
  }
  assertBoxInWorld(bounds, opt.dim);

  const origin = { x: 0, y: HEIGHT_LIMITS[opt.dim].minY, z: 0 };
  const tiles = [...set.splitByTiles(MAX_STRUCTURE_SIZE, origin).values()];
  const digest = digestSet(set);

  let op: OpRecord;
  if (opt.resumeOpId) {
    op = project.op(opt.resumeOpId);
    if (op.world !== backend.worldId()) throw new ProjectError(`op ${op.id} belongs to ${op.world}, not ${backend.worldId()}`);
    if (op.digest && op.digest !== digest) {
      throw new ProjectError(`op ${op.id} was generated from different content (digest ${op.digest} vs ${digest}), refusing to resume`);
    }
    if (op.status === "undone") throw new ProjectError(`op ${op.id} was undone, start a new one instead`);
  } else {
    const id = newId("op");
    const records: TileRecord[] = tiles.map((t, i) => ({
      i,
      box: t.set.bounds()!,
      snap: undo ? `mbm:u_${id}_${i}` : undefined,
      status: "pending",
    }));
    op = { id, at: new Date().toISOString(), label: opt.label, world: backend.worldId(), dim: opt.dim, blocks: set.size, undoable: undo, digest, tiles: records, status: "running" };
    project.beginOp(op);
  }

  const errors: string[] = [];
  const samples = opt.verifySamples ?? 128;
  const verify = { checked: 0, mismatched: 0, examples: [] as string[] };
  let placed = 0;
  let fills = 0;
  let done = 0;
  for (let i = 0; i < tiles.length; i++) {
    const rec = op.tiles[i];
    if (rec.status === "done") {
      done++;
      continue;
    }
    const tileSet = tiles[i].set;
    let release: (() => Promise<void>) | undefined;
    try {
      if (backend.caps.load) release = await backend.ensureLoaded(opt.dim, rec.box, `${op.id}_${i}`);
      // only snapshot a tile that hasn't been touched yet, a re-snapshot after a half fill would bake the half build into undo
      if (rec.snap && rec.status === "pending") {
        await backend.snapshot(opt.dim, rec.box, rec.snap);
        project.tileSnapped(op.id, i);
      }
      const cuboids = tileSet.toCuboids();
      let tilePlaced = 0;
      const runs = opt.filter || cuboids.length < 64 ? "" : tileSet.toRuns(rec.box);
      // pick whichever payload is smaller, noisy terrain and patterned floors go dense, walls and slabs go as boxes
      if (runs && runs.length < cuboids.length * 30) {
        const r = await backend.paint(opt.dim, rec.box, tileSet.palette, runs);
        tilePlaced += r.placed;
        fills++;
        for (const e of r.errors) if (errors.length < 20) errors.push(`tile ${i}: ${e}`);
      } else {
        for (let c = 0; c < cuboids.length; c += FILL_BATCH) {
          const flat: number[] = [];
          for (const q of cuboids.slice(c, c + FILL_BATCH)) flat.push(q.min.x, q.min.y, q.min.z, q.max.x, q.max.y, q.max.z, q.block);
          const r = await backend.fill(opt.dim, tileSet.palette, flat, opt.filter);
          tilePlaced += r.placed;
          fills++;
          for (const e of r.errors) if (errors.length < 20) errors.push(`tile ${i}: ${e}`);
        }
      }
      // check while the tile is still loaded, after release the probes would only see unloaded chunks
      if (samples > 0 && backend.caps.read && !opt.filter) {
        const v = await verifySample(backend, opt.dim, tileSet, Math.max(8, Math.ceil(samples / tiles.length)));
        verify.checked += v.checked;
        verify.mismatched += v.mismatched;
        for (const ex of v.examples) if (verify.examples.length < 5) verify.examples.push(ex);
      }
      placed += tilePlaced;
      project.tileDone(op.id, i, tilePlaced);
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`tile ${i} (${formatBox(rec.box)}): ${msg}`);
      project.tileFailed(op.id, i, msg);
    } finally {
      await release?.();
    }
    done++;
    opt.onProgress?.(done, tiles.length);
  }

  const fresh = project.op(op.id);
  const allDone = fresh.tiles.every((t) => t.status === "done");
  const anyDone = fresh.tiles.some((t) => t.status === "done");
  const status: OpRecord["status"] = allDone ? "done" : anyDone ? "partial" : "failed";
  project.endOp(op.id, status);

  const report: ApplyReport = {
    opId: op.id,
    label: opt.label,
    blocks: set.size,
    placed,
    tiles: tiles.length,
    fills,
    bounds,
    undoable: undo,
    status,
    errors,
    ms: 0,
  };
  if (verify.checked) report.verify = verify;
  report.ms = Date.now() - t0;
  return report;
}

/** Picks random cells from the set and asks the world what's really there. */
export async function verifySample(backend: Backend, dim: Dimension, set: VoxelSet, n: number) {
  const all: number[] = [];
  const stride = Math.max(1, Math.floor(set.size / n));
  let k = 0;
  set.forEach((x, y, z, i) => {
    if (k++ % stride === 0 && all.length < n * 4) all.push(x, y, z, i);
  });
  const pts: number[] = [];
  const want: number[] = [];
  for (let i = 0; i < all.length; i += 4) {
    pts.push(all[i], all[i + 1], all[i + 2]);
    want.push(all[i + 3]);
  }
  const r = await backend.bridge<{ blocks: ([string, Record<string, unknown>] | null)[] }>("probe", { dim, points: pts }, 60_000);
  let mismatched = 0;
  const examples: string[] = [];
  r.blocks.forEach((got, j) => {
    const exp = set.palette[want[j]];
    const ok = got && got[0] === exp.name && Object.entries(exp.states).every(([s, v]) => got[1][s] === v);
    if (!ok) {
      mismatched++;
      if (examples.length < 5) {
        examples.push(`${pts[j * 3]} ${pts[j * 3 + 1]} ${pts[j * 3 + 2]}: wanted ${blockKey(exp)}, found ${got ? got[0] : "unloaded"}`);
      }
    }
  });
  return { checked: r.blocks.length, mismatched, examples };
}

/**
 * Puts the snapshots of an op back. Refuses when a later op still overlaps it, since undoing out of order
 * would silently wipe that later work too (pass force to do it anyway).
 */
export async function undoOp(backend: Backend, project: Project, opId: string, force = false) {
  const op = project.op(opId);
  if (op.status === "undone") throw new ProjectError(`op ${opId} is already undone`);
  if (!op.undoable) throw new ProjectError(`op ${opId} was run with undo off, restore from a world backup instead`);
  if (op.world !== backend.worldId()) throw new ProjectError(`op ${opId} belongs to ${op.world}, the connected world is ${backend.worldId()}`);
  if (!force) {
    const later = [...project.ops().values()].filter(
      (o) => o.at > op.at && o.world === op.world && o.dim === op.dim && o.status !== "undone" &&
        o.tiles.some((t) => op.tiles.some((u) => boxIntersect(t.box, u.box))),
    );
    if (later.length) {
      throw new ProjectError(`later ops overlap this one: ${later.map((o) => `${o.id} (${o.label})`).join(", ")}. Undo those first or pass force`);
    }
  }
  let restored = 0;
  const errors: string[] = [];
  for (const t of [...op.tiles].reverse()) {
    if (!t.snap || t.status === "pending") continue;
    let release: (() => Promise<void>) | undefined;
    try {
      if (backend.caps.load) release = await backend.ensureLoaded(op.dim, t.box, `${op.id}_u${t.i}`);
      await backend.place(op.dim, t.snap, t.box.min);
      restored++;
    } catch (e) {
      errors.push(`tile ${t.i}: ${(e as Error).message}`);
    } finally {
      await release?.();
    }
  }
  if (!errors.length) {
    await backend.deleteStructures(op.tiles.map((t) => t.snap!).filter(Boolean)).catch(() => 0);
    project.endOp(op.id, "undone");
  }
  return { opId, restored, errors };
}
