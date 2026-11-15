import { BlockSpec, StateValue, parseBlock } from "../core/block.js";
import { hash3 } from "../core/noise.js";
import { defaultStates } from "../core/registry.js";

/** A block, or a weighted mix like { stone_bricks: 6, mossy_stone_bricks: 2, cracked_stone_bricks: 1 }. */
export type Material = string | Record<string, number>;

export type Role =
  | "foundation" | "wall" | "wall_accent" | "trim" | "pillar" | "floor" | "ceiling" | "roof" | "roof_stairs"
  | "roof_slab" | "window" | "door" | "light" | "path" | "path_edge" | "fence" | "stairs" | "slab" | "log"
  | "leaves" | "glass_pane" | "battlement" | "carpet" | "detail" | "water";

export interface Style {
  name: string;
  description: string;
  roles: Partial<Record<Role, Material>>;
}

// every block here is checked against the 1.26 registry in the tests, so a typo breaks the build, not the map
const base: Record<Role, Material> = {
  foundation: { cobblestone: 3, stone: 1 },
  wall: "oak_planks",
  wall_accent: "stripped_oak_log",
  trim: "spruce_planks",
  pillar: "oak_log",
  floor: "spruce_planks",
  ceiling: "oak_planks",
  roof: "spruce_planks",
  roof_stairs: "spruce_stairs",
  roof_slab: "spruce_slab",
  window: "glass_pane",
  door: "spruce_door",
  light: "lantern",
  path: { grass_path: 4, coarse_dirt: 1 },
  path_edge: "cobblestone",
  fence: "spruce_fence",
  stairs: "spruce_stairs",
  slab: "spruce_slab",
  log: "oak_log",
  leaves: "oak_leaves[persistent_bit=true]",
  glass_pane: "glass_pane",
  battlement: "stone_bricks",
  carpet: "red_carpet",
  detail: "flower_pot",
  water: "water",
};

export const STYLES: Record<string, Style> = {
  medieval: {
    name: "medieval",
    description: "Timber frame over stone, dark oak roofs, lanterns",
    roles: {
      foundation: { stone_bricks: 6, mossy_stone_bricks: 2, cracked_stone_bricks: 1 },
      wall: { white_terracotta: 5, light_gray_terracotta: 1 },
      wall_accent: "stripped_dark_oak_log",
      trim: "dark_oak_planks",
      pillar: "dark_oak_log",
      floor: "spruce_planks",
      roof: "dark_oak_planks",
      roof_stairs: "dark_oak_stairs",
      roof_slab: "dark_oak_slab",
      stairs: "spruce_stairs",
      door: "dark_oak_door",
      fence: "dark_oak_fence",
      battlement: { stone_bricks: 5, mossy_stone_bricks: 1 },
    },
  },
  castle: {
    name: "castle",
    description: "Heavy stone keep and walls, deepslate roofs",
    roles: {
      foundation: { cobblestone: 2, mossy_cobblestone: 1, stone_bricks: 3 },
      wall: { stone_bricks: 8, mossy_stone_bricks: 2, cracked_stone_bricks: 2, andesite: 1 },
      wall_accent: "chiseled_stone_bricks",
      trim: "polished_andesite",
      pillar: "polished_deepslate",
      floor: { stone_bricks: 3, polished_andesite: 1 },
      roof: "deepslate_tiles",
      roof_stairs: "deepslate_tile_stairs",
      roof_slab: "deepslate_tile_slab",
      stairs: "stone_brick_stairs",
      slab: "stone_brick_slab",
      door: "spruce_door",
      fence: "iron_bars",
      battlement: { stone_bricks: 4, mossy_stone_bricks: 1 },
      light: "lantern",
    },
  },
  modern: {
    name: "modern",
    description: "White concrete, glass, quartz and grey accents",
    roles: {
      foundation: "polished_andesite",
      wall: "white_concrete",
      wall_accent: "light_gray_concrete",
      trim: "smooth_quartz",
      pillar: "quartz_pillar",
      floor: "smooth_stone",
      ceiling: "white_concrete",
      roof: "light_gray_concrete",
      roof_stairs: "smooth_quartz_stairs",
      roof_slab: "smooth_stone_slab",
      window: "light_gray_stained_glass",
      glass_pane: "glass_pane",
      door: "iron_door",
      light: "sea_lantern",
      path: "smooth_stone",
      path_edge: "polished_andesite",
      fence: "iron_bars",
      stairs: "smooth_quartz_stairs",
      slab: "smooth_stone_slab",
      battlement: "smooth_quartz",
    },
  },
  skyscraper: {
    name: "skyscraper",
    description: "Glass curtain wall with dark steel frame",
    roles: {
      foundation: "polished_blackstone",
      wall: "gray_concrete",
      wall_accent: "black_concrete",
      trim: "polished_basalt",
      pillar: "gray_concrete",
      floor: "polished_andesite",
      roof: "gray_concrete",
      window: { light_blue_stained_glass: 3, cyan_stained_glass: 1 },
      light: "sea_lantern",
      door: "iron_door",
      battlement: "black_concrete",
    },
  },
  fantasy: {
    name: "fantasy",
    description: "Elven white stone, prismarine roofs, amethyst and glow",
    roles: {
      foundation: { calcite: 3, diorite: 1 },
      wall: { smooth_quartz: 3, calcite: 1 },
      wall_accent: "purpur_pillar",
      trim: "prismarine_bricks",
      pillar: "quartz_pillar",
      floor: "polished_diorite",
      roof: "dark_prismarine",
      roof_stairs: "dark_prismarine_stairs",
      roof_slab: "dark_prismarine_slab",
      window: "purple_stained_glass_pane",
      light: "end_rod",
      door: "cherry_door",
      fence: "cherry_fence",
      stairs: "prismarine_bricks_stairs",
      leaves: "cherry_leaves[persistent_bit=true]",
      log: "cherry_log",
      battlement: "smooth_quartz",
      detail: "amethyst_cluster",
    },
  },
  scifi: {
    name: "scifi",
    description: "Dark panels, cyan light strips, glass",
    roles: {
      foundation: "polished_deepslate",
      wall: { light_gray_concrete: 3, white_concrete: 1 },
      wall_accent: "cyan_concrete",
      trim: "polished_tuff",
      pillar: "iron_block",
      floor: "polished_deepslate",
      roof: "gray_concrete",
      window: "cyan_stained_glass",
      light: "sea_lantern",
      door: "iron_door",
      path: "polished_deepslate",
      fence: "iron_bars",
      battlement: "polished_tuff",
    },
  },
  desert: {
    name: "desert",
    description: "Sandstone with terracotta accents",
    roles: {
      foundation: "sandstone",
      wall: { smooth_sandstone: 4, sandstone: 1 },
      wall_accent: "cut_sandstone",
      trim: "orange_terracotta",
      pillar: "chiseled_sandstone",
      floor: "cut_sandstone",
      roof: "smooth_sandstone",
      roof_stairs: "smooth_sandstone_stairs",
      roof_slab: "smooth_sandstone_slab",
      stairs: "sandstone_stairs",
      door: "acacia_door",
      fence: "acacia_fence",
      path: { sand: 3, sandstone: 1 },
      light: "lantern",
      battlement: "cut_sandstone",
    },
  },
  nordic: {
    name: "nordic",
    description: "Spruce cabins on cobblestone with steep roofs",
    roles: {
      foundation: { cobblestone: 3, mossy_cobblestone: 1 },
      wall: "spruce_planks",
      wall_accent: "stripped_spruce_log",
      trim: "dark_oak_planks",
      pillar: "spruce_log",
      floor: "spruce_planks",
      roof: "dark_oak_planks",
      roof_stairs: "dark_oak_stairs",
      roof_slab: "dark_oak_slab",
      door: "spruce_door",
      fence: "spruce_fence",
      log: "spruce_log",
      leaves: "spruce_leaves[persistent_bit=true]",
    },
  },
  japanese: {
    name: "japanese",
    description: "Cherry and dark wood frames, white walls, deepslate tiles",
    roles: {
      foundation: "stone_bricks",
      wall: "white_concrete",
      wall_accent: "stripped_cherry_log",
      trim: "dark_oak_planks",
      pillar: "stripped_dark_oak_log",
      floor: "bamboo_planks",
      roof: "deepslate_tiles",
      roof_stairs: "deepslate_tile_stairs",
      roof_slab: "deepslate_tile_slab",
      door: "cherry_door",
      fence: "cherry_fence",
      log: "cherry_log",
      leaves: "cherry_leaves[persistent_bit=true]",
      light: "lantern",
    },
  },
  nether: {
    name: "nether",
    description: "Blackstone, nether bricks, crimson and lava light",
    roles: {
      foundation: "blackstone",
      wall: { polished_blackstone_bricks: 4, cracked_polished_blackstone_bricks: 1 },
      wall_accent: "gilded_blackstone",
      trim: "nether_brick",
      pillar: "basalt",
      floor: "polished_blackstone",
      roof: "red_nether_brick",
      roof_stairs: "red_nether_brick_stairs",
      roof_slab: "red_nether_brick_slab",
      light: "shroomlight",
      door: "crimson_door",
      fence: "nether_brick_fence",
      stairs: "polished_blackstone_brick_stairs",
      battlement: "polished_blackstone_bricks",
    },
  },
  rustic: {
    name: "rustic",
    description: "Oak and cobblestone farm look",
    roles: {},
  },
  ice: {
    name: "ice",
    description: "Packed ice, snow and blue ice",
    roles: {
      foundation: "packed_ice",
      wall: { packed_ice: 3, blue_ice: 1 },
      wall_accent: "blue_ice",
      trim: "snow",
      pillar: "blue_ice",
      floor: "packed_ice",
      roof: "snow",
      light: "sea_lantern",
      battlement: "packed_ice",
    },
  },
};

export class PaletteError extends Error {}

/**
 * Resolves roles to materials for one build. Project palette overrides beat the style, and anything
 * passed explicitly to a generator beats both.
 */
export class Palette {
  readonly roles: Record<Role, Material>;
  private cache = new Map<string, BlockSpec>();

  constructor(style: string | Style = "rustic", overrides: Partial<Record<string, Material>> = {}, readonly seed = 0) {
    const st = typeof style === "string" ? STYLES[style] : style;
    if (!st) throw new PaletteError(`unknown style "${style}". Styles: ${Object.keys(STYLES).join(", ")}`);
    this.roles = { ...base, ...st.roles, ...(overrides as Partial<Record<Role, Material>>) };
  }

  material(role: Role | Material): Material {
    if (typeof role === "string" && role.startsWith("@")) {
      const r = this.roles[role.slice(1) as Role];
      if (!r) throw new PaletteError(`unknown role ${role}`);
      return r;
    }
    if (typeof role === "string" && role in this.roles) return this.roles[role as Role];
    return role;
  }

  private spec(name: string): BlockSpec {
    let b = this.cache.get(name);
    if (!b) {
      b = parseBlock(name);
      this.cache.set(name, b);
    }
    return b;
  }

  /** Picks the block for a role at a position. Same spot, same block, so reruns and resumes match. */
  at(role: Role | Material, x: number, y: number, z: number, states?: Record<string, StateValue>): BlockSpec {
    const m = this.material(role);
    let name: string;
    if (typeof m === "string") name = m;
    else {
      const entries = Object.entries(m).filter(([, w]) => w > 0);
      if (!entries.length) throw new PaletteError("material mix has no positive weights");
      const total = entries.reduce((a, [, w]) => a + w, 0);
      let r = hash3(x, y, z, this.seed) * total;
      name = entries[entries.length - 1][0];
      for (const [k, w] of entries) {
        r -= w;
        if (r <= 0) {
          name = k;
          break;
        }
      }
    }
    const b = this.spec(name);
    if (!states) return b;
    // generators ask for things like pillar_axis without knowing which block a style picked, so drop
    // states the chosen block doesn't have instead of sending something the game refuses
    const known = defaultStates(b.name);
    const kept = known ? Object.fromEntries(Object.entries(states).filter(([k]) => k in known)) : states;
    return { name: b.name, states: { ...b.states, ...kept } };
  }

  /** The single main block of a role, for things like stairs where a mix makes no sense. */
  main(role: Role | Material): string {
    const m = this.material(role);
    if (typeof m === "string") return m;
    return Object.entries(m).sort((a, b) => b[1] - a[1])[0][0];
  }
}

/** Every concrete block name the styles mention, used by tests to catch typos. */
export function allStyleBlocks(): string[] {
  const out = new Set<string>();
  const add = (m: Material) => {
    if (typeof m === "string") out.add(parseBlock(m).name);
    else for (const k of Object.keys(m)) out.add(parseBlock(k).name);
  };
  for (const m of Object.values(base)) add(m);
  for (const s of Object.values(STYLES)) for (const m of Object.values(s.roles)) if (m) add(m);
  return [...out];
}
