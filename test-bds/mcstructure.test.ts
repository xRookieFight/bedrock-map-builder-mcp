// Checks that .mcstructure files we write are accepted by the real game: the file goes into a behavior pack's
// structures folder, the server loads it on start, and /structure load places it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const bds = process.env.MBM_BDS_DIR;
const tmp = mkdtempSync(join(process.env.MBM_TEST_TMP || tmpdir(), "mbm-struct-"));
process.env.MBM_DATA_DIR = tmp;

const { Session } = await import("../src/engine/session.js");
const { encodeMcStructure } = await import("../src/core/mcstructure.js");
const { VoxelSet } = await import("../src/core/voxels.js");
const { readRegion } = await import("../src/engine/read.js");

describe("mcstructure in the real game", { skip: !bds && "MBM_BDS_DIR not set" }, () => {
  const s = new Session();
  after(async () => {
    await s.shutdown();
    if (!process.env.MBM_KEEP_TMP) rmSync(tmp, { recursive: true, force: true });
  });

  it("loads a file we wrote", async () => {
    await s.startServer("structs", { levelType: "FLAT" });
    await s.stopServer();
    const blocks = new VoxelSet();
    blocks.set(0, 0, 0, "gold_block");
    blocks.set(2, 1, 3, "oak_stairs[weirdo_direction=2,upside_down_bit=true]");
    blocks.set(1, 0, 0, "oak_log[pillar_axis=x]");
    const file = encodeMcStructure({ size: { x: 3, y: 2, z: 4 }, origin: { x: 0, y: 0, z: 0 }, blocks, secondary: new VoxelSet() });

    const world = s.worldPath("structs");
    const pack = join(world, "behavior_packs", "mbm_struct_test");
    mkdirSync(join(pack, "structures"), { recursive: true });
    writeFileSync(join(pack, "structures", "piece.mcstructure"), file);
    writeFileSync(join(pack, "manifest.json"), JSON.stringify({
      format_version: 2,
      header: { name: "struct test", description: "", uuid: "0b1f8a52-7c7e-4b9b-9f43-1f4f7a4f0001", version: [1, 0, 0], min_engine_version: [1, 21, 0] },
      modules: [{ type: "data", uuid: "0b1f8a52-7c7e-4b9b-9f43-1f4f7a4f0002", version: [1, 0, 0] }],
    }));
    const listFile = join(world, "world_behavior_packs.json");
    const list = JSON.parse(readFileSync(listFile, "utf8"));
    list.push({ pack_id: "0b1f8a52-7c7e-4b9b-9f43-1f4f7a4f0001", version: [1, 0, 0] });
    writeFileSync(listFile, JSON.stringify(list));

    await s.startServer("structs");
    const b = s.requireBackend();
    const release = await b.ensureLoaded("overworld", { min: { x: 10, y: -60, z: 10 }, max: { x: 13, y: -58, z: 14 } }, "st");
    try {
      const r = await b.commands("overworld", ["structure load mystructure:piece 10 -60 10"]);
      assert.equal(r[0].ok, true, r[0].error ?? "");
    } finally {
      await release();
    }
    const { set } = await readRegion(b, "overworld", { min: { x: 10, y: -60, z: 10 }, max: { x: 12, y: -59, z: 13 } });
    assert.equal(set.getBlock(10, -60, 10)?.name, "minecraft:gold_block");
    assert.equal(set.getBlock(11, -60, 10)?.states.pillar_axis, "x");
    const st = set.getBlock(12, -59, 13);
    assert.equal(st?.name, "minecraft:oak_stairs");
    assert.equal(st?.states.weirdo_direction, 2);
    assert.equal(st?.states.upside_down_bit, true);
  });
});
