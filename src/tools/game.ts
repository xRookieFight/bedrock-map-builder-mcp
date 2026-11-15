import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Ctx, boxArg, dimOf, dimension, registerTool, vec3 } from "./shared.js";

const MAP_PACK_DIR = "mbm_map_logic";

// stable uuids per world, so re-writing the pack replaces it instead of piling up new packs
function uuidFrom(seed: string): string {
  const h = createHash("sha1").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function registerGame(ctx: Ctx) {
  const s = ctx.session;

  registerTool(ctx, "run_commands", "Run Bedrock commands in the world (setblock, fill, summon, tp, gamerule, scoreboard, tag, effect, time, weather, structure...). Each command reports success or the game's error text. Bedrock syntax, not Java: e.g. block states use [\"state\"=value] and there's no NBT. Commands that touch blocks far from players need load_area covering them, otherwise they quietly affect nothing (count 0).", {
    commands: z.array(z.string().min(1).max(32000)).min(1).max(500),
    load_area: z.object({ from: vec3, to: vec3 }).optional(),
    dimension,
  }, async (a) => {
    const b = s.requireBackend();
    const dim = dimOf(a.dimension);
    const cmds = a.commands.map((c: string) => c.replace(/^\//, ""));
    let release: (() => Promise<void>) | undefined;
    if (a.load_area && b.caps.load) {
      const box = boxArg(a.load_area.from, a.load_area.to);
      if ((box.max.x - box.min.x + 1) * (box.max.z - box.min.z + 1) > 256 * 256) throw new Error("load_area is limited to 256x256 columns");
      release = await b.ensureLoaded(dim, box, "cmd");
    }
    try {
      const r = await b.commands(dim, cmds);
      return {
        results: r.map((x, i) => ({ command: cmds[i], ...x })),
        failed: r.filter((x) => !x.ok).length,
        // count 0 isn't an error for every command (kill with no targets), but it usually means "nothing happened"
        noEffect: r.filter((x) => x.ok && x.count === 0).length,
      };
    } finally {
      await release?.();
    }
  });

  registerTool(ctx, "set_world_rules", "Set the world spawn point and any gamerules in one go (e.g. {pvp: true, keepInventory: true, doMobSpawning: false, showCoordinates: true}).", {
    spawn: vec3.optional(),
    gamerules: z.record(z.string(), z.union([z.boolean(), z.number()])).optional(),
    time: z.union([z.enum(["day", "noon", "sunset", "night", "midnight", "sunrise"]), z.number().int()]).optional(),
    weather: z.enum(["clear", "rain", "thunder"]).optional(),
    difficulty: z.enum(["peaceful", "easy", "normal", "hard"]).optional(),
  }, async (a) => {
    const cmds: string[] = [];
    if (a.spawn) cmds.push(`setworldspawn ${a.spawn.x} ${a.spawn.y} ${a.spawn.z}`);
    for (const [k, v] of Object.entries(a.gamerules ?? {})) cmds.push(`gamerule ${k} ${v}`);
    if (a.time !== undefined) cmds.push(`time set ${a.time}`);
    if (a.weather) cmds.push(`weather ${a.weather}`);
    if (a.difficulty) cmds.push(`difficulty ${a.difficulty}`);
    if (!cmds.length) throw new Error("nothing to set");
    const r = await s.requireBackend().commands("overworld", cmds);
    return { results: r.map((x, i) => ({ command: cmds[i], ...x })) };
  });

  registerTool(ctx, "spawn_entities", "Summon entities (npc, armor_stand, villager_v2, zombie, ...) with optional name tags and tags. Tags make it easy to target them later from commands and functions.", {
    entities: z.array(z.object({ type: z.string(), pos: z.object({ x: z.number(), y: z.number(), z: z.number() }), name: z.string().optional(), tags: z.array(z.string()).optional() })).min(1).max(200),
    dimension,
  }, async (a) => s.requireBackend().bridge("spawn", { dim: dimOf(a.dimension), entities: a.entities.map((e: { type: string }) => ({ ...e, type: e.type.includes(":") ? e.type : `minecraft:${e.type}` })) }));

  registerTool(ctx, "fill_container", "Put items into a chest, barrel, shulker box or other container block: loot rooms, kit chests, rewards.", {
    pos: vec3,
    items: z.array(z.object({ item: z.string(), amount: z.number().int().min(1).max(64).optional(), slot: z.number().int().min(0).optional(), name: z.string().optional(), lore: z.array(z.string()).optional() })).min(1).max(54),
    clear: z.boolean().default(true),
    dimension,
  }, async (a) => {
    const b = s.requireBackend();
    const dim = dimOf(a.dimension);
    const release = b.caps.load ? await b.ensureLoaded(dim, { min: a.pos, max: a.pos }, `c${a.pos.x}_${a.pos.z}`) : undefined;
    try {
      return await b.bridge("container", { dim, pos: a.pos, clear: a.clear, items: a.items.map((i: { item: string }) => ({ ...i, item: i.item.includes(":") ? i.item : `minecraft:${i.item}` })) });
    } finally {
      await release?.();
    }
  });

  registerTool(ctx, "set_sign", "Write text on a sign block (place the sign first). Use \\n for new lines.", {
    pos: vec3,
    text: z.string().max(400),
    side: z.enum(["front", "back"]).default("front"),
    waxed: z.boolean().default(true),
    dimension,
  }, async (a) => {
    const b = s.requireBackend();
    const dim = dimOf(a.dimension);
    const release = b.caps.load ? await b.ensureLoaded(dim, { min: a.pos, max: a.pos }, `s${a.pos.x}_${a.pos.z}`) : undefined;
    try {
      return await b.bridge("sign", { dim, pos: a.pos, text: a.text, side: a.side, waxed: a.waxed });
    } finally {
      await release?.();
    }
  });

  registerTool(ctx, "map_functions", "Write game logic as .mcfunction files into a behavior pack inside the managed world (Bedrock's replacement for command block chains). Functions are called with /function <name>; names listed in tick run every tick. The server reloads them right away. Example: {\"teams/tp_red\": [\"tp @a[tag=red] 10 65 0\"]}.", {
    world: z.string().optional(),
    functions: z.record(z.string().regex(/^[a-z0-9_/]+$/), z.array(z.string().max(32000))),
    tick: z.array(z.string()).optional(),
    replace_all: z.boolean().default(false),
  }, async (a) => {
    const world = a.world ?? s.world;
    if (!world) throw new Error("no world given and none running");
    const wdir = s.worldPath(world);
    if (!existsSync(join(wdir, "level.dat")) && !existsSync(wdir)) throw new Error(`no managed world ${world}`);
    const pdir = join(wdir, "behavior_packs", MAP_PACK_DIR);
    if (a.replace_all) rmSync(join(pdir, "functions"), { recursive: true, force: true });
    mkdirSync(join(pdir, "functions"), { recursive: true });
    const header = uuidFrom(`${world}:header`), mod = uuidFrom(`${world}:module`);
    writeFileSync(join(pdir, "manifest.json"), JSON.stringify({
      format_version: 2,
      header: { name: `${world} map logic`, description: "Functions written by bedrock-map-builder-mcp", uuid: header, version: [1, 0, 0], min_engine_version: [1, 21, 0] },
      modules: [{ type: "data", uuid: mod, version: [1, 0, 0] }],
    }, null, 2));
    let lines = 0;
    for (const [name, body] of Object.entries(a.functions as Record<string, string[]>)) {
      if (name.includes("..")) throw new Error(`bad function name ${name}`);
      const f = join(pdir, "functions", `${name}.mcfunction`);
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, body.map((l) => l.replace(/^\//, "")).join("\n") + "\n");
      lines += body.length;
    }
    if (a.tick) writeFileSync(join(pdir, "functions", "tick.json"), JSON.stringify({ values: a.tick }, null, 2));
    const listFile = join(wdir, "world_behavior_packs.json");
    let list: { pack_id: string; version: number[] }[] = [];
    try { list = JSON.parse(readFileSync(listFile, "utf8")); } catch {}
    if (!list.some((p) => p.pack_id === header)) {
      list.push({ pack_id: header, version: [1, 0, 0] });
      writeFileSync(listFile, JSON.stringify(list, null, 2));
    }
    let reload: string[] | undefined;
    if (s.server?.ready && s.world === world) {
      // a newly added pack only loads on restart, plain function edits come in with reload
      reload = await s.server.console("reload", { settleMs: 2500 });
    }
    return {
      pack: pdir,
      functions: Object.keys(a.functions),
      lines,
      reloadOutput: reload?.filter((l) => /function|error|warn/i.test(l)).slice(0, 30),
      note: "if this is the first time the pack was added, restart the server (server_start) so the world loads it",
    };
  });
}
