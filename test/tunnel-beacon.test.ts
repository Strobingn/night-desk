import { describe, expect, it, vi } from "vitest";
import { parseTunnelUrl, publishBeacon, shouldStartTunnel } from "../scripts/ensure-tunnel";

describe("quick tunnel", () => {
  it("reads the latest trycloudflare hostname from a cloudflared log", () => {
    const log = [
      "2026-10-28 INF Thank you for trying Cloudflare Tunnel.",
      "https://old-host.trycloudflare.com",
      "https://fresh-host.trycloudflare.com"
    ].join("\n");
    expect(parseTunnelUrl(log)).toBe("https://fresh-host.trycloudflare.com");
    expect(parseTunnelUrl("no tunnel yet")).toBeNull();
  });

  it("does not start a second tunnel when cloudflared already targets 4721", () => {
    const live = ["cloudflared tunnel --url http://127.0.0.1:4721 --no-autoupdate"];
    expect(shouldStartTunnel(live, 4721)).toBe(false);
    expect(shouldStartTunnel(["node dist/index.js"], 4721)).toBe(true);
    expect(shouldStartTunnel(["cloudflared tunnel --url http://127.0.0.1:8080"], 4721)).toBe(true);
  });

  it("skips the beacon PATCH when the service role key is absent", async () => {
    const fetchImpl = vi.fn();
    const result = await publishBeacon("https://fresh-host.trycloudflare.com", {}, fetchImpl);
    expect(result.patched).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("PATCHes night_desk_beacon and does not print the service key", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify([{ public_url: "https://fresh-host.trycloudflare.com" }]) }));
    const result = await publishBeacon(
      "https://fresh-host.trycloudflare.com",
      { SUPABASE_SERVICE_ROLE_KEY: "service-role-secret" },
      fetchImpl as unknown as typeof fetch
    );
    expect(result.patched).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { method: string; body: string; headers: Record<string, string> }];
    expect(url).toContain("/rest/v1/night_desk_beacon?id=eq.phone");
    expect(init.method).toBe("PATCH");
    expect(init.body).toContain("https://fresh-host.trycloudflare.com");
    expect(init.headers.apikey).toBe("service-role-secret");
  });
});
