import { BlockSpec } from "../core/block.js";
import { Box, Dimension, Vec3 } from "../core/geometry.js";
import { VoxelSet } from "../core/voxels.js";
import { BdsServer } from "../bds/server.js";
import { Backend, FillResult, HeightmapResult } from "./backend.js";

const ROT = ["None", "Rotate90", "Rotate180", "Rotate270"];

/** Backend for a BDS we started ourselves, everything goes through the bridge pack. */
export class BdsBackend implements Backend {
  readonly kind = "bds" as const;
  readonly caps = { read: true, snapshot: true, load: true, scripting: true };

  constructor(
    readonly server: BdsServer,
    readonly instance: string,
    readonly levelName: string,
  ) {}

  worldId() {
    return `bds:${this.instance}/${this.levelName}`;
  }

  bridge<T = any>(op: string, args: unknown, timeoutMs = 120_000): Promise<T> {
    return this.server.request<T>(op, args, timeoutMs);
  }

  async describe() {
    const p = await this.bridge("ping", {}, 15_000);
    return { kind: this.kind, world: this.worldId(), pid: this.server.pid, ...p };
  }

  async ensureLoaded(dim: Dimension, box: Box, id: string) {
    const area = `mbm${id}`.slice(0, 60);
    await this.bridge("load", { id: area, dim, from: box.min, to: box.max }, 120_000);
    return async () => {
      await this.bridge("unload", { id: area }, 15_000).catch(() => {});
    };
  }

  fill(dim: Dimension, palette: BlockSpec[], boxes: number[], filter?: { include?: string[]; exclude?: string[] }): Promise<FillResult> {
    return this.bridge("fill", { dim, palette, boxes, include: filter?.include, exclude: filter?.exclude }, 300_000);
  }

  paint(dim: Dimension, box: Box, palette: BlockSpec[], runs: string): Promise<FillResult> {
    return this.bridge("paint", { dim, from: box.min, to: box.max, palette, runs }, 300_000);
  }

  async read(dim: Dimension, box: Box) {
    const r = await this.bridge<{ size: Vec3; palette: BlockSpec[]; runs: string; water: number[] }>(
      "read",
      { dim, from: box.min, to: box.max },
      600_000,
    );
    const set = new VoxelSet();
    const map = r.palette.map((b) => set.indexOf(b));
    const { x: sx, z: sz } = r.size;
    let n = 0;
    for (const tok of r.runs ? r.runs.split(",") : []) {
      const star = tok.indexOf("*");
      const idx = Number(star < 0 ? tok : tok.slice(0, star));
      const cnt = star < 0 ? 1 : Number(tok.slice(star + 1));
      if (idx >= 0) {
        for (let k = 0; k < cnt; k++) {
          const c = n + k;
          const x = c % sx, z = Math.floor(c / sx) % sz, y = Math.floor(c / (sx * sz));
          set.set(box.min.x + x, box.min.y + y, box.min.z + z, map[idx]);
        }
      }
      n += cnt;
    }
    const waterlogged: Vec3[] = [];
    for (let i = 0; i < r.water.length; i += 3) waterlogged.push({ x: r.water[i], y: r.water[i + 1], z: r.water[i + 2] });
    return { set, waterlogged };
  }

  async heightmap(dim: Dimension, x1: number, z1: number, x2: number, z2: number): Promise<HeightmapResult> {
    const r = await this.bridge<{ palette: string[]; heights: (number | null)[]; tops: number[] }>(
      "heightmap",
      { dim, x1, z1, x2, z2 },
      300_000,
    );
    return {
      heights: r.heights,
      tops: r.tops.map((t) => (t < 0 ? null : r.palette[t])),
      width: x2 - x1 + 1,
      depth: z2 - z1 + 1,
    };
  }

  async snapshot(dim: Dimension, box: Box, name: string) {
    await this.bridge("snapshot", { dim, from: box.min, to: box.max, name }, 120_000);
  }

  async place(dim: Dimension, name: string, at: Vec3, opts: { rotation?: number; mirror?: "x" | "z" | "xz" | "none"; entities?: boolean } = {}) {
    const mirror = !opts.mirror || opts.mirror === "none" ? "None" : opts.mirror.toUpperCase();
    await this.bridge("place", { dim, name, at, rotation: ROT[(((opts.rotation ?? 0) % 4) + 4) % 4], mirror, entities: opts.entities }, 120_000);
  }

  async deleteStructures(names: string[]) {
    if (!names.length) return 0;
    const r = await this.bridge<{ removed: number }>("deleteStructure", { names }, 60_000);
    return r.removed;
  }

  async commands(dim: Dimension, cmds: string[]) {
    const r = await this.bridge<{ results: { ok: boolean; count?: number; error?: string }[] }>("command", { dim, commands: cmds }, 120_000);
    return r.results;
  }
}
