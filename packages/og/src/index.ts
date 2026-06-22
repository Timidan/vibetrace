import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalHash, canonicalStringify, ChainAnchor, StorageAnchor } from "@vibetrace/schema";

/** Allowlisted 0G EVM chain ids (Galileo testnet). A real anchor must land on one. */
const OG_CHAIN_IDS = new Set<number>([16601, 16602]);

export type OgClock = () => string;

export type OgStorageAdapter = {
  uploadJson(value: unknown): Promise<StorageAnchor>;
  downloadJson(rootHash: string): Promise<unknown>;
};

export type OgChainAdapter = {
  anchorManifest(manifestHash: string): Promise<ChainAnchor>;
  /** Read the calldata manifest hash for `txHash`. `expectedChainId` (the bundle's
   *  recorded 0G chain) lets the real adapter reject a wrong/malicious RPC on the
   *  READ path, mirroring anchorManifest's write-path chain-id guard. */
  readManifest(txHash: string, expectedChainId?: number): Promise<string>;
};

export type OgAdapters = {
  storage: OgStorageAdapter;
  chain: OgChainAdapter;
};

export type DevOgAdapterOptions = {
  workspace: string;
  now?: OgClock;
};

export function createDevOgAdapters(options: DevOgAdapterOptions): OgAdapters {
  const now = options.now ?? (() => new Date().toISOString());
  const storageDir = join(options.workspace, "storage");
  const chainDir = join(options.workspace, "chain");

  return {
    storage: {
      async uploadJson(value: unknown): Promise<StorageAnchor> {
        await mkdir(storageDir, { recursive: true });
        const rootHash = canonicalHash(value);
        await writeFile(join(storageDir, `${rootHash}.json`), `${canonicalStringify(value)}\n`, "utf8");
        return {
          kind: "storage",
          provider: "0g-dev",
          uri: `0g://local/${rootHash}`,
          rootHash,
          createdAt: now()
        };
      }
      ,
      async downloadJson(rootHash: string): Promise<unknown> {
        const filePath = join(storageDir, `${rootHash}.json`);
        let raw: string;
        try {
          raw = await readFile(filePath, "utf8");
        } catch {
          throw new Error(`0G dev storage has no object for rootHash ${rootHash} at ${filePath}`);
        }
        return JSON.parse(raw);
      }
    },
    chain: {
      async anchorManifest(manifestHash: string): Promise<ChainAnchor> {
        const createdAt = now();
        const txHash = canonicalHash({ manifestHash, provider: "0g-dev", createdAt });
        await mkdir(chainDir, { recursive: true });
        await writeFile(
          join(chainDir, `${txHash}.json`),
          `${canonicalStringify({ manifestHash })}\n`,
          "utf8"
        );
        return {
          kind: "chain",
          provider: "0g-dev",
          txHash,
          chainId: 16602,
          manifestHash,
          createdAt
        };
      },
      async readManifest(txHash: string): Promise<string> {
        const filePath = join(chainDir, `${txHash}.json`);
        let raw: string;
        try {
          raw = await readFile(filePath, "utf8");
        } catch {
          throw new Error(`0G dev chain has no calldata for txHash ${txHash} at ${filePath}`);
        }
        const parsed = JSON.parse(raw) as { manifestHash?: unknown };
        if (typeof parsed.manifestHash !== "string") {
          throw new Error(`0G dev chain calldata for txHash ${txHash} is malformed`);
        }
        return parsed.manifestHash;
      }
    }
  };
}

export function createOgAdaptersFromEnv(options: DevOgAdapterOptions & { env?: NodeJS.ProcessEnv }): OgAdapters {
  const env = options.env ?? process.env;
  const mode = env.VIBETRACE_OG_MODE;

  // Fully real: broadcast a real chain tx AND upload the bundle to 0G Storage.
  if (mode === "real") {
    return {
      storage: new RealOgStorageAdapter(env, options.now),
      chain: new RealOgChainAdapter(env, options.now)
    };
  }

  // Real CHAIN anchor only (the on-chain tx + explorer link) with local dev
  // storage. Minimal dependency surface: needs only a funded key + ethers, not
  // the 0G Storage SDK/indexer. The lightest honest path to a verifiable
  // on-chain anchor — dev storage still yields a rootHash for the score.
  if (mode === "real-chain") {
    return {
      storage: createDevOgAdapters(options).storage,
      chain: new RealOgChainAdapter(env, options.now)
    };
  }

  return createDevOgAdapters(options);
}

class RealOgStorageAdapter implements OgStorageAdapter {
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly now: OgClock = () => new Date().toISOString()
  ) {}

  async downloadJson(rootHash: string): Promise<unknown> {
    const indexerRpc = this.env.VIBETRACE_0G_STORAGE_INDEXER ?? "https://indexer-storage-testnet-turbo.0g.ai";
    const { Indexer } = (await import("@0gfoundation/0g-storage-ts-sdk")) as any;
    const indexer = new Indexer(indexerRpc);
    // A freshly-uploaded object propagates to the storage nodes asynchronously — an immediate read-back
    // (the publish-time verify, or a consumer's `vibetrace verify` right after) can transiently see "no
    // locations found" before the indexer registers them. Retry with a bounded backoff so the read-back
    // reflects the SETTLED object, not a propagation race. Configurable for tests via env.
    const attempts = Math.max(1, Number(this.env.VIBETRACE_0G_STORAGE_READBACK_ATTEMPTS ?? "8"));
    const delayMs = Math.max(0, Number(this.env.VIBETRACE_0G_STORAGE_READBACK_DELAY_MS ?? "5000"));
    let lastErr: unknown = null;
    for (let i = 0; i < attempts; i++) {
      const [blob, downloadErr] = await indexer.downloadToBlob(rootHash);
      if (downloadErr === null) {
        return JSON.parse(await blob.text());
      }
      lastErr = downloadErr;
      if (i < attempts - 1 && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw new Error(`0G Storage download error for ${rootHash}: ${lastErr}`);
  }

  async uploadJson(value: unknown): Promise<StorageAnchor> {
    const privateKey = requirePublishKey(this.env);
    const rpcUrl = this.env.VIBETRACE_0G_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
    const indexerRpc = this.env.VIBETRACE_0G_STORAGE_INDEXER ?? "https://indexer-storage-testnet-turbo.0g.ai";
    const [{ Indexer, MemData }, { ethers }] = await Promise.all([
      import("@0gfoundation/0g-storage-ts-sdk") as Promise<any>,
      import("ethers") as Promise<any>
    ]);

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(privateKey, provider);
    const indexer = new Indexer(indexerRpc);
    const data = new TextEncoder().encode(canonicalStringify(value));
    const memData = new MemData(data);
    const finalityRequired = parseBooleanEnv(this.env.VIBETRACE_0G_STORAGE_FINALITY, false);
    const [tree, treeErr] = await memData.merkleTree();
    if (treeErr !== null) {
      throw new Error(`0G Storage merkle tree error: ${treeErr}`);
    }

    const [tx, uploadErr] = await indexer.upload(memData, rpcUrl, signer, { finalityRequired });
    if (uploadErr !== null) {
      throw new Error(`0G Storage upload error: ${uploadErr}`);
    }

    return {
      kind: "storage",
      provider: "0g-storage",
      uri: `0g://${tx.rootHash ?? tree?.rootHash?.()}`,
      rootHash: tx.rootHash ?? tree?.rootHash?.() ?? canonicalHash(value),
      createdAt: this.now()
    };
  }
}

class RealOgChainAdapter implements OgChainAdapter {
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly now: OgClock = () => new Date().toISOString()
  ) {}

  async anchorManifest(manifestHash: string): Promise<ChainAnchor> {
    const privateKey = requirePublishKey(this.env);
    const rpcUrl = this.env.VIBETRACE_0G_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
    const chainId = Number(this.env.VIBETRACE_0G_CHAIN_ID ?? "16602");
    const { ethers } = await import("ethers");
    const provider = new ethers.JsonRpcProvider(rpcUrl);

    // Verify the RPC really IS the recorded 0G chain before anchoring, so a
    // misconfigured/malicious RPC can't make a non-0G tx masquerade as a 0G
    // anchor in the published bundle (security review #8).
    const network = await provider.getNetwork();
    const actualChainId = Number(network.chainId);
    if (actualChainId !== chainId) {
      throw new Error(`RPC chain id ${actualChainId} does not match expected 0G chain id ${chainId}`);
    }
    if (!OG_CHAIN_IDS.has(actualChainId)) {
      throw new Error(`Chain id ${actualChainId} is not an allowlisted 0G network`);
    }

    const wallet = new ethers.Wallet(privateKey, provider);
    const tx = await wallet.sendTransaction({
      to: wallet.address,
      value: 0n,
      data: manifestHash
    });
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`0G anchor tx ${tx.hash} did not succeed (status ${receipt?.status ?? "unknown"})`);
    }
    return {
      kind: "chain",
      provider: "0g-chain",
      txHash: tx.hash,
      chainId,
      manifestHash,
      createdAt: this.now()
    };
  }

  async readManifest(txHash: string, expectedChainId?: number): Promise<string> {
    const rpcUrl = this.env.VIBETRACE_0G_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
    const { ethers } = await import("ethers");
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    // SECURITY (read path, mirroring anchorManifest): verify the RPC really IS an
    // allowlisted 0G network — and the bundle's recorded chain — BEFORE trusting its
    // calldata, so a wrong/malicious RPC that just echoes the expected manifest hash
    // cannot spoof "verified against live 0G" (security review #8, read leg).
    const network = await provider.getNetwork();
    const actualChainId = Number(network.chainId);
    if (!OG_CHAIN_IDS.has(actualChainId)) {
      throw new Error(`RPC chain id ${actualChainId} is not an allowlisted 0G network`);
    }
    if (expectedChainId != null && actualChainId !== expectedChainId) {
      throw new Error(`RPC chain id ${actualChainId} does not match the bundle's recorded 0G chain id ${expectedChainId}`);
    }
    const tx = await provider.getTransaction(txHash);
    if (!tx) {
      throw new Error(`0G chain tx ${txHash} not found on ${rpcUrl}`);
    }
    // anchorManifest sets `data: manifestHash` (see anchorManifest above), so
    // the calldata IS the bundle manifest hash.
    return tx.data;
  }
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`${key} is required when VIBETRACE_OG_MODE=real`);
  }
  return value;
}

// Resolve the funded signing key for real anchoring/storage. Prefer the
// dedicated SERVER-SIDE publish key (so a hosted relayer funds with its own
// key), falling back to the legacy client var.
function requirePublishKey(env: NodeJS.ProcessEnv): string {
  const publishKey = env.VIBETRACE_0G_PUBLISH_PRIVATE_KEY;
  if (typeof publishKey === "string" && publishKey !== "") {
    return publishKey;
  }
  const legacyKey = env.VIBETRACE_0G_PRIVATE_KEY;
  if (legacyKey) {
    return legacyKey;
  }
  throw new Error(
    "VIBETRACE_0G_PUBLISH_PRIVATE_KEY or VIBETRACE_0G_PRIVATE_KEY is required when VIBETRACE_OG_MODE=real"
  );
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}
