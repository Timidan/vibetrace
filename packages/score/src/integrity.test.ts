import { describe, expect, it } from "vitest";
import { hashPublicLedgerBundle } from "@vibetrace/schema";
import { computeIntegrity } from "./integrity";
import { indexGraph } from "./graph-index";
import { DEFAULT_CONSTANTS } from "./types";
import { makeBundle, snapshot, traceSpan } from "./bundle.fixtures";

const base = () => ({
  traces: [traceSpan({ spanId: "s1", artifactsProduced: ["src/a.ts"] })],
  snapshots: [snapshot({ commit: "c1", files: [{ path: "src/a.ts", size: 500 }] })],
  claims: [{ claimId: "claim-synthetic-a", text: "AI", selectors: ["src"] }],
});

async function integrityOf(bundle: Awaited<ReturnType<typeof makeBundle>>) {
  const flags: string[] = [];
  const result = computeIntegrity(bundle, indexGraph(bundle), DEFAULT_CONSTANTS, flags);
  return { result, flags };
}

describe("computeIntegrity", () => {
  it("anchored + independent verifier ⇒ 1.0, seal anchored-verified", async () => {
    const { result } = await integrityOf(await makeBundle({ ...base(), anchored: true, independentVerifier: true }));
    expect(result.value).toBeCloseTo(1.0);
    expect(result.anchored).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.seal).toBe("anchored-verified");
  });

  it("unanchored ⇒ ceiling 0.33, seal self-published", async () => {
    const { result, flags } = await integrityOf(await makeBundle({ ...base(), anchored: false, independentVerifier: true }));
    expect(result.value).toBeCloseTo(0.33 * 1.0);
    expect(result.anchored).toBe(false);
    expect(result.seal).toBe("self-published");
    expect(flags).toContain("unanchored");
  });

  it("manifest mismatch ⇒ 0, seal broken, flag", async () => {
    const bundle = await makeBundle({ ...base(), anchored: true, manifestHashOverride: "0x" + "1".repeat(64) });
    const { result, flags } = await integrityOf(bundle);
    expect(result.value).toBe(0);
    expect(result.seal).toBe("broken");
    expect(flags).toContain("manifest-mismatch");
  });

  it("self-verified (same model as a trace) ⇒ verifierTrust 0.7", async () => {
    const bundle = await makeBundle({ ...base(), anchored: true, verifierModelOverride: "gpt-5" });
    const { result, flags } = await integrityOf(bundle);
    expect(result.value).toBeCloseTo(1.0 * 0.7);
    expect(result.verified).toBe(false);
    expect(flags).toContain("self-verified");
  });

  it.each(["requestHash", "responseHash", "outputHash"] as const)(
    "treats malformed verifierSummary.%s as no verifier",
    async (hashField) => {
      const bundle = await makeBundle({ ...base(), anchored: false });
      bundle.verifierSummary = { ...bundle.verifierSummary, [hashField]: "present-but-not-a-valid-hash" };

      const { result, flags } = await integrityOf(bundle);

      expect(result.value).toBeCloseTo(0.33 * 0.5);
      expect(result.verified).toBe(false);
      expect(flags).toContain("no-verifier");
      expect(flags).not.toContain("self-verified");
    }
  );

  it("a local 0g-dev verifier on an anchored bundle counts as self-verified (0.7)", async () => {
    const { result } = await integrityOf(await makeBundle({ ...base(), anchored: true }));
    expect(result.value).toBeCloseTo(1.0 * 0.7);
  });
});

/* ── isIndependent now requires a RECOVERING attestation, not a provider string ──
 * A bundle that merely WRITES provider "0g-compute" (or the legacy "0g-router"/
 * "0g-dev"), or carries a shape-valid attestation whose signature does NOT recover
 * to signingAddress, is FORGEABLE and must count as self-verified (0.7), not
 * independent (1.0). Independence requires a real recovering 0g-compute attestation
 * AND a live on-chain signer leg (verifyAgainst0G.signer.matches === true) — recovery
 * alone is only execution-attested (a self-keypair forger recovers to its own signer). */
describe("isIndependent: forgeable provider strings / non-recovering signatures are NOT independent", () => {
  // Force-set the verifierSummary's provider/attestation, then re-anchor so the
  // manifest hash stays valid (attestation rides under the tamper hash).
  function reAnchor(bundle: Awaited<ReturnType<typeof makeBundle>>) {
    const h = hashPublicLedgerBundle(bundle);
    return {
      ...bundle,
      manifest: { ...bundle.manifest, publicBundleHash: h },
      chainAnchor: { ...bundle.chainAnchor, manifestHash: h },
      storageAnchor: { ...bundle.storageAnchor, rootHash: h },
    } as typeof bundle;
  }

  it("provider-string-only (0g-compute, NO attestation) ⇒ self-verified, not independent", async () => {
    const bundle = await makeBundle({ ...base(), anchored: true });
    bundle.verifierSummary = { ...bundle.verifierSummary, provider: "0g-compute" };
    delete (bundle.verifierSummary as { attestation?: unknown }).attestation;
    const { result, flags } = await integrityOf(reAnchor(bundle));
    expect(result.verified).toBe(false);
    expect(result.value).toBeCloseTo(1.0 * 0.7);
    expect(flags).toContain("self-verified");
  });

  it("legacy 0g-router (no attestation) ⇒ NOT independent", async () => {
    const bundle = await makeBundle({ ...base(), anchored: true });
    bundle.verifierSummary = { ...bundle.verifierSummary, provider: "0g-router" };
    delete (bundle.verifierSummary as { attestation?: unknown }).attestation;
    const { result } = await integrityOf(reAnchor(bundle));
    expect(result.verified).toBe(false);
  });

  it("0g-dev provider (default fixture) ⇒ NOT independent", async () => {
    const { result } = await integrityOf(await makeBundle({ ...base(), anchored: true }));
    expect(result.verified).toBe(false);
  });

  it("0g-compute + shape-valid attestation whose signature does NOT recover ⇒ NOT independent", async () => {
    // Start from a real recovering attestation, then SUBSTITUTE the signer so recovery fails.
    const bundle = await makeBundle({ ...base(), anchored: true, independentVerifier: true });
    const att = (bundle.verifierSummary as { attestation: Record<string, unknown> }).attestation;
    att.signingAddress = "0x" + "0".repeat(40); // signature no longer recovers to this
    const { result } = await integrityOf(reAnchor(bundle));
    expect(result.verified).toBe(false);
  });

  it("0g-compute + WRONG scheme/attests ⇒ NOT independent", async () => {
    const bundle = await makeBundle({ ...base(), anchored: true, independentVerifier: true });
    const att = (bundle.verifierSummary as { attestation: Record<string, unknown> }).attestation;
    att.scheme = "not-teeml";
    att.attests = "something-else";
    const { result } = await integrityOf(reAnchor(bundle));
    expect(result.verified).toBe(false);
  });

  it.each(["signingAddress", "signature", "signedDigest"] as const)(
    "0g-compute + empty %s ⇒ NOT independent",
    async (field) => {
      const bundle = await makeBundle({ ...base(), anchored: true, independentVerifier: true });
      const att = (bundle.verifierSummary as { attestation: Record<string, unknown> }).attestation;
      att[field] = "";
      const { result } = await integrityOf(reAnchor(bundle));
      expect(result.verified).toBe(false);
    }
  );

  it("the real recovering 0g-compute attestation + live signer leg ⇒ INDEPENDENT (sanity)", async () => {
    const { result } = await integrityOf(await makeBundle({ ...base(), anchored: true, independentVerifier: true }));
    expect(result.verified).toBe(true);
  });

  it("0g-compute recovering attestation but NO live signer leg ⇒ NOT independent (execution-attested only)", async () => {
    // Recovery alone is forgeable (a self-keypair signer recovers to its own signingAddress).
    // Independence now requires the on-chain signer leg; strip it → execution-attested, not independent.
    const bundle = await makeBundle({ ...base(), anchored: true, independentVerifier: true });
    delete (bundle as { verifyAgainst0G?: unknown }).verifyAgainst0G;
    const { result, flags } = await integrityOf(reAnchor(bundle));
    expect(result.verified).toBe(false);
    expect(flags).toContain("self-verified");
  });

  it("0g-compute recovering attestation + signer leg matches:false ⇒ NOT independent", async () => {
    const bundle = await makeBundle({ ...base(), anchored: true, independentVerifier: true });
    (bundle as { verifyAgainst0G?: { signer?: { matches?: boolean } } }).verifyAgainst0G!.signer!.matches = false;
    const { result } = await integrityOf(reAnchor(bundle));
    expect(result.verified).toBe(false);
  });

  it("0g-compute + persisted signedText CONSISTENT with signedDigest ⇒ still INDEPENDENT", async () => {
    // The fixture's signedDigest = hashMessage("0x"+"a"*64+":chat-fixture"); persist exactly that.
    const bundle = await makeBundle({ ...base(), anchored: true, independentVerifier: true });
    const att = (bundle.verifierSummary as { attestation: Record<string, unknown> }).attestation;
    att.signedText = "0x" + "a".repeat(64) + ":chat-fixture";
    const { result } = await integrityOf(reAnchor(bundle));
    expect(result.verified).toBe(true);
  });

  it("0g-compute + persisted signedText that does NOT hash to signedDigest ⇒ NOT independent", async () => {
    const bundle = await makeBundle({ ...base(), anchored: true, independentVerifier: true });
    const att = (bundle.verifierSummary as { attestation: Record<string, unknown> }).attestation;
    att.signedText = "0x" + "f".repeat(64) + ":chat-tampered"; // inconsistent execution material
    const { result } = await integrityOf(reAnchor(bundle));
    expect(result.verified).toBe(false);
  });
});
