// Integration tests against a real Bedrock Dedicated Server. Needs MBM_BDS_DIR pointing at an unpacked
// Linux BDS. Everything runs in a throwaway data dir, nothing touches your real worlds.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const bds = process.env.MBM_BDS_DIR;
const tmp = mkdtempSync(join(process.env.MBM_TEST_TMP || tmpdir(), "mbm-bds-"));
process.env.MBM_DATA_DIR = tmp;

const { Session } = await import("../src/engine/session.js");
const { applyVoxels, undoOp } = await import("../src/engine/apply.js");
const { VoxelSet } = await import("../src/core/voxels.js");
const { readRegion, readHeightmap } = await import("../src/engine/read.js");

describe("BDS bridge", { skip: !bds && "MBM_BDS_DIR not set" }, () => {
  const session = new Session();

  before(async () => {
    const r = await session.startServer("itest", { levelType: "FLAT" });
    assert.equal(r.newWorld, true);
  });

  after(async () => {
    await session.shutdown();
    if (!process.env.MBM_KEEP_TMP) rmSync(tmp, { recursive: true, force: true });
  });

  it("answers ping", async () => {
    const d = await session.requireBackend().describe();
    assert.equal(d.bridge, "0.1.0");
  });

  it("fills, reads back and undoes", async () => {
    const b = session.requireBackend();
    const set = new VoxelSet();
    for (let x = 0; x < 20; x++) for (let z = 0; z < 20; z++) for (let y = -60; y < -55; y++) set.set(x, y, z, "stone_bricks");
    set.set(5, -55, 5, "oak_stairs[weirdo_direction=2]");
    const r = await applyVoxels(b, session.project, set, { label: "test fill", dim: "overworld" });
    assert.equal(r.status, "done", JSON.stringify(r.errors));
    assert.equal(r.placed, set.size);
    assert.equal(r.verify?.mismatched, 0, JSON.stringify(r.verify));

    const read = await readRegion(b, "overworld", { min: { x: 4, y: -56, z: 4 }, max: { x: 6, y: -55, z: 6 } });
    assert.equal(read.set.getBlock(5, -55, 5)?.name, "minecraft:oak_stairs");
    assert.equal(read.set.getBlock(5, -55, 5)?.states.weirdo_direction, 2);
    assert.equal(read.set.getBlock(4, -56, 4)?.name, "minecraft:stone_bricks");

    const ids = (await b.bridge<{ ids: string[] }>("structures", {})).ids;
    assert.deepEqual(ids.filter((i) => i.startsWith("mbm:")), [], "undo data must not be stored inside the world");

    const u = await undoOp(b, session.project, r.opId);
    assert.deepEqual(u.errors, []);
    const back = await readRegion(b, "overworld", { min: { x: 5, y: -55, z: 5 }, max: { x: 5, y: -55, z: 5 } });
    assert.equal(back.set.getBlock(5, -55, 5)?.name, "minecraft:air");
  });

  it("reads a heightmap of the flat world", async () => {
    const b = session.requireBackend();
    const h = await readHeightmap(b, "overworld", 100, 100, 110, 105);
    assert.equal(h.heights.length, 66);
    assert.equal(h.heights[0], -61);
    assert.equal(h.tops[0], "minecraft:grass_block");
  });

  it("writes far from spawn by loading the chunks first", async () => {
    const b = session.requireBackend();
    const set = new VoxelSet();
    for (let x = 0; x < 100; x++) set.set(5000 + x, -60, 5000, "gold_block");
    const r = await applyVoxels(b, session.project, set, { label: "far", dim: "overworld" });
    assert.equal(r.status, "done", JSON.stringify(r.errors));
    assert.equal(r.tiles, 2);
    assert.equal(r.verify?.mismatched, 0);
  });

  it("handles a big fill in several tiles", async () => {
    const b = session.requireBackend();
    const set = new VoxelSet();
    for (let x = -100; x < 100; x++) for (let z = -100; z < 100; z++) for (let y = -60; y < -58; y++) set.set(x, y, z, (x + z) % 2 ? "white_concrete" : "black_concrete");
    const t0 = Date.now();
    const r = await applyVoxels(b, session.project, set, { label: "checker", dim: "overworld" });
    console.log(`checker 80k blocks: ${r.fills} fill batches, ${r.tiles} tiles, ${Date.now() - t0} ms`);
    assert.equal(r.status, "done", JSON.stringify(r.errors));
    assert.equal(r.placed, 80000);
  });

  it("reports unknown blocks clearly", async () => {
    const b = session.requireBackend();
    const set = new VoxelSet();
    set.set(0, -50, 0, "not_a_real_block");
    const r = await applyVoxels(b, session.project, set, { label: "bad", dim: "overworld" });
    assert.notEqual(r.status, "done");
    assert.match(r.errors.join(" "), /not_a_real_block|block/i);
  });

  it("runs commands and backs up live", async () => {
    const b = session.requireBackend();
    const res = await b.commands("overworld", ["setblock 1 -50 1 diamond_block", "this_is_not_a_command"]);
    assert.equal(res[0].ok, true);
    assert.equal(res[1].ok, false);
    const path = await session.backupWorld("itest", "t");
    assert.ok(session.listBackups("itest").some((x) => x.path === path));
  });
});
