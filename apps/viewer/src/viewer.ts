import {
  PublicLedgerBundle,
  hashPublicLedgerBundle,
  type VerifierRun,
  type ClaimVerdict,
  type VerifyAgainst0G
} from "@vibetrace/schema";
import type { VibeScoreResult } from "@vibetrace/score";
import type { RegistrySummary } from "./registry";
import { logoMark } from "./assets";
import { renderFooter } from "./footer";

type PublicGraphNode = PublicLedgerBundle["publicGraph"]["nodes"][number];

export type BundleVerification = {
  valid: boolean;
  computedHash: string;
  expectedHash: string;
  chainAnchorValid: boolean;
};

type AnchorDisplayKind = "onchain" | "dev" | "pending" | "missing" | "mismatch";

type AnchorDisplay = {
  kind: AnchorDisplayKind;
  label: string;
  badgeClass: string;
  storyTitle: string;
  storyBadge: string;
  storyBadgeClass: string;
};

function presentAnchorValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isPendingAnchorValue(value: unknown): boolean {
  return value === "pending";
}

function isDevProvider(value: unknown): boolean {
  return presentAnchorValue(value)?.trim().toLowerCase() === "0g-dev";
}

/** Only the real on-chain adapter's provider ("0g-chain") is a verifiable 0G
 *  anchor — mirrors the score engine so a forged "0g"/"fake-chain" provider can
 *  never display as ANCHORED ON 0G in the UI. */
function isRealChainProvider(value: unknown): boolean {
  return presentAnchorValue(value)?.trim().toLowerCase() === "0g-chain";
}

export function verifyBundleHash(bundle: PublicLedgerBundle | any): BundleVerification {
  const computedHash = hashPublicLedgerBundle(bundle);
  const expectedHash =
    bundle.manifest.publicBundleHash === "pending" ? computedHash : String(bundle.manifest.publicBundleHash);
  const chainManifestHash = presentAnchorValue(bundle.chainAnchor?.manifestHash);
  const chainTxHash = presentAnchorValue(bundle.chainAnchor?.txHash);
  const hasChainManifest = Boolean(chainManifestHash && !isPendingAnchorValue(chainManifestHash));
  const hasChainTx = Boolean(chainTxHash && !isPendingAnchorValue(chainTxHash));

  return {
    valid: computedHash === expectedHash,
    computedHash,
    expectedHash,
    chainAnchorValid:
      isRealChainProvider(bundle.chainAnchor?.provider) && hasChainManifest && hasChainTx && chainManifestHash === expectedHash
  };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* ── helpers ── */

function shortenHash(hash: string): string {
  if (!hash || hash.length <= 20) return hash;
  return hash.slice(0, 10) + "…" + hash.slice(-9);
}

/**
 * 0G testnet explorer (0GScan) transaction URL. Only the Galileo testnet chain
 * ids map to a public explorer; anything else returns undefined so we NEVER
 * link a hash that has no real on-chain transaction page (dev/synthetic hashes
 * stay plain text — no anchor theater).
 */
function explorerTxUrl(chainId: unknown, txHash: string | undefined): string | undefined {
  if (!txHash || txHash === "pending") return undefined;
  const id = Number(chainId);
  if (id === 16602 || id === 16601) return `https://chainscan-galileo.0g.ai/tx/${txHash}`;
  return undefined;
}

/**
 * 0G testnet explorer (0GScan) ADDRESS URL — reuses the SAME explorer base and
 * Galileo chain-id gating as explorerTxUrl above. Used to link the attestation's
 * signing address so anyone can open the on-chain account page for the TEE signer.
 *
 * HONESTY: an address page is NOT proof the provider acknowledged this signer —
 * it is only a navigable trust anchor (label it "view signer", never "verify").
 * Returns undefined for unsupported chains / empty addresses so we never link a
 * route that has no real on-chain page (the address then renders as plain mono).
 */
function explorerAddressUrl(chainId: unknown, address: string | undefined): string | undefined {
  const addr = String(address ?? "").trim();
  if (!addr || addr === "pending") return undefined;
  const id = Number(chainId);
  if (id === 16602 || id === 16601) return `https://chainscan-galileo.0g.ai/address/${addr}`;
  return undefined;
}

/**
 * Resolve a 0G Storage rootHash to a BROWSER-FETCHABLE HTTP URL, or undefined
 * when no public object exists.
 *
 * Browsers cannot fetch `0g://…`; the bundle's `storageAnchor.uri` is exactly such
 * a value, so it must NEVER be handed to `fetch`. For REAL uploads (`0g://<root>`,
 * provider "0g-storage") we resolve the rootHash against the public 0G Storage
 * indexer's HTTP download endpoint — the SAME indexer host the real upload adapter
 * targets (packages/og/src/index.ts, `https://indexer-storage-testnet-turbo.0g.ai`).
 *
 * Dev-local roots (`0g://local/…`, provider "0g-dev") were written to a LOCAL folder
 * and never uploaded to the indexer (see the dev adapter's uploadJson), so that
 * endpoint would 404. We return undefined for them so the live-fetch button is
 * OMITTED rather than linking a proof affordance that breaks — the verifyAgainst0G
 * read-back sidecar still attests the local read.
 */
const OG_STORAGE_GATEWAY = "https://indexer-storage-testnet-turbo.0g.ai";

function storageGatewayUrl(uri: string | undefined, rootHash: string | undefined): string | undefined {
  const root = String(rootHash ?? "").trim();
  if (!root) return undefined;
  // Dev-local roots were never uploaded to the indexer → a gateway link would 404.
  // Omit the live-fetch button rather than expose a broken proof affordance.
  if (String(uri ?? "").startsWith("0g://local/")) return undefined;
  return `${OG_STORAGE_GATEWAY}/file?root=${root}`;
}

/**
 * Browser-navigable URL guard — the SINGLE gate that keeps the receipt free of
 * dead links. Returns the URL only when it is http(s), the only schemes a browser
 * can actually open. `0g://` (incl. `0g://local/…`), `ipfs://`, `file://`, empty,
 * and `"pending"` return undefined so the caller renders copyable TEXT instead of
 * a link that goes nowhere. (The old RA-quote path linked `0g://` raw — that ↗ was
 * the dead link this fixes.)
 */
function browserHref(value: unknown): string | undefined {
  const s = String(value ?? "").trim();
  if (!s || s === "pending") return undefined;
  return /^https?:\/\//i.test(s) ? s : undefined;
}

/**
 * A copyable mono hash: shows the shortened form, carries the FULL value in both
 * `title` (hover) and `data-copy` (click-to-copy, wired by bindReceiptsCard in
 * main.ts). Used for every hash/address that is NOT a live link, so a reader can
 * still grab the full value — we never trade a real value for a dead anchor.
 */
function copyableHash(full: string, extraCls = "text-ink/80"): string {
  return (
    `<code data-copy="${escapeHtml(full)}" title="${escapeHtml(full)} — click to copy" tabindex="0" role="button" ` +
    `class="cursor-pointer break-all font-bold ${extraCls} underline decoration-dotted decoration-ink/30 underline-offset-2 hover:text-blue">` +
    `${escapeHtml(shortenHash(full))}</code>`
  );
}

/**
 * Render `full` as a real `↗` anchor when `href` is browser-openable, else fall
 * back to a copyable hash — NEVER a dead anchor. The fallback is what makes a
 * `0g://` quote / dev-local tx readable-and-copyable instead of a broken link.
 */
function linkOrCopy(href: string | undefined, full: string, linkText?: string): string {
  if (!href) return copyableHash(full);
  const text = linkText ?? shortenHash(full);
  return (
    `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" ` +
    `class="text-blue font-bold underline decoration-dotted underline-offset-2 break-all">${escapeHtml(text)} ↗</a>`
  );
}

function nodesOfType(bundle: PublicLedgerBundle, type: PublicGraphNode["type"]): PublicGraphNode[] {
  return bundle.publicGraph.nodes.filter((n) => n.type === type);
}

// Per-claim verdict helpers now live in the shared, pure ./verdicts module so the
// story card (sealState below) and the leaderboard row (registry-core.ts) derive
// the headline from the SAME source (verifierSummary.verdicts, under the tamper hash)
// and can never disagree. Re-exported so existing `from "./viewer"` importers (tests,
// other modules) keep working unchanged.
export { substantiatedFlaggedCounts, verdictWordAndClass, worstVerdict } from "./verdicts";
import {
  isDisplayEligibleAttestation,
  substantiatedFlaggedCounts,
  verdictWordAndClass,
  verifyAgainst0GMismatch,
  worstVerdict
} from "./verdicts";

/* ── Receipts card: honest seal state ──
 * Three mutually exclusive states, checked in this order so a failed-but-present
 * attestation can NEVER render green:
 *   1. cracked        — attestation present but processResponseValid !== true
 *                       (the enclave signature did not verify) → "SEAL UNVERIFIED"
 *   2. attested       — provider === "0g-compute" AND processResponseValid → wax seal,
 *                       rim = real signature, word = worst per-claim verdict
 *   3. structural-only— no attestation / non-0g-compute provider → debossed grey
 *                       "LOCAL CHECK ONLY", NEVER a fake wax seal */

export type SealState = {
  kind: "attested" | "structural-only" | "cracked";
  verdictWord: string;
  verdictClass: string;
  sigShort: string;
  signingAddress: string;
  modelId: string;
};

export function sealState(bundle: PublicLedgerBundle, verification: BundleVerification): SealState {
  const verifier = bundle.verifierSummary as VerifierRun;
  const attestation = verifier.attestation;
  const provider = String(verifier.provider ?? "").trim().toLowerCase();
  const modelId = String(verifier.model ?? "");

  // 1. cracked — attestation object exists but its signature did not independently verify.
  if (attestation && attestation.processResponseValid !== true) {
    return {
      kind: "cracked",
      verdictWord: "SEAL UNVERIFIED",
      verdictClass: "bg-wax text-paperlight",
      sigShort: shortenHash(String(attestation.signature ?? "")),
      signingAddress: String(attestation.signingAddress ?? ""),
      modelId
    };
  }

  // 2. attested — genuine 0g-compute provider with a passing per-response signature AND the honest
  //    `attests: "tee-execution"` marker (legacy bundles missing it are NOT shown as TEE-attested),
  //    AND the deterministic bundle verification also passes (tamper-proof gate). If the bundle hash
  //    doesn't match OR (when present) the 0G read-back shows a mismatch, the seal is CRACKED — we
  //    NEVER return "attested" for a tampered bundle. This attests EXECUTION (the TEE signer named by
  //    the attestation ran inference + the signature recovers to it), NOT that the verdict content was
  //    signed, and NOT that VibeTrace verified the signer against an on-chain registry.
  if (isDisplayEligibleAttestation(attestation) && provider === "0g-compute") {
    // Fail closed: require the deterministic hash to be valid.
    if (!verification.valid) {
      return {
        kind: "cracked",
        verdictWord: "SEAL UNVERIFIED",
        verdictClass: "bg-wax text-paperlight",
        sigShort: shortenHash(String(attestation.signature ?? "")),
        signingAddress: String(attestation.signingAddress ?? ""),
        modelId
      };
    }

    // Fail closed: when the 0G read-back sidecar is present, both storage and chain
    // must match. A mismatch on either means the on-chain evidence doesn't agree with
    // the bundle — treat as cracked.
    const v0gSidecar = (bundle as PublicLedgerBundle & { verifyAgainst0G?: VerifyAgainst0G }).verifyAgainst0G;
    if (verifyAgainst0GMismatch(v0gSidecar)) {
      return {
        kind: "cracked",
        verdictWord: "SEAL UNVERIFIED",
        verdictClass: "bg-wax text-paperlight",
        sigShort: shortenHash(String(attestation.signature ?? "")),
        signingAddress: String(attestation.signingAddress ?? ""),
        modelId
      };
    }

    // The seal HEADLINES the attestation state — this build WAS examined by a 0G TEE enclave —
    // never the worst per-claim verdict. Headlining "unsupported" read as a build failure even
    // though the attestation + the live 0G anchor are green; the per-claim verdicts are shown
    // separately (the stat-row substantiated/flagged breakdown + the examiner claim cards).
    return {
      kind: "attested",
      verdictWord: "0G TEE EXAMINED",
      verdictClass: "bg-wax text-paperlight",
      sigShort: shortenHash(String(attestation.signature ?? "")),
      signingAddress: String(attestation.signingAddress ?? ""),
      modelId
    };
  }

  // 3. structural-only — honest degradation; no fake wax seal.
  return {
    kind: "structural-only",
    verdictWord: "LOCAL CHECK ONLY",
    verdictClass: "bg-ink/10 text-ink",
    sigShort: "",
    signingAddress: "",
    modelId
  };
}

function describeAnchor(bundle: PublicLedgerBundle, verification: BundleVerification): AnchorDisplay {
  const manifestHash = presentAnchorValue(bundle.chainAnchor?.manifestHash);
  const chainId = escapeHtml(String(bundle.chainAnchor?.chainId ?? "—"));

  if (!verification.valid || (manifestHash && !isPendingAnchorValue(manifestHash) && manifestHash !== verification.expectedHash)) {
    return {
      kind: "mismatch",
      label: "FINGERPRINT MISMATCH",
      badgeClass: "bg-coral text-white",
      storyTitle: "Anchor mismatch",
      storyBadge: "FINGERPRINT MISMATCH",
      storyBadgeClass: "bg-coral text-white"
    };
  }

  if (!manifestHash) {
    return {
      kind: "missing",
      label: "CHAIN MANIFEST MISSING",
      badgeClass: "bg-sun text-ink",
      storyTitle: "Anchor status",
      storyBadge: "CHAIN MANIFEST MISSING",
      storyBadgeClass: "bg-sun text-ink"
    };
  }

  if (isPendingAnchorValue(manifestHash)) {
    return {
      kind: "pending",
      label: "ANCHOR PENDING",
      badgeClass: "bg-sun text-ink",
      storyTitle: "Anchor pending",
      storyBadge: "ANCHOR PENDING",
      storyBadgeClass: "bg-sun text-ink"
    };
  }

  if (isDevProvider(bundle.chainAnchor?.provider)) {
    return {
      kind: "dev",
      label: "DEV ANCHOR (0g-dev)",
      badgeClass: "bg-sun text-ink",
      storyTitle: "Dev anchor recorded",
      storyBadge: `DEV ANCHOR (0g-dev) · chain ${chainId}`,
      storyBadgeClass: "bg-sun text-ink"
    };
  }

  if (verification.chainAnchorValid) {
    return {
      kind: "onchain",
      label: "ANCHORED ON 0G",
      badgeClass: "bg-lime text-ink",
      storyTitle: "Anchored on 0G",
      storyBadge: `ANCHORED ON 0G · chain ${chainId}`,
      storyBadgeClass: "bg-lime text-ink"
    };
  }

  return {
    kind: "pending",
    label: "ANCHOR PENDING",
    badgeClass: "bg-sun text-ink",
    storyTitle: "Anchor pending",
    storyBadge: "ANCHOR PENDING",
    storyBadgeClass: "bg-sun text-ink"
  };
}

function pct(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

const TIER_BG: Record<string, string> = {
  S: "bg-lime text-ink",
  A: "bg-lime text-ink",
  B: "bg-blue text-white",
  C: "bg-sun text-ink",
  D: "bg-coral text-ink"
};

/** Tier → Neo-Brutal badge background classes (shared with the leaderboard). */
export function tierBadgeClass(tier: string): string {
  return TIER_BG[tier] ?? "bg-lime text-ink";
}

/** Integrity seal → short human label (shared with the leaderboard). */
export function sealLabel(seal: string): string {
  switch (seal) {
    case "anchored-verified":
      return "Anchor Recorded";
    case "anchored":
      return "Anchor Recorded";
    case "self-published":
      return "Unanchored";
    default:
      return "Integrity Broken";
  }
}

/**
 * Relative-time formatter for a "minutes ago" seed. Computed at render time so
 * it can tick forward; never used inside scoring (display-only).
 */
export function relativeTime(minutesAgo: number): string {
  const m = Math.max(0, Math.round(minutesAgo));
  if (m <= 0) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Relative-time from a server ISO submission timestamp. Display-only (never used
 * in scoring). Falls back to "—" for an unparseable timestamp.
 */
export function relativeTimeFromIso(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return relativeTime((Date.now() - ms) / 60000);
}

/** Epoch millis for a submission ISO timestamp (0 if unparseable). */
function submittedMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/* ── 0. Live submissions marquee ──
 *
 * Replaces the old static taglines with a live feed of recent submissions from
 * the registry. The scroll animation runs uninterrupted — the CSS .marquee-track
 * animation is NEVER restarted. Liveness is achieved by ticking the relative
 * timestamps in place: each timestamp span carries a data-ts="<absoluteMillis>"
 * attribute so main.ts can update only the textContent of those spans on an
 * interval (~5s), with zero animation reset.
 * Under prefers-reduced-motion the CSS disables the scroll/pulse and we render
 * a static recent list instead.
 */

/**
 * Compute absolute epoch millis for a submission offset.
 * `minutesAgo` is a seed offset (display-only; not used in scoring).
 */
function absoluteMs(submittedAt: string): number {
  return submittedMs(submittedAt) || Date.now();
}

function marqueeItem(entry: RegistrySummary): string {
  const repo = escapeHtml(entry.repo);
  const tier = escapeHtml(entry.buildTier ?? entry.tier);
  const vibe = escapeHtml(String(entry.buildScore ?? entry.vibeScore));
  const rel = escapeHtml(relativeTimeFromIso(entry.submittedAt));
  const absMs = absoluteMs(entry.submittedAt);
  // Attested builds get the one examiner-only accent (wax) and a data-tee hook
  // so the live feed flags TEE-execution-attested builds before the user clicks through.
  // Fail closed on a broken integrity seal — same gate as the leaderboard pill — so a tampered
  // summary never shows the TEE mark even if its stored teeVerified is stale.
  const tee = entry.teeVerified && entry.seal !== "broken";
  const dot = tee ? "text-wax" : entry.seal === "anchored-verified" ? "text-lime" : "text-sun";
  const teeAttr = tee ? ` data-tee="1"` : "";
  const teeMark = tee
    ? `<span class="text-wax font-bold uppercase tracking-widest" aria-hidden="true">TEE</span>` +
      `<span class="text-paper/30">·</span>`
    : "";
  return (
    `<span class="px-4 inline-flex items-center gap-2"${teeAttr}>` +
    `<span class="${dot}" aria-hidden="true">●</span>` +
    `<span class="text-paper/90">${repo}</span>` +
    `<span class="text-paper/30">·</span>` +
    teeMark +
    `<span class="text-lime font-bold">${tier}</span>` +
    `<span class="text-paper/30">·</span>` +
    `<span class="text-sun font-bold">${vibe}</span>` +
    `<span class="text-paper/30">·</span>` +
    `<span class="text-paper/50" data-ts="${absMs}">${rel}</span>` +
    `</span>`
  );
}

/**
 * Render the live submissions marquee for the given registry entries. `lead` is
 * the index of the entry that currently leads the feed (rotated by main.ts).
 */
export function renderLiveMarquee(entries: RegistrySummary[], lead = 0): string {
  return `<div data-marquee-host>${renderMarqueeBar(entries, lead)}</div>`;
}

/** The inner marquee bar without the host wrapper — used for in-place ticks. */
export function renderMarqueeBar(entries: RegistrySummary[], lead = 0): string {
  if (entries.length === 0) {
    return `<div class="bg-ink text-lime b4 border-t-0 border-x-0 py-2.5" aria-hidden="true"></div>`;
  }

  // Newest-first by submission time, then rotated so `lead` is at the front.
  const ordered = [...entries].sort((a, b) => submittedMs(a.submittedAt) - submittedMs(b.submittedAt));
  const n = ordered.length;
  const rotated = ordered.map((_, i) => ordered[(i + lead) % n]);

  const items = rotated.map((e) => marqueeItem(e)).join("");
  // Duplicate the run so the -50% scroll loop is seamless.
  const track = items + items;

  const liveBadge =
    `<span class="inline-flex items-center gap-1.5 b2 bg-coral text-white px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest shrink-0">` +
    `<span class="w-2 h-2 bg-lime rounded-full inline-block" aria-hidden="true"></span>LIVE</span>`;

  // Static fallback list (shown only under reduced motion, where the scroll is off).
  const staticList = rotated
    .slice(0, 4)
    .map((e) => marqueeItem(e))
    .join("");

  return `
    <div class="bg-ink text-lime b4 border-t-0 border-x-0 overflow-hidden select-none">
      <div class="flex items-stretch">
        <div class="flex items-center gap-2 px-3 border-r-4 border-lime bg-ink shrink-0">
          ${liveBadge}
        </div>
        <div class="relative overflow-hidden grow" role="status" aria-label="Live submissions feed">
          <div class="marquee-track py-2.5 font-mono text-xs sm:text-sm font-bold tracking-wide" data-marquee-track aria-hidden="true">${track}</div>
          <div class="marquee-static hidden py-2.5 font-mono text-xs font-bold tracking-wide whitespace-nowrap overflow-hidden">${staticList}</div>
        </div>
      </div>
    </div>`;
}

/** Back-compat: the story page renders the live marquee with no registry as an
 *  empty bar; callers pass entries explicitly via renderBundle's third arg. */
function renderMarquee(entries?: RegistrySummary[]): string {
  return renderLiveMarquee(entries ?? []);
}

/* ── 1. Hook — project name + headline ── */

function renderHook(bundle: PublicLedgerBundle, anchor: AnchorDisplay): string {
  const projectName = escapeHtml(bundle.manifest.project.name);
  const proofCopy =
    anchor.kind === "onchain"
      ? "Every file, prompt, and commit hashed and anchored on 0G, so you can check for yourself that this software was built with AI."
      : anchor.kind === "dev"
        ? "Every file, prompt, and commit hashed with a 0g-dev anchor, so you can inspect the build evidence without mistaking it for a live on-chain anchor."
        : "Every file, prompt, and commit hashed into a public bundle, with the current anchor status shown below for verification.";
  return `
    <header class="flex flex-wrap items-center justify-between gap-4 mb-7">
      <div class="flex items-center gap-3">
        <div class="b3 bg-lime hard w-12 h-12 sm:w-14 sm:h-14 grid place-items-center shrink-0" aria-hidden="true">
          ${logoMark(32, { tileFill: "transparent" })}
        </div>
        <div class="leading-none">
          <div class="font-display text-xl sm:text-2xl tracking-tight">VibeTrace</div>
          <div class="font-mono text-[11px] sm:text-xs font-bold text-blue uppercase tracking-widest mt-1">Proof-of-Build Ledger</div>
        </div>
      </div>
      <a href="#proof-strip" class="b3 bg-sun hard lift inline-flex items-center gap-2 px-3.5 py-2 font-mono text-xs font-bold uppercase tracking-wide">
        <span class="w-2.5 h-2.5 bg-ink b2 rounded-full inline-block" aria-hidden="true"></span>
        Verify it yourself
      </a>
    </header>

    <div class="mb-8">
      <div class="font-mono text-[11px] font-bold uppercase tracking-widest text-blue mb-2">${projectName}</div>
      <h1 class="font-display text-5xl sm:text-6xl lg:text-7xl leading-[0.88] tracking-tight" style="text-shadow:3px 3px 0 #0B0B0F">
        Built with AI.<br/><span class="bg-coral text-white px-2 inline-block -rotate-1">Provably.</span>
      </h1>
      <p class="font-mono text-sm text-ink/60 mt-4 max-w-xl">
        ${proofCopy}
      </p>
    </div>`;
}

/* ── 2. The Receipts Attached Card (front + drawer) ──
 * Replaces the spinning-stamp hero. Front: flex line + mono stat row + wax seal
 * (rim = real enclave signature; verdict word = worst per-claim status; honest
 * cracked / grey fail states). The seal is the ONLY embossed, hot-colored object.
 * The deterministic local checks tick green (mono, flat ink); the verdict seal is
 * the one pressed object. main.ts presses it once after render. */

/** Short signature for the rim ornament — the signature IS the ornament (spec §11). */
function rimSignature(sigShort: string): string {
  return sigShort ? `SIG ${sigShort}` : "";
}

function renderSealFace(seal: SealState): string {
  if (seal.kind === "structural-only") {
    // Debossed, DASHED placeholder — deliberately NOT a wax seal (this build was
    // self-checked, never independently examined). Made legible (icon + verdict +
    // label) so it reads as an intentional "unsealed" state, not a broken stamp.
    return `
      <div class="relative grid place-items-center w-44 h-44 sm:w-52 sm:h-52 rounded-full b4 border-dashed border-ink/50 bg-ink/[0.06] text-ink"
           data-seal-press data-seal-kind="structural-only" data-verdict="${escapeHtml(seal.verdictWord)}"
           style="box-shadow: inset 4px 4px 0 rgba(11,11,15,0.07);">
        <div class="absolute inset-3 rounded-full b2 border-dashed border-ink/25 pointer-events-none"></div>
        <div class="text-center px-5 leading-tight z-10">
          <svg viewBox="0 0 24 24" class="w-7 h-7 mx-auto mb-1.5 text-ink/70" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" stroke-dasharray="3 3"/><path d="M8.5 12h7"/>
          </svg>
          <div class="font-display text-base sm:text-lg tracking-tight leading-none">${escapeHtml(seal.verdictWord)}</div>
          <div class="font-mono text-[10px] font-bold uppercase tracking-wide mt-1.5 text-ink/65">Self-checked · not independently examined</div>
        </div>
      </div>`;
  }

  const cracked = seal.kind === "cracked";
  // Cracked = wax with a visible fracture; attested = clean pressed wax.
  const face = "bg-wax text-paperlight";
  const crack = cracked
    ? `<svg viewBox="0 0 200 200" class="absolute inset-0 w-full h-full pointer-events-none" aria-hidden="true">
         <path d="M100,8 L92,70 L120,98 L86,128 L104,192" fill="none" stroke="#0B0B0F" stroke-width="5" stroke-linejoin="round"/>
       </svg>`
    : "";
  const rim = cracked
    ? "SEAL UNVERIFIED · DO NOT TRUST ·"
    : `${rimSignature(seal.sigShort)} · ${escapeHtml(seal.modelId)} ·`;

  // The face word IS the seal headline from sealState — "0G TEE EXAMINED" (attested),
  // "SEAL UNVERIFIED" (cracked), or "LOCAL CHECK ONLY" (structural). It is the attestation
  // state, NEVER a per-claim verdict word (those live in the breakdown + the claim cards).
  const faceWord = seal.verdictWord;

  return `
    <div class="relative grid place-items-center w-44 h-44 sm:w-52 sm:h-52 rounded-full b4 border-ink ${face} hard-lg"
         data-seal-press data-seal-kind="${seal.kind}" data-verdict="${escapeHtml(seal.verdictWord)}">
      <div class="absolute inset-2 rounded-full b2 border-dashed border-paperlight/60 pointer-events-none"></div>
      ${crack}
      <div class="text-center leading-none z-10 px-3">
        <div class="font-mono text-[9px] font-bold uppercase tracking-[0.18em] mb-2 opacity-90 break-words">${escapeHtml(rim)}</div>
        <div class="font-display text-xl sm:text-2xl tracking-tight">${escapeHtml(faceWord)}</div>
      </div>
    </div>`;
}

/** One examiner CLAIM CARD: verdict pill (◆ mark, locked color) + claimId + support
 *  count + rationale. The per-claim signature paragraph is GONE — its one shared
 *  explainer lives in the section footnote (renderSignatureNote), printed once. */
function renderExaminerRow(verdict: ClaimVerdict): string {
  const { word, cls } = verdictWordAndClass(verdict.verdict);
  const count = Array.isArray(verdict.supportingNodes) ? verdict.supportingNodes.length : 0;
  const rationale = escapeHtml(String(verdict.rationale ?? ""));
  const claimId = escapeHtml(String(verdict.claimId ?? ""));
  return `
    <li class="b2 border-ink bg-white hard p-3">
      <div class="flex flex-wrap items-center gap-2">
        <span class="b2 ${cls} px-2 py-0.5 font-display text-xs uppercase tracking-wide inline-flex items-center gap-1.5">
          <span class="leading-none" aria-hidden="true">◆</span>${word}
        </span>
        <code class="font-mono text-[11px] font-bold text-ink/70">${claimId}</code>
        <span class="font-mono text-[11px] text-ink/50">${count} supporting node${count !== 1 ? "s" : ""}</span>
      </div>
      ${rationale ? `<p class="font-mono text-[11px] text-ink/70 mt-1.5">${rationale}</p>` : ""}
    </li>`;
}

/** The ONE shared signature explainer for the examiner section (attested only).
 *  Collapsed `ⓘ` footnote — the substance is preserved but printed exactly once,
 *  not repeated under every claim. Carries `data-signature-note` for dedup tests. */
function renderSignatureNote(): string {
  return `
        <details class="mt-3 b2 border-ink/40 bg-paper/60 hard" data-signature-note>
          <summary class="font-mono text-[11px] font-bold uppercase tracking-wide text-blue cursor-pointer select-none px-3 py-2 flex items-center gap-1.5">
            <span aria-hidden="true">ⓘ</span> What the signature proves
          </summary>
          <p class="font-mono text-[11px] text-ink/65 px-3 pb-3 leading-relaxed">The signature lets anyone recover the 0G TEE signer named by this attestation and confirm it executed the inference — it does <strong>not</strong> prove the signer endorsed this verdict's words, nor that VibeTrace checked the signer against an on-chain registry. Verdict content is relayed by the operator.</p>
        </details>`;
}

/**
 * A single muted publisher-REPORTED chip for one verify leg. The `~` marker keeps the
 * HONESTY framing: this is a CLAIM the publisher recorded at publish, NEVER trustless
 * green. A reported MISMATCH renders wax (an honest publisher admission). The trustless
 * re-run is the live Fetch button (storage) / `npx vibetrace verify` (all legs).
 */
function reportedChip(matches: boolean): string {
  return matches
    ? `<span class="text-ink/50 italic" data-sidecar-reported>~ reported at publish: matched</span>`
    : `<span class="text-wax font-bold">✗ mismatch reported at publish</span>`;
}

/**
 * One deduped verify leg as a CARD: mono-caps label · value(+action) · optional
 * muted reported chip. Each datum (bundle hash, storage root, chain tx, signer)
 * appears exactly once, in its own bordered cell of the proof grid.
 */
function legCard(label: string, value: string, chip = ""): string {
  return `
          <div class="b2 border-ink bg-white hard p-3">
            <div class="font-mono text-[10px] font-bold uppercase tracking-widest text-blue mb-1.5">${label}</div>
            <div class="font-mono text-[11px] flex flex-wrap items-center gap-2">${value}</div>
            ${chip ? `<div class="font-mono text-[10px] mt-1.5">${chip}</div>` : ""}
          </div>`;
}

/** Small inline clock (~12px, currentColor) for the humanized verifiedAt line. */
const CLOCK_SVG = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="inline-block shrink-0 -mt-px" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;

/**
 * Attestation metadata block for the receipts drawer. Renders ONLY for an
 * attested seal; each field appears only when present. Anyone can read the scheme,
 * the TEE signer named by the attestation (linked to its 0GScan address page), the
 * signature + digests (short, full in title), the RA quote/report links, and the
 * exact MANUAL recovery check. The manual-check copy states what recovery proves
 * (signer === signingAddress) and what it does NOT (it is not, by itself, proof of
 * provider acknowledgement — that needs the provider's on-chain registry, which
 * VibeTrace does not check automatically; see the verify-this line below).
 */
function renderAttestationMeta(bundle: PublicLedgerBundle, seal: SealState): string {
  if (seal.kind !== "attested") return "";
  const verifier = bundle.verifierSummary as VerifierRun;
  const att = (verifier.attestation ?? {}) as Record<string, unknown>;
  if (!att || typeof att !== "object") return "";

  const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

  // One key/value cell. `valueHtml` is pre-rendered (caller escapes / wraps it).
  const kv = (label: string, valueHtml: string): string =>
    `<div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
       <span class="font-bold uppercase tracking-widest text-ink/55 text-[10px] shrink-0">${escapeHtml(label)}</span>
       <span class="text-ink/80 break-all">${valueHtml}</span>
     </div>`;

  const plainCell = (v: string) => `<code class="text-ink/75 break-all">${escapeHtml(v)}</code>`;

  // Split into headline (always shown) and deep (behind a raw-fields toggle).
  const head: string[] = [];
  const deep: string[] = [];

  if (att.scheme) head.push(kv("scheme", plainCell(str(att.scheme))));
  if (att.attests) head.push(kv("attests", plainCell(str(att.attests))));
  if (typeof att.processResponseValid === "boolean") {
    head.push(kv("processResponseValid", plainCell(String(att.processResponseValid))));
  }
  if (att.signature) head.push(kv("signature", copyableHash(str(att.signature), "text-ink/75")));
  if (att.signedDigest) head.push(kv("signedDigest", copyableHash(str(att.signedDigest), "text-ink/75")));

  // RA quote / report — link ONLY when browser-openable (http(s)); a 0g:// quote
  // renders as a copyable hash, never a dead ↗.
  const quoteUri = str(att.attestationQuoteUri);
  if (quoteUri) head.push(kv("RA quote", linkOrCopy(browserHref(quoteUri), quoteUri)));
  const raReport = str(att.raDownloadLink);
  if (raReport) head.push(kv("RA report", linkOrCopy(browserHref(raReport), raReport)));

  // Deep / hardware fields — present-only, tucked behind the toggle.
  if (att.providerAddress) deep.push(kv("providerAddress", copyableHash(str(att.providerAddress), "text-ink/75")));
  if (att.responseTextHash) deep.push(kv("responseTextHash", copyableHash(str(att.responseTextHash), "text-ink/75")));
  if (att.quoteHash) deep.push(kv("quoteHash", copyableHash(str(att.quoteHash), "text-ink/75")));
  if (att.teeType) deep.push(kv("teeType", plainCell(str(att.teeType))));
  if (typeof att.composeVerificationPassed === "boolean") {
    deep.push(kv("composeVerificationPassed", plainCell(String(att.composeVerificationPassed))));
  }
  if (typeof att.signerAllMatch === "boolean") {
    deep.push(kv("signerAllMatch", plainCell(String(att.signerAllMatch))));
  }

  // verifiedAt → humanized relative date with an inline clock + short verifiedBy.
  const verifiedAt = str(att.verifiedAt);
  const verifiedBy = str(att.verifiedBy);
  const verifiedLine = verifiedAt
    ? `
          <p class="font-mono text-[11px] text-ink/55 mt-2 flex items-center gap-1">
            ${CLOCK_SVG}<span title="${escapeHtml(verifiedAt)}">verified ${escapeHtml(relativeTimeFromIso(verifiedAt))}${verifiedBy ? ` by ${escapeHtml(shortenHash(verifiedBy))}` : ""}</span>
          </p>`
    : "";

  const grid = (cells: string[]) =>
    `<div class="font-mono text-[11px] grid sm:grid-cols-2 gap-x-4 gap-y-1.5">${cells.join("")}</div>`;

  const rawFields = deep.length
    ? `
          <details class="mt-2" data-attestation-raw>
            <summary class="font-mono text-[10px] font-bold uppercase tracking-widest text-ink/50 cursor-pointer select-none">raw fields ↓</summary>
            <div class="mt-2">${grid(deep)}</div>
          </details>`
    : "";

  return `
        <div class="b2 border-ink bg-white hard p-3">
          <p class="font-mono text-[11px] font-bold uppercase tracking-widest text-blue mb-2">Attestation</p>
          ${grid(head)}${rawFields}${verifiedLine}
        </div>`;
}

function renderReceiptsDrawer(
  bundle: PublicLedgerBundle,
  anchor: AnchorDisplay,
  verification: BundleVerification,
  seal: SealState
): string {
  // The data-expected-hash carries the live-recomputed hash (what a client-side
  // re-hash of the current bundle JSON should produce). Always use computedHash so
  // the attribute stays in sync even when the manifest.publicBundleHash was set
  // before attestation data was grafted on (as in test fixtures).
  const expectedHash = verification.computedHash;
  const shortBundle = escapeHtml(shortenHash(expectedHash));
  const storageUri = String(bundle.storageAnchor.uri ?? "");
  const rootHashFull = String(bundle.storageAnchor.rootHash ?? "");
  const rootHash = escapeHtml(shortenHash(rootHashFull));

  // BROWSER-SAFE gateway URL for the live re-check; NEVER a 0g:// value.
  const gatewayUrl = storageGatewayUrl(storageUri, rootHashFull);

  const fullTx = bundle.chainAnchor?.txHash ?? "";
  const explorerUrl = anchor.kind === "onchain" ? explorerTxUrl(bundle.chainAnchor?.chainId, fullTx) : undefined;
  // Link only a real explorer URL; any other tx value falls back to copyable text.
  const chainValue = fullTx
    ? linkOrCopy(explorerUrl, fullTx)
    : `<code class="text-ink/60 font-bold">—</code>`;

  // Publisher-REPORTED read-back sidecar (NOT under the bundle hash, NOT re-verified
  // by the viewer). Drives the muted "~ matched" / "✗ mismatch" chips on each leg.
  const v0g = (bundle as PublicLedgerBundle & { verifyAgainst0G?: VerifyAgainst0G }).verifyAgainst0G;

  // ── 0G STORAGE card value+action. The root hash appears ONCE here. When a public HTTP
  // gateway exists (real upload), the root is itself an INSPECT link that opens the stored
  // object on the 0G Storage indexer, AND the trustless Fetch & re-hash button re-pulls and
  // re-hashes it. Dev-local roots (0g://local/…) were never uploaded, so there is no public
  // object — render plain text + an honest note, never a dead link.
  const storageValue = gatewayUrl
    ? `<span class="text-ink/50">root <a href="${escapeHtml(gatewayUrl)}" target="_blank" rel="noopener noreferrer" title="Open the stored bundle object on 0G Storage" class="text-blue font-bold underline decoration-dotted underline-offset-2 break-all">${rootHash} ↗</a></span>
            <button type="button" data-fetch-rehash data-bundle-url="${escapeHtml(gatewayUrl)}" data-expected-hash="${escapeHtml(expectedHash)}"
              class="b2 border-ink bg-sun text-ink hard lift px-2.5 py-1 font-bold uppercase tracking-wide">
              Fetch & re-hash
            </button>
            <span data-fetch-rehash-result class="text-ink/50"></span>`
    : `<code class="text-ink/50">root ${rootHash}</code>
            <span class="text-ink/40 italic">local-dev · not on public 0G Storage</span>`;

  // ── 0G SIGNER card value+action. The signer address appears ONCE here (deduped out of
  // renderAttestationMeta), linked to its 0GScan address page when the route is known,
  // else a copyable hash — never a dead link.
  const signer = seal.kind === "attested" ? String(seal.signingAddress ?? "").trim() : "";
  const signerAddrUrl = signer ? explorerAddressUrl(bundle.chainAnchor?.chainId, signer) : undefined;
  const signerValue = signer ? linkOrCopy(signerAddrUrl, signer) : "";

  // The deduped verify legs as a 2-col card grid: each datum appears exactly ONCE in
  // its own cell with its action and reported chip.
  const legCards = [
    legCard(
      "BUNDLE",
      `<code class="text-ink/80 font-bold break-all" data-live-rehash data-copy="${escapeHtml(expectedHash)}" data-expected-hash="${escapeHtml(expectedHash)}" title="${escapeHtml(expectedHash)} — click to copy">${shortBundle}</code>
            <span class="text-ink/50 italic">re-hashes on load</span>`
    ),
    legCard("0G STORAGE", storageValue, v0g ? reportedChip(v0g.storage.matches) : ""),
    legCard("0G CHAIN", chainValue, v0g ? reportedChip(v0g.chain.matches) : ""),
    signer ? legCard("0G SIGNER", signerValue, v0g?.signer ? reportedChip(v0g.signer.matches) : "") : ""
  ].join("");
  const legs = `<div class="grid sm:grid-cols-2 gap-2.5">${legCards}</div>`;

  // Action-first CTA: the trustless live re-run of ALL legs, condensed to one line.
  // The recover check is shown only for an attested seal (a signature must exist).
  const recoverNote =
    seal.kind === "attested"
      ? ` <span class="text-ink/35">·</span> recover check <code class="text-ink/70 font-bold">recoverAddress(signedDigest, signature) === signingAddress</code>`
      : "";
  const verifyCta = `
        <p class="font-mono text-[11px] text-ink/55 leading-relaxed">
          re-verify live <code class="bg-ink text-lime px-1 font-bold">npx vibetrace verify &lt;bundle.json&gt;</code>${recoverNote}
        </p>`;

  const verifier = bundle.verifierSummary as VerifierRun;
  const verdicts = (verifier.verdicts ?? []) as ClaimVerdict[];
  const attested = seal.kind === "attested";
  const examinerBody = verdicts.length
    ? `<ul class="grid sm:grid-cols-2 gap-2.5 mt-2">${verdicts.map((v) => renderExaminerRow(v)).join("")}</ul>`
    : `<p class="font-mono text-[11px] text-ink/50 mt-2">No per-claim verdicts in this run.</p>`;
  // ONE shared signature explainer for the whole examiner section (attested only).
  const examiner = `
        <div>
          <p class="font-mono text-[11px] font-bold uppercase tracking-widest text-blue mb-1">EXAMINER</p>
          ${examinerBody}
          ${attested ? renderSignatureNote() : ""}
        </div>`;

  return `
    <details class="mt-6 b3 border-ink bg-white hard">
      <summary class="font-display text-sm uppercase tracking-wide px-4 py-3 cursor-pointer select-none">Verify it yourself ↓</summary>
      <div class="border-t-2 border-ink p-4 space-y-3">
        ${legs}
        ${verifyCta}

        ${renderAttestationMeta(bundle, seal)}

        ${examiner}
      </div>
    </details>`;
}

/* ── 0G TEE-execution exposure: hero band + examiner strip ──
 *
 * Both render ONLY for an `attested` seal (provider 0g-compute + a passing,
 * tamper-checked TEE-execution attestation). For cracked / structural-only /
 * legacy bundles they return "" — the story page degrades to its prior chrome and
 * never throws. The honest claim everywhere: the build was EXAMINED by the
 * provider's 0G TEE signer named by the attestation (execution attested; the
 * signature recovers to that signer). VibeTrace does NOT check that signer is
 * acknowledged in the provider's on-chain registry — so no copy asserts it. The
 * verdict CONTENT is relayed by the operator (trusted transport) — the enclave
 * does NOT sign the verdict. */

/** Hero band shown ABOVE the seal when the seal is attested. */
function renderTeeBand(seal: SealState): string {
  if (seal.kind !== "attested") return "";
  return `
      <div class="tee-band mb-5" role="note" aria-label="Independently examined by a 0G TEE enclave">
        <span class="tee-mark font-display text-2xl sm:text-3xl leading-none" aria-hidden="true">◆</span>
        <div class="leading-tight min-w-0">
          <div class="font-display text-sm sm:text-base uppercase tracking-tight">◆ Independently examined by a 0G TEE enclave</div>
          <div class="font-mono text-[10px] sm:text-[11px] font-bold uppercase tracking-wide text-ink/65 mt-0.5 break-words">execution attested · examined by the provider's 0G TEE signer · verdict relayed by the operator</div>
        </div>
      </div>`;
}

/**
 * Examiner strip rendered UNDER the seal when attested. The signing
 * address links to its 0GScan ADDRESS page (same explorer base + Galileo gating as
 * the tx link); when that route is unavailable the address renders as plain mono.
 * Line 3 carries the single honest caption (the old "execution signed" caption is
 * replaced and folded in here — not duplicated).
 */
function renderExaminerStrip(bundle: PublicLedgerBundle, seal: SealState): string {
  if (seal.kind !== "attested") return "";
  const signer = String(seal.signingAddress ?? "").trim();
  if (!signer) return "";
  const addrUrl = explorerAddressUrl(bundle.chainAnchor?.chainId, signer);
  const signerView = addrUrl
    ? `<a href="${escapeHtml(addrUrl)}" target="_blank" rel="noopener noreferrer" class="text-blue font-bold underline decoration-dotted underline-offset-2 break-all">${escapeHtml(signer)} <span aria-hidden="true">↗ view signer on 0GScan</span></a>`
    : `<code class="text-ink/70 font-bold break-all">${escapeHtml(signer)}</code>`;
  return `
      <div class="examiner-card mt-5" aria-label="Examined by a 0G TEE enclave">
        <div class="font-display text-sm uppercase tracking-tight"><span class="tee-mark" aria-hidden="true">◆</span> Examined by a 0G TEE enclave</div>
        <div class="font-mono text-[11px] text-ink/70 mt-2 flex flex-wrap items-center gap-1.5">
          <span class="font-bold uppercase tracking-widest text-ink/60">signer</span>
          ${signerView}
        </div>
        <p class="font-mono text-[11px] text-ink/65 mt-2 max-w-md">Execution attested by the provider's 0G TEE signer named by this attestation (the signature recovers to that signer). The verdict content is relayed by the operator (trusted transport) — the enclave does not sign the verdict.</p>
      </div>`;
}

function renderReceiptsCard(
  bundle: PublicLedgerBundle,
  score: VibeScoreResult,
  anchor: AnchorDisplay,
  verification: BundleVerification
): string {
  const seal = sealState(bundle, verification);
  const verifier = bundle.verifierSummary as VerifierRun;

  // Mono stat row facts.
  const toolPairs = new Set<string>();
  for (const n of nodesOfType(bundle, "TraceSpan")) {
    toolPairs.add(String((n.data as Record<string, unknown>).tool ?? "tool"));
  }
  const toolCount = toolPairs.size;
  const fileCount = nodesOfType(bundle, "FileVersion").length;
  const { substantiated, flagged } = substantiatedFlaggedCounts(verifier.verdicts);
  const anchorFact = anchor.kind === "onchain" ? "ANCHORED ON 0G" : anchor.label;

  const statRow = escapeHtml(
    `${toolCount} tool${toolCount !== 1 ? "s" : ""} · ${fileCount} files traced · ${anchorFact} · ${substantiated} SUBSTANTIATED · ${flagged} FLAGGED`
  );

  // Deterministic local checks — state is derived from real data, never fabricated.
  // Row 1: re-hash always runs locally (always has a result).
  // Row 2 & 3: derive from the verifyAgainst0G sidecar on the bundle.
  //
  // HONESTY NOTE: the verifyAgainst0G sidecar is PUBLISHER-REPORTED (mutable public
  // JSON, excluded from the bundle hash). A sidecar matches===true MUST NOT render
  // as the same trustless-green ✓ reserved for live client-side verification.
  // Instead we use a muted "reported at publish" state for those rows. The bold
  // green ✓ is produced ONLY by the live "Fetch & re-hash" handler in main.ts.
  const v0g = (bundle as PublicLedgerBundle & { verifyAgainst0G?: VerifyAgainst0G }).verifyAgainst0G;

  // Whether the drawer below will actually render a live "Fetch & re-hash" button.
  // Dev-local storage roots (0g://local/…) have no public object, so the button is
  // omitted (see storageGatewayUrl) — and the strip rows must NOT then point "below"
  // to a button that isn't there.
  const hasLiveRecheck = Boolean(storageGatewayUrl(bundle.storageAnchor.uri, bundle.storageAnchor.rootHash));

  // Row for row 1 (bundle hash) — genuinely deterministic: this JS process re-hashed it.
  function checkRow(label: string, matches: boolean | undefined): string {
    let icon: string;
    let symbol: string;
    let textCls: string;
    if (matches === true) {
      icon = `<svg viewBox="0 0 24 24" class="w-3.5 h-3.5 shrink-0" fill="none" stroke="#0B0B0F" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>`;
      symbol = `<span aria-hidden="true">✓</span>`;
      textCls = "text-ink/75";
    } else if (matches === false) {
      icon = `<svg viewBox="0 0 24 24" class="w-3.5 h-3.5 shrink-0" fill="none" stroke="#E03131" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
      symbol = `<span aria-hidden="true">✗</span>`;
      textCls = "text-wax font-bold";
    } else {
      // absent — render a neutral dash; never a tick without real evidence.
      icon = `<span class="w-3.5 h-3.5 shrink-0 inline-flex items-center justify-center font-mono text-ink/30" aria-hidden="true">—</span>`;
      symbol = "";
      textCls = "text-ink/40 italic";
    }
    return `
      <li class="flex items-center gap-2 font-mono text-[11px] sm:text-xs ${textCls}">
        ${icon}
        ${escapeHtml(label)} ${symbol}
      </li>`;
  }

  // Row for 0G sidecar rows — publisher-reported, NOT trustless.
  // matches===true  → muted neutral "reported at publish (re-hash matched)"; NO bold ✓.
  // matches===false → wax/✗ "MISMATCH reported at publish".
  // undefined       → neutral absent "not recorded at publish".
  function sidecarRow(baseLabel: string, matches: boolean | undefined): string {
    let icon: string;
    let labelSuffix: string;
    let textCls: string;
    // Only point "below" to the live re-check when that button actually renders.
    const below = hasLiveRecheck ? " — verify it yourself below ↓" : "";
    if (matches === true) {
      // Muted/neutral: reported by publisher, not independently re-checked here.
      icon = `<span class="w-3.5 h-3.5 shrink-0 inline-flex items-center justify-center font-mono text-ink/40" aria-hidden="true" data-sidecar-reported>~</span>`;
      labelSuffix = ` — reported at publish (re-hash matched)${below}`;
      textCls = "text-ink/50 italic";
    } else if (matches === false) {
      icon = `<svg viewBox="0 0 24 24" class="w-3.5 h-3.5 shrink-0" fill="none" stroke="#E03131" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
      labelSuffix = ` ✗ — MISMATCH reported at publish`;
      textCls = "text-wax font-bold";
    } else {
      // absent — neutral, never a tick.
      icon = `<span class="w-3.5 h-3.5 shrink-0 inline-flex items-center justify-center font-mono text-ink/30" aria-hidden="true">—</span>`;
      labelSuffix = ` — not recorded at publish${below}`;
      textCls = "text-ink/40 italic";
    }
    return `
      <li class="flex items-center gap-2 font-mono text-[11px] sm:text-xs ${textCls}">
        ${icon}
        ${escapeHtml(baseLabel + labelSuffix)}
      </li>`;
  }

  // Row 1 is always deterministic (hash re-computed in this JS process).
  const hashRowMatches = verification.valid;
  const checks = [
    checkRow("bundle re-hashed", hashRowMatches),
    sidecarRow(
      "fetched from 0G Storage, re-hashed",
      v0g !== undefined ? v0g.storage.matches : undefined
    ),
    sidecarRow(
      "0G Chain tx calldata",
      v0g !== undefined ? v0g.chain.matches : undefined
    )
  ].join("");

  const caption =
    seal.kind === "attested"
      ? "Examined by an inference running in an attested 0G TEE enclave (execution attested by the provider's 0G TEE signer named by the attestation). Verdict content is relayed by the operator."
      : seal.kind === "cracked"
        ? "An enclave signature was attached but did not verify locally. Treat the verdict as unattested."
        : "These checks ran locally and reproducibly. No independent examiner ran this build.";

  return `
    <section class="relative b4 bg-paperlight hard-xl p-5 sm:p-8 mb-6 overflow-hidden" aria-labelledby="receipts-h">
      <h2 id="receipts-h" class="font-display text-3xl sm:text-4xl lg:text-5xl leading-[0.92] tracking-tight mb-3"
          aria-label="Yes, I vibe-coded this. Receipts attached.">
        Yes, I vibe-coded this.<br/><span class="bg-ink text-lime px-2 inline-block -rotate-1">Receipts attached.</span>
      </h2>
      <p class="font-mono text-[11px] sm:text-xs font-bold uppercase tracking-wide text-ink/70 mb-6 break-words">${statRow}</p>

      ${renderTeeBand(seal)}

      <div class="grid lg:grid-cols-[1fr_auto] gap-7 items-center">
        <div>
          <p class="font-mono text-[10px] font-bold uppercase tracking-widest text-blue mb-2">Deterministic local checks</p>
          <ul class="space-y-1.5 mb-4">${checks}</ul>
          <p class="font-mono text-xs text-ink/60 max-w-md">${escapeHtml(caption)}</p>
        </div>
        <div class="relative grid place-items-center lg:w-60 py-2 lg:py-0">
          ${renderSealFace(seal)}
        </div>
      </div>

      ${renderExaminerStrip(bundle, seal)}

      ${renderReceiptsDrawer(bundle, anchor, verification, seal)}
    </section>`;
}

/* ── 3. How it was built — 4 story beats ── */

function renderStoryBeats(bundle: PublicLedgerBundle, score: VibeScoreResult, anchor: AnchorDisplay): string {
  const spans = nodesOfType(bundle, "TraceSpan");
  const fileNodes = nodesOfType(bundle, "FileVersion");
  const commitNodes = nodesOfType(bundle, "CommitSnapshot");

  // Group models under each tool so a tool chip is never repeated (e.g. claude-code
  // shows once, listing both opus + sonnet — instead of two "claude-code" chips).
  const toolToModels = new Map<string, Set<string>>();
  for (const node of spans) {
    const tool = String(node.data.tool ?? "tool");
    const model = String(node.data.model ?? "model");
    if (!toolToModels.has(tool)) toolToModels.set(tool, new Set());
    toolToModels.get(tool)!.add(model);
  }
  const toolPairs = [...toolToModels.entries()].map(([tool, models]) => {
    const modelChips = [...models]
      .map((m) => `<span class="b2 bg-lime text-ink px-2 py-0.5 hard font-mono text-xs font-bold">${escapeHtml(m)}</span>`)
      .join(" ");
    return `<span class="inline-flex flex-wrap items-center gap-1"><span class="b2 bg-blue text-white px-2 py-0.5 hard font-mono text-xs font-bold">${escapeHtml(tool)}</span>${modelChips}</span>`;
  });
  const toolsHtml = toolPairs.length
    ? `<div class="flex flex-wrap gap-x-3 gap-y-2 mt-2">${toolPairs.join("")}</div>`
    : `<div class="mt-2 font-mono text-xs text-ink/60">No public trace spans</div>`;

  // Representative file sample (up to 3): prefer source files, dedupe by basename
  // so the preview never shows ".gitignore" three times. Falls back to whatever
  // exists when there are no obvious source files.
  const allFilePaths = fileNodes.map((n) => String(n.data.path ?? n.label));
  const interestScore = (p: string): number => {
    const base = (p.split("/").pop() ?? p).toLowerCase();
    let s = 0;
    if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|sol|java|rb|php|css|scss|svelte|vue|html)$/.test(base)) s += 4;
    if (p.includes("src/")) s += 2;
    if (base.startsWith(".")) s -= 4;
    if (/^(package\.json|package-lock|pnpm-lock|tsconfig|readme|license)/.test(base)) s -= 2;
    return s;
  };
  const seenBase = new Set<string>();
  const pickedFiles: string[] = [];
  for (const p of [...allFilePaths].sort((a, b) => interestScore(b) - interestScore(a) || a.localeCompare(b))) {
    const base = (p.split("/").pop() ?? p).toLowerCase();
    if (seenBase.has(base)) continue;
    seenBase.add(base);
    pickedFiles.push(p);
    if (pickedFiles.length >= 3) break;
  }
  const exampleFiles = pickedFiles.map(
    (path) => `<code class="block font-mono text-xs text-blue font-bold mt-1">${escapeHtml(path)}</code>`
  );
  const fileCountStr = fileNodes.length;
  const moreFiles =
    fileNodes.length > pickedFiles.length
      ? `<span class="font-mono text-[11px] text-ink/50 mt-1 block">+ ${fileNodes.length - pickedFiles.length} more hashed</span>`
      : "";

  // Commit
  const commit = escapeHtml(bundle.manifest.repo.commit);
  const shortCommit = escapeHtml(shortenHash(bundle.manifest.repo.commit));
  const branch = escapeHtml(bundle.manifest.repo.branch ?? "—");

  // Anchor / verifier
  const verifierModel = escapeHtml(bundle.verifierSummary.model);
  const anchorStatus = `<span class="b2 ${anchor.storyBadgeClass} px-2 py-0.5 hard font-mono text-xs font-bold">${anchor.storyBadge}</span>`;

  const beats = [
    {
      num: "01",
      title: "Built by AI agents",
      body: `${spans.length} trace span${spans.length !== 1 ? "s" : ""} recorded.`,
      detail: toolsHtml,
      bg: "bg-violet text-white",
      numBg: "bg-lime text-ink"
    },
    {
      num: "02",
      title: `Producing ${fileCountStr} files`,
      body: "Each one hashed straight into the ledger.",
      detail: `${exampleFiles.join("")}${moreFiles}`,
      bg: "bg-white text-ink",
      numBg: "bg-coral text-white"
    },
    {
      num: "03",
      title: "Snapshotted &amp; hashed",
      body: `Commit <code class="font-mono text-xs font-bold">${shortCommit}</code> on <code class="font-mono text-xs font-bold">${branch}</code>. ${commitNodes.length} commit snapshot${commitNodes.length !== 1 ? "s" : ""}.`,
      detail: "",
      bg: "bg-sun text-ink",
      numBg: "bg-ink text-lime"
    },
    {
      num: "04",
      title: anchor.storyTitle,
      body: `Verifier: <code class="font-mono text-xs font-bold">${verifierModel}</code>.`,
      detail: `<div class="mt-2">${anchorStatus}</div>`,
      bg: "bg-ink text-paper",
      numBg: "bg-lime text-ink"
    }
  ];

  const cards = beats
    .map(
      (b) => `
    <article class="b4 ${b.bg} hard-lg p-4 sm:p-5 flex gap-4">
      <div class="shrink-0 b3 ${b.numBg} w-10 h-10 grid place-items-center hard font-display text-lg leading-none">${b.num}</div>
      <div class="min-w-0">
        <h3 class="font-display text-lg sm:text-xl leading-snug tracking-tight mb-1">${b.title}</h3>
        <p class="font-mono text-xs sm:text-sm leading-relaxed opacity-80">${b.body}</p>
        ${b.detail}
      </div>
    </article>`
    )
    .join("");

  return `
    <section aria-labelledby="story-h" class="mb-6">
      <h2 id="story-h" class="font-display text-2xl sm:text-3xl tracking-tight mb-4">How it was built</h2>
      <div class="grid sm:grid-cols-2 gap-4">${cards}</div>
    </section>`;
}

/* ── 3b. VibeScore — demoted below the fold ──
 * The score still lives on the page for the curious, but it NEVER leads the share
 * object (spec locked decision #1/#7). Quiet, single-line, after the build story. */

function renderScoreBelowFold(score: VibeScoreResult): string {
  const buildBg = TIER_BG[score.buildTier] ?? "bg-lime text-ink";
  const proof = score.proof;
  const proofCls =
    proof.rank >= 5
      ? "bg-lime text-ink"
      : proof.rank >= 3
        ? "bg-sun text-ink"
        : proof.rank >= 1
          ? "bg-paper text-ink"
          : "bg-coral text-white";
  return `
    <section aria-labelledby="vibescore-h" class="b4 bg-white hard-lg p-4 sm:p-5 mb-6">
      <div class="grid sm:grid-cols-2 gap-5 sm:gap-6">
        <div>
          <p id="vibescore-h" class="font-mono text-[10px] font-bold uppercase tracking-widest text-blue mb-1">Build Score</p>
          <div class="flex items-end gap-3">
            <div class="font-display text-4xl sm:text-5xl leading-none tag">${escapeHtml(String(score.buildScore))}<span class="text-xl text-ink/40">/100</span></div>
            <div class="b3 ${buildBg} hard grid place-items-center w-12 h-12 -rotate-3 shrink-0">
              <span class="font-display text-2xl leading-none">${escapeHtml(score.buildTier)}</span>
            </div>
          </div>
          <p class="font-mono text-xs text-ink/60 mt-2 max-w-xs">
            <span class="bg-ink text-lime px-1.5">${escapeHtml(score.buildTierLabel)}</span> — how much of this build is AI-traced. Intrinsic to the repo; it does NOT change based on who notarized it.
          </p>
        </div>
        <div class="sm:border-l-2 sm:border-ink/10 sm:pl-6">
          <p class="font-mono text-[10px] font-bold uppercase tracking-widest text-violet mb-1">Proof</p>
          <span class="inline-flex items-center b2 border-ink ${proofCls} px-2.5 py-1 hard font-mono text-xs font-bold uppercase tracking-wide">${escapeHtml(proof.label)}</span>
          <p class="font-mono text-xs text-ink/60 mt-2 max-w-xs">
            How independently provable it is — the verdict seal above is the receipt. Trust-weighted roll-up: ${escapeHtml(String(score.trustWeightedScore))}/100.
          </p>
        </div>
      </div>
    </section>`;
}

/* ── 4. Verify it yourself — compact proof strip ── */

function renderProofStrip(bundle: PublicLedgerBundle, verification: BundleVerification, anchor: AnchorDisplay): string {
  const hash = bundle.manifest.publicBundleHash === "pending" ? verification.computedHash : bundle.manifest.publicBundleHash;
  const shortHash = escapeHtml(shortenHash(hash));
  const fullTx = bundle.chainAnchor?.txHash ?? "";
  const txHash = escapeHtml(shortenHash(fullTx || "—"));
  const txLabel = anchor.kind === "dev" ? "0G dev tx" : anchor.kind === "onchain" ? "0G tx" : "chain tx";
  // Only a real on-chain anchor gets a clickable 0GScan link; dev/pending hashes
  // stay plain text (no public tx to link to).
  const explorerUrl = anchor.kind === "onchain" ? explorerTxUrl(bundle.chainAnchor?.chainId, fullTx) : undefined;
  const txValue = explorerUrl
    ? `<a href="${escapeHtml(explorerUrl)}" target="_blank" rel="noopener noreferrer" class="text-lime font-bold underline decoration-dotted underline-offset-2 hover:text-paper break-all">${txHash} ↗</a>`
    : `<code class="text-paper/80 font-bold">${txHash}</code>`;

  const matchBadge =
    anchor.kind === "onchain"
      ? `<span class="b2 ${anchor.badgeClass} px-2 py-0.5 hard font-mono text-[11px] font-bold uppercase tracking-wide">${anchor.label}</span>
      <span class="b2 bg-lime text-ink px-2 py-0.5 hard font-mono text-[11px] font-bold uppercase tracking-wide flex items-center gap-1.5">
        <svg viewBox="0 0 24 24" class="w-3 h-3" fill="none" stroke="#0B0B0F" stroke-width="4"><path d="M20 6L9 17l-5-5"/></svg>
        matches on-chain anchor
      </span>`
      : `<span class="b2 ${anchor.badgeClass} px-2 py-0.5 hard font-mono text-[11px] font-bold uppercase tracking-wide">
        ${anchor.label}
      </span>`;

  return `
    <section id="proof-strip" aria-labelledby="proof-strip-h" class="b4 bg-ink text-paper hard-xl p-4 sm:p-5 mb-6 relative overflow-hidden">
      <div class="absolute inset-0 opacity-[0.25] pointer-events-none" style="background-image: radial-gradient(circle at 85% 25%, #1D4ED8 0%, transparent 42%), radial-gradient(circle at 8% 90%, #6D28D9 0%, transparent 44%);" aria-hidden="true"></div>
      <div class="relative">
        <div class="flex items-center gap-2 mb-3">
          <span class="b2 border-ink bg-lime text-ink px-2 py-0.5 hard font-mono text-[10px] font-bold uppercase tracking-widest">Proof Moment</span>
          <h2 id="proof-strip-h" class="font-display text-lg sm:text-xl tracking-tight">Bundle Fingerprint</h2>
        </div>
        <div class="flex flex-wrap items-center gap-3 sm:gap-4">
          <code class="font-mono text-sm sm:text-base font-bold text-lime break-all">${shortHash}</code>
          ${matchBadge}
          <div class="flex items-center gap-1.5 font-mono text-[11px] text-paper/60">
            <span class="font-bold text-paper/40 uppercase tracking-widest">${txLabel}</span>
            ${txValue}
          </div>
        </div>
      </div>
    </section>`;
}

/* ── 5. Embed your badge ── */

/** The current live origin (browser at render time; safe SSR fallback). */
function currentOrigin(): string {
  if (typeof location !== "undefined" && location.origin && location.origin !== "null") {
    return location.origin;
  }
  return "";
}

/**
 * "EMBED YOUR BADGE" section for a registry-backed story (has an id):
 * a live <img> preview of /api/badge/<id>.svg plus a copyable markdown snippet
 * and a Copy button ([data-copy-badge]). For external ?bundle=<url> stories with
 * no id, a small "Submit your build to get a badge →" prompt instead.
 */
function renderEmbedBadge(score: VibeScoreResult, id?: string): string {
  const tier = escapeHtml(score.tier);

  if (!id) {
    return `
    <section aria-labelledby="embed-h" class="mb-6">
      <div class="b4 bg-white hard-lg p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
        <div class="min-w-0">
          <h2 id="embed-h" class="font-display text-lg sm:text-xl tracking-tight mb-1">Want an embeddable badge?</h2>
          <p class="font-mono text-xs text-ink/60">This story came from an external bundle URL. Put your build on the leaderboard and you get a live VibeScore badge.</p>
        </div>
        <a href="#/leaderboard" class="b3 bg-coral text-white hard lift inline-flex items-center gap-2 px-4 py-2.5 font-display text-sm uppercase tracking-tight shrink-0 whitespace-nowrap">
          Submit your build to get a badge
          <svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        </a>
      </div>
    </section>`;
  }

  const origin = currentOrigin();
  const safeId = escapeHtml(id);
  // Relative src so the preview works regardless of host; markdown uses the
  // absolute origin so it's portable into any README.
  const previewSrc = `/api/badge/${encodeURIComponent(id)}.svg`;
  const badgeUrl = `${origin}/api/badge/${encodeURIComponent(id)}.svg`;
  const storyUrl = `${origin}/#/p/${encodeURIComponent(id)}`;
  const snippet = `[![VibeScore ${score.tier}](${badgeUrl})](${storyUrl})`;
  const snippetEsc = escapeHtml(snippet);

  return `
    <section aria-labelledby="embed-h" class="mb-6">
      <div class="b4 bg-violet text-white hard-xl p-4 sm:p-6 relative overflow-hidden">
        <div class="absolute -top-6 -right-6 w-24 h-24 bg-lime b3 rotate-12 hidden sm:block" aria-hidden="true"></div>
        <div class="relative">
          <div class="inline-block b3 bg-lime text-ink px-3 py-1.5 hard font-mono text-[11px] font-bold uppercase tracking-widest mb-4 -rotate-1">Embed your badge</div>
          <h2 id="embed-h" class="font-display text-2xl sm:text-3xl tracking-tight mb-4">Put your VibeScore wherever you want.</h2>

          <div class="flex flex-wrap items-center gap-3 mb-4">
            <span class="font-mono text-[11px] font-bold uppercase tracking-widest text-white/60">Live preview</span>
            <span class="b3 bg-white hard inline-flex p-1.5">
              <img src="${previewSrc}" alt="VibeScore ${tier} badge for this build" width="auto" height="30" decoding="async" />
            </span>
          </div>

          <p class="font-mono text-[11px] font-bold uppercase tracking-widest text-white/60 mb-2">Copy the markdown</p>
          <div class="flex flex-col sm:flex-row gap-3 sm:items-stretch">
            <pre class="b3 bg-ink text-lime hard p-3 font-mono text-[11px] sm:text-xs font-bold overflow-x-auto grow min-w-0"><code data-copy-badge-src>${snippetEsc}</code></pre>
            <button type="button" data-copy-badge data-copy-text="${snippetEsc}"
              class="b3 bg-sun text-ink hard lift inline-flex items-center justify-center gap-2 px-4 py-2.5 font-display text-sm uppercase tracking-tight shrink-0 whitespace-nowrap">
              <svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="#0B0B0F" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              <span data-copy-label>Copy</span>
            </button>
          </div>
          <p class="font-mono text-[11px] text-white/50 mt-3">Paste it in your README. When your VibeScore changes, the badge follows.</p>
        </div>
      </div>
    </section>`;
}

/* ── Main export ── */

export function renderBundle(
  bundle: PublicLedgerBundle,
  score: VibeScoreResult,
  registry: RegistrySummary[] = [],
  id?: string
): string {
  const verification = verifyBundleHash(bundle);
  const anchor = describeAnchor(bundle, verification);

  const backLink = `
      <a href="#/" class="inline-flex items-center gap-1.5 b3 bg-paper hard lift px-3 py-1.5 font-mono text-[11px] sm:text-xs font-bold uppercase tracking-wide mb-5">
        <svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="#0B0B0F" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M11 18l-6-6 6-6"/></svg>
        Leaderboard
      </a>`;

  return `
    ${renderMarquee(registry)}
    <main class="grow w-full max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-10">
      ${backLink}
      ${renderHook(bundle, anchor)}
      ${renderReceiptsCard(bundle, score, anchor, verification)}
      ${renderStoryBeats(bundle, score, anchor)}
      ${renderScoreBelowFold(score)}
      ${renderProofStrip(bundle, verification, anchor)}
      ${renderEmbedBadge(score, id)}
    </main>
    ${renderFooter()}`;
}
