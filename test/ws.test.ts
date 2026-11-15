// Protocol test for the /connect link. A fake client stands in for the game: it speaks the commandRequest /
// commandResponse JSON and applies fill, setblock and structure commands to an in-memory world. This proves our
// side of the protocol, not the real client's behaviour.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { WebSocket } from "ws";

const tmp = mkdtempSync(join(tmpdir(), "mbm-ws-"));
process.env.MBM_DATA_DIR = tmp;
const { WsBackend, WsLink } = await import("../src/engine/ws-backend.js");
const { applyVoxels, undoOp } = await import("../src/engine/apply.js");
const { Project } = await import("../src/engine/project.js");
const { VoxelSet } = await import("../src/core/voxels.js");

function fakeGame(port: number) {
  const world = new Map<string, string>();
  const structures = new Map<string, Map<string, string>>();
  const commands: string[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const k = (x: number, y: number, z: number) => `${x},${y},${z}`;
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    const line: string = msg.body.commandLine;
    commands.push(line);
    let body: Record<string, unknown> = { statusCode: 0, statusMessage: "ok" };
    const p = line.split(" ");
    if (p[0] === "getlocalplayername") body = { statusCode: 0, localplayername: "Steve" };
    else if (p[0] === "fill" || p[0] === "setblock") {
      const n = p[0] === "fill" ? 6 : 3;
      const c = p.slice(1, 1 + n).map(Number);
      const [x1, y1, z1, x2, y2, z2] = n === 6 ? c : [...c, ...c];
      const block = p[1 + n];
      let count = 0;
      for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) for (let z = z1; z <= z2; z++) { world.set(k(x, y, z), block); count++; }
      body = { statusCode: 0, statusMessage: `${count} blocks filled` };
    } else if (p[0] === "structure" && p[1] === "save") {
      const [x1, y1, z1, x2, y2, z2] = p.slice(3, 9).map(Number);
      const s = new Map<string, string>();
      for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) for (let z = z1; z <= z2; z++) s.set(k(x - x1, y - y1, z - z1), world.get(k(x, y, z)) ?? "minecraft:air");
      structures.set(p[2], s);
    } else if (p[0] === "structure" && p[1] === "load") {
      const s = structures.get(p[2]);
      if (!s) body = { statusCode: -2147483648, statusMessage: "structure not found" };
      else {
        const [x, y, z] = p.slice(3, 6).map(Number);
        for (const [key, b] of s) {
          const [dx, dy, dz] = key.split(",").map(Number);
          world.set(k(x + dx, y + dy, z + dz), b);
        }
      }
    } else if (p[0] === "structure" && p[1] === "delete") structures.delete(p[2]);
    else if (p[0] === "nonsense") body = { statusCode: -2147483648, statusMessage: "Unknown command: nonsense" };
    ws.send(JSON.stringify({ header: { requestId: msg.header.requestId, messagePurpose: "commandResponse", version: 1 }, body }));
  });
  return { ws, world, commands, structures, open: new Promise((r) => ws.once("open", r)) };
}

describe("/connect websocket link", () => {
  const link = new WsLink();
  after(async () => {
    await link.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("builds, reports errors and undoes through commands only", async () => {
    await link.listen(0);
    const port = Number(link.address().split(":")[1]);
    const connected = new Promise<boolean>((r) => (link.onChange = r));
    const game = fakeGame(port);
    await game.open;
    assert.equal(await connected, true);
    assert.equal(link.player, "Steve");
    const backend = new WsBackend(link);
    assert.equal(backend.worldId(), "ws:Steve");

    const project = new Project("wstest");
    game.world.set("1,64,1", "minecraft:dirt");
    const set = new VoxelSet();
    for (let x = 0; x < 10; x++) for (let z = 0; z < 10; z++) set.set(x, 64, z, "stone");
    set.set(3, 65, 3, "oak_stairs[weirdo_direction=1]");
    const r = await applyVoxels(backend, project, set, { label: "ws build", dim: "overworld" });
    assert.equal(r.status, "done", r.errors.join(";"));
    assert.equal(game.world.get("9,64,9"), "minecraft:stone");
    assert.ok(game.commands.some((c) => c.startsWith("structure save") && c.endsWith("false memory true")), "undo snapshot should be in memory");
    assert.ok(game.commands.some((c) => c.includes('minecraft:oak_stairs ["weirdo_direction"=1]')));
    assert.ok(game.commands.some((c) => c.startsWith("tickingarea add")));

    await undoOp(backend, project, r.opId);
    assert.equal(game.world.get("1,64,1"), "minecraft:dirt");
    assert.equal(game.world.get("9,64,9"), "minecraft:air");
    assert.equal(game.structures.size, 0, "undo structures are cleaned up");

    const res = await backend.commands("overworld", ["say hi", "nonsense"]);
    assert.equal(res[0].ok, true);
    assert.equal(res[1].ok, false);
    await assert.rejects(backend.read(), /can't be read/);
    game.ws.close();
  });
});
