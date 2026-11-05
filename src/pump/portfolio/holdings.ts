/**
 * Read-only wallet list and the positions those wallets hold.
 * Only a 32-byte public key is stored. Signing stays in the user's wallet.
 */
import { PublicKey } from "@solana/web3.js";
import type { DatabaseSync } from "node:sqlite";
import { JournalStore, type JournalEntry } from "../journal/journal.js";
import { aggregatePnl, positionsOf, type PnlTotals, type PositionMark, type PositionView } from "./pnl.js";
import { deskScore, type DeskScore } from "./score.js";

export interface ConnectedWallet {
  pubkey: string;
  label?: string;
  connectedAt: number;
}

export interface PortfolioSnapshot {
  wallets: ConnectedWallet[];
  positions: PositionView[];
  totals: PnlTotals;
  score: DeskScore;
}

export function assertPubkey(value: string): string {
  const trimmed = value.trim();
  let key: PublicKey;
  try {
    key = new PublicKey(trimmed);
  } catch {
    throw new Error("Wallet must be a Solana public key. Night Desk stores the address only.");
  }
  if (key.toBytes().length !== 32) throw new Error("Wallet must be a 32-byte public key.");
  return key.toBase58();
}

export class WalletBook {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pump_wallets (
        pubkey TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );
    `);
  }

  add(pubkey: string, now: number, label?: string): ConnectedWallet {
    const address = assertPubkey(pubkey);
    const prior = this.read(address);
    const wallet: ConnectedWallet = {
      pubkey: address,
      label: label?.trim() || prior?.label,
      connectedAt: prior?.connectedAt ?? now
    };
    this.db
      .prepare(
        `INSERT INTO pump_wallets (pubkey, payload) VALUES (?, ?)
         ON CONFLICT(pubkey) DO UPDATE SET payload = excluded.payload`
      )
      .run(address, JSON.stringify(wallet));
    return wallet;
  }

  remove(pubkey: string): void {
    const address = assertPubkey(pubkey);
    this.db.prepare(`DELETE FROM pump_wallets WHERE pubkey = ?`).run(address);
  }

  list(): ConnectedWallet[] {
    const rows = this.db.prepare(`SELECT payload FROM pump_wallets ORDER BY pubkey ASC`).all() as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as ConnectedWallet);
  }

  private read(pubkey: string): ConnectedWallet | null {
    const row = this.db.prepare(`SELECT payload FROM pump_wallets WHERE pubkey = ?`).get(pubkey) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as ConnectedWallet) : null;
  }
}

export function snapshot(entries: readonly JournalEntry[], wallets: readonly ConnectedWallet[], marks: readonly PositionMark[], now: number): PortfolioSnapshot {
  const positions = positionsOf(entries, marks);
  return {
    wallets: [...wallets],
    positions,
    totals: aggregatePnl(positions),
    score: deskScore(entries, now)
  };
}

/** Connected wallets limit the book. With none connected, every journal fill is included. */
export function portfolioOf(db: DatabaseSync, marks: readonly PositionMark[], now: number, wallet?: string): PortfolioSnapshot {
  const book = new WalletBook(db);
  const journal = new JournalStore(db);
  let wallets = book.list();
  let entries = journal.entries();
  if (wallet) {
    const address = assertPubkey(wallet);
    entries = entries.filter((entry) => entry.wallet === address);
    const known = wallets.filter((item) => item.pubkey === address);
    wallets = known.length > 0 ? known : [{ pubkey: address, connectedAt: now }];
  } else if (wallets.length > 0) {
    const wanted = new Set(wallets.map((item) => item.pubkey));
    entries = entries.filter((entry) => wanted.has(entry.wallet));
  }
  return snapshot(entries, wallets, marks, now);
}
