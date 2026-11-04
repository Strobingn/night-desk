import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { formatTimestampEt, journalCsv } from "../../src/pump/journal/csv.js";
import { importReports, importWallet, reportsFromTrades } from "../../src/pump/journal/import.js";
import {
  JournalStore,
  readJournalCache,
  replayFrames,
  scrubReplay,
  writeJournalCache,
  type JournalRow,
  type TradeReport
} from "../../src/pump/journal/journal.js";
import { renderDeskReportPng } from "../../src/pump/journal/png.js";
import { buildDeskReport, deskReportLines, deskShareRequest, shareDeskReport } from "../../src/pump/journal/report.js";
import { PumpCore } from "../../src/pump/index.js";
import { assertPubkey, WalletBook, portfolioOf } from "../../src/pump/portfolio/holdings.js";
import { aggregatePnl, positionsOf } from "../../src/pump/portfolio/pnl.js";
import { DESK_SCORE_FORMULA, deskScore } from "../../src/pump/portfolio/score.js";
import type { TradeEvent } from "../../src/pump/types.js";
import { shareDeskReport as shareInBrowser } from "../../web/src/pump/report.js";
import { connectStandard, type StandardWallet } from "../../web/src/pump/wallet/provider.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

interface Fixture {
  now: number;
  marks: Array<{ mint: string; priceLamportsPerToken: string; marketCapLamports: string; progressPct: number; venue: "curve" | "pumpswap" }>;
  wallets: Array<{ pubkey: string; fills: TradeReport[] }>;
  expected: { realizedPnlLamports: string; unrealizedPnlLamports: string; positions: number; score: number; openAvgEntry: string; openTokens: string };
}

function fixture(): Fixture {
  return JSON.parse(readFileSync(path.join(root, "test/fixtures/pump/journal-wallet.json"), "utf8")) as Fixture;
}

function memory(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

describe("pump journal", () => {
  it("logs one row after confirmation and none for a failed transaction", () => {
    const book = fixture();
    const store = new JournalStore(memory());
    const buy = book.wallets[0]!.fills[0]!;
    expect(store.record({ ...buy, confirmation: "failed", err: "slippage" }).logged).toBe(false);
    expect(store.record({ ...buy, confirmation: "processed" }).logged).toBe(false);
    expect(store.record({ ...buy, confirmation: "confirmed", err: "blockhash" }).logged).toBe(false);
    expect(store.count()).toBe(0);
    const first = store.record({ ...buy, source: "desk" });
    const second = store.record({ ...buy, solLamports: "1", source: "desk" });
    expect(first.logged).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(store.count()).toBe(1);
    expect(store.rows()[0]?.solLamports).toBe(buy.solLamports);
    expect(store.rows()[0]?.priceLamportsPerToken).toBe("1000");
    expect(store.rows()[0]?.feeLamports).toBe(buy.feeLamports);
    expect(store.rows()[0]?.marketCapLamports).toBe(buy.marketCapLamports);
  });

  it("exports Eastern timestamps with the daylight-saving offset", () => {
    expect(formatTimestampEt(Date.parse("2026-07-15T18:00:00.000Z"))).toBe("2026-07-15T14:00:00.000-04:00");
    expect(formatTimestampEt(Date.parse("2026-01-15T18:00:00.000Z"))).toBe("2026-01-15T13:00:00.000-05:00");
    expect(formatTimestampEt(Date.parse("2026-03-08T06:30:00.000Z"))).toBe("2026-03-08T01:30:00.000-05:00");
    expect(formatTimestampEt(Date.parse("2026-03-08T07:30:00.000Z"))).toBe("2026-03-08T03:30:00.000-04:00");
    expect(formatTimestampEt(Date.parse("2026-11-01T05:30:00.000Z"))).toBe("2026-11-01T01:30:00.000-04:00");
    expect(formatTimestampEt(Date.parse("2026-11-01T06:30:00.000Z"))).toBe("2026-11-01T01:30:00.000-05:00");
    const csv = journalCsv([
      {
        signature: 'sig,"1"',
        wallet: "w",
        mint: "m",
        side: "sell",
        venue: "curve",
        source: "desk",
        solLamports: "1",
        tokenAmount: "1",
        feeLamports: "0",
        marketCapLamports: "2",
        priceLamportsPerToken: "1",
        timestamp: Date.parse("2026-01-15T18:00:00.000Z"),
        outcome: "unknown_basis",
        realizedPnlLamports: null,
        costBasisReason: "Cost basis is unknown"
      }
    ]);
    expect(csv.split("\n")[1]).toContain("2026-01-15T13:00:00.000-05:00");
    expect(csv).toContain('"sig,""1"""');
    expect(csv).not.toMatch(/,0,unknown_basis/);
  });

  it("scrubs replay along the curve in time order", () => {
    const book = fixture();
    const store = new JournalStore(memory());
    importReports(store, book.wallets.flatMap((wallet) => wallet.fills));
    const frames = replayFrames(store.rows());
    expect(frames.map((frame) => frame.signature)).toEqual(["deskABuy", "deskBBuy", "deskBSell", "deskASell"]);
    expect(scrubReplay(frames, 0)?.marketCapLamports).toBe("30000000000");
    expect(scrubReplay(frames, 99)?.signature).toBe("deskASell");
    expect(scrubReplay(frames, -4)?.signature).toBe("deskABuy");
    const curve = replayFrames(store.rows(), book.wallets[0]!.fills[0]!.mint);
    expect(curve).toHaveLength(2);
  });

  it("caches rows for the web local store", () => {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value)
    };
    const rows = [{ signature: "s" } as JournalRow];
    writeJournalCache(storage, rows);
    expect(readJournalCache(storage)?.[0]?.signature).toBe("s");
  });
});

describe("pump portfolio", () => {
  it("reproduces the fixture wallet PnL and aggregates both wallets", () => {
    const book = fixture();
    const db = memory();
    const store = new JournalStore(db);
    const imported = importReports(store, book.wallets.flatMap((wallet) => wallet.fills));
    expect(imported.logged).toBe(4);
    expect(importReports(store, book.wallets[0]!.fills).duplicates).toBe(2);
    const positions = positionsOf(store.entries(), book.marks);
    const totals = aggregatePnl(positions);
    expect(positions).toHaveLength(book.expected.positions);
    expect(totals.wallets).toHaveLength(2);
    expect(totals.realizedPnlLamports).toBe(book.expected.realizedPnlLamports);
    expect(totals.unrealizedPnlLamports).toBe(book.expected.unrealizedPnlLamports);
    const open = positions.find((position) => position.tokenAmount === book.expected.openTokens);
    expect(open?.avgEntryLamportsPerToken).toBe(book.expected.openAvgEntry);
    expect(open?.curvePosition).toBe("bonding_curve");
    expect(open?.progressPct).toBe(12.5);
    expect(open?.sources).toContain("chain");
    const flat = positions.find((position) => position.curvePosition === "flat");
    expect(flat?.realizedPnlLamports).toBe("29000000");
    const score = deskScore(store.entries(), book.now);
    expect(score.score).toBe(book.expected.score);
    expect(score.formula).toBe(DESK_SCORE_FORMULA);
    expect(score.volumeLamports).toBe("1930000000");
    const wallets = new WalletBook(db);
    for (const wallet of book.wallets) wallets.add(wallet.pubkey, book.now);
    const snap = portfolioOf(db, book.marks, book.now);
    expect(snap.totals.realizedPnlLamports).toBe(book.expected.realizedPnlLamports);
    expect(snap.score.score).toBe(book.expected.score);
  });

  it("withholds PnL when the cost basis is unknown", () => {
    const sell: TradeReport = {
      signature: "orphan",
      wallet: "11111111111111111111111111111111",
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      side: "sell",
      venue: "curve",
      source: "chain",
      solLamports: "1000",
      tokenAmount: "10",
      feeLamports: "0",
      marketCapLamports: "1",
      timestamp: 1700000000000,
      confirmation: "confirmed"
    };
    const [row] = importReports(new JournalStore(memory()), [sell]).rows;
    expect(row?.outcome).toBe("unknown_basis");
    expect(row?.realizedPnlLamports).toBeNull();
    expect(row?.costBasisReason ?? "").toMatch(/unknown/i);
    const [position] = positionsOf([row!]);
    expect(position?.costBasis).toBe("unknown");
    expect(position?.realizedPnlLamports).toBeNull();
    expect(position?.realizedPnlLamports).not.toBe("0");
    expect(position?.costLamports).toBeNull();
    expect(position?.realizedReason ?? "").not.toBe("0");
    expect(aggregatePnl([position!]).realizedPnlLamports).toBeNull();
  });

  it("imports a chain source once per signature and keeps only public keys", async () => {
    const book = fixture();
    const store = new JournalStore(memory());
    const source = {
      fills: async (wallet: string) => book.wallets[0]!.fills.filter((fill) => fill.wallet === wallet).concat({ ...book.wallets[0]!.fills[0]!, signature: "nope", confirmation: "failed" })
    };
    const imported = await importWallet(store, source, book.wallets[0]!.pubkey);
    expect(imported.logged).toBe(2);
    expect(imported.skipped).toBe(1);
    expect(store.count()).toBe(2);
    const wallets = new WalletBook(memory());
    expect(wallets.add(book.wallets[0]!.pubkey, 1).pubkey).toBe(book.wallets[0]!.pubkey);
    expect(() => wallets.add(Buffer.from(Keypair.generate().secretKey).toString("hex"), 1)).toThrow(/public key/i);
    expect(() => assertPubkey("1".repeat(64))).toThrow();
    const event: TradeEvent = {
      mint: book.wallets[1]!.fills[0]!.mint,
      signature: "chainSig",
      isBuy: true,
      user: book.wallets[1]!.pubkey,
      solAmountLamports: "10",
      tokenAmount: "2",
      virtualQuoteReserves: "30",
      virtualTokenReserves: "10",
      realQuoteReserves: "1",
      realTokenReserves: "1",
      feeLamports: "1",
      creator: "11111111111111111111111111111111",
      timestamp: 5,
      quoteMint: null,
      source: "log"
    };
    const reports = reportsFromTrades([event, { ...event, signature: undefined }], { supplyByMint: { [event.mint]: "100" } });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.marketCapLamports).toBe("300");
    expect(reports[0]?.confirmation).toBe("confirmed");
  });
});

describe("desk report share", () => {
  it("shares one png through the injected share sheet and navigator.share", async () => {
    const book = fixture();
    const store = new JournalStore(memory());
    importReports(store, book.wallets.flatMap((wallet) => wallet.fills));
    const positions = positionsOf(store.entries(), book.marks);
    const report = buildDeskReport({
      rows: store.rows(),
      totals: aggregatePnl(positions),
      score: deskScore(store.entries(), book.now),
      generatedAt: book.now
    });
    const png = renderDeskReportPng(deskReportLines(report));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const seen: Array<{ title?: string; files: Array<{ name?: string; type?: string }> }> = [];
    await shareDeskReport(deskShareRequest(png, report), async (data) => {
      seen.push(data);
    });
    expect(seen[0]?.title).toBe("Night Desk report");
    expect(seen[0]?.files[0]?.name).toBe("desk-report.png");
    expect(seen[0]?.files[0]?.type).toBe("image/png");
    const shared: unknown[] = [];
    await shareInBrowser(png, { title: report.title, text: deskReportLines(report).join("\n") }, async (data) => {
      shared.push(data);
    });
    const file = (shared[0] as { files: Array<{ name: string; type: string; constructor: { name: string } }> }).files[0]!;
    expect(file.constructor.name).toBe("File");
    expect(file.type).toBe("image/png");
    expect(file.name).toBe("desk-report.png");
    await expect(shareInBrowser(png, { title: "Night Desk report", text: "report" })).rejects.toThrow(/navigator\.share/);
  });
});

describe("pump journal routes", () => {
  it("records through the core store and imports chain trades for two wallets", async () => {
    const book = fixture();
    const core = new PumpCore({ db: memory(), rpcUrl: "http://127.0.0.1:1", now: () => book.now });
    const failed = await core.handle("POST", new URL("http://desk/api/pump/journal/report"), { ...book.wallets[0]!.fills[0], confirmation: "failed" });
    expect(failed.body).toMatchObject({ ok: true, logged: false, count: 0 });
    const ok = await core.handle("POST", new URL("http://desk/api/pump/journal/report"), { ...book.wallets[0]!.fills[0], source: "desk" });
    expect(ok.body).toMatchObject({ ok: true, logged: true, count: 1 });
    const again = await core.handle("POST", new URL("http://desk/api/pump/journal/report"), book.wallets[0]!.fills[0]);
    expect(again.body).toMatchObject({ logged: true, duplicate: true, count: 1 });
    for (const wallet of book.wallets) {
      const added = await core.handle("POST", new URL("http://desk/api/pump/portfolio/wallets"), { pubkey: wallet.pubkey });
      expect(added.status).toBe(200);
    }
    await core.handle("POST", new URL("http://desk/api/pump/portfolio/import"), {
      fills: book.wallets.flatMap((wallet) => wallet.fills),
      marks: book.marks
    });
    const portfolio = await core.handle("GET", new URL("http://desk/api/pump/portfolio"), {});
    const body = portfolio.body as { portfolio: { totals: { realizedPnlLamports: string }; score: { score: number; formula: string } } };
    expect(body.portfolio.totals.realizedPnlLamports).toBe(book.expected.realizedPnlLamports);
    expect(body.portfolio.score.score).toBe(book.expected.score);
    expect(body.portfolio.score.formula).toContain("holdFactor");
    const csv = await core.handle("GET", new URL("http://desk/api/pump/journal/csv"), {});
    expect(String((csv.body as { csv: string }).csv)).toContain("-05:00");
    const replay = await core.handle("GET", new URL("http://desk/api/pump/journal/replay?index=1"), {});
    expect((replay.body as { frame: { signature: string } }).frame.signature).toBe("deskBBuy");
    const png = await core.handle("GET", new URL("http://desk/api/pump/journal/report.png"), {});
    expect(String((png.body as { pngBase64: string }).pngBase64).length).toBeGreaterThan(20);
    expect((png.body as { lines: string[] }).lines).toContain("TRADES 4");

    const narrowed = new PumpCore({ db: memory(), rpcUrl: "http://127.0.0.1:1", now: () => book.now });
    await narrowed.handle("POST", new URL("http://desk/api/pump/portfolio/wallets"), { pubkey: book.wallets[0]!.pubkey });
    await narrowed.handle("POST", new URL("http://desk/api/pump/portfolio/import"), {
      fills: book.wallets.flatMap((wallet) => wallet.fills),
      marks: book.marks
    });
    const oneWallet = await narrowed.handle("GET", new URL("http://desk/api/pump/journal/report.png"), {});
    const lines = (oneWallet.body as { lines: string[] }).lines;
    expect(lines).toContain("TRADES 2");
    expect(lines).toContain("WALLETS 1");
    expect(lines).toContain("REALIZED +0.391 SOL");
  });
});

describe("readonly wallet adapter", () => {
  it("returns the address from the desk wallet connect and does not sign", async () => {
    let signed = false;
    const wallet: StandardWallet = {
      name: "Test",
      accounts: [],
      features: {
        "standard:connect": {
          connect: async () => ({ accounts: [{ address: "So11111111111111111111111111111111111111112", publicKey: new Uint8Array(32) }] })
        },
        "solana:signTransaction": {
          signTransaction: async () => {
            signed = true;
            return [];
          }
        }
      }
    };
    const connected = await connectStandard(wallet);
    expect(connected.address).toBe("So11111111111111111111111111111111111111112");
    expect(signed).toBe(false);
  });
});
