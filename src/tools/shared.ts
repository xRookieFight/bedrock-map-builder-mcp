import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseBlock } from "../core/block.js";
import { Box, Dimension, boxOf } from "../core/geometry.js";
import { validateBlock } from "../core/registry.js";
import { VoxelSet } from "../core/voxels.js";
import { GenResult } from "../gen/common.js";
import { Session } from "../engine/session.js";

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface ToolOutput {
  content: Content[];
  isError?: boolean;
}

export type Handler = (args: any) => Promise<unknown>;

export interface Ctx {
  server: McpServer;
  session: Session;
  /** Every tool handler by name, so build plans can replay any tool as a step. */
  handlers: Map<string, Handler>;
  /** Last generated result, kept so `view` can show a preview without touching the world. */
  last?: { label: string; result: GenResult };
}

/** A tool's return value: plain data becomes JSON text, images ride along as image content. */
export class Rich {
  constructor(readonly data: unknown, readonly images: { png: Buffer; caption?: string }[] = []) {}
}

function toOutput(v: unknown): ToolOutput {
  if (v instanceof Rich) {
    const content: Content[] = [{ type: "text", text: JSON.stringify(v.data, null, 2) }];
    for (const im of v.images) {
      if (im.caption) content.push({ type: "text", text: im.caption });
      content.push({ type: "image", data: im.png.toString("base64"), mimeType: "image/png" });
    }
    return { content };
  }
  return { content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] };
}

export function registerTool(
  ctx: Ctx,
  name: string,
  description: string,
  shape: z.ZodRawShape,
  handler: Handler,
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } = {},
): void {
  const schema = z.object(shape);
  // plans call handlers directly, so they get the same validation the MCP layer does
  const checked: Handler = async (args) => handler(schema.parse(args ?? {}));
  ctx.handlers.set(name, checked);
  ctx.server.registerTool(name, { description, inputSchema: shape, annotations }, (async (args: Record<string, unknown>) => {
    try {
      return toOutput(await handler(args));
    } catch (e) {
      const err = e as Error;
      const msg = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n") : err.message;
      return { content: [{ type: "text", text: `error: ${msg}` }], isError: true };
    }
  }) as never);
}

export const vec3 = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() });
export const dimension = z.enum(["overworld", "nether", "the_end"]).default("overworld");

export function boxArg(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): Box {
  return boxOf(from, to);
}

/**
 * Checks every block in a set against the registry before anything is written. Java names with a Bedrock
 * twin get swapped (and reported), everything else unknown fails with suggestions.
 */
export function validateSet(set: VoxelSet): { set: VoxelSet; notes: string[] } {
  const notes: string[] = [];
  const remap: number[] = [];
  let changed = false;
  const out = new VoxelSet();
  for (const b of set.palette) {
    const v = validateBlock(b);
    if (v.note && !notes.includes(v.note)) notes.push(v.note);
    if (v.block.name !== b.name) changed = true;
    remap.push(out.indexOf(v.block));
  }
  if (!changed) return { set, notes };
  set.forEach((x, y, z, i) => out.set(x, y, z, remap[i]));
  return { set: out, notes };
}

export function dimOf(d: string | undefined): Dimension {
  return (d ?? "overworld") as Dimension;
}

export function blockArg(b: string) {
  return validateBlock(parseBlock(b)).block;
}
