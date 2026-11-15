import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "../config.js";
import { BlockSpec, StateValue, parseBlock } from "./block.js";

interface RegistryFile {
  gameVersion: string;
  blocks: Record<string, Record<string, StateValue>>;
  states: Record<string, StateValue[]>;
}

let data: RegistryFile | undefined;

// hmm, the json sits next to the sources and isn't copied into dist, so read it from the package root
function load(): RegistryFile {
  if (!data) data = JSON.parse(readFileSync(join(PACKAGE_ROOT, "src", "data", "blocks.json"), "utf8")) as RegistryFile;
  return data;
}

/** Swaps in a block list read from the connected server, which beats the bundled snapshot. */
export function setLiveRegistry(r: RegistryFile): void {
  data = r;
}

export function registryVersion(): string {
  return load().gameVersion;
}

export function knownBlock(name: string): boolean {
  return name in load().blocks;
}

export function defaultStates(name: string): Record<string, StateValue> | undefined {
  return load().blocks[name];
}

function distance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

// a few Java names people reach for that are different on Bedrock
const JAVA_NAMES: Record<string, string> = {
  "minecraft:oak_door": "minecraft:wooden_door",
  "minecraft:oak_sign": "minecraft:standing_sign",
  "minecraft:oak_wall_sign": "minecraft:wall_sign",
  "minecraft:oak_trapdoor": "minecraft:trapdoor",
  "minecraft:oak_fence_gate": "minecraft:fence_gate",
  "minecraft:oak_button": "minecraft:wooden_button",
  "minecraft:oak_pressure_plate": "minecraft:wooden_pressure_plate",
  "minecraft:grass": "minecraft:short_grass",
  "minecraft:wall_torch": "minecraft:torch",
  "minecraft:redstone_wall_torch": "minecraft:redstone_torch",
  "minecraft:jack_o_lantern": "minecraft:lit_pumpkin",
  "minecraft:terracotta": "minecraft:hardened_clay",
  "minecraft:spawner": "minecraft:mob_spawner",
  "minecraft:note_block": "minecraft:noteblock",
  "minecraft:dirt_path": "minecraft:grass_path",
  "minecraft:magma_block": "minecraft:magma",
  "minecraft:nether_bricks": "minecraft:nether_brick",
  "minecraft:red_nether_bricks": "minecraft:red_nether_brick",
  "minecraft:snow_block": "minecraft:snow",
  "minecraft:cobweb": "minecraft:web",
  "minecraft:lily_pad": "minecraft:waterlily",
  "minecraft:end_stone_bricks": "minecraft:end_bricks",
  "minecraft:melon": "minecraft:melon_block",
  "minecraft:powered_rail": "minecraft:golden_rail",
  "minecraft:slime_block": "minecraft:slime",
  "minecraft:sugar_cane": "minecraft:reeds",
};

export function javaAlias(name: string): string | undefined {
  const a = JAVA_NAMES[name];
  return a && knownBlock(a) ? a : undefined;
}

export function suggestBlocks(name: string, n = 5): string[] {
  const alias = javaAlias(name);
  const bare = name.replace(/^minecraft:/, "");
  const scored = Object.keys(load().blocks)
    .map((k) => {
      const kb = k.replace(/^minecraft:/, "");
      let s = distance(bare, kb);
      if (kb.includes(bare) || bare.includes(kb)) s -= 3;
      return [k, s] as const;
    })
    .sort((a, b) => a[1] - b[1])
    .slice(0, n)
    .map(([k]) => k);
  return alias ? [alias, ...scored.filter((s) => s !== alias)].slice(0, n) : scored;
}

export class BlockValidationError extends Error {}

/**
 * Checks name and state values against what the game knows, so typos fail before anything is written.
 * Java names with a known Bedrock equivalent get swapped silently and reported back.
 */
export function validateBlock(input: string | BlockSpec): { block: BlockSpec; note?: string } {
  let b = parseBlock(input);
  const reg = load();
  let note: string | undefined;
  if (!reg.blocks[b.name]) {
    const alias = javaAlias(b.name);
    if (alias) {
      note = `${b.name} is the Java name, using ${alias}`;
      b = { name: alias, states: b.states };
    } else {
      throw new BlockValidationError(`unknown block ${b.name}. Did you mean: ${suggestBlocks(b.name).join(", ")}?`);
    }
  }
  const defaults = reg.blocks[b.name];
  for (const [k, v] of Object.entries(b.states)) {
    if (!(k in defaults)) {
      throw new BlockValidationError(
        `${b.name} has no state "${k}". Its states are: ${Object.keys(defaults).join(", ") || "(none)"}`,
      );
    }
    const valid = reg.states[k];
    if (valid && !valid.includes(v)) {
      throw new BlockValidationError(`${b.name} state ${k}=${JSON.stringify(v)} is invalid, allowed: ${valid.map((x) => JSON.stringify(x)).join(", ")}`);
    }
  }
  return { block: b, note };
}

export function searchBlocks(query: string, limit = 50): string[] {
  const q = query.toLowerCase();
  return Object.keys(load().blocks).filter((k) => k.includes(q)).slice(0, limit);
}

export function blockStateInfo(name: string): { states: Record<string, StateValue>; values: Record<string, StateValue[]> } | undefined {
  const reg = load();
  const s = reg.blocks[name];
  if (!s) return undefined;
  return { states: s, values: Object.fromEntries(Object.keys(s).map((k) => [k, reg.states[k] ?? []])) };
}
