import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// compiled code lives in dist/src, so the package root is two levels up
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BRIDGE_PACK_DIR = join(PACKAGE_ROOT, "bridge-pack");

export const BRIDGE_PACK_UUID = "cdb86979-d8f0-4c9b-882c-7b8c8f726370";
export const BRIDGE_PACK_VERSION: [number, number, number] = [0, 1, 0];

export function dataDir(): string {
  const d =
    process.env.MBM_DATA_DIR ||
    join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "bedrock-map-builder-mcp");
  mkdirSync(d, { recursive: true });
  return d;
}

export interface Settings {
  /** Folder of an unpacked Bedrock Dedicated Server, the one holding bedrock_server. */
  bdsDir?: string;
  serverPort?: number;
  /** Port the WebSocket bridge listens on for /connect. */
  wsPort?: number;
}

function settingsPath() {
  return join(dataDir(), "settings.json");
}

/** Env vars win over the saved settings file so a Claude Code config can pin things. */
export function loadSettings(): Settings {
  let s: Settings = {};
  try {
    s = JSON.parse(readFileSync(settingsPath(), "utf8"));
  } catch {}
  if (process.env.MBM_BDS_DIR) s.bdsDir = process.env.MBM_BDS_DIR;
  if (process.env.MBM_SERVER_PORT) s.serverPort = Number(process.env.MBM_SERVER_PORT);
  if (process.env.MBM_WS_PORT) s.wsPort = Number(process.env.MBM_WS_PORT);
  return s;
}

export function saveSettings(patch: Settings): Settings {
  let cur: Settings = {};
  try {
    cur = JSON.parse(readFileSync(settingsPath(), "utf8"));
  } catch {}
  const next = { ...cur, ...patch };
  writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  return { ...next, ...loadSettings() };
}
