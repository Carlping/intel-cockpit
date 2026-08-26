import { randomBytes } from "node:crypto";

export function createDocumentNonce() {
  return randomBytes(18).toString("base64");
}

export function addScriptNonces(html, nonce) {
  if (typeof html !== "string" || !html) return html;
  if (typeof nonce !== "string" || !nonce) throw new Error("A document nonce is required");
  return html.replace(/<script(?![^>]*\bnonce=)(?=[\s>])/gi, `<script nonce="${nonce}"`);
}

export function contentSecurityPolicy(nonce) {
  const scriptPolicy = nonce ? `'self' 'nonce-${nonce}'` : "'self'";
  return [
    "default-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    `script-src ${scriptPolicy}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}
