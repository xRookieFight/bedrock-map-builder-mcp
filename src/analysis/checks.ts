import { blockKey, isAir } from "../core/block.js";
import { Box, Vec3 } from "../core/geometry.js";
import { VoxelSet } from "../core/voxels.js";

const NON_SOLID = /air|water|lava|short_grass|tall_grass|fern|flower|poppy|dandelion|tulip|torch|carpet|pressure_plate|button|_sign|banner|vine|ladder|rail|snow_layer|sapling|bush|structure_void|light_block|tripwire|redstone_wire|lever|seagrass|kelp/;

export function isSolidName(name: string): boolean {
  return !NON_SOLID.test(name);
}

export function stats(set: VoxelSet, box?: Box) {
  const h = set.histogram();
  const total = set.size;
  const counts = [...h.entries()]
    .map(([i, n]) => ({ block: blockKey(set.palette[i]), count: n }))
    .sort((a, b) => b.count - a.count);
  const byName = new Map<string, number>();
  for (const c of counts) {
    const n = c.block.split("[")[0];
    byName.set(n, (byName.get(n) ?? 0) + c.count);
  }
  const air = [...byName.entries()].filter(([n]) => /air$/.test(n)).reduce((a, [, n]) => a + n, 0);
  return {
    bounds: box ?? set.bounds(),
    cells: total,
    nonAir: total - air,
    distinctBlocks: byName.size,
    top: [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([block, count]) => ({ block, count, pct: Math.round((count / Math.max(1, total)) * 1000) / 10 })),
  };
}

/**
 * Groups of solid blocks that touch nothing below the region floor. Small groups are usually leftovers or
 * floating bits; big ones might be intentional (sky islands), so the size is reported, not judged.
 */
export function floatingGroups(set: VoxelSet, floorY: number, maxReport = 20) {
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const solid = (x: number, y: number, z: number) => {
    const i = set.get(x, y, z);
    return i >= 0 && isSolidName(set.palette[i].name) && !isAir(set.palette[i]);
  };
  const seen = new Set<string>();
  const groups: { size: number; sample: Vec3; grounded: boolean }[] = [];
  set.forEach((x, y, z) => {
    if (!solid(x, y, z) || seen.has(key(x, y, z))) return;
    const stack: Vec3[] = [{ x, y, z }];
    seen.add(key(x, y, z));
    let size = 0, grounded = false;
    while (stack.length) {
      const c = stack.pop()!;
      size++;
      if (c.y <= floorY) grounded = true;
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const n = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
        const k = key(n.x, n.y, n.z);
        if (seen.has(k) || !solid(n.x, n.y, n.z)) continue;
        seen.add(k);
        stack.push(n);
      }
      if (size > 2_000_000) break;
    }
    if (!grounded) groups.push({ size, sample: { x, y, z }, grounded });
  });
  groups.sort((a, b) => a.size - b.size);
  return { floatingGroups: groups.length, smallest: groups.slice(0, maxReport) };
}

/** A player fits here: solid floor below, two non solid cells for the body. */
export function standable(set: VoxelSet, p: Vec3): { ok: boolean; why?: string } {
  const at = (dy: number) => set.getBlock(p.x, p.y + dy, p.z);
  const below = at(-1);
  if (!below || !isSolidName(below.name)) return { ok: false, why: `no solid floor under ${p.x} ${p.y} ${p.z} (${below?.name ?? "unknown"})` };
  for (const dy of [0, 1]) {
    const b = at(dy);
    if (b && isSolidName(b.name)) return { ok: false, why: `${b.name} blocks the player at y+${dy}` };
    if (b && /lava|fire|magma|cactus|sweet_berry/.test(b.name)) return { ok: false, why: `hazard ${b.name} at y+${dy}` };
  }
  if (/magma|campfire/.test(below.name)) return { ok: false, why: `hazard floor ${below.name}` };
  return { ok: true };
}

/**
 * Walk/jump reachability over the set. Moves: walk to a neighbour, step up one, drop up to 3, and straight
 * sprint jumps over gaps up to 3 wide on the same level. Loosely matches what a vanilla player can do.
 */
export function reachable(set: VoxelSet, from: Vec3, targets: Vec3[], limit = 400_000) {
  const k = (p: Vec3) => `${p.x},${p.y},${p.z}`;
  const start = standable(set, from);
  if (!start.ok) return { start: start.why, reached: [] as boolean[], explored: 0 };
  const want = new Map(targets.map((t, i) => [k(t), i]));
  const reached = targets.map(() => false);
  const seen = new Set([k(from)]);
  const q: Vec3[] = [from];
  let explored = 0;
  let head = 0;
  const can = (p: Vec3) => standable(set, p).ok;
  while (head < q.length && explored < limit) {
    const c = q[head++];
    explored++;
    const hit = want.get(k(c));
    if (hit !== undefined) reached[hit] = true;
    if (reached.every(Boolean)) break;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const cand: Vec3[] = [];
      for (let dy = 1; dy >= -3; dy--) cand.push({ x: c.x + dx, y: c.y + dy, z: c.z + dz });
      // sprint jumps: land up to 5 out on the same level or lower, 4 out one block up, with up to one block of side drift
      for (let g = 2; g <= 5; g++) {
        for (const side of [0, 1, -1]) {
          if (side && g > 4) continue;
          const lx = c.x + dx * g + (dx === 0 ? side : 0), lz = c.z + dz * g + (dz === 0 ? side : 0);
          cand.push({ x: lx, y: c.y, z: lz }, { x: lx, y: c.y - 1, z: lz }, { x: lx, y: c.y - 2, z: lz });
          if (g <= 4) cand.push({ x: lx, y: c.y + 1, z: lz });
        }
      }
      for (const n of cand) {
        const nk = k(n);
        if (seen.has(nk) || !can(n)) continue;
        seen.add(nk);
        q.push(n);
      }
    }
  }
  return { start: undefined, reached, explored };
}

/**
 * Compares the set with itself mirrored or rotated around the centre of `box`. 100 means perfectly symmetric.
 * By default it compares shape (solid or not), which is what matters for fairness; exact also compares block types,
 * which mixed palettes will never pass.
 */
export function symmetry(set: VoxelSet, box: Box, kind: "mirror_x" | "mirror_z" | "rot180" | "rot90", exact = false) {
  const cx = box.min.x + box.max.x, cz = box.min.z + box.max.z;
  let same = 0, total = 0;
  const examples: string[] = [];
  set.forEach((x, y, z, i) => {
    const b = set.palette[i];
    if (isAir(b)) return;
    let ox = x, oz = z;
    if (kind === "mirror_x") ox = cx - x;
    else if (kind === "mirror_z") oz = cz - z;
    else if (kind === "rot180") { ox = cx - x; oz = cz - z; }
    else { ox = Math.round(cx / 2 - (z - cz / 2)); oz = Math.round(cz / 2 + (x - cx / 2)); }
    total++;
    const o = set.getBlock(ox, y, oz);
    const match = exact ? !!o && o.name === b.name : !!o && !isAir(o) && isSolidName(o.name) === isSolidName(b.name);
    if (match) same++;
    else if (examples.length < 5) examples.push(`${x} ${y} ${z} ${b.name} vs ${ox} ${y} ${oz} ${o?.name ?? "nothing"}`);
  });
  return { kind, score: total ? Math.round((same / total) * 1000) / 10 : 100, compared: total, examples };
}
