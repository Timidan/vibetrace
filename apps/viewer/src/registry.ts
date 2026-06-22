/**
 * Registry client.
 *
 * The data is REAL submissions only — there is no fabricated/seed project data
 * in this module. The backend (see ../vite-registry-plugin.ts) seeds itself from
 * VibeTrace's own published ledger (.vibetrace/public/*.json, which scores ~tier
 * C) and grows by real POST /api/submit submissions. This module is just a thin
 * HTTP client over that API.
 */

import type { PublicLedgerBundle } from "@vibetrace/schema";

// RegistrySummary is defined once in ./registry-types and shared with the server
// (../registry-core.ts) so the client and server contracts can never drift.
// Re-exported so existing `from "./registry"` importers keep working unchanged.
export type { RegistrySummary } from "./registry-types";
import type { RegistrySummary } from "./registry-types";

/** GET /api/registry → summaries sorted desc by buildScore (tie-break proof rank). */
export async function getRegistry(): Promise<RegistrySummary[]> {
  const res = await fetch("/api/registry");
  if (!res.ok) {
    throw new Error(`Failed to load registry: ${res.status}`);
  }
  return (await res.json()) as RegistrySummary[];
}

/** GET /api/bundle/:id → the full PublicLedgerBundle for the story page. */
export async function getBundleEntry(id: string): Promise<PublicLedgerBundle> {
  const res = await fetch(`/api/bundle/${encodeURIComponent(id)}`);
  if (!res.ok) {
    let message = `Failed to load bundle: ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* keep the status-based message */
    }
    throw new Error(message);
  }
  return (await res.json()) as PublicLedgerBundle;
}
