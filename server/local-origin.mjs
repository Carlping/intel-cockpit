const SAFE_METHODS = new Set(["GET", "HEAD"]);

export function localRequestAllowed({
  host,
  origin,
  method = "GET",
  pathname = "/",
  allowedHosts,
  allowedOrigins,
} = {}) {
  const hosts = allowedHosts instanceof Set ? allowedHosts : new Set(allowedHosts || []);
  const origins = allowedOrigins instanceof Set ? allowedOrigins : new Set(allowedOrigins || []);
  if (!hosts.has(String(host || "").toLowerCase())) return false;
  if (!pathname.startsWith("/api/v1/") && !pathname.startsWith("/api/v2/")) return true;
  if (SAFE_METHODS.has(String(method || "GET").toUpperCase())) {
    return !origin || origins.has(origin);
  }
  return Boolean(origin) && origins.has(origin);
}
