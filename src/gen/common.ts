import { BlockSpec, StateValue } from "../core/block.js";
import { defaultStates } from "../core/registry.js";
import { Vec3 } from "../core/geometry.js";
import { transformSet } from "../core/transform.js";
import { VoxelSet } from "../core/voxels.js";
import { Palette, Role } from "./palette.js";

export type Facing = "north" | "east" | "south" | "west";

export interface Marker {
  kind: string;
  name?: string;
  pos: Vec3;
  data?: Record<string, unknown>;
}

/** What every generator hands back: the blocks, points of interest, and anything worth telling the user. */
export interface GenResult {
  set: VoxelSet;
  markers: Marker[];
  notes: string[];
}

// stairs "ascend toward" this direction. measured against the registry: weirdo_direction 0 east, 1 west, 2 south, 3 north
const WEIRDO: Record<Facing, number> = { east: 0, west: 1, south: 2, north: 3 };

export function stairs(p: Palette, role: Role | string, x: number, y: number, z: number, ascendToward: Facing, upsideDown = false): BlockSpec {
  return p.at(role as Role, x, y, z, { weirdo_direction: WEIRDO[ascendToward], upside_down_bit: upsideDown });
}

export function slab(p: Palette, role: Role | string, x: number, y: number, z: number, top = false): BlockSpec {
  return p.at(role as Role, x, y, z, { "minecraft:vertical_half": top ? "top" : "bottom" });
}

export function opposite(f: Facing): Facing {
  return ({ north: "south", south: "north", east: "west", west: "east" } as const)[f];
}

/** Quarter turns that take the canonical south facing build to `f`. */
export function turnsFromSouth(f: Facing): number {
  return { south: 0, west: 1, north: 2, east: 3 }[f];
}

/**
 * Generators build facing south with their min corner at 0,0,0. This rotates the result to the wanted
 * facing and moves it so the footprint's min corner lands on `origin`, markers included.
 */
export function place(r: GenResult, origin: Vec3, facing: Facing = "south"): GenResult {
  const t = turnsFromSouth(facing);
  const pivot = { x: 0, y: 0, z: 0 };
  let set = t ? transformSet(r.set, { rotate: t, pivot }) : r.set;
  const b = set.bounds();
  const shift = b ? { x: origin.x - b.min.x, y: origin.y, z: origin.z - b.min.z } : origin;
  const out = new VoxelSet().merge(set, shift);
  const rot = (p: Vec3): Vec3 => {
    let x = p.x, z = p.z;
    for (let k = 0; k < t; k++) [x, z] = [-z, x];
    return { x: x + shift.x, y: p.y + shift.y, z: z + shift.z };
  };
  return { set: out, markers: r.markers.map((m) => ({ ...m, pos: rot(m.pos) })), notes: r.notes };
}

/** Moves a result by an offset, markers too. */
export function shift(r: GenResult, d: Vec3): GenResult {
  return {
    set: new VoxelSet().merge(r.set, d),
    markers: r.markers.map((m) => ({ ...m, pos: { x: m.pos.x + d.x, y: m.pos.y + d.y, z: m.pos.z + d.z } })),
    notes: r.notes,
  };
}

export function combine(...parts: GenResult[]): GenResult {
  const set = new VoxelSet();
  const markers: Marker[] = [];
  const notes: string[] = [];
  for (const p of parts) {
    set.merge(p.set);
    markers.push(...p.markers);
    notes.push(...p.notes);
  }
  return { set, markers, notes };
}

export function result(set = new VoxelSet()): GenResult {
  return { set, markers: [], notes: [] };
}

/** Adds states the block actually has, silently skipping the rest (a door style might be a block without hinges). */
export function withState(b: BlockSpec, states: Record<string, StateValue>): BlockSpec {
  const known = defaultStates(b.name);
  const kept = known ? Object.fromEntries(Object.entries(states).filter(([k]) => k in known)) : states;
  return { name: b.name, states: { ...b.states, ...kept } };
}

export const TEAM_COLORS = ["red", "blue", "lime", "yellow", "orange", "purple", "cyan", "magenta"];
