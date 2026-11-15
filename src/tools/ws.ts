import { z } from "zod";
import { loadSettings } from "../config.js";
import { WsBackend, WsLink } from "../engine/ws-backend.js";
import { Ctx, registerTool } from "./shared.js";

export function registerWs(ctx: Ctx) {
  let link: WsLink | undefined;

  registerTool(ctx, "ws_listen", "Open a WebSocket for a world that's open in the game client. The player then types /connect localhost:<port> in chat (cheats on; turn off \"Require Encrypted Websockets\" in the game settings if the client has it). Over this link only commands work: building, filling and in-session undo, but no reading back, analysis or export.", {
    port: z.number().int().min(1024).max(65535).optional(),
  }, async (a) => {
    if (link) await link.close();
    link = new WsLink();
    const port = a.port ?? loadSettings().wsPort ?? 19150;
    const l = link;
    l.onChange = (up) => ctx.session.setWsBackend(up ? new WsBackend(l) : undefined);
    await l.listen(port);
    return { listening: `ws://localhost:${port}`, tellPlayer: `/connect localhost:${port}`, note: "tools switch to this world once the game connects; server_start switches back to BDS" };
  });

  registerTool(ctx, "ws_status", "Whether a game client is connected over /connect.", {}, async () => ({
    listening: !!link, connected: link?.connected ?? false, player: link?.player ?? null, active: ctx.session.active,
  }), { readOnlyHint: true });

  registerTool(ctx, "ws_stop", "Close the WebSocket and disconnect the game client.", {}, async () => {
    await link?.close();
    link = undefined;
    ctx.session.setWsBackend(undefined);
    return { stopped: true };
  });

  registerTool(ctx, "use_connection", "Pick which connection the tools act on when both a BDS world and a /connect client are up.", {
    target: z.enum(["bds", "ws"]),
  }, async (a) => {
    ctx.session.active = a.target;
    return { active: a.target, world: ctx.session.requireBackend().worldId() };
  });
}
