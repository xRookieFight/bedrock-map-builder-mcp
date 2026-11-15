import { BlockSpec } from "../core/block.js";
import { Box, Dimension, Vec3 } from "../core/geometry.js";
import { VoxelSet } from "../core/voxels.js";

export interface FillResult {
  placed: number;
  errors: string[];
}

export interface HeightmapResult {
  /** Row major over z then x. null where the column is empty or unloaded. */
  heights: (number | null)[];
  /** Top block id per column, same order as heights. */
  tops: (string | null)[];
  width: number;
  depth: number;
}

export interface BackendCapabilities {
  /** Can read blocks back, needed for analysis, copy, export and verification. */
  read: boolean;
  /** Can save and place structures, which is what undo is built on. */
  snapshot: boolean;
  /** Can force chunks to load, without it edits only work near players. */
  load: boolean;
  scripting: boolean;
}

export class UnsupportedError extends Error {}

/**
 * Everything the engine needs from a world. BDS implements all of it through the bridge pack, the
 * WebSocket connection only gets what plain commands can do.
 */
export interface Backend {
  readonly kind: "bds" | "websocket";
  readonly caps: BackendCapabilities;
  /** Identifies the world so journal entries never get undone into the wrong map. */
  worldId(): string;
  describe(): Promise<Record<string, unknown>>;
  /** Makes sure a box is loaded and returns a function that releases it again. */
  ensureLoaded(dim: Dimension, box: Box, id: string): Promise<() => Promise<void>>;
  fill(dim: Dimension, palette: BlockSpec[], boxes: number[], filter?: { include?: string[]; exclude?: string[] }): Promise<FillResult>;
  /** Dense write for tiles that don't merge into boxes well. runs is RLE over y, z, x, -1 skips. */
  paint(dim: Dimension, box: Box, palette: BlockSpec[], runs: string): Promise<FillResult>;
  read(dim: Dimension, box: Box): Promise<{ set: VoxelSet; waterlogged: Vec3[] }>;
  heightmap(dim: Dimension, x1: number, z1: number, x2: number, z2: number): Promise<HeightmapResult>;
  snapshot(dim: Dimension, box: Box, name: string): Promise<void>;
  place(dim: Dimension, name: string, at: Vec3, opts?: { rotation?: number; mirror?: "x" | "z" | "xz" | "none"; entities?: boolean }): Promise<void>;
  deleteStructures(names: string[]): Promise<number>;
  commands(dim: Dimension, cmds: string[]): Promise<{ ok: boolean; count?: number; error?: string }[]>;
  /** Raw bridge op for features that only exist on the scripting side. */
  bridge<T = any>(op: string, args: unknown, timeoutMs?: number): Promise<T>;
}
