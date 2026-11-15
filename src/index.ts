#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_ROOT } from "./config.js";
import { Session } from "./engine/session.js";
import { registerAnalyze } from "./tools/analyze.js";
import { registerBuild } from "./tools/build.js";
import { registerGame } from "./tools/game.js";
import { registerProject } from "./tools/project.js";
import { Ctx } from "./tools/shared.js";
import { registerWorld } from "./tools/world.js";
import { registerWs } from "./tools/ws.js";

const version = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version as string;

const instructions = `Builds and edits Minecraft: Bedrock Edition maps in a real world.

Connect first. server_status shows what's up. For a world managed here: server_setup once (finds the Bedrock Dedicated Server), then world_create (new) or world_import + server_start (existing world, e.g. from world_list's client section), and world_export to hand it back to the game. For a world open in the game client: ws_listen, then the player types /connect in chat (commands only, no reading back, no undo).

Build with generate (generator_help lists houses, towers, castles, walls, bridges, roads, skyscrapers, cities, arenas, parkour, lobbies, dungeons, trees, vegetation, terrain, sculpt, rivers, lakes, caves, mountains, free form shapes and JS scripts). dry_run with preview shows an image before writing anything. fill_region, replace_blocks, clear_region, place_blocks, copy_region (copy/move/rotate/mirror/stack) and structure_import/export cover direct editing. run_commands, set_world_rules, spawn_entities, fill_container, set_sign and map_functions handle game logic.

Look at the world with view (images), region_stats, find_blocks, list_entities and check_map (spawn safety, reachability, symmetry, floating blocks, dark spots).

Every world edit is journaled and undoable (op_list, op_undo); snapshots live in the project folder, not in the map. For big jobs make a plan (plan_create, plan_run): steps survive restarts and resume where they stopped. Record design decisions with project_note and palette_set so the whole project stays consistent. Block ids are Bedrock ids (block_search, block_info); common Java names are translated automatically.`;

const server = new McpServer({ name: "bedrock-map-builder", version }, { instructions });
const ctx: Ctx = { server, session: new Session(), handlers: new Map() };

registerWorld(ctx);
registerWs(ctx);
registerProject(ctx);
registerBuild(ctx);
registerGame(ctx);
registerAnalyze(ctx);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  // stop BDS cleanly so the world is saved, a killed server can lose the last minute of edits
  await ctx.session.shutdown();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);

await server.connect(new StdioServerTransport());
