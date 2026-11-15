import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { loadSettings, saveSettings } from "../config.js";
import { checkBdsDir } from "../bds/instance.js";
import { setLiveRegistry } from "../core/registry.js";
import { Ctx, registerTool } from "./shared.js";

/** Looks in the usual download spots for unpacked servers and returns them newest version first. */
function findBdsInstalls(): { dir: string; version: string }[] {
  const h = homedir();
  const roots = [join(h, "Downloads"), join(h, "İndirilenler"), join(h, "bedrock-server"), join(h, "bds"), h, join(h, ".local", "share")];
  const out: { dir: string; version: string }[] = [];
  for (const r of roots) {
    if (!existsSync(r)) continue;
    let names: string[] = [];
    try {
      names = readdirSync(r);
    } catch {
      continue;
    }
    for (const n of names) {
      const d = join(r, n);
      try {
        if (!statSync(d).isDirectory() || !existsSync(join(d, "bedrock_server"))) continue;
      } catch {
        continue;
      }
      const v = /(\d+\.\d+\.\d+(?:\.\d+)?)/.exec(n)?.[1] ?? "unknown";
      out.push({ dir: d, version: v });
    }
  }
  const key = (v: string) => v.split(".").map((p) => p.padStart(5, "0")).join(".");
  return out.sort((a, b) => key(b.version).localeCompare(key(a.version)));
}

export function registerWorld(ctx: Ctx) {
  const s = ctx.session;

  registerTool(ctx, "server_setup", "Point the builder at an unpacked Linux Bedrock Dedicated Server (the folder with bedrock_server). With detect=true it searches Downloads and similar folders and picks the newest. Also sets the game port players can join on.", {
    bds_dir: z.string().optional(),
    detect: z.boolean().optional(),
    server_port: z.number().int().min(1024).max(65530).optional(),
  }, async (a) => {
    let dir = a.bds_dir as string | undefined;
    const found = a.detect || !dir ? findBdsInstalls() : [];
    if (!dir && found.length) dir = found[0].dir;
    if (!dir) {
      return { configured: false, found, hint: "Download BDS from https://www.minecraft.net/download/server/bedrock (accepting the EULA), unzip it and pass bds_dir" };
    }
    checkBdsDir(dir);
    const st = saveSettings({ bdsDir: dir, ...(a.server_port ? { serverPort: a.server_port } : {}) });
    return { configured: true, bdsDir: st.bdsDir, serverPort: st.serverPort ?? 19140, otherInstalls: found.filter((f) => f.dir !== dir).slice(0, 5) };
  });

  registerTool(ctx, "server_status", "What is connected right now: server state, world, BDS version, bridge ping, current project, and the last console lines.", {
    log_lines: z.number().int().min(0).max(200).optional(),
  }, async (a) => {
    const st = loadSettings();
    const out: Record<string, unknown> = {
      bdsDir: st.bdsDir ?? null,
      project: s.project.name,
      world: s.world ?? null,
      server: s.server ? { state: s.server.state, pid: s.server.pid, bdsVersion: s.bdsVersion, exit: s.server.exitInfo } : null,
    };
    if (s.backend) out.bridge = await s.backend.describe().catch((e) => `ping failed: ${(e as Error).message}`);
    if (s.server && (a.log_lines ?? 15) > 0) out.log = s.server.recentLog(a.log_lines ?? 15);
    return out;
  }, { readOnlyHint: true });

  registerTool(ctx, "world_list", "Managed worlds (inside the builder's server) and worlds found in the game client folders (mcpelauncher, Windows) that can be imported.", {}, async () => s.listWorlds(), { readOnlyHint: true });

  registerTool(ctx, "world_create", "Create a new managed world and start the server on it. flat is a superflat build plot, default is normal terrain. Mob spawning, daylight and weather cycles are turned off for building.", {
    name: z.string().min(1).max(80),
    type: z.enum(["flat", "default"]).default("flat"),
    seed: z.string().optional(),
  }, async (a) => {
    if (existsSync(s.worldPath(a.name))) throw new Error(`world ${a.name} already exists, use server_start`);
    const r = await s.startServer(a.name, { levelType: a.type === "flat" ? "FLAT" : "DEFAULT", seed: a.seed ?? "" });
    await refreshRegistry(ctx);
    return r;
  });

  registerTool(ctx, "server_start", "Start the server on a managed world (stops whatever else was running). The world gets the bridge pack attached automatically.", {
    world: z.string().min(1),
  }, async (a) => {
    if (!existsSync(s.worldPath(a.world))) throw new Error(`no managed world ${a.world}. world_list shows them, world_import brings one in`);
    const r = await s.startServer(a.world);
    await refreshRegistry(ctx);
    return r;
  });

  registerTool(ctx, "server_stop", "Stop the server cleanly (it saves the world first).", {}, async () => {
    await s.stopServer();
    return { stopped: true };
  });

  registerTool(ctx, "server_console", "Send a raw line to the BDS console and return what it printed for a moment after (for save, list, reload and other console only commands). In-game commands are better sent with run_commands.", {
    line: z.string().min(1).max(4000),
    wait_ms: z.number().int().min(50).max(10000).optional(),
  }, async (a) => {
    if (!s.server) throw new Error("server is not running");
    if (/^\s*stop\s*$/i.test(a.line)) throw new Error("use server_stop to stop the server");
    return { output: await s.server.console(a.line, { settleMs: a.wait_ms ?? 800 }) };
  });

  registerTool(ctx, "world_import", "Copy a world into the builder: a world folder (for example one from world_list's client section) or a .mcworld file. The original stays untouched; use world_export to write changes back.", {
    source: z.string().min(1),
    name: z.string().optional(),
  }, async (a) => s.importWorld(a.source, a.name));

  registerTool(ctx, "world_export", "Write a managed world out: to='source' copies it back over where it was imported from, a path ending in .mcworld makes a file, any other path makes a world folder. Whatever gets overwritten is backed up first, and the bridge pack reference is removed so the client sees a clean world.", {
    world: z.string().min(1),
    to: z.string().min(1),
  }, async (a) => s.exportWorld(a.world, a.to), { destructiveHint: true });

  registerTool(ctx, "world_backup", "Full copy of a managed world. While the server runs it uses save hold/query/resume, so the copy is consistent.", {
    world: z.string().min(1),
    label: z.string().max(40).optional(),
  }, async (a) => ({ backup: await s.backupWorld(a.world, a.label) }));

  registerTool(ctx, "world_backups", "List world backups.", { world: z.string().optional() }, async (a) => s.listBackups(a.world), { readOnlyHint: true });

  registerTool(ctx, "world_restore", "Replace a managed world with one of its backups. The current state is backed up first, so this can be undone too.", {
    world: z.string().min(1),
    backup: z.string().min(1),
  }, async (a) => s.restoreBackup(a.world, a.backup), { destructiveHint: true });
}

/** Pulls the block list from the running game so validation matches its exact version. */
export async function refreshRegistry(ctx: Ctx) {
  const b = ctx.session.backend;
  if (!b) return;
  try {
    const r = await b.bridge<{ blocks: { id: string; states: Record<string, never> }[]; stateTypes: { id: string; values: never[] }[] }>("registry", {}, 60_000);
    setLiveRegistry({
      gameVersion: ctx.session.bdsVersion ?? "live",
      blocks: Object.fromEntries(r.blocks.map((x) => [x.id, x.states])),
      states: Object.fromEntries(r.stateTypes.map((x) => [x.id, x.values])),
    });
  } catch {
    // the bundled snapshot still works, just maybe a version behind
  }
}
