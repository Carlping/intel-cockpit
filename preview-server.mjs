import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createIntelRuntime } from "./server/runtime.mjs";
import { localRequestAllowed } from "./server/local-origin.mjs";
import { addScriptNonces, contentSecurityPolicy, createDocumentNonce } from "./server/security-headers.mjs";
import worker from "./dist/server/index.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const assetRoot = path.join(root, "dist", "client");
const host = "127.0.0.1";
const port = Number(process.env.PORT || 4173);
const allowedHosts = new Set([`${host}:${port}`, `localhost:${port}`]);
const allowedOrigins = new Set([`http://${host}:${port}`, `http://localhost:${port}`]);
const runtime = await createIntelRuntime({
  startCollectors: process.env.INTEL_OS_DISABLE_COLLECTORS !== "1",
});

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

async function fetchAsset(request) {
  const url = new URL(request.url);
  const relative = path
    .normalize(decodeURIComponent(url.pathname))
    .replace(/^[/\\]+/, "");
  const filename = path.join(assetRoot, relative);

  const boundary = path.relative(assetRoot, filename);
  if (boundary.startsWith("..") || path.isAbsolute(boundary)) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const body = await readFile(filename);
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": mimeTypes[path.extname(filename)] || "application/octet-stream",
        "cache-control": relative.startsWith("assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

const assets = { fetch: fetchAsset };

async function readIncomingBody(incoming) {
  const chunks = [];
  let size = 0;
  for await (const chunk of incoming) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("Request body exceeds 1 MiB");
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url || "/", `http://${incoming.headers.host || `${host}:${port}`}`);
    if (!localRequestAllowed({
      host: incoming.headers.host,
      origin: incoming.headers.origin,
      method: incoming.method,
      pathname: url.pathname,
      allowedHosts,
      allowedOrigins,
    })) {
      outgoing.statusCode = 403;
      outgoing.setHeader("content-type", "application/json; charset=utf-8");
      outgoing.end(JSON.stringify({ error: { code: "LOCAL_ORIGIN_REQUIRED", message: "Local origin required" } }));
      return;
    }
    const body = ["GET", "HEAD"].includes(incoming.method || "GET")
      ? undefined
      : await readIncomingBody(incoming);
    const request = new Request(url, {
      method: incoming.method,
      headers: incoming.headers,
      body,
    });

    const response =
      url.pathname.startsWith("/api/v1/") || url.pathname.startsWith("/api/v2/")
        ? await runtime.api.fetch(request)
        : url.pathname.startsWith("/assets/") || url.pathname === "/favicon.svg"
        ? await fetchAsset(request)
        : await worker.fetch(
            request,
            { ASSETS: assets },
            { waitUntil() {}, passThroughOnException() {} },
          );

    const contentType = response.headers.get("content-type") || "";
    if (/^text\/event-stream\b/i.test(contentType) && response.body) {
      outgoing.statusCode = response.status;
      response.headers.forEach((value, key) => outgoing.setHeader(key, value));
      outgoing.setHeader("content-security-policy", contentSecurityPolicy());
      outgoing.setHeader("x-frame-options", "DENY");
      outgoing.setHeader("referrer-policy", "no-referrer");
      outgoing.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
      outgoing.flushHeaders();
      const reader = response.body.getReader();
      incoming.on("close", () => void reader.cancel().catch(() => {}));
      while (!outgoing.destroyed) {
        const { done, value } = await reader.read();
        if (done) break;
        outgoing.write(Buffer.from(value));
      }
      if (!outgoing.destroyed) outgoing.end();
      return;
    }
    const originalBody = Buffer.from(await response.arrayBuffer());
    const documentNonce = /^text\/html\b/i.test(contentType) ? createDocumentNonce() : undefined;
    const responseBody = documentNonce
      ? Buffer.from(addScriptNonces(originalBody.toString("utf8"), documentNonce), "utf8")
      : originalBody;

    outgoing.statusCode = response.status;
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "content-length") outgoing.setHeader(key, value);
    });
    outgoing.setHeader("content-length", responseBody.byteLength);
    outgoing.setHeader("content-security-policy", contentSecurityPolicy(documentNonce));
    outgoing.setHeader("x-frame-options", "DENY");
    outgoing.setHeader("referrer-policy", "no-referrer");
    outgoing.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
    outgoing.end(responseBody);
  } catch (error) {
    outgoing.statusCode = 500;
    outgoing.setHeader("content-type", "text/plain; charset=utf-8");
    outgoing.end(error instanceof Error ? error.message : "Unknown server error");
  }
});

server.listen(port, host, () => {
  const url = `http://${host}:${port}`;
  console.log(`個人世界情報系統已啟動：${url}`);
  console.log("資料只在本機與指定的情報 Vault 處理；關閉此視窗即可停止。\n");

  if (process.argv.includes("--open") && process.platform === "win32") {
    execFile("cmd.exe", ["/c", "start", "", url], { windowsHide: true });
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    runtime.stop();
    server.close(() => process.exit(0));
  });
}
