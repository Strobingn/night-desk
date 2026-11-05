import WebSocket from "ws";
import type { EventBus } from "../bus.js";
import { enrichSighting } from "../market/enrich.js";
import type { DeskEvents, FeedStatus, RawSighting } from "../types.js";

export interface ScoutOptions {
  bus: EventBus<DeskEvents>;
  feedMode: FeedStatus["mode"];
  demo: boolean;
  rpcUrl?: string;
  rugcheckUrl?: string;
  pumpWsUrl: string;
  bitqueryKey?: string;
  /** In-flight enrichments. Default 6, clamped 1–12 by config. */
  enrichConcurrency?: number;
  /** Pending sightings before the oldest is dropped. Default 160. */
  queueCap?: number;
  /** Helius DAS pages past the 20-account RPC cap. Ignored on a public RPC. */
  holderPagesMax?: number;
  fetchImpl?: typeof fetch;
  onStatus: (patch: Partial<FeedStatus>) => void;
}

/**
 * Scout is the only publisher of `scout.candidate`.
 * Live sightings are enriched, then handed to Filter. They never skip ahead.
 */
export class Scout {
  private seen = new Set<string>();
  private queue: RawSighting[] = [];
  private active = 0;
  private stopped = false;
  private readonly concurrency: number;
  private readonly queueCap: number;
  private pump: WebSocket | null = null;
  private pumpTimer: NodeJS.Timeout | null = null;
  private dexTimer: NodeJS.Timeout | null = null;
  private bitqueryTimer: NodeJS.Timeout | null = null;
  readonly status: FeedStatus;

  constructor(private readonly opts: ScoutOptions) {
    this.concurrency = clampInt(opts.enrichConcurrency, 6, 1, 12);
    this.queueCap = clampInt(opts.queueCap, 160, 1, 2000);
    this.status = {
      mode: opts.feedMode,
      demo: opts.demo,
      pumpConnected: false,
      dexLastPollAt: null,
      sightings: 0,
      enriched: 0,
      dropped: 0
    };
  }

  start(): void {
    if (this.opts.feedMode === "replay") return;
    this.connectPump();
    void this.pollDex();
    this.dexTimer = setInterval(() => void this.pollDex(), 25_000);
    if (this.opts.bitqueryKey) {
      void this.pollBitquery();
      this.bitqueryTimer = setInterval(() => void this.pollBitquery(), 30_000);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    if (this.dexTimer) clearInterval(this.dexTimer);
    if (this.bitqueryTimer) clearInterval(this.bitqueryTimer);
    this.pump?.close();
  }

  /** Replay and tests enter here — the same topic live enrichment publishes. */
  publish(token: DeskEvents["scout.candidate"]): void {
    this.opts.bus.emit("scout.candidate", token);
  }

  tick(mint: string, priceUsd: number): void {
    this.opts.bus.emit("market.tick", { mint, priceUsd, at: Date.now() });
  }

  ingest(raw: RawSighting): void {
    if (!raw.mint || this.seen.has(raw.mint)) return;
    this.seen.add(raw.mint);
    if (this.seen.size > 8000) {
      const first = this.seen.values().next().value;
      if (first) this.seen.delete(first);
    }
    this.status.sightings += 1;
    if (this.queue.length >= this.queueCap) {
      this.queue.shift();
      this.status.dropped += 1;
    }
    this.queue.push(raw);
    this.opts.onStatus({ ...this.status });
    this.drain();
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const raw = this.queue.shift()!;
      this.active += 1;
      void this.enrich(raw).finally(() => {
        this.active -= 1;
        this.drain();
      });
    }
  }

  private async enrich(raw: RawSighting): Promise<void> {
    try {
      const token = await enrichSighting(raw, {
        rpcUrl: this.opts.rpcUrl,
        rugcheckUrl: this.opts.rugcheckUrl,
        fetchImpl: this.opts.fetchImpl,
        holderPagesMax: this.opts.holderPagesMax
      });
      this.status.enriched += 1;
      this.opts.onStatus({ ...this.status });
      this.publish(token);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status.lastError = message;
      this.opts.onStatus({ ...this.status });
    }
  }

  private connectPump(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.pumpWsUrl);
    } catch (err) {
      this.noteError(err);
      this.schedulePumpReconnect();
      return;
    }
    this.pump = ws;
    ws.on("open", () => {
      this.status.pumpConnected = true;
      this.opts.onStatus({ ...this.status });
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    });
    ws.on("message", (buf) => {
      try {
        const msg = JSON.parse(buf.toString()) as {
          mint?: string;
          symbol?: string;
          name?: string;
          traderPublicKey?: string;
          txType?: string;
        };
        if (!msg.mint) return;
        if (msg.txType && msg.txType !== "create") return;
        this.ingest({
          mint: msg.mint,
          symbol: msg.symbol,
          name: msg.name,
          source: "pumpfun",
          devWallet: msg.traderPublicKey,
          observedAt: Date.now()
        });
      } catch {
        /* malformed frame */
      }
    });
    ws.on("close", () => {
      this.status.pumpConnected = false;
      this.opts.onStatus({ ...this.status });
      this.schedulePumpReconnect();
    });
    ws.on("error", (err) => {
      this.noteError(err);
      this.status.pumpConnected = false;
      this.opts.onStatus({ ...this.status });
    });
  }

  private schedulePumpReconnect(): void {
    if (this.stopped) return;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = setTimeout(() => this.connectPump(), 5_000);
  }

  private async pollDex(): Promise<void> {
    if (this.stopped) return;
    try {
      const res = await fetch("https://api.dexscreener.com/token-profiles/latest/v1", {
        headers: { accept: "application/json", "user-agent": "night-desk/1.0" },
        signal: AbortSignal.timeout(5000)
      });
      if (!res.ok) throw new Error(`dexscreener HTTP ${res.status}`);
      const rows = (await res.json()) as Array<{ chainId?: string; tokenAddress?: string; description?: string }>;
      this.status.dexLastPollAt = Date.now();
      this.opts.onStatus({ ...this.status });
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        if (row.chainId !== "solana" || !row.tokenAddress) continue;
        this.ingest({
          mint: row.tokenAddress,
          source: "raydium",
          observedAt: Date.now()
        });
      }
    } catch (err) {
      this.noteError(err);
    }
  }

  /**
   * Optional Bitquery poll. Requires BITQUERY_API_KEY. Failures stay on the feed status
   * and never block PumpPortal or DexScreener.
   */
  private async pollBitquery(): Promise<void> {
    if (this.stopped || !this.opts.bitqueryKey) return;
    const query = `
      query {
        Solana {
          DEXTrades(limit: { count: 15 }, orderBy: { descending: Block_Time }) {
            Trade {
              Buy { Currency { MintAddress Symbol Name } }
            }
          }
        }
      }`;
    try {
      const res = await fetch("https://streaming.bitquery.io/graphql", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.bitqueryKey}`
        },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(6000)
      });
      if (!res.ok) throw new Error(`bitquery HTTP ${res.status}`);
      const body = (await res.json()) as {
        data?: { Solana?: { DEXTrades?: Array<{ Trade?: { Buy?: { Currency?: { MintAddress?: string; Symbol?: string; Name?: string } } } }> } };
      };
      const trades = body.data?.Solana?.DEXTrades ?? [];
      for (const trade of trades) {
        const cur = trade.Trade?.Buy?.Currency;
        if (!cur?.MintAddress) continue;
        this.ingest({
          mint: cur.MintAddress,
          symbol: cur.Symbol,
          name: cur.Name,
          source: "raydium",
          observedAt: Date.now()
        });
      }
    } catch (err) {
      this.noteError(err);
    }
  }

  private noteError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.status.lastError = message;
    this.opts.onStatus({ ...this.status });
  }
}

function clampInt(raw: number | undefined, fallback: number, min: number, max: number): number {
  const n = raw == null || !Number.isFinite(raw) ? fallback : Math.floor(raw);
  return Math.min(max, Math.max(min, n));
}
