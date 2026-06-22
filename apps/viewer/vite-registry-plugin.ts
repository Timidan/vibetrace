/**
 * VibeTrace registry backend — a THIN Vite dev-server middleware adapter.
 *
 * All registry behavior (store load/persist/seed, scoring, badge SVGs, and the
 * request handlers) now lives in the framework-agnostic ./registry-core, which
 * is shared verbatim by the standalone ./server.ts host. This file only maps
 * Vite's Connect req/res onto the core handlers so dev and standalone behavior
 * stay aligned.
 *
 * API:
 *   GET  /api/registry      -> RegistrySummary[]  (sorted desc by buildScore, tie-break proof rank)
 *   GET  /api/bundle/:id     -> PublicLedgerBundle (full bundle for the story page)
 *   GET  /api/badge/:id.svg  -> image/svg+xml  (embeddable VibeScore badge; muted on unknown id)
 *   POST /api/submit         -> { entry } | 4xx { error }   body: { bundle }
 */

import type { Connect, Plugin, ViteDevServer } from "vite";
import {
  createStore,
  handleBadge,
  handleBundle,
  handleRegistry,
  handleSubmit,
  isRequestBodyTooLargeError,
  readLimitedRequestBody,
  setModuleLoader,
  type CoreResult,
  type RegistryStore
} from "./registry-core";

// Re-export the core's types + badge/score surface so existing importers
// (the client contract, the test-suite) keep their `../vite-registry-plugin`
// import paths working unchanged.
export {
  badgeForEntry,
  createStore,
  deriveSummary,
  escapeXml,
  flatBadgeSvg,
  handleBadge,
  handleBundle,
  handleRegistry,
  handleSubmit,
  isRequestBodyTooLargeError,
  isPublicLedgerBundle,
  readLimitedRequestBody,
  mutedBadgeSvg,
  renderBadgeForId,
  setModuleLoader,
  stampBadgeSvg,
  tierBadgeColors,
  type CoreResult,
  type RegistryStore,
  type RegistrySummary,
  type StoredEntry
} from "./registry-core";

/* ── request helpers ── */

/** Apply a CoreResult to a Connect response. */
function applyResult(res: Parameters<Connect.NextHandleFunction>[1], result: CoreResult): void {
  res.statusCode = result.status;
  for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
  res.end(result.body);
}

/* ── the plugin (thin adapter over registry-core) ── */

export function registryPlugin(): Plugin {
  let store: RegistryStore | null = null;

  return {
    name: "vibetrace-registry",
    async configureServer(server: ViteDevServer) {
      // Resolve @vibetrace/score + @vibetrace/schema through Vite's SSR module
      // graph: their compiled dist uses extensionless ESM imports that Node's
      // native loader (which evaluates this plugin) cannot resolve.
      setModuleLoader((specifier) => server.ssrLoadModule(specifier));
      store = await createStore();

      server.middlewares.use("/api", async (req, res, next) => {
        const activeStore = store;
        if (!activeStore) {
          next();
          return;
        }
        const method = (req.method ?? "GET").toUpperCase();
        // req.url here is relative to the "/api" mount (e.g. "/registry").
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname;

        try {
          // GET /api/registry
          if (method === "GET" && path === "/registry") {
            applyResult(res, await handleRegistry(activeStore));
            return;
          }

          // GET /api/bundle/:id
          if (method === "GET" && path.startsWith("/bundle/")) {
            const id = decodeURIComponent(path.slice("/bundle/".length));
            applyResult(res, await handleBundle(activeStore, id));
            return;
          }

          // GET /api/badge/:id.svg  (also accepts /api/badge/:id)
          if (method === "GET" && path.startsWith("/badge/")) {
            const style = url.searchParams.get("style") ?? "flat";
            let rawId = decodeURIComponent(path.slice("/badge/".length));
            if (rawId.endsWith(".svg")) rawId = rawId.slice(0, -".svg".length);
            applyResult(res, await handleBadge(activeStore, rawId, style));
            return;
          }

          // POST /api/submit
          if (method === "POST" && path === "/submit") {
            let raw: string;
            try {
              raw = await readLimitedRequestBody(req);
            } catch (err) {
              if (isRequestBodyTooLargeError(err)) {
                res.statusCode = 413;
                res.setHeader("Content-Type", "application/json; charset=utf-8");
                res.setHeader("Cache-Control", "no-store");
                res.end(JSON.stringify({ error: err.message }));
                return;
              }
              throw err;
            }
            applyResult(res, await handleSubmit(activeStore, raw));
            return;
          }

          next();
        } catch (err) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
        }
      });
    }
  };
}

export default registryPlugin;
