// End to end: a real MCP client talks to the built server over stdio, and the server drives a real BDS.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bds = process.env.MBM_BDS_DIR;
const tmp = mkdtempSync(join(process.env.MBM_TEST_TMP || tmpdir(), "mbm-mcp-"));

type Out = { content: { type: string; text?: string; data?: string }[]; isError?: boolean };

describe("MCP server end to end", { skip: !bds && "MBM_BDS_DIR not set" }, () => {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 })) as Out;
    const text = r.content.find((c) => c.type === "text")?.text ?? "";
    if (r.isError) throw new Error(`${name}: ${text}`);
    return { data: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text, images: r.content.filter((c) => c.type === "image").length };
  };

  before(async () => {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dirname, "..", "src", "index.js")],
      env: { ...process.env, MBM_DATA_DIR: tmp, MBM_SERVER_PORT: "19240" } as Record<string, string>,
    }));
  });

  after(async () => {
    await call("server_stop").catch(() => {});
    await client.close();
    if (!process.env.MBM_KEEP_TMP) rmSync(tmp, { recursive: true, force: true });
  });

  it("lists the tools", async () => {
    const t = await client.listTools();
    const names = t.tools.map((x) => x.name);
    for (const n of ["generate", "fill_region", "op_undo", "plan_run", "view", "check_map", "world_export", "ws_listen"]) assert.ok(names.includes(n), n);
    console.log(`${names.length} tools`);
  });

  it("previews without a world", async () => {
    const r = await call("generate", { generator: "house", args: { width: 9, depth: 7 }, dry_run: true, preview: "both" });
    assert.equal(r.data.dryRun, true);
    assert.equal(r.images, 2);
  });

  it("sets up and creates a world", async () => {
    const s = await call("server_setup", { bds_dir: bds });
    assert.equal(s.data.configured, true);
    const w = await call("world_create", { name: "e2e", type: "flat" });
    assert.equal(w.data.newWorld, true);
  });

  it("builds an arena, checks it, views it and undoes it", async () => {
    const g = await call("generate", { generator: "arena", args: { radius: 16, teams: 2, seating: false }, origin: { x: 0, y: -60, z: 0 } });
    assert.equal(g.data.status, "done", JSON.stringify(g.data.errors));
    assert.equal(g.data.verify.mismatched, 0, JSON.stringify(g.data.verify));
    const spawns = g.data.markers.filter((m: { kind: string }) => m.kind === "spawn");
    assert.equal(spawns.length, 2);

    const c = await call("check_map", { from: { x: -18, y: -61, z: -18 }, to: { x: 18, y: -50, z: 18 }, reach_from: spawns[0].pos, reach_to: [spawns[1].pos], symmetry: "rot180" });
    assert.ok(c.data.spawns.every((s: { ok: boolean }) => s.ok), JSON.stringify(c.data.spawns));
    assert.equal(c.data.reachability.targets[0].reachable, true);
    assert.ok(c.data.symmetry.score >= 99, JSON.stringify(c.data.symmetry));

    const v = await call("view", { source: "world", mode: "iso", from: { x: -18, y: -61, z: -18 }, to: { x: 18, y: -50, z: 18 } });
    assert.equal(v.images, 1);

    const u = await call("op_undo", { op_id: g.data.opId });
    assert.deepEqual(u.data.errors, []);
    const st = await call("region_stats", { from: { x: -16, y: -60, z: -16 }, to: { x: 16, y: -60, z: 16 } });
    assert.equal(st.data.top[0].block, "minecraft:air");
  });

  it("fills with filters, copies with rotation and finds blocks", async () => {
    await call("fill_region", { from: { x: 100, y: -60, z: 0 }, to: { x: 104, y: -58, z: 4 }, block: { stone_bricks: 3, mossy_stone_bricks: 1 } });
    await call("place_blocks", { blocks: [{ x: 100, y: -57, z: 0, block: "oak_stairs[weirdo_direction=0]" }] });
    const r = await call("replace_blocks", { from: { x: 100, y: -60, z: 0 }, to: { x: 104, y: -58, z: 4 }, find: ["mossy_stone_bricks"], replace_with: "gold_block" });
    assert.equal(r.data.status, "done");
    const f = await call("find_blocks", { from: { x: 100, y: -60, z: 0 }, to: { x: 104, y: -58, z: 4 }, blocks: ["mossy_stone_bricks"] });
    assert.equal(f.data.total, 0);
    const cp = await call("copy_region", { from: { x: 100, y: -60, z: 0 }, to: { x: 104, y: -57, z: 4 }, dest: { x: 120, y: -60, z: 0 }, rotate: 1 });
    assert.equal(cp.data.status, "done");
    const probe = await call("region_stats", { from: { x: 120, y: -57, z: 0 }, to: { x: 124, y: -57, z: 4 } });
    assert.ok(probe.data.top.some((t: { block: string }) => t.block === "minecraft:oak_stairs"));
  });

  it("exports and re-imports a .mcstructure", async () => {
    const file = join(tmp, "out", "piece.mcstructure");
    const e = await call("structure_export", { from: { x: 100, y: -60, z: 0 }, to: { x: 104, y: -57, z: 4 }, file });
    assert.ok(existsSync(file) && e.data.bytes > 100);
    const i = await call("structure_import", { file, origin: { x: 140, y: -60, z: 0 } });
    assert.equal(i.data.status, "done");
    assert.equal(i.data.verify.mismatched, 0);
  });

  it("runs a plan, game logic and an export", async () => {
    const p = await call("plan_create", {
      title: "mini lobby",
      steps: [
        { tool: "generate", args: { generator: "lobby", args: { radius: 12, portals: 2 }, origin: { x: 0, y: -60, z: 200 } } },
        { tool: "set_world_rules", args: { spawn: { x: 0, y: -59, z: 205 }, gamerules: { pvp: false, showcoordinates: true } } },
        { tool: "map_functions", args: { functions: { "lobby/welcome": ["say welcome"] } } },
      ],
    });
    const run = await call("plan_run", { plan: p.data.plan });
    assert.equal(run.data.done, true, JSON.stringify(run.data.ran));
    const cmds = await call("run_commands", { commands: ["/setblock 0 -55 0 chest", "summon armor_stand 0 -59 0", "definitely_not_a_command"], load_area: { from: { x: 0, y: -60, z: 0 }, to: { x: 0, y: -50, z: 0 } } });
    assert.equal(cmds.data.failed, 1);
    assert.equal(cmds.data.noEffect, 0, JSON.stringify(cmds.data.results));
    await call("fill_container", { pos: { x: 0, y: -55, z: 0 }, items: [{ item: "diamond_sword", amount: 1, name: "Starter" }, { item: "bread", amount: 16 }] });
    const out = join(tmp, "out", "e2e.mcworld");
    const ex = await call("world_export", { world: "e2e", to: out });
    assert.equal(ex.data.written, out);
    assert.ok(statSync(out).size > 1000);
  });
});
