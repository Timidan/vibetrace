import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalStringify } from "@vibetrace/schema";

// Shared, hoisted mock state so the (hoisted) vi.mock factories can reach per-test implementations.
const h = vi.hoisted(() => ({
  uploadMock: vi.fn(),
  merkleTreeMock: vi.fn(),
  downloadToBlobMock: vi.fn(),
  getNetworkMock: vi.fn(),
  sendTransactionMock: vi.fn(),
  getTransactionMock: vi.fn(),
  lastMemData: null as Uint8Array | null,
  uploadArgs: null as any[] | null
}));

vi.mock("@0gfoundation/0g-storage-ts-sdk", () => {
  class Indexer {
    constructor(public rpc: string) {}
    upload = (...args: any[]) => {
      h.uploadArgs = args;
      return h.uploadMock(...args);
    };
    downloadToBlob = (...args: any[]) => h.downloadToBlobMock(...args);
  }
  class MemData {
    constructor(public data: Uint8Array) {
      h.lastMemData = data;
    }
    merkleTree = (...args: any[]) => h.merkleTreeMock(...args);
  }
  return { Indexer, MemData };
});

vi.mock("ethers", () => {
  class JsonRpcProvider {
    constructor(public url: string) {}
    getNetwork = (...args: any[]) => h.getNetworkMock(...args);
    getTransaction = (...args: any[]) => h.getTransactionMock(...args);
  }
  class Wallet {
    address = "0xWALLETADDRESS";
    constructor(public key: string, public provider?: any) {}
    sendTransaction = (...args: any[]) => h.sendTransactionMock(...args);
  }
  return { ethers: { JsonRpcProvider, Wallet }, JsonRpcProvider, Wallet };
});

// Imported AFTER the mocks are registered (vi.mock is hoisted above this).
const { createOgAdaptersFromEnv } = await import("./index");

const REAL_ENV = {
  VIBETRACE_OG_MODE: "real",
  VIBETRACE_0G_PRIVATE_KEY: "0x" + "1".repeat(64),
  VIBETRACE_0G_RPC_URL: "https://rpc.example",
  VIBETRACE_0G_STORAGE_INDEXER: "https://indexer.example",
  // Keep read-back retries instant in tests (real default is 8 attempts × 5s for propagation).
  VIBETRACE_0G_STORAGE_READBACK_ATTEMPTS: "1",
  VIBETRACE_0G_STORAGE_READBACK_DELAY_MS: "0"
} as NodeJS.ProcessEnv;

function realAdapters(env: NodeJS.ProcessEnv = REAL_ENV) {
  return createOgAdaptersFromEnv({ workspace: "/tmp/og-real-test", env });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.lastMemData = null;
  h.uploadArgs = null;
});

describe("RealOgStorageAdapter.uploadJson", () => {
  it("uploads canonical bytes and returns the 0G-storage anchor from the SDK rootHash", async () => {
    h.merkleTreeMock.mockResolvedValue([{ rootHash: () => "0xROOT" }, null]);
    h.uploadMock.mockResolvedValue([{ rootHash: "0xROOT" }, null]);

    const value = { z: 1, a: 2 };
    const anchor = await realAdapters().storage.uploadJson(value);

    expect(anchor).toMatchObject({ kind: "storage", provider: "0g-storage", rootHash: "0xROOT", uri: "0g://0xROOT" });
    // The bytes handed to the SDK are the CANONICAL serialization (sorted keys), not the literal object.
    expect(new TextDecoder().decode(h.lastMemData!)).toBe(canonicalStringify(value));
    // upload is called with (memData, rpcUrl, signer, { finalityRequired }).
    expect(h.uploadArgs?.[1]).toBe("https://rpc.example");
    expect(h.uploadArgs?.[3]).toMatchObject({ finalityRequired: false });
  });

  it("throws when the SDK upload returns an error tuple", async () => {
    h.merkleTreeMock.mockResolvedValue([{ rootHash: () => "0xROOT" }, null]);
    h.uploadMock.mockResolvedValue([null, "node rejected"]);
    await expect(realAdapters().storage.uploadJson({ a: 1 })).rejects.toThrow(/0G Storage upload error: node rejected/);
  });

  it("throws when the merkle tree build returns an error tuple", async () => {
    h.merkleTreeMock.mockResolvedValue([null, "bad tree"]);
    await expect(realAdapters().storage.uploadJson({ a: 1 })).rejects.toThrow(/0G Storage merkle tree error: bad tree/);
  });

  it("throws when VIBETRACE_0G_PRIVATE_KEY is missing", async () => {
    const env = { ...REAL_ENV, VIBETRACE_0G_PRIVATE_KEY: "" } as NodeJS.ProcessEnv;
    await expect(realAdapters(env).storage.uploadJson({ a: 1 })).rejects.toThrow(/VIBETRACE_0G_PRIVATE_KEY is required/);
  });

  it("uses VIBETRACE_0G_PUBLISH_PRIVATE_KEY when set (server-side relayer key)", async () => {
    h.merkleTreeMock.mockResolvedValue([{ rootHash: () => "0xROOT" }, null]);
    h.uploadMock.mockResolvedValue([{ rootHash: "0xROOT" }, null]);
    // Only the publish var is set — the legacy client var is absent.
    const env = {
      ...REAL_ENV,
      VIBETRACE_0G_PRIVATE_KEY: "",
      VIBETRACE_0G_PUBLISH_PRIVATE_KEY: "0x" + "2".repeat(64)
    } as NodeJS.ProcessEnv;
    const anchor = await realAdapters(env).storage.uploadJson({ a: 1 });
    expect(anchor.provider).toBe("0g-storage");
  });

  it("falls back to VIBETRACE_0G_PRIVATE_KEY when the publish var is absent", async () => {
    h.merkleTreeMock.mockResolvedValue([{ rootHash: () => "0xROOT" }, null]);
    h.uploadMock.mockResolvedValue([{ rootHash: "0xROOT" }, null]);
    // No publish var; the legacy var (present in REAL_ENV) carries the signing key.
    const anchor = await realAdapters().storage.uploadJson({ a: 1 });
    expect(anchor.provider).toBe("0g-storage");
  });

  it("throws naming BOTH vars when neither publish nor legacy key is set", async () => {
    const env = {
      ...REAL_ENV,
      VIBETRACE_0G_PRIVATE_KEY: "",
      VIBETRACE_0G_PUBLISH_PRIVATE_KEY: ""
    } as NodeJS.ProcessEnv;
    await expect(realAdapters(env).storage.uploadJson({ a: 1 })).rejects.toThrow(
      /VIBETRACE_0G_PUBLISH_PRIVATE_KEY or VIBETRACE_0G_PRIVATE_KEY is required/
    );
  });
});

describe("RealOgStorageAdapter.downloadJson", () => {
  it("downloads a blob by rootHash and parses it", async () => {
    h.downloadToBlobMock.mockResolvedValue([{ text: async () => '{"a":1}' }, null]);
    const got = await realAdapters().storage.downloadJson("0xROOT");
    expect(got).toEqual({ a: 1 });
  });

  it("throws when the indexer returns a download error (after exhausting retries)", async () => {
    h.downloadToBlobMock.mockResolvedValue([null, "file not found"]);
    await expect(realAdapters().storage.downloadJson("0xMISSING")).rejects.toThrow(/0G Storage download error for 0xMISSING: file not found/);
  });

  it("RETRIES a transient 'no locations' read-back, then succeeds once the object propagates", async () => {
    h.downloadToBlobMock
      .mockResolvedValueOnce([null, "no locations found"]) // freshly uploaded, not yet synced
      .mockResolvedValueOnce([null, "no locations found"])
      .mockResolvedValueOnce([{ text: async () => '{"propagated":true}' }, null]);
    const env = { ...REAL_ENV, VIBETRACE_0G_STORAGE_READBACK_ATTEMPTS: "5", VIBETRACE_0G_STORAGE_READBACK_DELAY_MS: "0" } as NodeJS.ProcessEnv;
    const got = await realAdapters(env).storage.downloadJson("0xFRESH");
    expect(got).toEqual({ propagated: true });
    expect(h.downloadToBlobMock).toHaveBeenCalledTimes(3);
  });
});

describe("RealOgChainAdapter.anchorManifest", () => {
  const MANIFEST = "0x" + "a".repeat(64);

  it("anchors calldata == manifest hash on a verified 0G chain and returns the tx", async () => {
    h.getNetworkMock.mockResolvedValue({ chainId: 16602n });
    h.sendTransactionMock.mockResolvedValue({ hash: "0xTX", wait: async () => ({ status: 1 }) });
    const anchor = await realAdapters().chain.anchorManifest(MANIFEST);
    expect(anchor).toMatchObject({ kind: "chain", provider: "0g-chain", txHash: "0xTX", chainId: 16602, manifestHash: MANIFEST });
    // The tx data IS the manifest hash (the calldata == bundle hash invariant).
    expect(h.sendTransactionMock.mock.calls[0][0]).toMatchObject({ data: MANIFEST, value: 0n });
  });

  it("rejects when the RPC chain id does not match the expected 0G chain id", async () => {
    h.getNetworkMock.mockResolvedValue({ chainId: 999n });
    await expect(realAdapters().chain.anchorManifest(MANIFEST)).rejects.toThrow(/does not match expected 0G chain id/);
  });

  it("rejects when the anchor tx does not succeed (status != 1)", async () => {
    h.getNetworkMock.mockResolvedValue({ chainId: 16602n });
    h.sendTransactionMock.mockResolvedValue({ hash: "0xTX", wait: async () => ({ status: 0 }) });
    await expect(realAdapters().chain.anchorManifest(MANIFEST)).rejects.toThrow(/did not succeed/);
  });

  it("uses VIBETRACE_0G_PUBLISH_PRIVATE_KEY when set (server-side relayer key)", async () => {
    h.getNetworkMock.mockResolvedValue({ chainId: 16602n });
    h.sendTransactionMock.mockResolvedValue({ hash: "0xTX", wait: async () => ({ status: 1 }) });
    // Only the publish var is set — the legacy client var is absent.
    const env = {
      ...REAL_ENV,
      VIBETRACE_0G_PRIVATE_KEY: "",
      VIBETRACE_0G_PUBLISH_PRIVATE_KEY: "0x" + "2".repeat(64)
    } as NodeJS.ProcessEnv;
    const anchor = await realAdapters(env).chain.anchorManifest(MANIFEST);
    expect(anchor).toMatchObject({ provider: "0g-chain", txHash: "0xTX" });
  });

  it("falls back to VIBETRACE_0G_PRIVATE_KEY when the publish var is absent", async () => {
    h.getNetworkMock.mockResolvedValue({ chainId: 16602n });
    h.sendTransactionMock.mockResolvedValue({ hash: "0xTX", wait: async () => ({ status: 1 }) });
    // No publish var; the legacy var (present in REAL_ENV) carries the signing key.
    const anchor = await realAdapters().chain.anchorManifest(MANIFEST);
    expect(anchor).toMatchObject({ provider: "0g-chain", txHash: "0xTX" });
  });

  it("throws naming BOTH vars when neither publish nor legacy key is set", async () => {
    const env = {
      ...REAL_ENV,
      VIBETRACE_0G_PRIVATE_KEY: "",
      VIBETRACE_0G_PUBLISH_PRIVATE_KEY: ""
    } as NodeJS.ProcessEnv;
    await expect(realAdapters(env).chain.anchorManifest(MANIFEST)).rejects.toThrow(
      /VIBETRACE_0G_PUBLISH_PRIVATE_KEY or VIBETRACE_0G_PRIVATE_KEY is required/
    );
  });
});

describe("RealOgChainAdapter.readManifest", () => {
  it("returns the tx calldata as the manifest hash (on a verified allowlisted 0G chain)", async () => {
    h.getNetworkMock.mockResolvedValue({ chainId: 16602n });
    h.getTransactionMock.mockResolvedValue({ data: "0xMANIFESTDATA" });
    expect(await realAdapters().chain.readManifest("0xTX", 16602)).toBe("0xMANIFESTDATA");
  });

  it("throws when the tx is not found", async () => {
    h.getNetworkMock.mockResolvedValue({ chainId: 16602n });
    h.getTransactionMock.mockResolvedValue(null);
    await expect(realAdapters().chain.readManifest("0xMISSING", 16602)).rejects.toThrow(/not found/);
  });

  it("rejects a non-allowlisted RPC network on the READ path (anti-spoof, mirrors anchorManifest)", async () => {
    // A malicious/wrong RPC that echoes the expected calldata must NOT be trusted on verify.
    h.getNetworkMock.mockResolvedValue({ chainId: 999n });
    h.getTransactionMock.mockResolvedValue({ data: "0xMANIFESTDATA" });
    await expect(realAdapters().chain.readManifest("0xTX")).rejects.toThrow(/not an allowlisted 0G network/);
  });

  it("rejects when the RPC chain id does not match the bundle's recorded 0G chain id", async () => {
    h.getNetworkMock.mockResolvedValue({ chainId: 16602n });
    h.getTransactionMock.mockResolvedValue({ data: "0xMANIFESTDATA" });
    await expect(realAdapters().chain.readManifest("0xTX", 16601)).rejects.toThrow(/does not match the bundle's recorded 0G chain id/);
  });
});

describe("createOgAdaptersFromEnv mode routing", () => {
  it("VIBETRACE_OG_MODE unset → dev storage (provider 0g-dev, local file uri)", async () => {
    const anchor = await createOgAdaptersFromEnv({ workspace: "/tmp/og-dev-route", env: {} as NodeJS.ProcessEnv })
      .storage.uploadJson({ a: 1 });
    expect(anchor.provider).toBe("0g-dev");
    expect(anchor.uri.startsWith("0g://local/")).toBe(true);
  });

  it("VIBETRACE_OG_MODE=real-chain → dev STORAGE (0g-dev) with the real chain adapter", async () => {
    const env = { VIBETRACE_OG_MODE: "real-chain", VIBETRACE_0G_PRIVATE_KEY: REAL_ENV.VIBETRACE_0G_PRIVATE_KEY } as NodeJS.ProcessEnv;
    const anchor = await createOgAdaptersFromEnv({ workspace: "/tmp/og-realchain-route", env }).storage.uploadJson({ a: 1 });
    expect(anchor.provider).toBe("0g-dev"); // storage stays local in real-chain mode
  });

  it("VIBETRACE_OG_MODE=real → real STORAGE (0g-storage) via the SDK", async () => {
    h.merkleTreeMock.mockResolvedValue([{ rootHash: () => "0xROOT" }, null]);
    h.uploadMock.mockResolvedValue([{ rootHash: "0xROOT" }, null]);
    const anchor = await realAdapters().storage.uploadJson({ a: 1 });
    expect(anchor.provider).toBe("0g-storage");
  });
});
