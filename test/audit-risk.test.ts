import { describe, expect, it } from "vitest";
import { evaluateFilter } from "../src/agents/filter.js";
import { makeToken } from "../src/demo/tokens.js";
import { enrichSighting } from "../src/market/enrich.js";
import { parseMintAccount, parseTop10Pct, retailPctFromRugcheck } from "../src/market/parsers.js";
import { resolveRules } from "../src/rules.js";

const rules = resolveRules({});
const reasons = (token: ReturnType<typeof makeToken>) => evaluateFilter(token, { status: "clean" }, rules).reasons.map((r) => r.code);

describe("pre-trade evidence", () => {
  it.each([false, null, undefined])("blocks active or unverified freeze authority: %s", (value) => {
    expect(reasons(makeToken({ freezeAuthorityRevoked: value as boolean | null }))).toContain("FREEZE_AUTHORITY_ACTIVE");
  });
  it("does not mistake missing authority fields for explicit revocation", () => {
    const result = parseMintAccount({ value: { data: { parsed: { info: { supply: "100", decimals: 6 } } } } });
    expect(result.mintAuthorityRevoked).toBeNull();
    expect(result.freezeAuthorityRevoked).toBeNull();
  });
  it("blocks transfer hooks and permanent delegates even with revoked authorities", () => {
    const result = parseMintAccount({ value: { data: { parsed: { info: {
      mintAuthority: null, freezeAuthority: null, supply: "1000", decimals: 6,
      extensions: [{ extension: "metadataPointer" }, { extension: "transferHook" }, { extension: "permanentDelegate" }]
    } } } } });
    expect(result.unsupportedExtensions).toEqual(["transferHook", "permanentDelegate"]);
    expect(reasons(makeToken(result))).toContain("UNSUPPORTED_TOKEN_EXTENSION");
  });
  it("aggregates split token accounts by owner before choosing the top ten", () => {
    const rows = Array.from({ length: 11 }, (_, index) => ({ address: `account-${index}`, owner: "same-wallet", uiAmount: 20 }));
    const result = parseTop10Pct({ value: rows }, 1000);
    expect(result.top10HolderPct).toBeCloseTo(0.22);
    expect(result.holderCount).toBe(1);
    expect(reasons(makeToken(result))).toContain("HOLDER_CONCENTRATION");
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 2])("blocks invalid holder fractions: %s", (value) => {
    expect(reasons(makeToken({ top10HolderPct: value }))).toContain("HOLDER_CONCENTRATION");
  });
  it("fails closed on malformed holder balances", () => {
    expect(parseTop10Pct({ value: [{ amount: "garbage", decimals: 6 }] }, 1000).top10HolderPct).toBeNull();
    expect(parseTop10Pct({ value: [{ uiAmount: -1 }] }, 1000).top10HolderPct).toBeNull();
  });
  it("handles sub-one-percent RugCheck fields without unit guessing", () => {
    expect(retailPctFromRugcheck([{ address: "wallet", pct: 0.8 }]).top10HolderPct).toBe(0.008);
    expect(retailPctFromRugcheck([{ address: "wallet" }]).top10HolderPct).toBeNull();
  });
  it("blocks reported insiders above 18%, while leaving unknown cluster coverage explicit", () => {
    expect(reasons(makeToken({ insiderSupplyPct: 0.19 }))).toContain("INSIDER_CONCENTRATION");
    expect(reasons(makeToken({ insiderSupplyPct: null }))).not.toContain("INSIDER_CONCENTRATION");
  });
  it("passes chain freeze evidence and insider flags from enrichment into the filter", async () => {
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("dexscreener")) return Response.json({ pairs: [] });
      if (String(input).includes("/report")) return Response.json({ topHolders: [{ address: "insider", pct: 30, insider: true }] });
      const method = JSON.parse(String(init?.body)).method;
      return Response.json({ result: method === "getAccountInfo" ? { value: { data: { parsed: { info: {
        mintAuthority: null, freezeAuthority: "dev", supply: "1000000000", decimals: 6
      } } } } } : { value: [] } });
    }) as typeof fetch;
    const token = await enrichSighting({ mint: "So11111111111111111111111111111111111111112", source: "pumpfun", observedAt: 0 },
      { rpcUrl: "https://rpc.test", rugcheckUrl: "https://rug.test", fetchImpl });
    expect(token.freezeAuthorityRevoked).toBe(false);
    expect(token.insiderSupplyPct).toBe(0.3);
    expect(reasons(token)).toEqual(expect.arrayContaining(["FREEZE_AUTHORITY_ACTIVE", "INSIDER_CONCENTRATION"]));
  });
});
