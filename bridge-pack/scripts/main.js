// Map Builder Bridge. Requests arrive as `scriptevent mbm:c <id> <seq> <total> <chunk>` and answers go out on the
// server console as `MBM1 <id> <seq> <total> <chunk>`. The MCP side does all the planning, this side only executes.
import {
  system,
  world,
  BlockVolume,
  BlockPermutation,
  BlockTypes,
  BlockStates,
  ItemStack,
  StructureSaveMode,
  StructureRotation,
  StructureMirrorAxis,
} from "@minecraft/server";

const BRIDGE_VERSION = "0.1.0";
// console lines over ~20k chars came through fine on BDS 1.26.61, stay well under that
const OUT_CHUNK = 12000;

const pending = new Map();

function send(id, obj) {
  const text = JSON.stringify(obj);
  const total = Math.max(1, Math.ceil(text.length / OUT_CHUNK));
  for (let i = 0; i < total; i++) {
    console.log(`MBM1 ${id} ${i} ${total} ${text.slice(i * OUT_CHUNK, (i + 1) * OUT_CHUNK)}`);
  }
}

function dim(name) {
  return world.getDimension(name || "overworld");
}

const permCache = new Map();
function perm(spec) {
  const key = JSON.stringify(spec);
  let p = permCache.get(key);
  if (!p) {
    p = BlockPermutation.resolve(spec.name, spec.states || {});
    permCache.set(key, p);
  }
  return p;
}

function describe(p) {
  return { name: p.type.id, states: p.getAllStates() };
}

// runs a generator as a job so big loops don't trip the script watchdog
function job(gen) {
  return new Promise((resolve, reject) => {
    system.runJob(
      (function* () {
        try {
          resolve(yield* gen());
        } catch (e) {
          reject(e);
        }
      })(),
    );
  });
}

function boxVolume(b) {
  return new BlockVolume(b.from, b.to);
}

const handlers = {
  ping() {
    return {
      bridge: BRIDGE_VERSION,
      tick: system.currentTick,
      players: world.getAllPlayers().map((p) => ({ name: p.name, dim: p.dimension.id, pos: p.location })),
    };
  },

  registry() {
    const blocks = BlockTypes.getAll().map((t) => {
      let states = {};
      try {
        states = BlockPermutation.resolve(t.id).getAllStates();
      } catch {}
      return { id: t.id, states };
    });
    const stateTypes = BlockStates.getAll().map((s) => ({ id: s.id, values: s.validValues }));
    return { blocks, stateTypes };
  },

  async load(a) {
    const tam = world.tickingAreaManager;
    if (tam.hasTickingArea(a.id)) tam.removeTickingArea(a.id);
    await tam.createTickingArea(a.id, { dimension: dim(a.dim), from: a.from, to: a.to });
    return { loaded: true };
  },

  unload(a) {
    const tam = world.tickingAreaManager;
    if (a.all) {
      for (const t of tam.getAllTickingAreas()) if (t.identifier.startsWith("mbm")) tam.removeTickingArea(t);
    } else if (tam.hasTickingArea(a.id)) tam.removeTickingArea(a.id);
    return { ok: true };
  },

  async fill(a) {
    const d = dim(a.dim);
    const perms = a.palette.map(perm);
    const opts = {};
    if (a.include || a.exclude) {
      opts.blockFilter = {};
      if (a.include) opts.blockFilter.includeTypes = a.include;
      if (a.exclude) opts.blockFilter.excludeTypes = a.exclude;
    }
    const b = a.boxes;
    return job(function* () {
      let placed = 0;
      const errors = [];
      for (let i = 0; i < b.length; i += 7) {
        try {
          const vol = new BlockVolume({ x: b[i], y: b[i + 1], z: b[i + 2] }, { x: b[i + 3], y: b[i + 4], z: b[i + 5] });
          const r = d.fillBlocks(vol, perms[b[i + 6]], opts);
          placed += r.getCapacity();
        } catch (e) {
          if (errors.length < 10) errors.push(String(e));
        }
        yield;
      }
      return { placed, errors };
    });
  },

  // dense variant of fill for noisy tiles: runs of palette indices over y, z, x with -1 meaning leave alone
  async paint(a) {
    const d = dim(a.dim);
    const perms = a.palette.map(perm);
    const { from, to } = a;
    const sx = to.x - from.x + 1, sz = to.z - from.z + 1;
    const toks = a.runs.split(",");
    return job(function* () {
      let n = 0, placed = 0, ops = 0;
      const errors = [];
      for (const tok of toks) {
        const star = tok.indexOf("*");
        const idx = Number(star < 0 ? tok : tok.slice(0, star));
        let cnt = star < 0 ? 1 : Number(tok.slice(star + 1));
        while (cnt > 0) {
          const x0 = n % sx;
          const len = Math.min(cnt, sx - x0);
          if (idx >= 0) {
            const z = Math.floor(n / sx) % sz, y = Math.floor(n / (sx * sz));
            const p0 = { x: from.x + x0, y: from.y + y, z: from.z + z };
            try {
              if (len === 1) d.setBlockPermutation(p0, perms[idx]);
              else d.fillBlocks(new BlockVolume(p0, { x: p0.x + len - 1, y: p0.y, z: p0.z }), perms[idx]);
              placed += len;
            } catch (e) {
              if (errors.length < 10) errors.push(String(e));
            }
            if (++ops % 256 === 0) yield;
          }
          n += len;
          cnt -= len;
        }
      }
      return { placed, errors };
    });
  },

  async read(a) {
    const d = dim(a.dim);
    const { from, to } = a;
    return job(function* () {
      const palette = [];
      const pIndex = new Map();
      const sx = to.x - from.x + 1, sy = to.y - from.y + 1, sz = to.z - from.z + 1;
      // RLE over y, z, x (x fastest). empty air runs compress to almost nothing
      const runs = [];
      let last = -2, count = 0;
      let water = [];
      let n = 0;
      for (let y = from.y; y <= to.y; y++) {
        for (let z = from.z; z <= to.z; z++) {
          for (let x = from.x; x <= to.x; x++) {
            const blk = d.getBlock({ x, y, z });
            let idx = -1;
            if (blk) {
              const p = blk.permutation;
              const key = p.type.id + JSON.stringify(p.getAllStates());
              idx = pIndex.get(key);
              if (idx === undefined) {
                idx = palette.length;
                palette.push(describe(p));
                pIndex.set(key, idx);
              }
              if (blk.isWaterlogged) water.push(x, y, z);
            }
            if (idx === last) count++;
            else {
              if (count) runs.push(count === 1 ? last : `${last}*${count}`);
              last = idx;
              count = 1;
            }
            if (++n % 2048 === 0) yield;
          }
        }
      }
      if (count) runs.push(count === 1 ? last : `${last}*${count}`);
      return { size: { x: sx, y: sy, z: sz }, palette, runs: runs.join(","), water };
    });
  },

  async heightmap(a) {
    const d = dim(a.dim);
    return job(function* () {
      const palette = [];
      const pIndex = new Map();
      const heights = [];
      const tops = [];
      for (let z = a.z1; z <= a.z2; z++) {
        for (let x = a.x1; x <= a.x2; x++) {
          let b;
          try {
            b = d.getTopmostBlock({ x, z }, a.minY);
          } catch {
            b = undefined;
          }
          if (!b) {
            heights.push(null);
            tops.push(-1);
          } else {
            heights.push(b.location.y);
            const id = b.typeId;
            let i = pIndex.get(id);
            if (i === undefined) {
              i = palette.length;
              palette.push(id);
              pIndex.set(id, i);
            }
            tops.push(i);
          }
        }
        yield;
      }
      return { palette, heights, tops };
    });
  },

  async find(a) {
    const d = dim(a.dim);
    return job(function* () {
      const list = d.getBlocks(boxVolume(a), { includeTypes: a.include, excludeTypes: a.exclude }, true);
      const out = [];
      const limit = a.limit || 1000;
      let total = 0;
      for (const loc of list.getBlockLocationIterator()) {
        total++;
        if (out.length < limit) out.push([loc.x, loc.y, loc.z]);
        if (total % 1024 === 0) yield;
      }
      return { total, positions: out };
    });
  },

  probe(a) {
    const d = dim(a.dim);
    const out = [];
    for (let i = 0; i < a.points.length; i += 3) {
      const b = d.getBlock({ x: a.points[i], y: a.points[i + 1], z: a.points[i + 2] });
      out.push(b ? [b.typeId, b.permutation.getAllStates()] : null);
    }
    return { blocks: out };
  },

  snapshot(a) {
    const sm = world.structureManager;
    if (sm.get(a.name)) sm.delete(a.name);
    sm.createFromWorld(a.name, dim(a.dim), a.from, a.to, {
      saveMode: a.memory ? StructureSaveMode.Memory : StructureSaveMode.World,
      includeEntities: !!a.entities,
      includeBlocks: true,
    });
    return { name: a.name };
  },

  place(a) {
    world.structureManager.place(a.name, dim(a.dim), a.at, {
      includeEntities: !!a.entities,
      rotation: StructureRotation[a.rotation || "None"],
      mirror: StructureMirrorAxis[a.mirror || "None"],
      integrity: a.integrity,
      integritySeed: a.seed,
    });
    return { ok: true };
  },

  deleteStructure(a) {
    const sm = world.structureManager;
    let removed = 0;
    for (const n of a.names) {
      try {
        if (sm.get(n) && sm.delete(n)) removed++;
      } catch {}
    }
    return { removed };
  },

  structures() {
    return { ids: world.structureManager.getWorldStructureIds() };
  },

  command(a) {
    const d = dim(a.dim);
    const out = [];
    for (const c of a.commands) {
      try {
        out.push({ ok: true, count: d.runCommand(c).successCount });
      } catch (e) {
        out.push({ ok: false, error: String(e) });
      }
    }
    return { results: out };
  },

  entities(a) {
    const d = dim(a.dim);
    const q = {};
    if (a.from && a.to) {
      q.location = a.from;
      q.volume = { x: a.to.x - a.from.x, y: a.to.y - a.from.y, z: a.to.z - a.from.z };
    }
    if (a.type) q.type = a.type;
    return {
      entities: d.getEntities(q).slice(0, a.limit || 500).map((e) => ({
        id: e.id,
        type: e.typeId,
        name: e.nameTag,
        pos: e.location,
        tags: e.getTags(),
      })),
    };
  },

  spawn(a) {
    const d = dim(a.dim);
    const out = [];
    for (const s of a.entities) {
      try {
        const e = d.spawnEntity(s.type, s.pos);
        if (s.name) e.nameTag = s.name;
        for (const t of s.tags || []) e.addTag(t);
        out.push({ ok: true, id: e.id });
      } catch (e) {
        out.push({ ok: false, error: String(e) });
      }
    }
    return { results: out };
  },

  container(a) {
    const b = dim(a.dim).getBlock(a.pos);
    if (!b) throw new Error("block is not loaded");
    const inv = b.getComponent("minecraft:inventory");
    if (!inv || !inv.container) throw new Error(`${b.typeId} has no inventory`);
    const c = inv.container;
    if (a.clear) c.clearAll();
    let slot = 0;
    for (const it of a.items) {
      const s = it.slot ?? slot++;
      const stack = new ItemStack(it.item, it.amount || 1);
      if (it.name) stack.nameTag = it.name;
      if (it.lore) stack.setLore(it.lore);
      c.setItem(s, stack);
    }
    return { size: c.size };
  },

  sign(a) {
    const b = dim(a.dim).getBlock(a.pos);
    if (!b) throw new Error("block is not loaded");
    const s = b.getComponent("minecraft:sign");
    if (!s) throw new Error(`${b.typeId} is not a sign`);
    s.setText(a.text, a.side === "back" ? "Back" : "Front");
    if (a.waxed) s.setWaxed(true);
    return { ok: true };
  },

  async light(a) {
    const d = dim(a.dim);
    const thr = a.threshold ?? 8;
    return job(function* () {
      const dark = [];
      let checked = 0;
      for (let z = a.from.z; z <= a.to.z; z++) {
        for (let x = a.from.x; x <= a.to.x; x++) {
          for (let y = a.from.y + 1; y <= a.to.y; y++) {
            const here = d.getBlock({ x, y, z });
            if (!here || !here.isAir) continue;
            const below = d.getBlock({ x, y: y - 1, z });
            if (!below || below.isAir || below.isLiquid) continue;
            checked++;
            const lvl = Math.max(d.getLightLevel({ x, y, z }), 0);
            if (lvl < thr && dark.length < (a.limit || 2000)) dark.push([x, y, z, lvl]);
          }
          yield;
        }
      }
      return { checked, dark };
    });
  },
};

async function run(id, raw) {
  let req;
  try {
    req = JSON.parse(raw);
  } catch (e) {
    send(id, { ok: false, error: `bad request json: ${e}` });
    return;
  }
  const h = handlers[req.op];
  if (!h) {
    send(id, { ok: false, error: `unknown op ${req.op}` });
    return;
  }
  try {
    const result = await h(req.args || {});
    send(id, { ok: true, result });
  } catch (e) {
    send(id, { ok: false, error: String(e && e.stack ? `${e}` : e) });
  }
}

system.afterEvents.scriptEventReceive.subscribe((ev) => {
  if (ev.id !== "mbm:c") return;
  const m = ev.message;
  const s1 = m.indexOf(" "), s2 = m.indexOf(" ", s1 + 1), s3 = m.indexOf(" ", s2 + 1);
  if (s1 < 0 || s2 < 0 || s3 < 0) return;
  const id = m.slice(0, s1);
  const seq = Number(m.slice(s1 + 1, s2));
  const total = Number(m.slice(s2 + 1, s3));
  const data = m.slice(s3 + 1);
  let parts = pending.get(id);
  if (!parts) {
    parts = { got: 0, chunks: new Array(total) };
    pending.set(id, parts);
  }
  if (parts.chunks[seq] === undefined) {
    parts.chunks[seq] = data;
    parts.got++;
  }
  if (parts.got === total) {
    pending.delete(id);
    // hmm, async handlers can't run inside the event callback's restricted context, so hop to the next tick
    system.run(() => run(id, parts.chunks.join("")));
  }
});

world.afterEvents.worldLoad.subscribe(() => {
  console.log(`MBM1 ready 0 1 ${JSON.stringify({ bridge: BRIDGE_VERSION })}`);
});
