import assert from "node:assert/strict";
import test from "node:test";
import { isTrustedPreviewRequest } from "../scripts/preview-request-security.mjs";

function request({ address = "127.0.0.1", host = "127.0.0.1:5173", origin, site } = {}) {
  return {
    socket: { remoteAddress: address },
    headers: {
      host,
      ...(origin ? { origin } : {}),
      ...(site ? { "sec-fetch-site": site } : {}),
    },
  };
}

test("preview API accepts loopback same-origin and non-browser requests", () => {
  assert.equal(isTrustedPreviewRequest(request({ origin: "http://127.0.0.1:5173", site: "same-origin" })), true);
  assert.equal(isTrustedPreviewRequest(request({ address: "::ffff:127.0.0.1" })), true);
  assert.equal(isTrustedPreviewRequest(request({ address: "::1", host: "localhost:5173", origin: "http://localhost:5173", site: "none" })), true);
});

test("preview API rejects network and cross-origin browser requests", () => {
  assert.equal(isTrustedPreviewRequest(request({ address: "192.0.2.10" })), false);
  assert.equal(isTrustedPreviewRequest(request({ origin: "https://example.test", site: "cross-site" })), false);
  assert.equal(isTrustedPreviewRequest(request({ origin: "http://localhost:9999", site: "same-origin" })), false);
  assert.equal(isTrustedPreviewRequest(request({ origin: "not a URL", site: "same-origin" })), false);
});
