import { describe, expect, it } from "vitest";
import { hashPublicLedgerBundle } from "@vibetrace/schema";
import { makeBundle, snapshot, traceSpan } from "./bundle.fixtures";

describe("makeBundle", () => {
  it("produces an anchored bundle whose manifestHash matches the recomputed hash", async () => {
    const bundle = await makeBundle({
      anchored: true,
      traces: [traceSpan({ spanId: "s1", artifactsProduced: ["src/a.ts"] })],
      snapshots: [snapshot({ commit: "c1", files: [{ path: "src/a.ts", size: 500 }, { path: "src/b.ts", size: 500 }] })],
      claims: [{ claimId: "claim-synthetic-a", text: "AI build", selectors: ["src"] }],
    });
    expect(bundle.chainAnchor.txHash).not.toBe("");
    expect(bundle.chainAnchor.manifestHash).toBe(hashPublicLedgerBundle(bundle));
    expect(bundle.storageAnchor.rootHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("produces an unanchored bundle with no txHash and pending manifest", async () => {
    const bundle = await makeBundle({ anchored: false, snapshots: [snapshot({ commit: "c1", files: [{ path: "x", size: 1 }] })] });
    expect(bundle.chainAnchor.txHash).toBe("");
    expect(bundle.chainAnchor.manifestHash).toBe("pending");
  });
});
