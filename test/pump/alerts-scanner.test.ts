import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { AlertEngine } from "../../src/pump/alerts/engine.js";
import { countOwners, readPagedHolderCount } from "../../src/pump/alerts/holders.js";
import { fcmPayload, sendFcm } from "../../src/pump/alerts/fcm.js";
import { DEFAULT_NIGHT, inNightWindow } from "../../src/pump/alerts/night.js";
import { parseRules, type AlertRule, type AlertSample } from "../../src/pump/alerts/rules.js";
import { webPushPayload } from "../../src/pump/alerts/webpush.js";
import { routePumpExtras, type PumpHost } from "../../src/pump/features/extras.js";
import { PumpCore } from "../../src/pump/index.js";
import { bondingCurvePda, GLOBAL_PDA } from "../../src/pump/sdk.js";
import { PUMP_PROGRAM } from "../../src/pump/constants.js";
import { PumpSafety } from "../../src/pump/safety.js";
import { PumpStore } from "../../src/pump/store.js";
import type { PumpConnection } from "../../src/pump/rpc.js";
import { rankCoins, scoreCoin, type ScanInput } from "../../src/pump/scanner/score.js";
import { approveIntent } from "../../web/src/pump/wallet/sign.js";
import { autoBuyBest, AUTO_BUY_COOLDOWN_MS, HotScanner, SCAN_INTERVAL_MS, SCAN_TOP_N } from "../../src/pump/scanner/scanner.js";
import type { TradeIntent } from "../../src/pump/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function rule(partial: Partial<AlertRule> & Pick<AlertRule, "id" | "kind" | "threshold">): AlertRule {
  return {
    mint: "",
    hysteresis: 0,
    cooldownMs: 0,
    delivery: "sound",
    enabled: true,
    ...partial
  };
}

function sample(partial: Partial<AlertSample> & Pick<AlertSample, "at">): AlertSample {
  return { mint: "Mint111", ...partial };
}

describe("alert engine", () => {
  it("fires once per threshold crossing and re-arms only below the hysteresis band", () => {
    const engine = new AlertEngine([rule({ id: "px", kind: "price", threshold: 10, hysteresis: 2, cooldownMs: 1_000 })]);
    const first = engine.evaluate(sample({ at: 0, price: 10 }));
    const held = engine.evaluate(sample({ at: 50, price: 14 }));
    const inside = engine.evaluate(sample({ at: 80, price: 9 }));
    expect(first).toHaveLength(1);
    expect(first[0]?.delivery).toBe("sound");
    expect(held).toHaveLength(0);
    expect(inside).toHaveLength(0);

    expect(engine.evaluate(sample({ at: 100, price: 7 }))).toHaveLength(0);
    const cooled = engine.evaluate(sample({ at: 200, price: 11 }));
    expect(cooled).toHaveLength(0);
    expect(engine.evaluate(sample({ at: 2_000, price: 12 }))).toHaveLength(0);
    expect(engine.evaluate(sample({ at: 2_100, price: 7 }))).toHaveLength(0);
    const again = engine.evaluate(sample({ at: 2_200, price: 10 }));
    expect(again).toHaveLength(1);
    expect(again[0]?.id).not.toBe(first[0]?.id);
  });

  it("fires each mcap milestone once when price jumps across several steps", () => {
    const engine = new AlertEngine([
      rule({ id: "mcap", kind: "mcap", threshold: 50, hysteresis: 5, milestoneStep: 50, delivery: "fullscreen" })
    ]);
    expect(engine.evaluate(sample({ at: 1, marketCapLamports: 40 }))).toHaveLength(0);
    const first = engine.evaluate(sample({ at: 2, marketCapLamports: 50 }));
    expect(first.map((alert) => alert.threshold)).toEqual([50]);
    const jump = engine.evaluate(sample({ at: 3, marketCapLamports: 160 }));
    expect(jump.map((alert) => alert.threshold)).toEqual([100, 150]);
    expect(engine.evaluate(sample({ at: 4, marketCapLamports: 180 }))).toHaveLength(0);
    engine.evaluate(sample({ at: 5, marketCapLamports: 40 }));
    expect(engine.evaluate(sample({ at: 6, marketCapLamports: 50 })).map((alert) => alert.threshold)).toEqual([50]);
  });

  it("fires curve, graduation, large buy, and whale sell once per crossing", () => {
    const engine = new AlertEngine([
      rule({ id: "curve", kind: "curve", threshold: 50, hysteresis: 5 }),
      rule({ id: "grad", kind: "graduation", threshold: 1, delivery: "fullscreen" }),
      rule({ id: "buy", kind: "large_buy", threshold: 1_000, cooldownMs: 500 }),
      rule({ id: "sell", kind: "whale_sell", threshold: 2_000, delivery: "silent" })
    ]);
    expect(engine.evaluate(sample({ at: 1, progressPct: 49 }))).toHaveLength(0);
    expect(engine.evaluate(sample({ at: 2, progressPct: 50 }))).toHaveLength(1);
    expect(engine.evaluate(sample({ at: 3, progressPct: 80 }))).toHaveLength(0);

    expect(engine.evaluate(sample({ at: 4, graduated: false }))).toHaveLength(0);
    expect(engine.evaluate(sample({ at: 5, graduated: true }))).toHaveLength(1);
    expect(engine.evaluate(sample({ at: 6, graduated: true }))).toHaveLength(0);

    const buy = { lamports: 1_500, signature: "sig-a" };
    expect(engine.evaluate(sample({ at: 7, buy }))).toHaveLength(1);
    expect(engine.evaluate(sample({ at: 8, buy }))).toHaveLength(0);
    expect(engine.evaluate(sample({ at: 9, buy: { lamports: 5_000, signature: "sig-b" } }))).toHaveLength(0);
    expect(engine.evaluate(sample({ at: 800, buy: { lamports: 5_000, signature: "sig-c" } }))).toHaveLength(1);

    expect(engine.evaluate(sample({ at: 900, sell: { lamports: 100, signature: "small" } }))).toHaveLength(0);
    const whale = engine.evaluate(sample({ at: 901, sell: { lamports: 2_000, signature: "whale" } }));
    expect(whale).toHaveLength(1);
    expect(whale[0]?.delivery).toBe("silent");
    expect(engine.evaluate(sample({ at: 902, sell: { lamports: 9_000, signature: "whale" } }))).toHaveLength(0);
  });

  it("alerts on holder delta from a paged count, once per burst", () => {
    const engine = new AlertEngine([rule({ id: "holders", kind: "holders", threshold: 10, hysteresis: 3, delivery: "silent" })]);
    expect(engine.evaluate(sample({ at: 1, holderCount: 10 }))).toHaveLength(0);
    const gained = engine.evaluate(sample({ at: 2, holderCount: 25 }));
    expect(gained).toHaveLength(1);
    expect(gained[0]?.value).toBe(15);
    expect(engine.evaluate(sample({ at: 3, holderCount: 40 }))).toHaveLength(0);
    expect(engine.evaluate(sample({ at: 4, holderCount: 41 }))).toHaveLength(0);
    expect(engine.evaluate(sample({ at: 5, holderCount: 60 }))).toHaveLength(1);
  });

  it("counts owners from paged rows and ignores a DAS total", async () => {
    const reserve = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
    const pages = [
      { total: 9_999, token_accounts: [{ owner: "alice", amount: 5 }, { owner: reserve, amount: 9 }] },
      { total: 1, token_accounts: [{ owner: "alice", amount: 1 }, { owner: "bob", amount: 2 }] }
    ];
    expect(countOwners(pages)).toBe(2);

    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({ result: { total: 50_000, token_accounts: [{ owner: "carol", amount: "4" }] } })
    })) as unknown as typeof fetch;
    const read = await readPagedHolderCount({ rpcUrl: "http://rpc", mint: "Mint", maxPages: 2, fetchImpl });
    expect(read.holderCount).toBe(1);
    expect(read.pagesRead).toBe(1);
  });

  it("builds silent web push and skips FCM without a server key", async () => {
    const engine = new AlertEngine([rule({ id: "sell", kind: "whale_sell", threshold: 1, delivery: "silent" })]);
    const alert = engine.evaluate(sample({ at: 1, sell: { lamports: 5, signature: "s" } }))[0]!;
    const note = webPushPayload(alert);
    expect(note.options.silent).toBe(true);
    expect(note.options.tag).toBe(alert.id);
    const payload = fcmPayload({ ...alert, delivery: "fullscreen" }, "device");
    expect(payload.priority).toBe("high");
    expect(payload.data.fullscreen).toBe("1");
    const skipped = await sendFcm(alert, { token: "", serverKey: "" });
    expect(skipped).toEqual({ delivered: false, reason: "local-only" });
  });

  it("follows an overnight night-mode schedule", () => {
    const night = { ...DEFAULT_NIGHT, enabled: true, startMin: 22 * 60, endMin: 7 * 60 };
    expect(inNightWindow(night, new Date(2026, 10, 4, 23, 15))).toBe(true);
    expect(inNightWindow(night, new Date(2026, 10, 4, 6, 30))).toBe(true);
    expect(inNightWindow(night, new Date(2026, 10, 4, 7, 0))).toBe(false);
    expect(inNightWindow(night, new Date(2026, 10, 4, 12, 0))).toBe(false);
    expect(inNightWindow({ ...night, enabled: false }, new Date(2026, 10, 4, 23, 0))).toBe(false);
    const rules = parseRules([{ id: "curve-50", kind: "curve", mint: "", threshold: 50, hysteresis: 5, cooldownMs: 0, delivery: "sound", enabled: true }]);
    expect(rules).toHaveLength(1);
  });
});

describe("hot scanner", () => {
  const now = 1_700_000_000_000;
  function coin(partial: Partial<ScanInput> & Pick<ScanInput, "mint">): ScanInput {
    return {
      createdAt: now,
      volumeLamports: 10_000_000_000,
      progressPct: 100,
      buyLamports: 10_000_000_000,
      sellLamports: 0,
      uniqueBuyers: 40,
      holderGrowth: 25,
      ...partial
    };
  }

  it("scores a clean new coin and forces 0 on every rug flag", () => {
    expect(scoreCoin(coin({ mint: "clean" }), now).score).toBe(1);
    expect(scoreCoin(coin({ mint: "dev", devHoldingPct: 0.11 }), now).score).toBe(0);
    expect(scoreCoin(coin({ mint: "top", top10HoldingPct: 0.31 }), now).score).toBe(0);
    expect(scoreCoin(coin({ mint: "mint", mintAuthority: "Auth111" }), now).score).toBe(0);
    expect(scoreCoin(coin({ mint: "freeze", freezeAuthority: "Auth111" }), now).score).toBe(0);
    expect(scoreCoin(coin({ mint: "dump", creatorDumping: true }), now).score).toBe(0);
    expect(scoreCoin(coin({ mint: "revoked", mintAuthority: "11111111111111111111111111111111" }), now).score).toBe(1);
    const ranked = rankCoins(
      [coin({ mint: "rug", creatorDumping: true }), ...Array.from({ length: 21 }, (_, i) => coin({ mint: `m${String(i).padStart(2, "0")}`, volumeLamports: i * 1_000_000_000 }))],
      now,
      SCAN_TOP_N
    );
    expect(ranked).toHaveLength(20);
    expect(ranked.some((row) => row.mint === "rug")).toBe(false);
    expect(ranked[0]?.score).toBeGreaterThan(ranked[19]?.score ?? 0);
  });

  it("refreshes on a 5s cadence and prepares at most one simulate buy per 10 minutes unless armed", async () => {
    let clock = now;
    const scanner = new HotScanner(() => clock);
    expect(scanner.due(clock)).toBe(true);
    scanner.replace([coin({ mint: "best" })], clock);
    expect(scanner.top()).toHaveLength(1);
    expect(scanner.due(clock + SCAN_INTERVAL_MS - 1)).toBe(false);
    expect(scanner.due(clock + SCAN_INTERVAL_MS)).toBe(true);

    const calls: boolean[] = [];
    const prepare = async (input: { live: boolean; solLamports: string }): Promise<TradeIntent> => {
      calls.push(input.live);
      return intent(input.live, input.solLamports);
    };
    const disarmed = await autoBuyBest([{ mint: "best", score: 1 }], {
      enabled: true,
      armed: false,
      liveRequested: true,
      wallet: "Wallet",
      solLamports: 1_000n,
      now: clock,
      lastBuyAt: null,
      assertRoom: () => {},
      prepare
    });
    expect(disarmed.simulateOnly).toBe(true);
    expect(disarmed.intent?.mode).toBe("simulate");
    expect(disarmed.intent?.simulateOnly).toBe(true);
    expect(calls).toEqual([false]);

    const blocked = await autoBuyBest([{ mint: "best", score: 1 }], {
      enabled: true,
      armed: true,
      liveRequested: true,
      wallet: "Wallet",
      solLamports: 1_000n,
      now: clock + 1_000,
      lastBuyAt: disarmed.lastBuyAt,
      assertRoom: () => {},
      prepare
    });
    expect(blocked.reason).toBe("cooldown");
    expect(blocked.intent).toBeNull();
    expect(calls).toEqual([false]);

    const armed = await autoBuyBest([{ mint: "rug", score: 0 }, { mint: "best", score: 0.4 }], {
      enabled: true,
      armed: true,
      liveRequested: true,
      wallet: "Wallet",
      solLamports: 1_000n,
      now: clock + AUTO_BUY_COOLDOWN_MS,
      lastBuyAt: disarmed.lastBuyAt,
      assertRoom: () => {},
      prepare
    });
    expect(armed.intent?.simulateOnly).toBe(false);
    expect(armed.intent?.mode).toBe("live");
    expect(armed.intent?.unsignedTx).toBe("unsigned");
    expect(calls).toEqual([false, true]);

    await expect(
      autoBuyBest([{ mint: "best", score: 1 }], {
        enabled: true,
        armed: true,
        liveRequested: false,
        wallet: "Wallet",
        solLamports: 9_000_000_000n,
        now: clock + AUTO_BUY_COOLDOWN_MS * 2,
        lastBuyAt: null,
        assertRoom: () => {
          throw new Error("cap");
        },
        prepare
      })
    ).rejects.toThrow("cap");
  });
});

describe("pump alert routes", () => {
  it("keeps an auto-buy simulate-only until the core session is armed", async () => {
    const db = new DatabaseSync(":memory:");
    const mint = Keypair.generate().publicKey;
    const wallet = Keypair.generate().publicKey;
    let now = 1_700_000_000_000;
    const core = new PumpCore({ db, rpcUrl: "http://127.0.0.1", connection: world(mint), now: () => now });
    const listed = await core.handle("POST", new URL("http://desk/api/pump/scanner"), {
      coins: [
        {
          mint: mint.toBase58(),
          createdAt: now,
          volumeLamports: 10_000_000_000,
          progressPct: 40,
          buyLamports: 8_000_000_000,
          sellLamports: 1_000_000_000,
          uniqueBuyers: 12,
          holderGrowth: 8
        }
      ]
    });
    expect(listed.status).toBe(200);
    expect((listed.body as { coins: Array<{ score: number }> }).coins[0]?.score).toBeGreaterThan(0);

    const over = await core.handle("POST", new URL("http://desk/api/pump/scanner/auto-buy"), {
      enabled: true,
      wallet: wallet.toBase58(),
      solLamports: "6000000",
      live: true
    });
    expect(over.status).toBe(409);

    const sim = await core.handle("POST", new URL("http://desk/api/pump/scanner/auto-buy"), {
      enabled: true,
      wallet: wallet.toBase58(),
      solLamports: "1000000",
      live: true
    });
    expect(sim.status).toBe(200);
    const first = (sim.body as { intent: TradeIntent; reason: string }).intent;
    expect((sim.body as { reason: string }).reason).toBe("prepared");
    expect(first.simulateOnly).toBe(true);
    expect(first.mode).toBe("simulate");
    let opens = 0;
    const opener = {
      address: wallet.toBase58(),
      open: async (bytes: Uint8Array) => {
        opens += 1;
        return bytes;
      }
    };
    const closed = await approveIntent({
      unsignedTx: first.unsignedTx,
      wallet: first.wallet,
      amountLamports: BigInt(first.solLamports),
      capLamports: 5_000_000n,
      simulateOnly: first.simulateOnly,
      opener
    });
    expect(closed.code).toBe("SIMULATED");
    expect(closed.opened).toBe(false);
    expect(opens).toBe(0);
    const tx = Transaction.from(Buffer.from(first.unsignedTx!, "base64"));
    expect(tx.signatures.every((entry) => entry.signature == null)).toBe(true);

    now += 1_000;
    const early = await core.handle("POST", new URL("http://desk/api/pump/scanner/auto-buy"), {
      enabled: true,
      wallet: wallet.toBase58(),
      solLamports: "1000000",
      live: true
    });
    expect((early.body as { reason: string }).reason).toBe("cooldown");

    now += AUTO_BUY_COOLDOWN_MS;
    await core.handle("POST", new URL("http://desk/api/pump/arm"), { confirm: true, wallet: wallet.toBase58() });
    const live = await core.handle("POST", new URL("http://desk/api/pump/scanner/auto-buy"), {
      enabled: true,
      wallet: wallet.toBase58(),
      solLamports: "1000000",
      live: true
    });
    const armedIntent = (live.body as { intent: TradeIntent }).intent;
    expect(armedIntent.simulateOnly).toBe(false);
    expect(armedIntent.mode).toBe("live");
    expect(Transaction.from(Buffer.from(armedIntent.unsignedTx!, "base64")).signatures.every((entry) => entry.signature == null)).toBe(true);
    const signed = await approveIntent({
      unsignedTx: armedIntent.unsignedTx,
      wallet: armedIntent.wallet,
      amountLamports: BigInt(armedIntent.solLamports),
      capLamports: 5_000_000n,
      simulateOnly: armedIntent.simulateOnly,
      opener
    });
    expect(signed.code).toBe("SIGNED");
    expect(signed.opened).toBe(true);
    expect(opens).toBe(1);
    expect(signed.message).toContain("does not broadcast");
  });

  it("evaluates a posted holder page without trusting total", async () => {
    const db = new DatabaseSync(":memory:");
    const store = new PumpStore(db);
    const safety = new PumpSafety(store, () => 10);
    const core = {};
    const host: PumpHost = {
      now: () => 10,
      db,
      rpcUrl: "http://rpc",
      safety,
      prepare: async () => {
        throw new Error("no");
      },
      listCoins: () => [],
      recentTrades: () => [],
      emitAlert: () => {}
    };
    await routePumpExtras(core, "POST", "/api/pump/alert-rules", new URL("http://desk/api/pump/alert-rules"), {
      rules: [rule({ id: "holders", kind: "holders", threshold: 1, hysteresis: 0, delivery: "silent" })]
    }, host);
    const first = await routePumpExtras(core, "POST", "/api/pump/alert-holders", new URL("http://desk/api/pump/alert-holders"), {
      mint: "Mint",
      holderPages: [{ total: 100, token_accounts: [{ owner: "a", amount: 1 }] }]
    }, host);
    expect((first!.body as { holderCount: number }).holderCount).toBe(1);
    expect((first!.body as { alerts: unknown[] }).alerts).toHaveLength(0);
    const second = await routePumpExtras(core, "POST", "/api/pump/alert-holders", new URL("http://desk/api/pump/alert-holders"), {
      mint: "Mint",
      holderPages: [{ total: 0, token_accounts: [{ owner: "a", amount: 1 }, { owner: "b", amount: 1 }] }]
    }, host);
    expect((second!.body as { alerts: Array<{ value: number }> }).alerts).toHaveLength(1);
  });

  it("ships a service worker and declares the Android full-screen intent", () => {
    const sw = readFileSync(path.join(root, "web/public/sw.js"), "utf8");
    expect(sw).toContain("showNotification");
    expect(sw).toContain("SHOW_ALERT");
    expect(sw).toContain("push");
    const manifest = readFileSync(path.join(root, "android/app/src/main/AndroidManifest.xml"), "utf8");
    expect(manifest).toContain("android.permission.USE_FULL_SCREEN_INTENT");
    const notifier = readFileSync(path.join(root, "android/app/src/main/java/com/dirk/nightdesk/pump/alerts/AlertNotifier.kt"), "utf8");
    expect(notifier).toContain("canUseFullScreenIntent");
    expect(notifier).toContain("setFullScreenIntent");
    const gate = readFileSync(path.join(root, "android/app/src/main/java/com/dirk/nightdesk/pump/alerts/FullScreenGate.kt"), "utf8");
    expect(gate).toContain("ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT");
    expect(gate).toContain("package:");
  });
});

function intent(live: boolean, sol: string): TradeIntent {
  return {
    id: "i",
    mint: "best",
    side: "buy",
    venue: "curve",
    wallet: "Wallet",
    solLamports: sol,
    tokenAmount: "1",
    mode: live ? "live" : "simulate",
    simulateOnly: !live,
    unsignedTx: "unsigned",
    feePayer: "Wallet",
    simulation: { ok: true },
    createdAt: 1,
    status: "reserved"
  };
}

function mintData(supply: bigint): Buffer {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default
    },
    data
  );
  return data;
}

function world(mint: PublicKey): PumpConnection {
  const curve = Buffer.from(JSON.parse(readFileSync(path.join(root, "test/fixtures/pump/curve.json"), "utf8")).base64, "base64");
  const global = Buffer.from(JSON.parse(readFileSync(path.join(root, "test/fixtures/pump/global.json"), "utf8")).base64, "base64");
  const map = new Map<string, { data: Buffer; owner: string }>([
    [mint.toBase58(), { data: mintData(1_000_000_000_000_000n), owner: TOKEN_PROGRAM_ID.toBase58() }],
    [bondingCurvePda(mint).toBase58(), { data: curve, owner: PUMP_PROGRAM.toBase58() }]
  ]);
  return {
    async getAccountInfo(address: string) {
      return map.get(address) ?? (address === GLOBAL_PDA.toBase58() ? { data: global, owner: PUMP_PROGRAM.toBase58() } : null);
    },
    async getLatestBlockhash() {
      return PublicKey.default.toBase58();
    },
    async simulateTransaction() {
      return { err: null, units: 12, logs: ["simulated"] };
    }
  };
}
