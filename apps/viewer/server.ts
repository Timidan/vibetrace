/**
 * VibeTrace registry — standalone production host.
 *
 * A dependency-free Node `http` server (run through tsx so the workspace
 * @vibetrace/* packages resolve) that:
 *   (a) routes /api/* to the SHARED ./registry-core handlers — identical
 *       behavior to the Vite dev middleware, and
 *   (b) serves the built static viewer from ./dist for all other paths, with an
 *       SPA fallback to dist/index.html.
 *
 * Run after `vite build` produces dist/:
 *   PORT=5198 tsx server.ts            (from apps/viewer/)
 *   PORT=5198 pnpm --filter @vibetrace/viewer serve
 *
 * No framework, no new runtime deps — Node http + tsx only.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createStore,
  handleBadge,
  handleBundle,
  handleRegistry,
  handleSubmit,
  isRequestBodyTooLargeError,
  isRequestBodyDecodeError,
  readAndDecodeSubmitBody,
  tryAcquireSubmitSlot,
  releaseSubmitSlot,
  type CoreResult,
  type RegistryStore
} from "./registry-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(HERE, "dist");
const INDEX_HTML = join(DIST_DIR, "index.html");
const PORT = Number(process.env.PORT ?? 5173);

/** Minimal content-type map for the static assets a Vite build emits. */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

function applyResult(res: ServerResponse, result: CoreResult): void {
  res.writeHead(result.status, result.headers);
  res.end(result.body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify({ error: message }));
}

/**
 * Resolve a request pathname to a real file inside DIST_DIR, guarding against
 * path traversal. Returns null if it escapes dist or is not a regular file.
 */
function resolveStaticFile(pathname: string): string | null {
  const decoded = decodeURIComponent(pathname);
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const candidate = join(DIST_DIR, rel);
  // Containment check: the resolved path must stay inside dist/.
  if (candidate !== DIST_DIR && !candidate.startsWith(DIST_DIR + sep)) return null;
  if (!existsSync(candidate)) return null;
  const st = statSync(candidate);
  if (st.isDirectory()) {
    const indexed = join(candidate, "index.html");
    return existsSync(indexed) ? indexed : null;
  }
  return st.isFile() ? candidate : null;
}

function serveFile(res: ServerResponse, filePath: string, status = 200): void {
  const type = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(status, { "Content-Type": type });
  createReadStream(filePath)
    .on("error", () => sendError(res, 500, "Failed to read file"))
    .pipe(res);
}

async function handleApi(
  store: RegistryStore,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  // url.pathname is the full request path (e.g. "/api/registry").
  const path = url.pathname.slice("/api".length); // → "/registry", "/bundle/x", …

  // GET /api/registry
  if (method === "GET" && path === "/registry") {
    applyResult(res, await handleRegistry(store));
    return;
  }

  // GET /api/bundle/:id
  if (method === "GET" && path.startsWith("/bundle/")) {
    const id = decodeURIComponent(path.slice("/bundle/".length));
    applyResult(res, await handleBundle(store, id));
    return;
  }

  // GET /api/badge/:id.svg  (also accepts /api/badge/:id)
  if (method === "GET" && path.startsWith("/badge/")) {
    const style = url.searchParams.get("style") ?? "flat";
    let rawId = decodeURIComponent(path.slice("/badge/".length));
    if (rawId.endsWith(".svg")) rawId = rawId.slice(0, -".svg".length);
    applyResult(res, await handleBadge(store, rawId, style));
    return;
  }

  // POST /api/submit
  if (method === "POST" && path === "/submit") {
    if (!tryAcquireSubmitSlot()) {
      sendError(res, 429, "Too many concurrent submissions; retry shortly");
      return;
    }
    try {
      let raw: string;
      try {
        raw = await readAndDecodeSubmitBody(req, req.headers["content-encoding"], store.limits);
      } catch (err) {
        if (isRequestBodyTooLargeError(err)) {
          sendError(res, 413, err.message);
          return;
        }
        if (isRequestBodyDecodeError(err)) {
          sendError(res, 400, err.message);
          return;
        }
        throw err;
      }
      applyResult(res, await handleSubmit(store, raw));
    } finally {
      releaseSubmitSlot();
    }
    return;
  }

  sendError(res, 404, `No API route for ${method} ${url.pathname}`);
}

async function main(): Promise<void> {
  const store = await createStore();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    void (async () => {
      try {
        // (a) API routes → shared core handlers.
        if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
          await handleApi(store, req, res, url);
          return;
        }

        // (b) Static prod serving of the built viewer.
        const method = (req.method ?? "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD") {
          sendError(res, 405, `Method ${method} not allowed`);
          return;
        }

        const filePath = resolveStaticFile(url.pathname);
        if (filePath) {
          serveFile(res, filePath);
          return;
        }

        // SPA fallback → dist/index.html (so client-side hash routes resolve).
        if (existsSync(INDEX_HTML)) {
          serveFile(res, INDEX_HTML);
          return;
        }

        sendError(
          res,
          404,
          "Not found. Did you run `vite build` first? (no dist/index.html)"
        );
      } catch (err) {
        sendError(res, 500, err instanceof Error ? err.message : String(err));
      }
    })();
  });

  server.listen(PORT, () => {
    const built = existsSync(INDEX_HTML);
    // eslint-disable-next-line no-console
    console.log(
      `VibeTrace registry host listening on http://localhost:${PORT}` +
        (built ? ` (serving ${DIST_DIR})` : " (WARNING: dist/ not built yet — run `vite build`)")
    );
  });
}

void main();
