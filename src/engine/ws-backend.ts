import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { BlockSpec, blockToCommand } from "../core/block.js";
import { Box, Dimension, Vec3 } from "../core/geometry.js";
import { VoxelSet } from "../core/voxels.js";
import { Backend, FillResult, HeightmapResult, UnsupportedError } from "./backend.js";

// the client starts dropping requests somewhere past 100 in flight, stay well below
const MAX_IN_FLIGHT = 40;

interface Pending {
  resolve: (r: { statusCode: number; statusMessage?: string; [k: string]: unknown }) => void;
  timer: NodeJS.Timeout;
}

/**
 * Talks to a game client that ran /connect host:port. Only commands go over this link: blocks can be
 * written, structures saved and loaded in memory, but nothing can be read back, so no analysis or exports.
 */
export class WsLink {
  private wss?: WebSocketServer;
  private sock?: WebSocket;
  private pending = new Map<string, Pending>();
  private inFlight = 0;
  private waiters: (() => void)[] = [];
  player?: string;
  connectedAt?: string;
  onChange?: (connected: boolean) => void;

  get connected() {
    return !!this.sock && this.sock.readyState === WebSocket.OPEN;
  }

  listen(port: number, host = "127.0.0.1"): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port, host });
      wss.once("listening", () => resolve());
      wss.once("error", reject);
      wss.on("connection", (sock) => {
        // one game at a time, a second /connect replaces the first
        this.sock?.close();
        this.sock = sock;
        this.connectedAt = new Date().toISOString();
        sock.on("message", (data) => this.onMessage(String(data)));
        sock.on("close", () => {
          if (this.sock === sock) {
            this.sock = undefined;
            this.onChange?.(false);
          }
          for (const [id, p] of this.pending) {
            clearTimeout(p.timer);
            p.resolve({ statusCode: -1, statusMessage: "connection closed" });
            this.pending.delete(id);
          }
        });
        this.command("getlocalplayername").then((r) => {
          this.player = typeof r.localplayername === "string" ? r.localplayername : undefined;
          this.onChange?.(true);
        });
      });
      this.wss = wss;
    });
  }

  private onMessage(text: string) {
    let msg: { header?: { requestId?: string; messagePurpose?: string }; body?: Record<string, unknown> };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const id = msg.header?.requestId;
    if (!id) return;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    this.inFlight--;
    this.waiters.shift()?.();
    const body = msg.body ?? {};
    p.resolve({ statusCode: typeof body.statusCode === "number" ? body.statusCode : msg.header?.messagePurpose === "error" ? -1 : 0, ...body } as never);
  }

  async command(line: string, timeoutMs = 20_000): Promise<{ statusCode: number; statusMessage?: string; [k: string]: unknown }> {
    if (!this.connected) throw new Error("no game connected. In the game run /connect " + this.address());
    while (this.inFlight >= MAX_IN_FLIGHT) await new Promise<void>((r) => this.waiters.push(r));
    this.inFlight++;
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.inFlight--;
        this.waiters.shift()?.();
        resolve({ statusCode: -1, statusMessage: `no answer after ${timeoutMs} ms` });
      }, timeoutMs);
      this.pending.set(requestId, { resolve, timer });
      this.sock!.send(JSON.stringify({
        header: { version: 1, requestId, messagePurpose: "commandRequest", messageType: "commandRequest" },
        body: { version: 1, commandLine: line, origin: { type: "player" } },
      }));
    });
  }

  address() {
    const a = this.wss?.address();
    return a && typeof a === "object" ? `localhost:${a.port}` : "localhost:<port>";
  }

  async close() {
    this.sock?.close();
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
    this.wss = undefined;
  }
}

const ROT = ["0_degrees", "90_degrees", "180_degrees", "270_degrees"];

export class WsBackend implements Backend {
  readonly kind = "websocket" as const;
  readonly caps = { read: false, snapshot: true, load: true, scripting: false };

  constructor(readonly link: WsLink) {}

  worldId() {
    return `ws:${this.link.player ?? "client"}`;
  }

  async describe() {
    return { kind: this.kind, world: this.worldId(), connected: this.link.connected, player: this.link.player, since: this.link.connectedAt };
  }

  bridge<T>(op: string): Promise<T> {
    return Promise.reject(new UnsupportedError(`${op} needs the script bridge, which only exists on a BDS world. Over /connect only commands work`));
  }

  async ensureLoaded(dim: Dimension, box: Box, id: string) {
    const name = `mbm${id}`.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 32);
    const exec = dim === "overworld" ? "" : `execute in ${dim} run `;
    await this.link.command(`${exec}tickingarea add ${box.min.x} 0 ${box.min.z} ${box.max.x} 0 ${box.max.z} ${name}`);
    // poll until the area answers block tests instead of saying it's outside the world
    for (let i = 0; i < 40; i++) {
      const r = await this.link.command(`${exec}testforblock ${box.max.x} ${box.min.y} ${box.max.z} air`);
      if (!/outside|unloaded|not loaded/i.test(r.statusMessage ?? "")) break;
      await new Promise((res) => setTimeout(res, 250));
    }
    return async () => {
      await this.link.command(`tickingarea remove ${name}`).catch(() => {});
    };
  }

  private async run(dim: Dimension, cmds: string[]) {
    const exec = dim === "overworld" ? "" : `execute in ${dim} run `;
    return Promise.all(cmds.map((c) => this.link.command(exec + c)));
  }

  async fill(dim: Dimension, palette: BlockSpec[], boxes: number[], filter?: { include?: string[]; exclude?: string[] }): Promise<FillResult> {
    if (filter?.exclude?.length) throw new UnsupportedError("keep/exclude filters aren't available over /connect, /fill only has a single replace filter");
    const cmds: string[] = [];
    for (let i = 0; i < boxes.length; i += 7) {
      const [x1, y1, z1, x2, y2, z2, p] = boxes.slice(i, i + 7);
      const blk = blockToCommand(palette[p]);
      const single = x1 === x2 && y1 === y2 && z1 === z2;
      if (filter?.include?.length) for (const inc of filter.include) cmds.push(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${blk} replace ${inc}`);
      else cmds.push(single ? `setblock ${x1} ${y1} ${z1} ${blk}` : `fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${blk}`);
    }
    const res = await this.run(dim, cmds);
    let placed = 0;
    const errors: string[] = [];
    res.forEach((r, i) => {
      if (r.statusCode >= 0) {
        const m = /(\d+)\s+blocks?/i.exec(r.statusMessage ?? "");
        placed += m ? Number(m[1]) : 1;
      } else if (!/no blocks|0 blocks|could not place|already/i.test(r.statusMessage ?? "") && errors.length < 10) errors.push(`${cmds[i]}: ${r.statusMessage}`);
    });
    return { placed, errors };
  }

  async paint(dim: Dimension, box: Box, palette: BlockSpec[], runs: string): Promise<FillResult> {
    // no dense op over commands, so turn the runs back into single row fills
    const flat: number[] = [];
    const sx = box.max.x - box.min.x + 1, sz = box.max.z - box.min.z + 1;
    let n = 0;
    for (const tok of runs.split(",")) {
      const star = tok.indexOf("*");
      const idx = Number(star < 0 ? tok : tok.slice(0, star));
      let cnt = star < 0 ? 1 : Number(tok.slice(star + 1));
      while (cnt > 0) {
        const x0 = n % sx, len = Math.min(cnt, sx - x0);
        if (idx >= 0) {
          const z = Math.floor(n / sx) % sz, y = Math.floor(n / (sx * sz));
          flat.push(box.min.x + x0, box.min.y + y, box.min.z + z, box.min.x + x0 + len - 1, box.min.y + y, box.min.z + z, idx);
        }
        n += len;
        cnt -= len;
      }
    }
    return this.fill(dim, palette, flat);
  }

  async read(): Promise<{ set: VoxelSet; waterlogged: Vec3[] }> {
    throw new UnsupportedError("blocks can't be read back over /connect. Import the world (world_import) to analyse or export it");
  }

  async heightmap(): Promise<HeightmapResult> {
    throw new UnsupportedError("terrain can't be read over /connect. Import the world to use terrain aware tools");
  }

  async snapshot(dim: Dimension, box: Box, name: string) {
    const exec = dim === "overworld" ? "" : `execute in ${dim} run `;
    // memory mode stays out of the save file, so the map never carries our undo copies
    const r = await this.link.command(`${exec}structure save ${name} ${box.min.x} ${box.min.y} ${box.min.z} ${box.max.x} ${box.max.y} ${box.max.z} false memory true`);
    if (r.statusCode < 0) throw new Error(`structure save failed: ${r.statusMessage}`);
  }

  async place(dim: Dimension, name: string, at: Vec3, opts: { rotation?: number; mirror?: "x" | "z" | "xz" | "none" } = {}) {
    const exec = dim === "overworld" ? "" : `execute in ${dim} run `;
    const mirror = !opts.mirror || opts.mirror === "none" ? "none" : opts.mirror;
    const r = await this.link.command(`${exec}structure load ${name} ${at.x} ${at.y} ${at.z} ${ROT[(opts.rotation ?? 0) % 4]} ${mirror}`);
    if (r.statusCode < 0) throw new Error(`structure load failed: ${r.statusMessage}`);
  }

  async deleteStructures(names: string[]) {
    let n = 0;
    for (const name of names) if ((await this.link.command(`structure delete ${name}`)).statusCode >= 0) n++;
    return n;
  }

  async commands(dim: Dimension, cmds: string[]) {
    const res = await this.run(dim, cmds);
    return res.map((r) => (r.statusCode >= 0 ? { ok: true, count: 1 } : { ok: false, error: r.statusMessage ?? "failed" }));
  }
}
