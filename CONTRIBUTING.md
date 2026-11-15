# Contributing

Thanks for helping. Bug reports with a reproduction are as welcome as code.

## Setup

```sh
npm install
npm run build
npm test
MBM_BDS_DIR=/path/to/bedrock-server npm run test:bds
```

`test:bds` starts real servers in a temporary data folder; it never touches your worlds.

## Adding a generator

1. Write the builder in `src/gen/`. Build in local coordinates (min corner or centre at 0,0,0, facing south) and
   return a `GenResult` with markers for anything a later step needs (spawns, doors, chests).
2. Use `Palette.at(role, x, y, z)` for materials so styles and project palettes apply.
3. Register it in `src/gen/registry.ts` with a zod schema, a one line summary and how `origin` is used.
4. Add sample args to `test/generators.test.ts`. The test fails if a generator has no sample, and it checks every block
   against the Bedrock registry.

## Adding a tool

Tools live in `src/tools/`. Use `registerTool` from `shared.ts`, so the tool also works as a plan step. World edits go
through `applyVoxels` to get tiling, undo, journaling and verification for free.

## Bridge pack

`bridge-pack/scripts/main.js` runs inside BDS. Keep it a thin executor: planning belongs on the MCP side where it can be
unit tested. Use only stable `@minecraft/server` APIs and bump `BRIDGE_VERSION` when the protocol changes.

## Block registry

After a Minecraft update, regenerate the bundled list:

```sh
npx tsc && MBM_BDS_DIR=/path/to/new/bds node dist/scripts/dump-registry.js
```

## Style

TypeScript, ES modules, strict mode. Match the surrounding code. Comments explain why, not what. Commit titles are
short imperative sentences.
