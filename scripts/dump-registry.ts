// Dumps block ids, default states and valid state values from a real BDS into src/data/blocks.json.
// Run with MBM_BDS_DIR set: npx tsc && node dist/scripts/dump-registry.js
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "mbm-reg-"));
process.env.MBM_DATA_DIR = tmp;
const { Session } = await import("../src/engine/session.js");
const s = new Session();
try {
  await s.startServer("registry", { levelType: "FLAT" });
  const r = await s.requireBackend().bridge<{ blocks: { id: string; states: Record<string, unknown> }[]; stateTypes: { id: string; values: unknown[] }[] }>("registry", {}, 120_000);
  const out = {
    gameVersion: s.bdsVersion,
    blocks: Object.fromEntries(r.blocks.sort((a, b) => a.id.localeCompare(b.id)).map((b) => [b.id, b.states])),
    states: Object.fromEntries(r.stateTypes.sort((a, b) => a.id.localeCompare(b.id)).map((t) => [t.id, t.values])),
  };
  writeFileSync(join(process.cwd(), "src", "data", "blocks.json"), JSON.stringify(out));
  console.log(`${r.blocks.length} blocks, ${r.stateTypes.length} state types from ${s.bdsVersion}`);
} finally {
  await s.shutdown();
  rmSync(tmp, { recursive: true, force: true });
}
