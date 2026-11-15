type RGBA = [number, number, number, number];

const DYES: Record<string, [number, number, number]> = {
  white: [233, 236, 236], orange: [240, 118, 19], magenta: [189, 68, 179], light_blue: [58, 175, 217],
  yellow: [248, 198, 39], lime: [112, 185, 25], pink: [237, 141, 172], gray: [62, 68, 71],
  light_gray: [142, 142, 134], cyan: [21, 137, 145], purple: [121, 42, 172], blue: [53, 57, 157],
  brown: [114, 71, 40], green: [84, 109, 27], red: [161, 39, 34], black: [20, 21, 25],
};

const WOOD: Record<string, [number, number, number]> = {
  oak: [162, 130, 78], spruce: [114, 84, 48], birch: [196, 179, 123], jungle: [160, 115, 80], acacia: [168, 90, 50],
  dark_oak: [66, 43, 20], mangrove: [117, 54, 48], cherry: [226, 178, 172], bamboo: [194, 173, 80], crimson: [101, 48, 70], warped: [43, 104, 99], pale_oak: [228, 218, 216],
};

// exact matches first, then keyword rules. approximate map colours, good enough to read a layout
const EXACT: Record<string, [number, number, number]> = {
  grass_block: [95, 159, 53], dirt: [134, 96, 67], coarse_dirt: [119, 85, 59], grass_path: [148, 121, 65], stone: [125, 125, 125],
  cobblestone: [122, 122, 122], mossy_cobblestone: [110, 118, 94], stone_bricks: [122, 121, 122], mossy_stone_bricks: [115, 121, 105],
  cracked_stone_bricks: [118, 117, 118], andesite: [136, 136, 137], polished_andesite: [132, 135, 134], diorite: [188, 188, 188],
  granite: [149, 103, 86], sand: [219, 207, 163], red_sand: [190, 102, 33], sandstone: [216, 203, 155], smooth_sandstone: [223, 214, 170],
  gravel: [131, 127, 126], water: [63, 118, 228], lava: [207, 92, 15], snow: [249, 254, 254], snow_layer: [249, 254, 254], ice: [145, 183, 253],
  packed_ice: [141, 180, 250], blue_ice: [116, 167, 253], glass: [200, 230, 240], glass_pane: [200, 230, 240], bedrock: [85, 85, 85],
  deepslate: [80, 80, 82], cobbled_deepslate: [77, 77, 80], deepslate_tiles: [54, 54, 55], polished_deepslate: [72, 72, 73],
  blackstone: [42, 36, 41], polished_blackstone_bricks: [48, 42, 49], basalt: [80, 81, 86], netherrack: [97, 38, 38],
  quartz_block: [235, 229, 222], smooth_quartz: [235, 229, 222], quartz_pillar: [235, 230, 224], calcite: [223, 224, 220],
  sea_lantern: [172, 199, 190], glowstone: [171, 131, 84], lantern: [106, 91, 83], shroomlight: [240, 146, 70], torch: [255, 210, 90],
  end_rod: [240, 235, 225], iron_block: [220, 220, 220], gold_block: [246, 208, 61], diamond_block: [98, 237, 228], emerald_block: [42, 203, 87],
  smooth_stone: [158, 158, 158], bricks: [150, 97, 83], hardened_clay: [152, 94, 67], prismarine: [99, 156, 151], dark_prismarine: [51, 91, 75],
  prismarine_bricks: [99, 171, 158], purpur_block: [169, 125, 169], tuff: [108, 109, 102], mud_bricks: [137, 103, 79], barrier: [255, 0, 0],
  oak_leaves: [59, 118, 40], spruce_leaves: [52, 84, 52], birch_leaves: [94, 128, 58], jungle_leaves: [48, 129, 22], cherry_leaves: [230, 173, 201],
  dark_oak_leaves: [45, 98, 28], acacia_leaves: [70, 110, 30], iron_bars: [130, 130, 130], chest: [150, 106, 47], bookshelf: [117, 94, 59],
  crafting_table: [128, 95, 58], furnace: [110, 110, 110], magma: [142, 63, 31], obsidian: [20, 18, 30], amethyst_block: [133, 97, 191],
  short_grass: [95, 159, 53], tall_grass: [95, 159, 53], fern: [80, 130, 50], redstone_lamp: [160, 100, 60], light_weighted_pressure_plate: [246, 208, 61],
};

const cache = new Map<string, RGBA>();

export function blockColor(name: string): RGBA | null {
  const n = name.replace(/^minecraft:/, "");
  const hit = cache.get(n);
  if (hit) return hit;
  let c: [number, number, number] | undefined = EXACT[n];
  let a = 255;
  if (n === "air" || n === "cave_air" || n === "void_air" || n === "structure_void" || n === "light_block" || n.startsWith("light_block_")) return null;
  if (!c) {
    const dye = Object.keys(DYES).sort((x, y) => y.length - x.length).find((d) => n.startsWith(d + "_"));
    if (dye) c = DYES[dye];
  }
  if (!c) {
    const wood = Object.keys(WOOD).sort((x, y) => y.length - x.length).find((w) => n.includes(w));
    if (wood) c = WOOD[wood];
  }
  if (!c) {
    if (n.includes("leaves")) c = [60, 120, 40];
    else if (n.includes("deepslate")) c = [70, 70, 72];
    else if (n.includes("blackstone")) c = [45, 38, 44];
    else if (n.includes("sandstone")) c = [216, 203, 155];
    else if (n.includes("stone") || n.includes("brick")) c = [125, 125, 125];
    else if (n.includes("copper")) c = [192, 107, 79];
    else if (n.includes("flower") || n.includes("tulip") || n.includes("poppy") || n.includes("dandelion")) c = [200, 60, 60];
    else c = [160, 160, 160];
  }
  if (n.includes("glass")) a = 110;
  if (n === "water") a = 190;
  const out: RGBA = [c[0], c[1], c[2], a];
  cache.set(n, out);
  return out;
}

/** Slabs, stairs, plants and similar don't fill the cell, the isometric view draws them a bit lower. */
export function isPartial(name: string): boolean {
  return /_slab|stairs|carpet|pressure_plate|_button|torch|lantern|flower|grass$|fern|sapling|rail|snow_layer|_sign|fence|bars|pane|wall$|ladder|vine|door/.test(name);
}
