import { mkdir } from "node:fs/promises";
import type { VerifyAgainst0G } from "@vibetrace/schema";
import type { BrokerLike } from "./attested-adjudicator";

export type SignerVerification = NonNullable<VerifyAgainst0G["signer"]>;

/**
 * CONSUMER-side re-verification of the attestation's signer against live 0G — the trustless closer for
 * the forger-with-own-keypair hole. Given a (read-only) 0G Compute broker and the bundle's claimed
 * `providerAddress` + `signingAddress`, it:
 *   1. reads the provider's ON-CHAIN-acknowledged TEE signer (listServiceWithDetail → teeSignerAddress,
 *      teeSignerAcknowledged), and
 *   2. runs the TDX/dstack quote check (verifyService → composeVerification.passed + signerVerification.allMatch),
 * then confirms the bundle's `expectedSigner` IS that on-chain, acknowledged, quote-verified signer.
 *
 * `matches` (the seal-cracking condition) is the IDENTITY BINDING: provider found && onChainSigner ===
 * expectedSigner (case-insensitive) && acknowledgedOnChain. That is the reliably re-checkable fact and the
 * actual forgery-closer — a self-minted keypair is NOT the provider's on-chain-acknowledged signer, so it
 * yields matches:false.
 *
 * `quoteVerified` (the live TDX/dstack quote re-check) is reported as ADDITIONAL, BEST-EFFORT assurance and
 * is DELIBERATELY NOT part of `matches`: the bundle's attestation already embeds the relayer's
 * production-time quote verification (composeVerificationPassed / signerAllMatch / teeType), and the live
 * quote node can be slow/unreachable at re-check time — so a transient quote miss must NOT crack a seal
 * whose signer genuinely matches. When quoteVerified IS true, the consumer additionally re-confirmed the
 * live hardware quote.
 *
 * FAIL-CLOSED: any network/SDK error or a missing provider yields matches:false (onChainSigner:null),
 * NEVER a throw — callers attach the result to VerifyAgainst0G.signer and the viewer/score crack on
 * matches===false. HONEST LIMIT: this proves "an attested 0G TEE signer executed this", NOT that the
 * provider is neutral — a party running their own genuine TeeML provider would also pass.
 */
export async function verifySignerAgainst0G(
  broker: BrokerLike,
  input: { providerAddress: string; expectedSigner: string; outputDir?: string }
): Promise<SignerVerification> {
  const base: SignerVerification = {
    providerAddress: input.providerAddress,
    expectedSigner: input.expectedSigner,
    onChainSigner: null,
    acknowledgedOnChain: false,
    quoteVerified: false,
    matches: false
  };
  try {
    // Window (0,50) MUST stay >= the production provider-selection window (attested-adjudicator.ts
    // selectTeeMlProvider over the same listServiceWithDetail) so a provider selectable at produce time
    // is also visible here. If the on-chain TeeML registry ever exceeds this, paginate to find the
    // specific providerAddress — otherwise a genuine bundle whose provider falls outside the window would
    // wrongly report matches:false and crack the seal.
    const services = await broker.inference.listServiceWithDetail(0, 50, false);
    const svc = services.find((s) => s.provider.toLowerCase() === input.providerAddress.toLowerCase());
    if (!svc) return base; // provider not on-chain → cannot be the acknowledged signer
    const onChainSigner =
      typeof svc.teeSignerAddress === "string" && svc.teeSignerAddress.length > 0 ? svc.teeSignerAddress : null;
    const acknowledgedOnChain = svc.teeSignerAcknowledged === true;

    let quoteVerified = false;
    try {
      // verifyService writes the downloaded RA report into outputDir but does NOT create it — a missing
      // dir ENOENTs and silently drops quoteVerified to false (observed as an unexpectedly-false quote leg).
      const outDir = input.outputDir ?? "/tmp/vt-verify";
      await mkdir(outDir, { recursive: true });
      const vr = await broker.inference.verifyService(input.providerAddress, outDir);
      quoteVerified = vr?.composeVerification?.passed === true && vr?.signerVerification?.allMatch === true;
    } catch {
      quoteVerified = false; // quote unreachable / failed → not quote-verified
    }

    const addrMatch = onChainSigner !== null && onChainSigner.toLowerCase() === input.expectedSigner.toLowerCase();
    return {
      ...base,
      onChainSigner,
      acknowledgedOnChain,
      quoteVerified, // reported, but NOT a factor in `matches` (best-effort live quote; see doc above)
      matches: addrMatch && acknowledgedOnChain
    };
  } catch {
    return base; // any list/network failure → fail-closed
  }
}
