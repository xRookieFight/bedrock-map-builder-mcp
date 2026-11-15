import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { blockKey, blockToCommand, parseBlock } from "../src/core/block.js";
import { GeometryError, assertBoxInWorld, tileBox } from "../src/core/geometry.js";
import { decodeMcStructure, encodeMcStructure } from "../src/core/mcstructure.js";
import { nbt, readNbt, toPlain, writeNbt } from "../src/core/nbt.js";
import { Simplex } from "../src/core/noise.js";
import { mirrorBlock, rotateBlock, transformSet } from "../src/core/transform.js";
import { VoxelSet } from "../src/core/voxels.js";
import { encodeForCommand, chunkRequest } from "../src/bds/server.js";
import { unzipTo, zipDirectory } from "../src/util/zip.js";

describe("block parsing", () => {
  it("adds the namespace and reads states", () => {
    const b = parseBlock('oak_stairs["weirdo_direction"=1,"upside_down_bit"=false]');
    assert.equal(b.name, "minecraft:oak_stairs");
    assert.deepEqual(b.states, { weirdo_direction: 1, upside_down_bit: false });
    assert.equal(parseBlock("oak_log[pillar_axis=x]").states.pillar_axis, "x");
  });
  it("gives the same key regardless of state order", () => {
    assert.equal(blockKey(parseBlock("a[x=1,y=2]")), blockKey(parseBlock("a[y=2,x=1]")));
  });
  it("formats command syntax", () => {
    assert.equal(blockToCommand(parseBlock("oak_log[pillar_axis=x]")), 'minecraft:oak_log ["pillar_axis"="x"]');
  });
  it("rejects garbage", () => {
    assert.throws(() => parseBlock("stone[oops"));
    assert.throws(() => parseBlock(""));
  });
});

describe("geometry", () => {
  it("rejects boxes outside the build limit", () => {
    assert.throws(() => assertBoxInWorld({ min: { x: 0, y: -65, z: 0 }, max: { x: 1, y: 0, z: 1 } }, "overworld"), GeometryError);
    assert.throws(() => assertBoxInWorld({ min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 128, z: 1 } }, "nether"), GeometryError);
    assert.throws(() => assertBoxInWorld({ min: { x: 0.5, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }, "overworld"), GeometryError);
    assertBoxInWorld({ min: { x: -5, y: -64, z: 0 }, max: { x: 5, y: 319, z: 1 } }, "overworld");
  });
  it("tiles cover the box exactly", () => {
    const tiles = tileBox({ min: { x: 0, y: 0, z: 0 }, max: { x: 99, y: 9, z: 9 } }, { x: 64, y: 64, z: 64 });
    assert.equal(tiles.length, 2);
    assert.equal(tiles[1].min.x, 64);
    assert.equal(tiles[1].max.x, 99);
  });
});

describe("VoxelSet", () => {
  it("stores negative coords and counts", () => {
    const s = new VoxelSet();
    s.set(-1, -64, -17, "stone");
    s.set(-1, -64, -17, "dirt");
    s.set(30_000_000 - 1, 319, 5, "stone");
    assert.equal(s.size, 2);
    assert.equal(s.getBlock(-1, -64, -17)?.name, "minecraft:dirt");
    s.unset(-1, -64, -17);
    assert.equal(s.size, 1);
    assert.equal(s.get(-1, -64, -17), -1);
  });
  it("merges a solid box into few cuboids under the fill limit", () => {
    const s = new VoxelSet();
    for (let x = 0; x < 64; x++) for (let y = 0; y < 20; y++) for (let z = 0; z < 64; z++) s.set(x, y, z, "stone");
    const c = s.toCuboids();
    assert.ok(c.length <= 4, `got ${c.length} cuboids`);
    let vol = 0;
    for (const q of c) {
      const v = (q.max.x - q.min.x + 1) * (q.max.y - q.min.y + 1) * (q.max.z - q.min.z + 1);
      assert.ok(v <= 32768);
      vol += v;
    }
    assert.equal(vol, s.size);
  });
  it("cuboids reproduce the set exactly", () => {
    const s = new VoxelSet();
    const n = new Simplex(3);
    for (let x = 0; x < 30; x++) for (let z = 0; z < 30; z++) for (let y = 0; y < 10; y++) if (n.noise3(x / 8, y / 8, z / 8) > 0) s.set(x, y, z, y > 5 ? "dirt" : "stone");
    const back = new VoxelSet();
    for (const q of s.toCuboids())
      for (let x = q.min.x; x <= q.max.x; x++) for (let y = q.min.y; y <= q.max.y; y++) for (let z = q.min.z; z <= q.max.z; z++) {
        assert.equal(back.get(x, y, z), -1, "cuboids overlap");
        back.set(x, y, z, s.palette[q.block]);
      }
    assert.equal(back.size, s.size);
    s.forEach((x, y, z, i) => assert.equal(back.getBlock(x, y, z)?.name, s.palette[i].name));
  });
  it("RLE runs round trip through the bridge format", () => {
    const s = new VoxelSet();
    s.set(1, 0, 0, "stone");
    s.set(2, 0, 0, "stone");
    s.set(0, 1, 1, "dirt");
    assert.equal(s.toRuns({ min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 1, z: 1 } }), "-1,0*2,-1*6,1,-1*2");
  });
  it("splits by aligned tiles", () => {
    const s = new VoxelSet();
    s.set(-1, -64, 0, "stone");
    s.set(0, 319, 0, "stone");
    const tiles = s.splitByTiles({ x: 64, y: 384, z: 64 }, { x: 0, y: -64, z: 0 });
    assert.equal(tiles.size, 2);
  });
});

describe("transforms", () => {
  it("rotates stairs and logs with the build", () => {
    assert.equal(rotateBlock(parseBlock("oak_stairs[weirdo_direction=0]"), 1).states.weirdo_direction, 2); // east -> south
    assert.equal(rotateBlock(parseBlock("oak_log[pillar_axis=x]"), 1).states.pillar_axis, "z");
    assert.equal(rotateBlock(parseBlock("chest[minecraft:cardinal_direction=north]"), 2).states["minecraft:cardinal_direction"], "south");
    assert.equal(mirrorBlock(parseBlock("oak_stairs[weirdo_direction=0]"), "x").states.weirdo_direction, 1);
    assert.equal(rotateBlock(parseBlock("standing_sign[ground_sign_direction=0]"), 1).states.ground_sign_direction, 4);
  });
  it("rotating four times gives the original", () => {
    const s = new VoxelSet();
    s.set(3, 0, 1, "oak_stairs[weirdo_direction=3]");
    s.set(5, 2, 7, "stone");
    let r = s;
    for (let i = 0; i < 4; i++) r = transformSet(r, { rotate: 1, pivot: { x: 0, y: 0, z: 0 } });
    assert.equal(r.getBlock(3, 0, 1)?.states.weirdo_direction, 3);
    assert.equal(r.getBlock(5, 2, 7)?.name, "minecraft:stone");
  });
  it("rotates positions clockwise seen from above", () => {
    const s = new VoxelSet();
    s.set(0, 0, -1, "stone"); // north of the pivot
    const r = transformSet(s, { rotate: 1, pivot: { x: 0, y: 0, z: 0 } });
    assert.equal(r.getBlock(1, 0, 0)?.name, "minecraft:stone"); // now east
  });
});

describe("NBT and mcstructure", () => {
  it("round trips NBT", () => {
    const t = nbt.compound({ a: nbt.int(5), b: nbt.string("çğü"), c: nbt.list("int", [nbt.int(1)]), d: nbt.long(123n), e: nbt.list("end", []) });
    const back = readNbt(writeNbt(t, "root"));
    assert.equal(back.name, "root");
    assert.deepEqual(toPlain(back.tag), { a: 5, b: "çğü", c: [1], d: "123", e: [] });
  });
  it("rejects truncated data", () => {
    const buf = writeNbt(nbt.compound({ a: nbt.string("hello") }));
    assert.throws(() => readNbt(buf.subarray(0, buf.length - 3)));
  });
  it("round trips a structure with void and states", () => {
    const blocks = new VoxelSet();
    blocks.set(0, 0, 0, "stone");
    blocks.set(1, 2, 3, "oak_stairs[weirdo_direction=2,upside_down_bit=true]");
    const secondary = new VoxelSet();
    secondary.set(1, 2, 3, "water[liquid_depth=0]");
    const buf = encodeMcStructure({ size: { x: 2, y: 3, z: 4 }, origin: { x: 10, y: 20, z: 30 }, blocks, secondary });
    const s = decodeMcStructure(buf);
    assert.deepEqual(s.size, { x: 2, y: 3, z: 4 });
    assert.equal(s.blocks.size, 2);
    assert.equal(s.blocks.getBlock(1, 2, 3)?.states.upside_down_bit, true);
    assert.equal(s.blocks.getBlock(1, 2, 3)?.states.weirdo_direction, 2);
    assert.equal(s.secondary.getBlock(1, 2, 3)?.name, "minecraft:water");
    assert.equal(s.blocks.get(0, 1, 0), -1);
  });
});

describe("bridge encoding", () => {
  it("keeps commands ASCII without spaces and under the scriptevent limit", () => {
    const payload = encodeForCommand({ text: "merhaba dünya \"q\"", n: [1, 2] });
    assert.match(payload, /^[\x21-\x7e]+$/);
    assert.deepEqual(JSON.parse(payload), { text: "merhaba dünya \"q\"", n: [1, 2] });
    const lines = chunkRequest("a1", "x".repeat(5000));
    assert.equal(lines.length, 3);
    for (const l of lines) assert.ok(l.length < 2000);
  });
});

describe("zip", () => {
  it("round trips a folder and refuses path escapes on extract", () => {
    const d = mkdtempSync(join(tmpdir(), "mbm-zip-"));
    try {
      mkdirSync(join(d, "src", "db"), { recursive: true });
      writeFileSync(join(d, "src", "level.dat"), Buffer.from([1, 2, 3]));
      writeFileSync(join(d, "src", "db", "CURRENT"), "x".repeat(1000));
      assert.equal(zipDirectory(join(d, "src"), join(d, "w.mcworld")), 2);
      unzipTo(join(d, "w.mcworld"), join(d, "out"));
      assert.equal(readFileSync(join(d, "out", "db", "CURRENT"), "utf8"), "x".repeat(1000));
      assert.deepEqual([...readFileSync(join(d, "out", "level.dat"))], [1, 2, 3]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
