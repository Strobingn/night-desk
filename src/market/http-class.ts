/**
 * Classify an HTTP failure before Scout stores it.
 * A Cloudflare challenge is not a rejected API key, and it is not a payment error.
 */

export const PUMP_DISCOVERY_HOST = "frontend-api-v3.pump.fun";

/** Shown while the challenged coin list stays uncalled. The free stream is a different source. */
export const PUMP_API_CHALLENGE =
  "Cloudflare challenge on frontend-api-v3.pump.fun. HTTP coin discovery is off. This is not a key or plan rejection. The free Pump stream is separate.";

export type HttpFailureKind = "gone" | "auth" | "challenge" | "forbidden";

export interface HttpFailure {
  kind: HttpFailureKind;
  detail: string;
}

export function isPumpDiscoveryUrl(url: string): boolean {
  try {
    return new URL(url).hostname === PUMP_DISCOVERY_HOST;
  } catch {
    return url.includes(PUMP_DISCOVERY_HOST);
  }
}

function header(headers: { get(name: string): string | null }, name: string): string {
  return headers.get(name) ?? "";
}

/** HTML interstitial or an explicit Cf-Mitigated challenge. A JSON 403 is not this. */
export function isCloudflareChallenge(status: number, headers: { get(name: string): string | null }, body: string): boolean {
  if (/challenge/i.test(header(headers, "cf-mitigated"))) return true;
  const html = /text\/html/i.test(header(headers, "content-type")) || /<!doctype html/i.test(body) || /<html/i.test(body);
  const cloudflare = /cloudflare/i.test(header(headers, "server")) || /cloudflare/i.test(body);
  const interstitial = /just a moment/i.test(body) || /cf-challenge/i.test(body) || /cf-mitigated/i.test(body);
  return status === 403 && html && (cloudflare || interstitial);
}

/**
 * 401/402 stay "key or plan rejected".
 * 403 is a challenge only when the body or headers say Cloudflare is challenging.
 * Any other 403 stays forbidden and is not labeled as a key or plan.
 */
export function classifyHttpFailure(status: number, headers: { get(name: string): string | null }, body: string): HttpFailure | null {
  if (isCloudflareChallenge(status, headers, body)) {
    return { kind: "challenge", detail: "Cloudflare challenge (not a key or plan rejection)" };
  }
  if (status === 410) return { kind: "gone", detail: "endpoint removed (HTTP 410)" };
  if (status === 401 || status === 402) return { kind: "auth", detail: `key or plan rejected (HTTP ${status})` };
  if (status === 403) return { kind: "forbidden", detail: "HTTP 403 forbidden (not a key or plan rejection)" };
  return null;
}
