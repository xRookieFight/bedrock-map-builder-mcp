import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { knownBlock, validateBlock } from "../src/core/registry.js";
import { allStyleBlocks, Palette, STYLES } from "../src/gen/palette.js";
import { GENERATORS, getGenerator } from "../src/gen/registry.js";
import { GenContext } from "../src/gen/registry.js";
import { reachable, standable, symmetry } from "../src/analysis/checks.js";
import { HeightmapResult } from "../src/engine/backend.js";
import { renderIsometric, renderTopDown } from "../src/render/views.js";

// a fake flat world at y 64 for generators that read the ground
const flat = (x1: number, z1: number, x2: number, z2: number): Promise<HeightmapResult> => {
  const w = Math.abs(x2 - x1) + 1, d = Math.abs(z2 - z1) + 1;
  return Promise.resolve({ heights: new Array(w * d).fill(64), tops: new Array(w * d).fill("minecraft:grass_block"), width: w, depth: d });
};

const ctx = (origin = { x: 0, y: 64, z: 0 }): GenContext => ({
  dim: "overworld",
  origin,
  facing: "south",
  palette: (style = "rustic", overrides = {}, seed = 0) => new Palette(style, overrides, seed),
  heightmap: flat,
});

const SAMPLE_ARGS: Record<string, unknown> = {
  shapes: { shapes: [{ type: "sphere", center: { x: 0, y: 70, z: 0 }, radius: 5, block: "stone", hollow: true }, { type: "box", from: { x: -3, y: 64, z: -3 }, to: { x: 3, y: 66, z: 3 }, block: { stone_bricks: 3, mossy_stone_bricks: 1 }, mode: "walls" }] },
  script: { code: "for (let i = 0; i < 10; i++) set(origin.x + i, origin.y, origin.z, i % 2 ? '@wall' : 'gold_block'); marker('spawn', origin);" },
  house: { width: 9, depth: 7, floors: 2 },
  tower: { radius: 4, height: 20 },
  wall: { points: [{ x: 0, z: 0 }, { x: 30, z: 0 }, { x: 30, z: 20 }], height: 6 },
  castle: { size: 40 },
  bridge: { from: { x: 0, y: 70, z: 0 }, to: { x: 40, y: 72, z: 0 } },
  road: { points: [{ x: 0, y: 64, z: 0 }, { x: 30, y: 64, z: 10 }] },
  skyscraper: { width: 12, depth: 12, floors: 10 },
  city: { width: 80, depth: 80 },
  arena: { radius: 20, teams: 2 },
  parkour: { jumps: 20, difficulty: "hard" },
  lobby: { radius: 20, portals: 4 },
  dungeon: { width: 40, depth: 40 },
  tree: { kind: "big_oak" },
  vegetation: { area: { x1: 0, z1: 0, x2: 40, z2: 40 }, kinds: ["oak", "spruce", "rock", "plants"], density: 2 },
  terrain: { area: { x1: 0, z1: 0, x2: 60, z2: 60 }, kind: "mountains", baseY: 64, waterLevel: 62, blend: 8 },
  sculpt: { mode: "raise", center: { x: 0, z: 0 }, radius: 10, amount: 6 },
  river: { points: [{ x: 0, z: 0 }, { x: 50, z: 20 }], surfaceY: 64 },
  lake: { radius: 10, depth: 4 },
  caves: { area: { x1: 0, z1: 0, x2: 60, z2: 60 }, yMin: 10, yMax: 50 },
  mountain: { radius: 30, height: 50 },
};

describe("styles", () => {
  it("only use blocks that exist in Bedrock 1.26", () => {
    const bad = allStyleBlocks().filter((b) => !knownBlock(b));
    assert.deepEqual(bad, []);
  });
});

describe("generators", () => {
  it("every generator has a sample in this test", () => {
    assert.deepEqual(GENERATORS.map((g) => g.name).filter((n) => !(n in SAMPLE_ARGS)), []);
  });

  for (const g of GENERATORS) {
    it(`${g.name} builds valid Bedrock blocks`, async () => {
      const args = g.schema.parse(SAMPLE_ARGS[g.name]);
      const r = await g.run(args, ctx());
      assert.ok(r.set.size > 0, "built nothing");
      for (const b of r.set.palette) validateBlock(b);
      const bounds = r.set.bounds()!;
      assert.ok(bounds.min.y >= -64 && bounds.max.y <= 319, `y out of range ${bounds.min.y}..${bounds.max.y}`);
    });
  }

  it("the house rotates to face each direction and keeps its footprint corner", async () => {
    for (const facing of ["north", "east", "south", "west"] as const) {
      const r = await getGenerator("house").run({ width: 9, depth: 7 }, { ...ctx({ x: 100, y: 64, z: 200 }), facing });
      const b = r.set.bounds()!;
      assert.equal(b.min.x, 100);
      assert.equal(b.min.z, 200);
      const door = r.markers.find((m) => m.kind === "door")!;
      assert.ok(door, "door marker");
    }
  });

  it("two team arenas are point symmetric", async () => {
    const r = await getGenerator("arena").run(getGenerator("arena").schema.parse({ radius: 24, teams: 2, seating: false }), ctx({ x: 0, y: 64, z: 0 }));
    const b = r.set.bounds()!;
    const sym = symmetry(r.set, b, "rot180");
    assert.ok(sym.score >= 99.5, `symmetry ${sym.score}: ${sym.examples.join(" | ")}`);
    for (const m of r.markers.filter((x) => x.kind === "spawn")) assert.ok(standable(r.set, m.pos).ok, standable(r.set, m.pos).why ?? "");
  });

  it("parkour can be finished on foot", async () => {
    for (const difficulty of ["easy", "medium", "hard"]) {
      const r = await getGenerator("parkour").run(getGenerator("parkour").schema.parse({ jumps: 30, difficulty, seed: 4 }), ctx({ x: 0, y: 64, z: 0 }));
      const start = r.markers.find((m) => m.kind === "start")!.pos;
      const finish = r.markers.find((m) => m.kind === "finish")!.pos;
      const res = reachable(r.set, start, [finish]);
      assert.equal(res.start, undefined);
      assert.ok(res.reached[0], `${difficulty} parkour finish unreachable`);
    }
  });

  it("dungeon rooms connect to the entrance", async () => {
    const r = await getGenerator("dungeon").run(getGenerator("dungeon").schema.parse({ width: 50, depth: 50, seed: 3 }), ctx({ x: 0, y: 20, z: 0 }));
    const entrance = r.markers.find((m) => m.kind === "entrance")!.pos;
    const boss = r.markers.find((m) => m.kind === "boss")!.pos;
    assert.ok(reachable(r.set, entrance, [boss]).reached[0], "boss room unreachable");
  });

  it("rejects bad args with a readable message", () => {
    const res = getGenerator("house").schema.safeParse({ width: 2 });
    assert.equal(res.success, false);
  });

  it("scripts can't run forever", () => {
    assert.throws(() => getGenerator("script").run({ code: "while(true){}" }, { ...ctx() }), /timed out|Script execution/i);
  });

  it("renders previews", async () => {
    const r = await getGenerator("castle").run({ size: 30 }, ctx());
    const iso = renderIsometric(r.set);
    const top = renderTopDown(r.set, { markers: r.markers });
    assert.equal(iso.png.subarray(1, 4).toString(), "PNG");
    assert.equal(top.png.subarray(1, 4).toString(), "PNG");
  });

  it("all styles resolve every role", () => {
    for (const st of Object.keys(STYLES)) {
      const p = new Palette(st);
      for (const role of Object.keys(p.roles)) validateBlock(p.at(role as never, 1, 2, 3));
    }
  });
});
