import { Connection, PublicKey, Transaction } from "@solana/web3.js";

export interface AccountBytes {
  data: Buffer;
  owner: string;
}

export interface PumpConnection {
  getAccountInfo(address: string): Promise<AccountBytes | null>;
  getLatestBlockhash(): Promise<string>;
  simulateTransaction(tx: Transaction): Promise<{ err: string | null; units: number | null; logs: string[] }>;
}

/** Read and simulate only. This wrapper has no send method. `fetchImpl` is the exec lane, not the 9/min poll. */
export function solanaConnection(rpcUrl: string, fetchImpl?: typeof fetch): PumpConnection {
  const connection = fetchImpl
    ? new Connection(rpcUrl, { commitment: "confirmed", fetch: fetchImpl })
    : new Connection(rpcUrl, "confirmed");
  return {
    async getAccountInfo(address: string) {
      const info = await connection.getAccountInfo(new PublicKey(address), "confirmed");
      if (!info) return null;
      return { data: Buffer.from(info.data), owner: info.owner.toBase58() };
    },
    async getLatestBlockhash() {
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      return blockhash;
    },
    async simulateTransaction(tx: Transaction) {
      const sim = await connection.simulateTransaction(tx);
      return {
        err: sim.value.err ? JSON.stringify(sim.value.err) : null,
        units: sim.value.unitsConsumed ?? null,
        logs: sim.value.logs ?? []
      };
    }
  };
}
