import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalHash } from "@vibetrace/schema";
import { createDevOgAdapters } from "./index";

describe("dev 0G adapters", () => {
  it("stores bundles locally with 0G-shaped URIs and anchors exact manifest hashes", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vibetrace-og-"));
    const adapters = createDevOgAdapters({
      workspace,
      now: () => "2026-06-17T10:00:00.000Z"
    });
    const bundle = { hello: "0g" };
    const expectedHash = canonicalHash(bundle);

    const storage = await adapters.storage.uploadJson(bundle);
    const chain = await adapters.chain.anchorManifest(expectedHash);

    expect(storage.uri).toBe(`0g://local/${expectedHash}`);
    expect(storage.rootHash).toBe(expectedHash);
    expect(chain.manifestHash).toBe(expectedHash);
    expect(chain.txHash).toMatch(/^0x[a-f0-9]{64}$/);

    const stored = JSON.parse(await readFile(join(workspace, "storage", `${expectedHash}.json`), "utf8"));
    expect(stored).toEqual(bundle);
  });
});

describe("dev 0G chain read-back", () => {
  it("reads the manifest hash back from an anchored tx calldata", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vibetrace-og-chain-"));
    const adapters = createDevOgAdapters({ workspace, now: () => "2026-06-17T10:00:00.000Z" });
    const manifestHash = canonicalHash({ bundle: "v1" });

    const anchor = await adapters.chain.anchorManifest(manifestHash);
    const readBack = await adapters.chain.readManifest(anchor.txHash);

    expect(readBack).toBe(manifestHash);
  });

  it("throws a clear error when the txHash was never anchored", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vibetrace-og-chain-miss-"));
    const adapters = createDevOgAdapters({ workspace, now: () => "2026-06-17T10:00:00.000Z" });
    await expect(adapters.chain.readManifest("0xnope")).rejects.toThrow(/0xnope/);
  });
});

describe("dev 0G storage read-back", () => {
  it("downloads an uploaded bundle by rootHash and re-hashes to the same root", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vibetrace-og-dl-"));
    const adapters = createDevOgAdapters({ workspace, now: () => "2026-06-17T10:00:00.000Z" });
    const bundle = { hello: "0g", nested: { b: 2, a: 1 } };

    const anchor = await adapters.storage.uploadJson(bundle);
    const fetched = await adapters.storage.downloadJson(anchor.rootHash);

    expect(fetched).toEqual(bundle);
    expect(canonicalHash(fetched)).toBe(anchor.rootHash);
  });

  it("throws a clear error when the rootHash is not present locally", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vibetrace-og-dl-miss-"));
    const adapters = createDevOgAdapters({ workspace, now: () => "2026-06-17T10:00:00.000Z" });
    await expect(adapters.storage.downloadJson("0xdeadbeef")).rejects.toThrow(/0xdeadbeef/);
  });
});
