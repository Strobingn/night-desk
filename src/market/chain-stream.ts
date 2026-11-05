/**
 * v13.8 websocket account stream for held coins' pool / curve accounts.
 * accountSubscribe (base64, processed) on the RPC's ws endpoint; every change is handed to
 * the reader so the held mark updates as soon as the pool moves. The 1 s poll stays on as the
 * fallback. Rate-limit friendly: one socket, subscriptions only for held pools (capped),
 * exponential reconnect backoff (1 s → 60 s), and a 60 s cool-off after an HTTP 429 / rate error.
 * Never logs the RPC URL (it may carry an API key).
 */
import WebSocket from "ws";

export const STREAM_MAX_SUBS = 60;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const RATE_COOL_MS = 60_000;

/** http(s)://host/path?q → ws(s)://host/path?q. Null when it is not an http(s) URL. */
export function wsUrlFor(rpcUrl: string | undefined | null): string | null {
  if (!rpcUrl) return null;
  try {
    const u = new URL(rpcUrl);
    if (u.protocol === "https:") u.protocol = "wss:";
    else if (u.protocol === "http:") u.protocol = "ws:";
    else if (u.protocol !== "wss:" && u.protocol !== "ws:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export interface StreamStats {
  connected: boolean;
  subscriptions: number;
  wanted: number;
  updates: number;
  lastUpdateAt: number | null;
  reconnects: number;
  lastError: string | null;
}

type SocketLike = Pick<WebSocket, "send" | "close" | "on" | "readyState">;

export class ChainStream {
  private ws: SocketLike | null = null;
  private wanted = new Set<string>();
  /** Held-pool keys from the pricer. */
  private base = new Set<string>();
  /** Pump curve / pool keys. Kept when the pricer replaces `base`. */
  private extra = new Set<string>();
  /** key → subscription id */
  private readonly subs = new Map<string, number>();
  /** subscription id → key */
  private readonly bySub = new Map<number, string>();
  /** request id → key (pending subscribe) */
  private readonly pending = new Map<number, string>();
  private id = 0;
  private backoff = BACKOFF_MIN_MS;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private stats_: StreamStats = { connected: false, subscriptions: 0, wanted: 0, updates: 0, lastUpdateAt: null, reconnects: 0, lastError: null };

  constructor(
    private readonly url: string,
    private readonly onAccount: (key: string, data: Uint8Array, at: number) => void,
    private readonly opts: { maxSubs?: number; now?: () => number; connect?: (url: string) => SocketLike } = {}
  ) {}

  stats(): StreamStats {
    return { ...this.stats_, subscriptions: this.subs.size, wanted: this.wanted.size };
  }

  connected(): boolean {
    return this.stats_.connected;
  }

  /** The accounts to watch now. Diffed against the open subscriptions. */
  setKeys(keys: Iterable<string>): void {
    if (this.stopped) return;
    const cap = this.opts.maxSubs ?? STREAM_MAX_SUBS;
    this.base = new Set([...keys].slice(0, cap));
    this.reconcile();
  }

  /**
   * Extra accounts (pump bonding curves and PumpSwap pools) that survive a later `setKeys`
   * from the position pricer. One RPC socket, shared. Room left after `base` is the cap.
   */
  setExtraKeys(keys: Iterable<string>): void {
    if (this.stopped) return;
    const cap = this.opts.maxSubs ?? STREAM_MAX_SUBS;
    const room = Math.max(0, cap - this.base.size);
    this.extra = new Set([...keys].filter((key) => !this.base.has(key)).slice(0, room));
    this.reconcile();
  }

  private reconcile(): void {
    const cap = this.opts.maxSubs ?? STREAM_MAX_SUBS;
    const next = new Set([...this.base, ...this.extra].slice(0, cap));
    const same = next.size === this.wanted.size && [...next].every((k) => this.wanted.has(k));
    if (same) return;
    const removed = [...this.wanted].filter((k) => !next.has(k));
    this.wanted = next;
    if (!this.wanted.size) {
      this.close();
      return;
    }
    if (!this.ws) {
      if (!this.timer) this.connect();
      return;
    }
    if (this.stats_.connected) {
      for (const key of removed) this.unsubscribe(key);
      for (const key of this.wanted) if (!this.subs.has(key) && ![...this.pending.values()].includes(key)) this.subscribe(key);
    }
  }

  stop(): void {
    this.stopped = true;
    this.close();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    this.subs.clear();
    this.bySub.clear();
    this.pending.clear();
    this.stats_.connected = false;
    try {
      ws?.close();
    } catch {
      /* closing */
    }
  }

  private connect(): void {
    if (this.stopped || this.ws || !this.wanted.size) return;
    let ws: SocketLike;
    try {
      ws = this.opts.connect ? this.opts.connect(this.url) : new WebSocket(this.url, { handshakeTimeout: 8_000 });
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.stats_.connected = true;
      this.backoff = BACKOFF_MIN_MS;
      for (const key of this.wanted) this.subscribe(key);
    });
    ws.on("message", (raw: WebSocket.RawData) => {
      if (this.ws !== ws) return;
      this.onMessage(String(raw));
    });
    ws.on("unexpected-response", (_req: unknown, res: { statusCode?: number }) => {
      if (this.ws !== ws) return;
      this.fail(`ws HTTP ${res?.statusCode ?? "?"}`, res?.statusCode === 429);
    });
    ws.on("error", (err: Error) => {
      if (this.ws !== ws) return;
      this.fail(err.message, /429|rate/i.test(err.message));
    });
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.fail(this.stats_.lastError ?? "closed");
    });
  }

  private fail(message: string, rate = false): void {
    // Keep only the message class, never the URL.
    this.stats_.lastError = message.replace(/[a-z]+:\/\/\S+/gi, "<rpc>").slice(0, 120);
    const ws = this.ws;
    this.ws = null;
    this.subs.clear();
    this.bySub.clear();
    this.pending.clear();
    this.stats_.connected = false;
    try {
      ws?.close();
    } catch {
      /* closing */
    }
    if (this.stopped || !this.wanted.size || this.timer) return;
    const wait = rate ? Math.max(RATE_COOL_MS, this.backoff) : this.backoff;
    this.backoff = Math.min(BACKOFF_MAX_MS, this.backoff * 2);
    this.stats_.reconnects += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, wait);
    this.timer.unref?.();
  }

  private subscribe(key: string): void {
    const id = ++this.id;
    this.pending.set(id, key);
    this.send({ jsonrpc: "2.0", id, method: "accountSubscribe", params: [key, { encoding: "base64", commitment: "processed" }] });
  }

  private unsubscribe(key: string): void {
    const sub = this.subs.get(key);
    if (sub == null) return;
    this.subs.delete(key);
    this.bySub.delete(sub);
    this.send({ jsonrpc: "2.0", id: ++this.id, method: "accountUnsubscribe", params: [sub] });
  }

  private send(body: unknown): void {
    try {
      this.ws?.send(JSON.stringify(body));
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  /** Public for tests. */
  onMessage(text: string): void {
    let msg: { id?: number; result?: unknown; error?: { code?: number; message?: string }; method?: string; params?: { subscription?: number; result?: { context?: unknown; value?: { data?: unknown } | null } } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const key = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (typeof msg.result === "number") {
        if (!this.wanted.has(key)) {
          this.send({ jsonrpc: "2.0", id: ++this.id, method: "accountUnsubscribe", params: [msg.result] });
          return;
        }
        this.subs.set(key, msg.result);
        this.bySub.set(msg.result, key);
      } else if (msg.error) {
        const text = `${msg.error.code ?? ""} ${msg.error.message ?? "subscribe error"}`.trim();
        this.stats_.lastError = text.slice(0, 120);
        if (/429|rate|too many/i.test(text)) this.fail(text, true);
      }
      return;
    }
    if (msg.method !== "accountNotification") return;
    const sub = msg.params?.subscription;
    const key = typeof sub === "number" ? this.bySub.get(sub) : undefined;
    const data = msg.params?.result?.value?.data;
    if (!key || !Array.isArray(data) || typeof data[0] !== "string") return;
    const at = this.now();
    this.stats_.updates += 1;
    this.stats_.lastUpdateAt = at;
    this.onAccount(key, Buffer.from(data[0], "base64"), at);
  }
}
