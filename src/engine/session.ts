import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { dataDir, loadSettings } from "../config.js";
import { readNbt, toPlain } from "../core/nbt.js";
import { BdsServer } from "../bds/server.js";
import { disableBridgeInWorld, enableBridgeInWorld, instancesDir, prepareInstance, InstanceOptions } from "../bds/instance.js";
import { unzipTo, zipDirectory } from "../util/zip.js";
import { Backend } from "./backend.js";
import { BdsBackend } from "./bds-backend.js";
import { Project, atomicWrite } from "./project.js";

export const INSTANCE = "main";

export interface WorldInfo {
  name: string;
  path: string;
  levelName?: string;
  lastOpenedWith?: string;
  sizeMb?: number;
  source?: string;
}

export class SessionError extends Error {}

/** Reads level.dat: 8 byte header (storage version, length) and then little endian NBT. */
export function readLevelDat(worldDir: string): Record<string, unknown> | undefined {
  const f = join(worldDir, "level.dat");
  if (!existsSync(f)) return undefined;
  const buf = readFileSync(f);
  if (buf.length < 9) return undefined;
  try {
    return toPlain(readNbt(buf, 8).tag) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function dirSizeMb(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else total += s.size;
    }
  };
  try {
    walk(dir);
  } catch {}
  return Math.round((total / 1048576) * 10) / 10;
}

export function describeWorld(path: string, name = basename(path)): WorldInfo {
  const ld = readLevelDat(path);
  const ver = ld?.lastOpenedWithVersion;
  let levelName = typeof ld?.LevelName === "string" ? (ld.LevelName as string) : undefined;
  try {
    levelName = readFileSync(join(path, "levelname.txt"), "utf8").trim() || levelName;
  } catch {}
  return {
    name,
    path,
    levelName,
    lastOpenedWith: Array.isArray(ver) ? ver.join(".") : undefined,
    sizeMb: dirSizeMb(path),
  };
}

/** Places the game client keeps its worlds on this machine, checked when listing importable worlds. */
export function clientWorldDirs(): string[] {
  const h = homedir();
  const c = [
    join(h, ".var/app/io.mrarm.mcpelauncher/data/mcpelauncher/games/com.mojang/minecraftWorlds"),
    join(h, ".local/share/mcpelauncher/games/com.mojang/minecraftWorlds"),
    process.env.APPDATA ? join(process.env.APPDATA, "Minecraft Bedrock/Users/Shared/games/com.mojang/minecraftWorlds") : "",
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Packages/Microsoft.MinecraftUWP_8wekyb3d8bbwe/LocalState/games/com.mojang/minecraftWorlds") : "",
  ];
  if (process.env.MBM_CLIENT_WORLDS) c.unshift(...process.env.MBM_CLIENT_WORLDS.split(":"));
  return c.filter((d) => d && existsSync(d));
}

interface WorldSources {
  [name: string]: { source: string; importedAt: string; kind: "folder" | "mcworld" };
}

/**
 * Holds the one live connection the tools act on, plus the current project. Switching worlds stops the
 * old server first, so two processes never write the same files.
 */
export class Session {
  server?: BdsServer;
  backend?: Backend;
  world?: string;
  bdsVersion?: string;
  project: Project;
  private wsBackend?: Backend;

  constructor() {
    this.project = new Project(process.env.MBM_PROJECT || "default");
  }

  get instanceRoot() {
    return join(instancesDir(), INSTANCE);
  }

  worldsDir() {
    const d = join(this.instanceRoot, "worlds");
    mkdirSync(d, { recursive: true });
    return d;
  }

  worldPath(name: string): string {
    if (!/^[^/\\\0]{1,80}$/.test(name) || name.startsWith(".")) throw new SessionError(`bad world name "${name}"`);
    return join(this.worldsDir(), name);
  }

  requireBackend(): Backend {
    const b = this.backend ?? this.wsBackend;
    if (!b) {
      throw new SessionError(
        "no world connected. Use world_create or world_import and then server_start, or ws_listen for a world open in the game",
      );
    }
    return b;
  }

  setWsBackend(b: Backend | undefined) {
    this.wsBackend = b;
    if (b && !this.backend) this.world = b.worldId();
  }

  private sources(): WorldSources {
    try {
      return JSON.parse(readFileSync(join(dataDir(), "world-sources.json"), "utf8"));
    } catch {
      return {};
    }
  }

  private saveSources(s: WorldSources) {
    atomicWrite(join(dataDir(), "world-sources.json"), JSON.stringify(s, null, 2));
  }

  listWorlds(): { managed: WorldInfo[]; client: WorldInfo[] } {
    const src = this.sources();
    const managed = existsSync(this.worldsDir())
      ? readdirSync(this.worldsDir())
          .filter((n) => statSync(join(this.worldsDir(), n)).isDirectory())
          .map((n) => ({ ...describeWorld(join(this.worldsDir(), n), n), source: src[n]?.source }))
      : [];
    const client: WorldInfo[] = [];
    for (const d of clientWorldDirs()) {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (existsSync(join(p, "level.dat"))) client.push(describeWorld(p, n));
      }
    }
    return { managed, client };
  }

  /** Copies a world folder or .mcworld into the managed server. The original is never touched here. */
  importWorld(source: string, name?: string): WorldInfo {
    if (!existsSync(source)) throw new SessionError(`${source} does not exist`);
    const isZip = statSync(source).isFile();
    const target = name ?? (isZip ? basename(source).replace(/\.mcworld$/i, "") : describeWorld(source).levelName ?? basename(source));
    const safe = target.replace(/[/\\\0]/g, "_").slice(0, 80);
    const dst = this.worldPath(safe);
    if (existsSync(dst)) throw new SessionError(`a managed world named "${safe}" already exists, pick another name`);
    const tmp = `${dst}.importing`;
    rmSync(tmp, { recursive: true, force: true });
    if (isZip) {
      unzipTo(source, tmp);
      // some .mcworld files wrap everything in one top folder
      if (!existsSync(join(tmp, "level.dat"))) {
        const inner = readdirSync(tmp).filter((n) => existsSync(join(tmp, n, "level.dat")));
        if (inner.length !== 1) {
          rmSync(tmp, { recursive: true, force: true });
          throw new SessionError(`${source} has no level.dat, is it really a world?`);
        }
        renameSync(join(tmp, inner[0]), `${tmp}.inner`);
        rmSync(tmp, { recursive: true, force: true });
        renameSync(`${tmp}.inner`, tmp);
      }
    } else {
      if (!existsSync(join(source, "level.dat"))) throw new SessionError(`${source} has no level.dat, is it really a world folder?`);
      cpSync(source, tmp, { recursive: true });
    }
    renameSync(tmp, dst);
    const s = this.sources();
    s[safe] = { source, importedAt: new Date().toISOString(), kind: isZip ? "mcworld" : "folder" };
    this.saveSources(s);
    return { ...describeWorld(dst, safe), source };
  }

  /**
   * Copies a managed world out again, either back over where it came from or to a new folder or
   * .mcworld. Whatever gets overwritten is backed up first, and the bridge pack reference is stripped.
   */
  async exportWorld(name: string, to: string | "source"): Promise<{ written: string; backup?: string }> {
    const src = this.worldPath(name);
    if (!existsSync(src)) throw new SessionError(`no managed world "${name}"`);
    if (this.world === name && this.server) await this.stopServer();
    const dest = to === "source" ? this.sources()[name]?.source : to;
    if (!dest) throw new SessionError(`world "${name}" was not imported from anywhere, give an explicit path`);
    const staging = join(dataDir(), "tmp", `export-${Date.now()}`);
    cpSync(src, staging, { recursive: true });
    disableBridgeInWorld(staging);
    let backup: string | undefined;
    try {
      if (dest.toLowerCase().endsWith(".mcworld")) {
        if (existsSync(dest)) {
          backup = join(dataDir(), "backups", "exports", `${basename(dest)}.${Date.now()}.bak`);
          mkdirSync(join(dataDir(), "backups", "exports"), { recursive: true });
          cpSync(dest, backup);
        }
        zipDirectory(staging, dest);
      } else {
        if (existsSync(dest)) {
          backup = join(dataDir(), "backups", "exports", `${basename(dest)}.${Date.now()}`);
          cpSync(dest, backup, { recursive: true });
          rmSync(dest, { recursive: true, force: true });
        }
        cpSync(staging, dest, { recursive: true });
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    return { written: dest, backup };
  }

  async startServer(world: string, opts: Partial<InstanceOptions> = {}): Promise<Record<string, unknown>> {
    const s = loadSettings();
    if (this.server && this.world === world && this.server.ready) return { already: true, world };
    if (this.server) await this.stopServer();
    const root = prepareInstance(INSTANCE, {
      bdsDir: s.bdsDir ?? "",
      levelName: world,
      port: s.serverPort ?? 19140,
      gamemode: "creative",
      ...opts,
    });
    const isNew = !existsSync(join(this.worldPath(world), "level.dat"));
    enableBridgeInWorld(this.worldPath(world));
    const server = new BdsServer(root);
    try {
      await server.start(Number(process.env.MBM_START_TIMEOUT_MS) || 180_000);
    } catch (e) {
      throw new SessionError(`BDS did not come up: ${(e as Error).message}`);
    }
    this.server = server;
    const ver = server.recentLog(400).map((l) => /Version: ([\d.]+)/.exec(l)?.[1]).find(Boolean);
    this.bdsVersion = ver;
    this.world = world;
    this.backend = new BdsBackend(server, INSTANCE, world);
    if (isNew) {
      // a fresh build world shouldn't have mobs wandering through the scaffolding or the sun setting on it
      await this.backend.commands("overworld", [
        "gamerule domobspawning false",
        "gamerule dodaylightcycle false",
        "gamerule doweathercycle false",
        "time set noon",
      ]);
    }
    this.project.meta.world = this.backend.worldId();
    this.project.saveMeta();
    return { world, bdsVersion: ver, newWorld: isNew, port: s.serverPort ?? 19140, pid: server.pid };
  }

  async stopServer(): Promise<void> {
    const s = this.server;
    this.server = undefined;
    this.backend = undefined;
    if (s) await s.stop();
  }

  /**
   * Copies the world while it's safe to: with the server running it uses save hold / query / resume so the
   * copy is consistent, otherwise a plain folder copy.
   */
  async backupWorld(name: string, label = ""): Promise<string> {
    const src = this.worldPath(name);
    if (!existsSync(src)) throw new SessionError(`no managed world "${name}"`);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dst = join(dataDir(), "backups", name, `${stamp}${label ? "_" + label.replace(/[^a-zA-Z0-9_-]/g, "_") : ""}`);
    mkdirSync(join(dataDir(), "backups", name), { recursive: true });
    const live = this.server?.ready && this.world === name ? this.server : undefined;
    if (live) {
      await live.console("save hold", { settleMs: 300 });
      try {
        let ready = false;
        for (let i = 0; i < 40 && !ready; i++) {
          const out = await live.console("save query", { settleMs: 500 });
          ready = out.some((l) => /Data saved|ready to be copied/i.test(l));
        }
        if (!ready) throw new SessionError("server never reported the save as ready to copy");
        cpSync(src, dst, { recursive: true });
      } finally {
        await live.console("save resume", { settleMs: 200 });
      }
    } else {
      cpSync(src, dst, { recursive: true });
    }
    writeFileSync(join(dst, ".mbm-backup.json"), JSON.stringify({ world: name, at: new Date().toISOString(), label, live: !!live }));
    return dst;
  }

  listBackups(name?: string): { world: string; id: string; path: string; sizeMb: number }[] {
    const root = join(dataDir(), "backups");
    if (!existsSync(root)) return [];
    const out: { world: string; id: string; path: string; sizeMb: number }[] = [];
    for (const w of readdirSync(root)) {
      if (w === "exports" || (name && w !== name)) continue;
      for (const id of readdirSync(join(root, w)).sort()) out.push({ world: w, id, path: join(root, w, id), sizeMb: dirSizeMb(join(root, w, id)) });
    }
    return out;
  }

  /** Swaps a backup back in. The current state is backed up first so even a restore can be undone. */
  async restoreBackup(name: string, id: string): Promise<{ restored: string; safety: string }> {
    const b = join(dataDir(), "backups", name, id);
    if (!/^[^/\\]+$/.test(id) || !existsSync(b)) throw new SessionError(`no backup ${id} for world ${name}`);
    const wasRunning = this.world === name && !!this.server;
    if (wasRunning) await this.stopServer();
    const safety = await this.backupWorld(name, "before-restore");
    const dst = this.worldPath(name);
    rmSync(dst, { recursive: true, force: true });
    cpSync(b, dst, { recursive: true });
    rmSync(join(dst, ".mbm-backup.json"), { force: true });
    if (wasRunning) await this.startServer(name);
    return { restored: id, safety };
  }

  async shutdown() {
    await this.stopServer().catch(() => {});
  }
}
