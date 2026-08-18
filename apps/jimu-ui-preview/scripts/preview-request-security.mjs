const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1"]);

function headerValue(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

export function isTrustedPreviewRequest(request) {
  const remoteAddress = String(request?.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (!LOOPBACK_ADDRESSES.has(remoteAddress)) return false;

  const fetchSite = headerValue(request?.headers, "sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;

  const origin = headerValue(request?.headers, "origin");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const host = headerValue(request?.headers, "host");
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host === host;
  } catch {
    return false;
  }
}
