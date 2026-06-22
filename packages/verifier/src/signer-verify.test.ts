import { describe, expect, it } from "vitest";
import { verifySignerAgainst0G } from "./signer-verify";
import type { BrokerLike, ServiceSummary } from "./attested-adjudicator";

const PROVIDER = "0xa48fA0e1c8C9c3fE0c2F2a6B5D9E3a1B2c3D4e5f";
const SIGNER = "0x83df4B8EbA7c0B3B740019b8c9a77ffF77D508cF";

function brokerWith(
  services: Partial<ServiceSummary>[],
  verify: (() => Promise<any>) | null
): BrokerLike {
  return {
    inference: {
      listServiceWithDetail: async () =>
        services.map((s) => ({
          provider: s.provider ?? PROVIDER,
          verifiability: s.verifiability ?? "TeeML",
          teeSignerAcknowledged: s.teeSignerAcknowledged ?? true,
          teeSignerAddress: s.teeSignerAddress ?? SIGNER,
          model: s.model ?? "qwen/qwen2.5-omni-7b"
        })),
      getServiceMetadata: async () => ({ endpoint: "", model: "" }),
      getRequestHeaders: async () => ({}),
      processResponse: async () => true,
      verifyService: verify ?? (async () => ({ composeVerification: { passed: true }, signerVerification: { allMatch: true } })),
      getSignerRaDownloadLink: async () => "",
      getChatSignatureDownloadLink: async () => ""
    }
  };
}

describe("verifySignerAgainst0G", () => {
  it("matches when the signer IS the provider's acknowledged + quote-verified on-chain signer", async () => {
    const broker = brokerWith([{ teeSignerAddress: SIGNER, teeSignerAcknowledged: true }], null);
    const r = await verifySignerAgainst0G(broker, { providerAddress: PROVIDER, expectedSigner: SIGNER });
    expect(r).toMatchObject({ onChainSigner: SIGNER, acknowledgedOnChain: true, quoteVerified: true, matches: true });
  });

  it("is case-insensitive on the address comparison", async () => {
    const broker = brokerWith([{ teeSignerAddress: SIGNER.toUpperCase(), teeSignerAcknowledged: true }], null);
    const r = await verifySignerAgainst0G(broker, { providerAddress: PROVIDER.toLowerCase(), expectedSigner: SIGNER.toLowerCase() });
    expect(r.matches).toBe(true);
  });

  it("does NOT match a forger's own keypair (signer != provider's on-chain signer)", async () => {
    const broker = brokerWith([{ teeSignerAddress: SIGNER, teeSignerAcknowledged: true }], null);
    const r = await verifySignerAgainst0G(broker, { providerAddress: PROVIDER, expectedSigner: "0x" + "9".repeat(40) });
    expect(r.matches).toBe(false);
    expect(r.onChainSigner).toBe(SIGNER); // the REAL signer is reported, the forged one simply doesn't equal it
  });

  it("does NOT match when the provider is not found on-chain", async () => {
    const broker = brokerWith([{ provider: "0xSomeOtherProvider" }], null);
    const r = await verifySignerAgainst0G(broker, { providerAddress: PROVIDER, expectedSigner: SIGNER });
    expect(r).toMatchObject({ onChainSigner: null, acknowledgedOnChain: false, quoteVerified: false, matches: false });
  });

  it("does NOT match when the signer is not acknowledged on-chain", async () => {
    const broker = brokerWith([{ teeSignerAddress: SIGNER, teeSignerAcknowledged: false }], null);
    const r = await verifySignerAgainst0G(broker, { providerAddress: PROVIDER, expectedSigner: SIGNER });
    expect(r).toMatchObject({ acknowledgedOnChain: false, matches: false });
  });

  it("STILL matches on identity when the live quote re-check fails (quote is best-effort, not part of matches)", async () => {
    const broker = brokerWith(
      [{ teeSignerAddress: SIGNER, teeSignerAcknowledged: true }],
      async () => ({ composeVerification: { passed: false }, signerVerification: { allMatch: true } })
    );
    const r = await verifySignerAgainst0G(broker, { providerAddress: PROVIDER, expectedSigner: SIGNER });
    // Identity binding holds (acknowledged on-chain signer) → matches; quote is reported false, not seal-cracking.
    expect(r).toMatchObject({ quoteVerified: false, matches: true });
  });

  it("a transient verifyService THROW does not crack a matching identity (matches stays true, quoteVerified false)", async () => {
    const broker = brokerWith(
      [{ teeSignerAddress: SIGNER, teeSignerAcknowledged: true }],
      async () => { throw new Error("quote node unreachable"); }
    );
    const r = await verifySignerAgainst0G(broker, { providerAddress: PROVIDER, expectedSigner: SIGNER });
    expect(r).toMatchObject({ acknowledgedOnChain: true, quoteVerified: false, matches: true });
  });

  it("fail-closed (never throws) when listServiceWithDetail rejects", async () => {
    const broker: BrokerLike = {
      inference: {
        listServiceWithDetail: async () => { throw new Error("rpc down"); },
        getServiceMetadata: async () => ({ endpoint: "", model: "" }),
        getRequestHeaders: async () => ({}),
        processResponse: async () => true,
        verifyService: async () => null,
        getSignerRaDownloadLink: async () => "",
        getChatSignatureDownloadLink: async () => ""
      }
    };
    const r = await verifySignerAgainst0G(broker, { providerAddress: PROVIDER, expectedSigner: SIGNER });
    expect(r).toMatchObject({ onChainSigner: null, matches: false });
  });
});
