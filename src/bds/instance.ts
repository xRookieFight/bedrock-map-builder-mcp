import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRIDGE_PACK_DIR, BRIDGE_PACK_UUID, BRIDGE_PACK_VERSION, dataDir } from "../config.js";

// these come straight from the BDS install, everything else in the instance is ours
const SHARED = ["bedrock_server", "behavior_packs", "resource_packs", "definitions", "data"];

export class InstanceError extends Error {}

export function checkBdsDir(dir: string): void {
  if (!dir) throw new InstanceError("no BDS folder configured. Call server_setup with bds_dir, or set MBM_BDS_DIR");
  if (!existsSync(join(dir, "bedrock_server"))) {
    throw new InstanceError(
      `${dir} has no bedrock_server binary. Point bds_dir at an unpacked Linux Bedrock Dedicated Server`,
    );
  }
  for (const f of ["behavior_packs", "resource_packs", "definitions"]) {
    if (!existsSync(join(dir, f))) throw new InstanceError(`${dir} is missing ${f}/, is the BDS unpacked completely?`);
  }
}

export function setProperty(text: string, key: string, value: string | number | boolean): string {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=.*$`, "m");
  return re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
}

export function getProperty(text: string, key: string): string | undefined {
  const m = new RegExp(`^${key}=(.*)$`, "m").exec(text);
  return m?.[1];
}

export interface InstanceOptions {
  bdsDir: string;
  levelName: string;
  port: number;
  levelType?: "FLAT" | "DEFAULT" | "LEGACY";
  seed?: string;
  gamemode?: "creative" | "survival" | "adventure";
  /** Lets a player joining from the client look at the build. */
  playerPermission?: "visitor" | "member" | "operator";
  viewDistance?: number;
}

export function instancesDir(): string {
  const d = join(dataDir(), "instances");
  mkdirSync(d, { recursive: true });
  return d;
}

/**
 * Builds (or refreshes) a server folder that borrows the big read only parts of the BDS install through
 * symlinks and keeps its own config, worlds and our bridge pack. Several instances can share one install.
 */
export function prepareInstance(name: string, o: InstanceOptions): string {
  checkBdsDir(o.bdsDir);
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name)) throw new InstanceError(`bad instance name "${name}"`);
  if (!/^[^/\\\0]{1,80}$/.test(o.levelName) || o.levelName.startsWith(".")) {
    throw new InstanceError(`bad level name "${o.levelName}"`);
  }
  const root = join(instancesDir(), name);
  mkdirSync(join(root, "config", "default"), { recursive: true });
  mkdirSync(join(root, "worlds"), { recursive: true });
  for (const f of SHARED) {
    const dst = join(root, f);
    let exists = false;
    try {
      lstatSync(dst);
      exists = true;
    } catch {}
    if (exists) rmSync(dst, { recursive: false, force: true });
    if (existsSync(join(o.bdsDir, f))) symlinkSync(join(o.bdsDir, f), dst);
  }

  const propsPath = join(root, "server.properties");
  let props = existsSync(propsPath) ? readFileSync(propsPath, "utf8") : readFileSync(join(o.bdsDir, "server.properties"), "utf8");
  const set = (k: string, v: string | number | boolean) => (props = setProperty(props, k, v));
  set("level-name", o.levelName);
  set("server-port", o.port);
  set("server-portv6", o.port + 1);
  // a build server, not a public one. allow-list without online-mode refuses to start, so keep auth on
  set("online-mode", true);
  set("allow-list", false);
  set("enable-lan-visibility", false);
  set("allow-cheats", true);
  set("content-log-console-output-enabled", true);
  set("content-log-file-enabled", false);
  if (o.levelType) set("level-type", o.levelType);
  if (o.seed !== undefined) set("level-seed", o.seed);
  if (o.gamemode) set("gamemode", o.gamemode);
  if (o.playerPermission) set("default-player-permission-level", o.playerPermission);
  if (o.viewDistance) set("view-distance", o.viewDistance);
  writeFileSync(propsPath, props);
  if (!existsSync(join(root, "allowlist.json"))) writeFileSync(join(root, "allowlist.json"), "[]");
  writeFileSync(
    join(root, "config", "default", "permissions.json"),
    JSON.stringify({ allowed_modules: ["@minecraft/server", "@minecraft/server-ui", "@minecraft/server-admin"] }, null, 2),
  );

  installBridgePack(root);
  return root;
}

/** Copies the bridge pack in fresh each time so an updated MCP never runs against an old script. */
export function installBridgePack(root: string): void {
  const dst = join(root, "development_behavior_packs", "mbm_bridge");
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(join(root, "development_behavior_packs"), { recursive: true });
  cpSync(BRIDGE_PACK_DIR, dst, { recursive: true });
}

interface PackRef {
  pack_id: string;
  version: number[];
}

function readPackList(file: string): PackRef[] {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function enableBridgeInWorld(worldDir: string): void {
  mkdirSync(worldDir, { recursive: true });
  const f = join(worldDir, "world_behavior_packs.json");
  const list = readPackList(f).filter((p) => p.pack_id !== BRIDGE_PACK_UUID);
  list.push({ pack_id: BRIDGE_PACK_UUID, version: [...BRIDGE_PACK_VERSION] });
  writeFileSync(f, JSON.stringify(list, null, 2));
}

/** Takes the bridge back out of a world before it goes back to the game client. */
export function disableBridgeInWorld(worldDir: string): void {
  const f = join(worldDir, "world_behavior_packs.json");
  if (!existsSync(f)) return;
  const list = readPackList(f).filter((p) => p.pack_id !== BRIDGE_PACK_UUID);
  if (list.length) writeFileSync(f, JSON.stringify(list, null, 2));
  else rmSync(f);
}
