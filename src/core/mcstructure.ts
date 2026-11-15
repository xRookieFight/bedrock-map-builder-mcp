import { BlockSpec, StateValue } from "./block.js";
import { Vec3 } from "./geometry.js";
import { NbtError, Tag, nbt, readNbt, toPlain, writeNbt } from "./nbt.js";
import { VoxelSet } from "./voxels.js";

// 1.21.60.33 packed as major<<24 | minor<<16 | patch<<8 | rev. the game runs its block upgrader on anything
// older than itself, so writing a recent-ish version keeps current names from being "upgraded" again
export const BLOCK_VERSION = 18168865;

export interface McStructure {
  size: Vec3;
  origin: Vec3;
  /** Blocks relative to the structure's own 0,0,0. Cells left unset are structure void. */
  blocks: VoxelSet;
  /** Waterlogging layer, e.g. water inside a waterlogged fence. */
  secondary: VoxelSet;
  entities: unknown[];
  /** Raw block entity data keyed by flat index, kept so a round trip doesn't lose chest contents. */
  blockEntities: Record<string, Tag>;
}

function stateToTag(v: StateValue): Tag {
  if (typeof v === "boolean") return nbt.byte(v ? 1 : 0);
  if (typeof v === "number") return nbt.int(v);
  return nbt.string(v);
}

function tagToState(t: Tag): StateValue {
  // bool states are stored as bytes, the script API hands them out as booleans so match that
  if (t.type === "byte") return t.value !== 0;
  if (t.type === "int" || t.type === "short") return t.value;
  if (t.type === "string") return t.value;
  return String(toPlain(t));
}

function intList(t: Tag | undefined, what: string): number[] {
  if (!t || t.type !== "list") throw new NbtError(`mcstructure is missing ${what}`);
  return t.value.items.map((i) => {
    if (i.type !== "int") throw new NbtError(`${what} should hold ints`);
    return i.value;
  });
}

export function encodeMcStructure(s: Omit<McStructure, "blockEntities" | "entities"> & Partial<McStructure>): Buffer {
  const { x: sx, y: sy, z: sz } = s.size;
  const n = sx * sy * sz;
  const palette: BlockSpec[] = [];
  const pIndex = new Map<string, number>();
  const idx = (b: BlockSpec) => {
    const k = JSON.stringify([b.name, Object.entries(b.states).sort()]);
    let i = pIndex.get(k);
    if (i === undefined) {
      i = palette.length;
      palette.push(b);
      pIndex.set(k, i);
    }
    return i;
  };
  const layer0 = new Array<Tag>(n);
  const layer1 = new Array<Tag>(n);
  const neg = nbt.int(-1);
  for (let i = 0; i < n; i++) {
    layer0[i] = neg;
    layer1[i] = neg;
  }
  // index order is x major, then y, then z. easy to get wrong, the game silently scrambles the build if you do
  const flat = (x: number, y: number, z: number) => (x * sy + y) * sz + z;
  const fill = (set: VoxelSet, layer: Tag[]) =>
    set.forEach((x, y, z, i) => {
      if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return;
      layer[flat(x, y, z)] = nbt.int(idx(set.palette[i]));
    });
  fill(s.blocks, layer0);
  fill(s.secondary, layer1);

  const blockPalette = palette.map((b) =>
    nbt.compound({
      name: nbt.string(b.name),
      states: nbt.compound(Object.fromEntries(Object.entries(b.states).map(([k, v]) => [k, stateToTag(v)]))),
      version: nbt.int(BLOCK_VERSION),
    }),
  );
  const root = nbt.compound({
    format_version: nbt.int(1),
    size: nbt.list("int", [nbt.int(sx), nbt.int(sy), nbt.int(sz)]),
    structure: nbt.compound({
      block_indices: nbt.list("list", [nbt.list("int", layer0), nbt.list("int", layer1)]),
      entities: nbt.list("compound", []),
      palette: nbt.compound({
        default: nbt.compound({
          block_palette: nbt.list("compound", blockPalette),
          block_position_data: nbt.compound(s.blockEntities ?? {}),
        }),
      }),
    }),
    structure_world_origin: nbt.list("int", [nbt.int(s.origin.x), nbt.int(s.origin.y), nbt.int(s.origin.z)]),
  });
  return writeNbt(root);
}

export function decodeMcStructure(buf: Buffer): McStructure {
  const { tag } = readNbt(buf);
  if (tag.type !== "compound") throw new NbtError("mcstructure root is not a compound");
  const root = tag.value;
  const [sx, sy, sz] = intList(root.size, "size");
  if (![sx, sy, sz].every((v) => Number.isInteger(v) && v > 0 && v <= 1024)) {
    throw new NbtError(`implausible structure size ${sx}x${sy}x${sz}`);
  }
  const origin = root.structure_world_origin ? intList(root.structure_world_origin, "origin") : [0, 0, 0];
  const st = root.structure;
  if (!st || st.type !== "compound") throw new NbtError("mcstructure has no structure compound");
  const bi = st.value.block_indices;
  if (!bi || bi.type !== "list" || bi.value.items.length < 1) throw new NbtError("mcstructure has no block_indices");
  const pal = st.value.palette;
  const def = pal?.type === "compound" ? pal.value.default : undefined;
  if (!def || def.type !== "compound") throw new NbtError("mcstructure has no default palette");
  const bp = def.value.block_palette;
  if (!bp || bp.type !== "list") throw new NbtError("mcstructure has no block_palette");
  const palette: BlockSpec[] = bp.value.items.map((it) => {
    if (it.type !== "compound") throw new NbtError("palette entry is not a compound");
    const name = it.value.name;
    if (!name || name.type !== "string") throw new NbtError("palette entry has no name");
    const states: Record<string, StateValue> = {};
    const s = it.value.states;
    if (s?.type === "compound") for (const [k, v] of Object.entries(s.value)) states[k] = tagToState(v);
    return { name: name.value, states };
  });
  const n = sx * sy * sz;
  const layers = bi.value.items.map((l, li) => intList(l, `block layer ${li}`));
  const blocks = new VoxelSet();
  const secondary = new VoxelSet();
  const map0 = palette.map((b) => blocks.indexOf(b));
  const map1 = palette.map((b) => secondary.indexOf(b));
  for (let li = 0; li < Math.min(2, layers.length); li++) {
    const layer = layers[li];
    if (layer.length !== n) throw new NbtError(`block layer ${li} has ${layer.length} entries, expected ${n}`);
    const set = li === 0 ? blocks : secondary;
    const map = li === 0 ? map0 : map1;
    let i = 0;
    for (let x = 0; x < sx; x++)
      for (let y = 0; y < sy; y++)
        for (let z = 0; z < sz; z++, i++) {
          const v = layer[i];
          if (v < 0) continue;
          if (v >= palette.length) throw new NbtError(`block index ${v} is outside the palette`);
          set.set(x, y, z, map[v]);
        }
  }
  const bpd = def.value.block_position_data;
  const ents = st.value.entities;
  return {
    size: { x: sx, y: sy, z: sz },
    origin: { x: origin[0], y: origin[1], z: origin[2] },
    blocks,
    secondary,
    entities: ents?.type === "list" ? ents.value.items.map(toPlain) : [],
    blockEntities: bpd?.type === "compound" ? bpd.value : {},
  };
}
