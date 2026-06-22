// Bundle the CLI + its workspace deps (@vibetrace/{schema,graph,og,verifier})
// into ONE self-contained file so `npx vibetrace` works in any repo without the
// monorepo. ethers + @0gfoundation/* stay external (not inlined). NOTE: `ethers`
// is imported EAGERLY by the verifier (attestation hashing/recovery) and so is a
// REQUIRED runtime dependency in EVERY mode — it is declared under `dependencies`
// in apps/cli/publish/package.json. Only @0gfoundation/0g-storage-ts-sdk is truly
// optional (dynamically imported in VIBETRACE_OG_MODE=real storage). Run the
// workspace build first (this bundles the compiled dist of the deps). The entry
// keeps its own shebang.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  external: ["ethers", "@0gfoundation/*"],
  outfile: "dist/vibetrace.mjs",
  logLevel: "info",
});
