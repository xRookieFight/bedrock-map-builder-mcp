import { runInNewContext } from "node:vm";
import { parseBlock } from "../core/block.js";
import { Rng, Simplex } from "../core/noise.js";
import { GenResult, Marker, result } from "./common.js";
import { Palette } from "./palette.js";
import * as shapes from "./shapes.js";
import { tree } from "./nature.js";

export const SCRIPT_LIMIT = 5_000_000;

/**
 * Runs a user (or Claude) written JS snippet that builds blocks through a small API. This is the escape hatch
 * for anything the named generators don't cover. It runs in a separate vm context with a timeout; vm isn't a
 * security boundary, but the code comes from the same local session that could run node anyway.
 */
export function runScript(code: string, palette: Palette, seed = 1, timeoutMs = 20_000): GenResult {
  const r = result();
  const set = r.set;
  const brush = (b: unknown): shapes.Brush => {
    if (typeof b === "function") return b as shapes.Brush;
    const s = String(b);
    return (x, y, z) => (s.startsWith("@") ? palette.at(s.slice(1) as never, x, y, z) : s);
  };
  const guard = () => {
    if (set.size > SCRIPT_LIMIT) throw new Error(`script wrote more than ${SCRIPT_LIMIT} blocks, split the job`);
  };
  const api = {
    set: (x: number, y: number, z: number, b: string) => {
      set.set(Math.round(x), Math.round(y), Math.round(z), b.startsWith("@") ? palette.at(b.slice(1) as never, x, y, z) : parseBlock(b));
      if ((set.size & 0xffff) === 0) guard();
    },
    get: (x: number, y: number, z: number) => set.getBlock(x, y, z)?.name ?? null,
    clear: (x: number, y: number, z: number) => set.set(x, y, z, "minecraft:air"),
    box: (p1: never, p2: never, b: unknown, mode?: shapes.BoxMode) => (shapes.box(set, p1, p2, brush(b), mode ?? "solid"), guard()),
    sphere: (c: never, radius: number, b: unknown, opt?: never) => (shapes.sphere(set, c, radius, brush(b), opt), guard()),
    ellipsoid: (c: never, r: never, b: unknown, opt?: never) => (shapes.ellipsoid(set, c, r, brush(b), opt), guard()),
    cylinder: (base: never, radius: number, height: number, b: unknown, opt?: never) => (shapes.cylinder(set, base, radius, height, brush(b), opt), guard()),
    cone: (base: never, radius: number, height: number, b: unknown, opt?: never) => (shapes.cone(set, base, radius, height, brush(b), opt), guard()),
    pyramid: (base: never, half: number, height: number, b: unknown, opt?: never) => (shapes.pyramid(set, base, half, height, brush(b), opt), guard()),
    line: (a: never, c: never, b: unknown, radius?: number) => (shapes.line(set, a, c, brush(b), radius), guard()),
    torus: (c: never, major: number, minor: number, b: unknown, axis?: never) => (shapes.torus(set, c, major, minor, brush(b), axis), guard()),
    arch: (a: never, c: never, h: number, t: number, d: number, b: unknown) => (shapes.arch(set, a, c, h, t, d, brush(b)), guard()),
    prism: (pts: never, y1: number, y2: number, b: unknown, hollow?: boolean) => (shapes.prism(set, pts, y1, y2, brush(b), hollow), guard()),
    tree: (kind: never, at: never, s?: number, scale?: number) => tree(set, kind, at, s ?? 1, scale),
    palette: (role: string, x = 0, y = 0, z = 0) => palette.at(role as never, x, y, z).name,
    marker: (kind: string, pos: Marker["pos"], name?: string) => r.markers.push({ kind, pos, name }),
    note: (s: string) => r.notes.push(String(s)),
    noise: new Simplex(seed),
    rng: new Rng(seed),
  };
  runInNewContext(`"use strict";\n${code}`, { ...api, Math, JSON, console: { log: (...a: unknown[]) => r.notes.push(a.map(String).join(" ")) } }, {
    timeout: timeoutMs,
    filename: "build_script.js",
  });
  guard();
  return r;
}
