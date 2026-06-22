// Bundle the hosted adjudication relayer (scripts/relayer.ts + its workspace deps) into ONE
// node-executable .mjs at repo-root scripts/relayer.bundle.mjs.
//
// WHY THIS EXISTS (not just `tsx scripts/relayer.ts`): the @0gfoundation/0g-compute-ts-sdk 0.8.4
// ships a BROKEN ESM entry (lib.esm/index.mjs re-exports names its chunk does not provide). `tsx`
// always resolves the package to that ESM build and crashes at import, and passing
// `--conditions=require` THROUGH tsx does not steer resolution. Running a plain-node bundle with
// `node --conditions=require` makes Node itself resolve the SDK to its working CommonJS build.
//
// ethers + the 0G SDKs stay external so Node resolves them from the repo node_modules at runtime
// (and so `--conditions=require` applies to the SDK package import). Run from the CLI package dir
// (pnpm --filter @vibetrace/cli exec), so the relative paths below point at the repo root.
import { build } from "esbuild";

await build({
  entryPoints: ["../../scripts/relayer.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  external: ["ethers", "@0gfoundation/*"],
  outfile: "../../scripts/relayer.bundle.mjs",
  logLevel: "info",
});
