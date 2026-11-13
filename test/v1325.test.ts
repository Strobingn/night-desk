import { describe, expect, it } from "vitest";
import { quotePaperSell } from "../src/agents/execution-math.js";
import { makeToken } from "../src/demo/tokens.js";
import { hardKillFollowUp, buyToast } from "../web/src/onetap.js";
import { formatBalanceUsd, formatSolHolding, liveCashLabel } from "../web/src/format.js";
import { BUCKETS, NetLimiter, bucketFor, rpcLane } from "../src/market/net.js";
import { testDesk } from "./helpers.js";

const PAYDAY = "9LihG7BkcLSTN2Ytt9q2CePBBqMmd8SgvbGn9UWinqCf";

async function openPaper(symbol: string, mint: string, priceUsd = 1) {
  const desk = testDesk();
  await desk.submitCandidate(makeToken({ mint, symbol, priceUsd, liquidityUsd: 180_000 }));
  const pos = desk.book.positions.get(mint);
  expect(pos).toBeTruthy();
  return { desk, pos: pos! };
}

describe("v13.25 manual paper close confirms past the exit-impact gate", () => {
  it("closes a PAYDAY-shaped paper position by hand and still blocks an automatic exit", async () => {
    const { desk, pos } = await openPaper("PAYDAY", PAYDAY, 1);
    try {
      const entry = pos.entryPrice;
      expect(entry).toBeGreaterThan(0);
      pos.liquidityUsd = 15;
      const above = entry * 1.2;
      await desk.markPrice(PAYDAY, above);
      expect(desk.book.positions.has(PAYDAY)).toBe(true);

      const part = await desk.closePosition(PAYDAY, 0.25);
      expect(part.ok).toBe(false);
      if (part.ok) return;
      expect(part.allowSellAnyway).toBe(true);
      expect(part.error).toMatch(/would cost/);
      expect(desk.book.positions.has(PAYDAY)).toBe(true);
      const partSold = await desk.closePosition(PAYDAY, 0.25, undefined, { sellAnyway: true });
      expect(partSold.ok).toBe(true);
      expect(desk.book.positions.has(PAYDAY)).toBe(true);

      const open = desk.book.positions.get(PAYDAY)!;
      const mark = desk.book.price(PAYDAY, open.entryPrice);
      const modeled = quotePaperSell(mark, open.qty, 15);
      const blocked = await desk.closePosition(PAYDAY, 1);
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.allowSellAnyway).toBe(true);
      const sold = await desk.closePosition(PAYDAY, 1, undefined, { sellAnyway: true });
      expect(sold.ok).toBe(true);
      if (!sold.ok) return;
      expect(sold.exitCode).toBe("MANUAL_CLOSE");
      expect(desk.book.positions.has(PAYDAY)).toBe(false);
      const closed = desk.snapshot().closed.find((trade) => trade.mint === PAYDAY && trade.exitCode === "MANUAL_CLOSE");
      expect(closed).toBeTruthy();
      expect(closed?.proceedsUsd).toBeGreaterThanOrEqual(0);
      expect(closed?.proceedsUsd).toBeLessThan(open.qty * mark);
      expect(closed?.proceedsUsd).toBeCloseTo(modeled.proceedsUsd ?? 0, 2);
      expect(desk.snapshot().events.some((event) => event.code === "LIVE_SWAP_FAILED" && event.symbol === "PAYDAY")).toBe(false);
    } finally {
      desk.stop();
    }

    const auto = testDesk();
    try {
      await auto.submitCandidate(makeToken({ mint: PAYDAY, symbol: "PAYDAY", priceUsd: 1, liquidityUsd: 180_000 }));
      const pos = auto.book.positions.get(PAYDAY)!;
      const entry = pos.entryPrice;
      expect(auto.updateSettings({ trailTakeProfit: true }).ok).toBe(true);
      await auto.markPrice(PAYDAY, entry * 1.2);
      pos.liquidityUsd = 15;
      await auto.markPrice(PAYDAY, entry * 1.05);
      expect(auto.book.positions.has(PAYDAY)).toBe(true);
      const hit = auto.snapshot().events.find((event) => event.code === "EXIT_IMPACT" && event.symbol === "PAYDAY");
      expect(hit?.message).toMatch(/would cost .*Sell refused/);
      expect(hit?.message).not.toMatch(/did not complete/);
      expect(auto.snapshot().events.some((event) => event.code === "LIVE_SWAP_FAILED" && event.symbol === "PAYDAY")).toBe(false);
    } finally {
      auto.stop();
    }
  });
});

describe("v13.25 wallet display and hard-kill copy", () => {
  it("keeps sub-cent USDC and shows SOL with an approximate dollar value", () => {
    expect(formatBalanceUsd(0.001008)).toBe("$0.0010");
    expect(formatBalanceUsd(0.001008)).not.toBe("$0.00");
    expect(formatSolHolding(0.2951, 86.24)).toMatch(/^0\.2951 SOL · ~\$/);
    const strip = liveCashLabel({ sol: 0.2951, solUsd: 86.24, usdc: 0.001008, cashUsd: 0, cashKnown: true, balanceError: null });
    expect(strip).toContain("0.2951 SOL");
    expect(strip).toContain("USDC $0.0010");
    expect(strip).not.toMatch(/USDC \$0\.00(?:\D|$)/);
  });

  it("serves wallet reads ahead of mark polls on the same Helius budget", async () => {
    const read = bucketFor("https://mainnet.helius-rpc.com/?api-key=test")!;
    const exec = BUCKETS.find((row) => row.id === "helius:exec")!;
    expect(read.budgetPerMin).toBe(10);
    expect(exec.budgetPerMin).toBe(8);
    expect(read.budgetPerMin + exec.budgetPerMin).toBe(18);
    const balance = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: ["wallet"] });
    const marks = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "getMultipleAccounts", params: [["pool"]] });
    expect(rpcLane(read, -1, balance)?.id).toBe("helius");
    expect(rpcLane(read, 0, marks)?.id).toBe("helius");

    let now = 0;
    const later: Array<() => void> = [];
    const sent: string[] = [];
    const net = new NetLimiter({
      clock: {
        now: () => now,
        random: () => 0,
        setTimeout: ((fn: () => void) => {
          later.push(fn);
          return 0;
        }) as typeof setTimeout
      },
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        sent.push(String(init?.body));
        return Response.json({ jsonrpc: "2.0", result: { value: 1 } });
      }) as typeof fetch
    });
    const url = "https://mainnet.helius-rpc.com/?api-key=test";
    for (let i = 0; i < 3; i += 1) {
      await net.fetchAt(0)(url, { method: "POST", body: marks });
    }
    const buried = net.fetchAt(0)(url, { method: "POST", body: marks });
    const wallet = net.fetchAt(-1)(url, { method: "POST", body: balance });
    expect(later.length).toBeGreaterThan(0);
    // 13.46: the wallet read does not wait for a token. It goes while the mark is still queued.
    await wallet;
    expect(sent.at(-1)).toContain("getBalance");
    expect(net.stats().find((row) => row.id === "helius")?.queued).toBe(1);
    now += 6_000;
    later.shift()?.();
    await buried;
    expect(net.stats().find((row) => row.id === "helius")?.sent).toBe(5);
    expect(net.stats().find((row) => row.id === "helius:exec")?.sent ?? 0).toBe(0);
  });

  it("surfaces a hard kill reason with the Buy anyway hook", () => {
    const reason = "Hard kill on NEAR: mint authority is still active. Tap Buy anyway to paper-buy it regardless.";
    expect(hardKillFollowUp("HARD_KILL", reason)).toEqual({ reason });
    expect(hardKillFollowUp("ENTRY_SLIPPAGE", reason)).toBeNull();
    expect(buyToast("NEAR", { ok: false, error: reason, code: "HARD_KILL" }, 40)).toContain(reason);
    expect(buyToast("NEAR", { ok: false, error: reason, code: "HARD_KILL" }, 40)).toContain("HARD_KILL");
    expect(buyToast("NEAR", { ok: false, error: reason, code: "HARD_KILL" }, 40)).toContain("Buy…");
  });
});

describe("v13.25 gap rugs stay visible and a bogus first mark does not fire one", () => {
  it("lists a same-second GAP_RUG and ignores one absurd first mark", async () => {
    const real = await openPaper("GHOST", "GhostMint11111111111111111111111111111111", 1);
    try {
      const entry = real.pos.entryPrice;
      await real.desk.markPrice(real.pos.mint, entry / 100);
      expect(real.desk.book.positions.has(real.pos.mint)).toBe(true);
      expect(real.desk.snapshot().closed.some((trade) => trade.exitCode === "GAP_RUG")).toBe(false);

      await real.desk.markPrice(real.pos.mint, entry * 0.9);
      expect(real.desk.book.positions.has(real.pos.mint)).toBe(false);
      const gap = real.desk.snapshot().closed.find((trade) => trade.mint === real.pos.mint);
      expect(gap?.exitCode).toBe("GAP_RUG");
      expect(gap?.entryPrice).toBeGreaterThan(0);
      expect(gap?.exitPrice).toBeGreaterThan(0);
      expect(gap?.pnlUsd).toBeLessThan(0);
      expect(gap && gap.closedAt - gap.openedAt).toBeLessThan(60_000);
    } finally {
      real.desk.stop();
    }

    const repeated = await openPaper("JOSE", "JoseMint111111111111111111111111111111111", 1);
    try {
      const entry = repeated.pos.entryPrice;
      await repeated.desk.markPrice(repeated.pos.mint, entry / 1000);
      expect(repeated.desk.book.positions.has(repeated.pos.mint)).toBe(true);
      await repeated.desk.markPrice(repeated.pos.mint, entry / 1000);
      expect(repeated.desk.book.positions.has(repeated.pos.mint)).toBe(false);
      const gap = repeated.desk.snapshot().closed.find((trade) => trade.mint === repeated.pos.mint);
      expect(gap?.exitCode).toBe("GAP_RUG");
      expect(gap?.entryPrice).toBeGreaterThan(0);
      expect(gap?.exitPrice).toBeGreaterThan(0);
      expect(typeof gap?.pnlUsd).toBe("number");
    } finally {
      repeated.desk.stop();
    }
  });
});
