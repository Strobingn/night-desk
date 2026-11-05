import { describe, expect, it } from "vitest";
import { evaluateFilter } from "../src/agents/filter.js";
import { makeToken } from "../src/demo/tokens.js";
import { holderEntropy, looksSybilSplit } from "../src/market/holder-entropy.js";
import { parseHolderAccounts, parseMintAccount, parseRugcheckReport } from "../src/market/parsers.js";
import { decodePumpCurve, PUMP_INITIAL_REAL_TOKEN_RESERVES, quoteCurveBuy } from "../src/market/pump-curve.js";
import { kellyHint } from "../src/desk/kelly.js";
import { resolveRules } from "../src/rules.js";
import type { ClosedTrade } from "../src/types.js";

const rules = resolveRules({});
const clean = { status: "clean" as const };

describe("freeze authority", () => {
  it("reads freeze authority from the mint account", () => {
    const active = parseMintAccount({
      value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: "Frz111", supply: "1000", decimals: 0 } } } }
    });
    expect(active.freezeAuthorityRevoked).toBe(false);
    const revoked = parseMintAccount({
      value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null, supply: "1000", decimals: 0 } } } }
    });
    expect(revoked.freezeAuthorityRevoked).toBe(true);
    expect(parseMintAccount(null).freezeAuthorityRevoked).toBeNull();
  });

  it("only takes a 'still enabled' freeze from RugCheck", () => {
    expect(parseRugcheckReport({ risks: [{ name: "Freeze Authority still enabled" }] }).freezeAuthorityRevoked).toBe(false);
    expect(parseRugcheckReport({ risks: [] }).freezeAuthorityRevoked).toBeNull();
  });

  it("rejects active and unknown freeze authority", () => {
    for (const freezeAuthorityRevoked of [false, null]) {
      const result = evaluateFilter(makeToken({ freezeAuthorityRevoked }), clean, rules);
      expect(result.decision).toBe("reject");
      expect(result.reasons.map((r) => r.code)).toContain("FREEZE_AUTHORITY_ACTIVE");
    }
    expect(evaluateFilter(makeToken(), clean, rules).decision).toBe("pass");
  });
});

describe("holder entropy", () => {
  it("is 1 for identical balances and low for one whale", () => {
    expect(holderEntropy(Array(30).fill(100))).toBeCloseTo(1, 6);
    const whale = holderEntropy([10_000, 1, 1, 1, 1]);
    expect(whale).not.toBeNull();
    expect(whale!).toBeLessThan(0.1);
    expect(holderEntropy([5])).toBeNull();
  });

  it("flags a split only with enough holders", () => {
    expect(looksSybilSplit(0.995, 20)).toBe(true);
    expect(looksSybilSplit(0.995, 10)).toBe(false);
    expect(looksSybilSplit(0.9, 25)).toBe(false);
    expect(looksSybilSplit(null, 25)).toBe(false);
  });

  it("is measured from full account lists, per owner", () => {
    const accounts = Array.from({ length: 30 }, (_, i) => ({ address: `acct${i}`, owner: `own${i}`, amount: 1_000_000 }));
    const read = parseHolderAccounts(accounts, 1_000, 6);
    expect(read.entropyHolders).toBe(25);
    expect(read.holderEntropy).toBeCloseTo(1, 6);
  });

  it("rejects a uniform split that passes the top-10 line", () => {
    // 50 wallets at 0.8% each: top 10 is 8%, well under the 20% limit.
    const token = makeToken({ top10HolderPct: 0.08, holderEntropy: 0.999, entropyHolders: 25 });
    const result = evaluateFilter(token, clean, rules);
    expect(result.decision).toBe("reject");
    expect(result.reasons.map((r) => r.code)).toEqual(["HOLDER_SYBIL_SPLIT"]);
  });

  it("skips the split check when entropy is not measured", () => {
    const result = evaluateFilter(makeToken({ holderEntropy: null }), clean, rules);
    expect(result.decision).toBe("pass");
  });
});

function curveBuffer(fields: { vToken: bigint; vSol: bigint; rToken: bigint; rSol: bigint; supply: bigint; complete?: boolean }) {
  const buf = new Uint8Array(81);
  const view = new DataView(buf.buffer);
  view.setBigUint64(8, fields.vToken, true);
  view.setBigUint64(16, fields.vSol, true);
  view.setBigUint64(24, fields.rToken, true);
  view.setBigUint64(32, fields.rSol, true);
  view.setBigUint64(40, fields.supply, true);
  view.setUint8(48, fields.complete ? 1 : 0);
  return buf;
}

describe("pump curve", () => {
  // Fresh Pump curve: 1.073B virtual tokens, 30 virtual SOL.
  const fresh = curveBuffer({
    vToken: 1_073_000_000_000_000n,
    vSol: 30_000_000_000n,
    rToken: PUMP_INITIAL_REAL_TOKEN_RESERVES,
    rSol: 0n,
    supply: 1_000_000_000_000_000n
  });

  it("decodes a fresh curve", () => {
    const s = decodePumpCurve(fresh);
    expect(s.complete).toBe(false);
    expect(s.progress).toBe(0);
    expect(s.spotPriceSol).toBeCloseTo(30 / 1_073_000_000, 15);
    // About 85 SOL completes a fresh curve.
    expect(Number(s.lamportsToComplete) / 1e9).toBeGreaterThan(84);
    expect(Number(s.lamportsToComplete) / 1e9).toBeLessThan(86);
  });

  it("rejects short buffers", () => {
    expect(() => decodePumpCurve(new Uint8Array(48))).toThrow();
  });

  it("quotes a buy and clips at completion", () => {
    const s = decodePumpCurve(fresh);
    const one = quoteCurveBuy(s, 1_000_000_000n);
    expect(one.tokensOut).toBeGreaterThan(0n);
    // 1 SOL into 30 virtual SOL: average fill about 3.3% over spot.
    expect(one.priceImpactBps).toBeGreaterThan(300);
    expect(one.priceImpactBps).toBeLessThan(360);
    const all = quoteCurveBuy(s, 500_000_000_000n);
    expect(all.lamportsIn).toBe(s.lamportsToComplete);
    expect(all.tokensOut).toBe(s.realTokenReserves);
  });

  it("does not quote a completed curve", () => {
    const done = decodePumpCurve(curveBuffer({ vToken: 1n, vSol: 1n, rToken: 0n, rSol: 0n, supply: 1n, complete: true }));
    expect(quoteCurveBuy(done, 1_000n).tokensOut).toBe(0n);
  });
});

function trade(pnlPct: number): ClosedTrade {
  return {
    id: String(Math.random()),
    mint: "m",
    symbol: "S",
    openedAt: 0,
    closedAt: 1,
    costUsd: 8,
    proceedsUsd: 8 * (1 + pnlPct),
    pnlUsd: 8 * pnlPct,
    pnlPct,
    exitCode: "MANUAL_CLOSE",
    score: 0.7,
    mode: "paper"
  };
}

describe("kelly hint", () => {
  it("needs a win and a loss", () => {
    expect(kellyHint([trade(0.1)], 0.08)).toBeNull();
  });

  it("is quarter Kelly, floored at 0 and capped", () => {
    // 50% wins of +30%, losses of −6%: b = 5, full Kelly = 0.5 − 0.5/5 = 0.4, quarter = 0.1 → capped to 0.08.
    const good = kellyHint([...Array(20)].flatMap(() => [trade(0.3), trade(-0.06)]), 0.08)!;
    expect(good.fullKelly).toBeCloseTo(0.4, 6);
    expect(good.suggestedPct).toBe(0.08);
    expect(good.thin).toBe(false);
    // 30% wins of +6%, losses of −6%: no edge.
    const bad = kellyHint([trade(0.06), trade(0.06), trade(0.06), ...Array(7).fill(0).map(() => trade(-0.06))], 0.08)!;
    expect(bad.fullKelly).toBeLessThan(0);
    expect(bad.suggestedPct).toBe(0);
    expect(bad.thin).toBe(true);
  });
});
