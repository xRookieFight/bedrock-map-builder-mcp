export type StateValue = string | number | boolean;

/** A Bedrock block with its states, e.g. minecraft:oak_stairs with weirdo_direction=2. */
export interface BlockSpec {
  name: string;
  states: Record<string, StateValue>;
}

export class BlockParseError extends Error {}

export function normalizeName(name: string): string {
  const n = name.trim().toLowerCase();
  if (!n) throw new BlockParseError("empty block name");
  return n.includes(":") ? n : `minecraft:${n}`;
}

function parseValue(raw: string): StateValue {
  const v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) return v.slice(1, -1);
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}

/**
 * Parses the forms people actually type: `stone`, `minecraft:oak_log[pillar_axis=y]` and the
 * command syntax `oak_stairs["weirdo_direction"=1,"upside_down_bit"=false]`. Java style `:` separators
 * inside the brackets are accepted too since that's what Java copy pastes look like.
 */
export function parseBlock(input: string | BlockSpec): BlockSpec {
  if (typeof input !== "string") {
    return { name: normalizeName(input.name), states: { ...(input.states ?? {}) } };
  }
  const s = input.trim();
  const open = s.indexOf("[");
  if (open < 0) return { name: normalizeName(s), states: {} };
  if (!s.endsWith("]")) throw new BlockParseError(`unterminated state list in "${input}"`);
  const name = normalizeName(s.slice(0, open));
  const body = s.slice(open + 1, -1).trim();
  const states: Record<string, StateValue> = {};
  if (body) {
    for (const part of body.split(",")) {
      const m = /^\s*"?([a-z0-9_:]+)"?\s*[=:]\s*(.+?)\s*$/i.exec(part);
      if (!m) throw new BlockParseError(`bad state "${part}" in "${input}"`);
      states[m[1]] = parseValue(m[2]);
    }
  }
  return { name, states };
}

/** Stable string key, states sorted, so equal blocks always map to the same palette slot. */
export function blockKey(b: BlockSpec): string {
  const keys = Object.keys(b.states).sort();
  if (!keys.length) return b.name;
  return `${b.name}[${keys.map((k) => `${k}=${JSON.stringify(b.states[k])}`).join(",")}]`;
}

/** Formats a block for Bedrock commands: `minecraft:oak_stairs ["weirdo_direction"=1]`. */
export function blockToCommand(b: BlockSpec): string {
  const keys = Object.keys(b.states);
  if (!keys.length) return b.name;
  return `${b.name} [${keys.map((k) => `"${k}"=${JSON.stringify(b.states[k])}`).join(",")}]`;
}

export const AIR: BlockSpec = { name: "minecraft:air", states: {} };

export function isAir(b: BlockSpec): boolean {
  return b.name === "minecraft:air" || b.name === "minecraft:cave_air" || b.name === "minecraft:void_air";
}

export function withStates(b: BlockSpec | string, states: Record<string, StateValue>): BlockSpec {
  const base = parseBlock(b);
  return { name: base.name, states: { ...base.states, ...states } };
}
