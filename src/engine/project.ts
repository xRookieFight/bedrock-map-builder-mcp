import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { join } from "node:path";
import { dataDir } from "../config.js";
import { BlockSpec } from "../core/block.js";
import { Box, Dimension } from "../core/geometry.js";

export interface TileRecord {
  i: number;
  /** Tight bounds of what this tile writes, also what the undo snapshot covers. */
  box: Box;
  /** Snapshot file name under the project's snapshots folder. */
  snap?: string;
  status: "pending" | "snapped" | "done" | "failed";
  placed?: number;
  error?: string;
}

export interface OpRecord {
  id: string;
  at: string;
  label: string;
  world: string;
  dim: Dimension;
  blocks: number;
  undoable: boolean;
  /** Hash of the generated content, lets a resumed step prove it regenerated the same thing. */
  digest?: string;
  tiles: TileRecord[];
  status: "running" | "done" | "partial" | "failed" | "undone";
}

type JournalEvent =
  | { t: "op"; op: Omit<OpRecord, "status"> }
  | { t: "tile"; id: string; i: number; status: "snapped" | "done" | "failed"; placed?: number; error?: string }
  | { t: "end"; id: string; status: OpRecord["status"] };

export interface RegionNote {
  dim: Dimension;
  box: Box;
  note?: string;
}

export interface PlanStep {
  id: string;
  action: string;
  args: Record<string, unknown>;
  note?: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  opIds?: string[];
  error?: string;
  result?: unknown;
}

export interface Plan {
  id: string;
  title: string;
  created: string;
  steps: PlanStep[];
}

export interface ProjectMeta {
  name: string;
  created: string;
  /** Free form design decisions: style, palette rules, scale, whatever should survive between sessions. */
  decisions: string[];
  palette: Record<string, string>;
  regions: Record<string, RegionNote>;
  world?: string;
}

export class ProjectError extends Error {}

/**
 * A project folder: design notes, named regions, the operation journal and build plans.
 * The journal is append only JSON lines, so a crash mid write loses at most the last line.
 */
export class Project {
  readonly dir: string;
  meta: ProjectMeta;
  private opsCache?: Map<string, OpRecord>;

  constructor(readonly name: string) {
    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(name)) throw new ProjectError(`bad project name "${name}"`);
    this.dir = join(dataDir(), "projects", name);
    mkdirSync(join(this.dir, "plans"), { recursive: true });
    const metaPath = join(this.dir, "project.json");
    if (existsSync(metaPath)) {
      this.meta = JSON.parse(readFileSync(metaPath, "utf8"));
    } else {
      this.meta = { name, created: new Date().toISOString(), decisions: [], palette: {}, regions: {} };
      this.saveMeta();
    }
  }

  static list(): string[] {
    const d = join(dataDir(), "projects");
    if (!existsSync(d)) return [];
    return readdirSync(d).filter((n) => existsSync(join(d, n, "project.json")));
  }

  saveMeta(): void {
    atomicWrite(join(this.dir, "project.json"), JSON.stringify(this.meta, null, 2));
  }

  private append(ev: JournalEvent) {
    appendFileSync(join(this.dir, "journal.jsonl"), JSON.stringify(ev) + "\n");
    this.opsCache = undefined;
  }

  beginOp(op: Omit<OpRecord, "status">): void {
    this.append({ t: "op", op });
  }

  tileSnapped(id: string, i: number): void {
    this.append({ t: "tile", id, i, status: "snapped" });
  }

  tileDone(id: string, i: number, placed: number): void {
    this.append({ t: "tile", id, i, status: "done", placed });
  }

  tileFailed(id: string, i: number, error: string): void {
    this.append({ t: "tile", id, i, status: "failed", error });
  }

  endOp(id: string, status: OpRecord["status"]): void {
    this.append({ t: "end", id, status });
  }

  ops(): Map<string, OpRecord> {
    if (this.opsCache) return this.opsCache;
    const out = new Map<string, OpRecord>();
    const f = join(this.dir, "journal.jsonl");
    if (existsSync(f)) {
      for (const line of readFileSync(f, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let ev: JournalEvent;
        try {
          ev = JSON.parse(line);
        } catch {
          // a torn last line after a crash, everything before it is still good
          continue;
        }
        if (ev.t === "op") out.set(ev.op.id, { ...ev.op, tiles: ev.op.tiles.map((t) => ({ ...t })), status: "running" });
        else if (ev.t === "tile") {
          const t = out.get(ev.id)?.tiles.find((x) => x.i === ev.i);
          if (t) {
            t.status = ev.status;
            t.placed = ev.placed;
            t.error = ev.error;
          }
        } else if (ev.t === "end") {
          const o = out.get(ev.id);
          if (o) o.status = ev.status;
        }
      }
    }
    this.opsCache = out;
    return out;
  }

  op(id: string): OpRecord {
    const o = this.ops().get(id);
    if (!o) throw new ProjectError(`no operation ${id} in project ${this.name}`);
    return o;
  }

  // undo snapshots live here, never inside the world, so an exported map carries no hidden copies

  saveSnapshot(name: string, data: UndoSnapshot): void {
    mkdirSync(join(this.dir, "snapshots"), { recursive: true });
    const f = join(this.dir, "snapshots", `${safeName(name)}.json.gz`);
    const tmp = `${f}.tmp-${process.pid}`;
    writeFileSync(tmp, gzipSync(JSON.stringify(data)));
    renameSync(tmp, f);
  }

  loadSnapshot(name: string): UndoSnapshot {
    const f = join(this.dir, "snapshots", `${safeName(name)}.json.gz`);
    if (!existsSync(f)) throw new ProjectError(`undo snapshot ${name} is missing from ${this.dir}/snapshots`);
    return JSON.parse(gunzipSync(readFileSync(f)).toString("utf8"));
  }

  deleteSnapshot(name: string): void {
    rmSync(join(this.dir, "snapshots", `${safeName(name)}.json.gz`), { force: true });
  }

  // plans

  savePlan(p: Plan): void {
    atomicWrite(join(this.dir, "plans", `${p.id}.json`), JSON.stringify(p, null, 2));
  }

  plan(id: string): Plan {
    const f = join(this.dir, "plans", `${id}.json`);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || !existsSync(f)) throw new ProjectError(`no plan ${id} in project ${this.name}`);
    return JSON.parse(readFileSync(f, "utf8"));
  }

  plans(): Plan[] {
    return readdirSync(join(this.dir, "plans"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.dir, "plans", f), "utf8")) as Plan);
  }
}

/** Prior state of one tile, enough to paint it back exactly (block entities like chest contents excluded). */
export interface UndoSnapshot {
  dim: Dimension;
  box: Box;
  palette: BlockSpec[];
  /** RLE over y, z, x like the bridge's paint op. */
  runs: string;
}

function safeName(n: string): string {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(n)) throw new ProjectError(`bad snapshot name "${n}"`);
  return n;
}

export function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

let counter = 0;
export function newId(prefix: string): string {
  counter = (counter + 1) % 1296;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36).padStart(2, "0")}`;
}
