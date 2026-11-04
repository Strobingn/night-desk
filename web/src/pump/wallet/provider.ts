/**
 * Wallet Standard first, then an injected Phantom or Solflare provider.
 * Signing stays inside the wallet. This module never holds a secret key.
 */

export interface InjectedProvider {
  isPhantom?: boolean;
  isSolflare?: boolean;
  publicKey?: { toBase58(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toBase58(): string } }>;
  signTransaction?(tx: { serialize(): Uint8Array | { length: number } }): Promise<{ serialize(): Uint8Array | { length: number } }>;
}

export interface StandardAccount {
  address: string;
  publicKey: Uint8Array;
}

export interface StandardWallet {
  name: string;
  accounts: StandardAccount[];
  features: Record<string, unknown> & {
    "standard:connect"?: { connect: () => Promise<{ accounts: StandardAccount[] }> };
    "solana:signTransaction"?: {
      signTransaction: (
        ...inputs: { transaction: Uint8Array; account: StandardAccount }[]
      ) => Promise<{ signedTransaction: Uint8Array }[]>;
    };
  };
}

type Listener = (event: { type?: string; detail?: unknown }) => void;

export interface WalletHost {
  solana?: InjectedProvider;
  solflare?: InjectedProvider;
  addEventListener?(type: string, cb: Listener): void;
  removeEventListener?(type: string, cb: Listener): void;
  dispatchEvent?(event: { type: string; detail?: unknown }): boolean;
}

export interface ConnectedWallet {
  name: string;
  address: string;
  open(unsigned: Uint8Array): Promise<Uint8Array>;
}

export function browserHost(): WalletHost {
  const g = globalThis as WalletHost & { window?: WalletHost };
  return g.window ?? g;
}

/** Registers the Wallet Standard callback and announces that the app is ready. */
export function attachWalletStandard(host: WalletHost, onWallet: (wallet: StandardWallet) => void): () => void {
  const handler: Listener = (event) => {
    const detail = event.detail;
    if (typeof detail !== "function") return;
    (detail as (api: { register(wallet: StandardWallet): void }) => void)({ register: onWallet });
  };
  host.addEventListener?.("wallet-standard:register-wallet", handler);
  const api = { register: onWallet };
  const Custom = (globalThis as { CustomEvent?: new (type: string, eventInitDict?: { detail?: unknown }) => { type: string } }).CustomEvent;
  if (Custom) host.dispatchEvent?.(new Custom("wallet-standard:app-ready", { detail: api }));
  else host.dispatchEvent?.({ type: "wallet-standard:app-ready", detail: api });
  return () => host.removeEventListener?.("wallet-standard:register-wallet", handler);
}

export function injectedChoices(host: WalletHost): { name: string; provider: InjectedProvider }[] {
  const out: { name: string; provider: InjectedProvider }[] = [];
  if (host.solana && typeof host.solana.connect === "function") {
    out.push({ name: host.solana.isSolflare ? "Solflare" : "Phantom", provider: host.solana });
  }
  if (host.solflare && host.solflare !== host.solana && typeof host.solflare.connect === "function") {
    out.push({ name: "Solflare", provider: host.solflare });
  }
  return out;
}

export async function connectInjected(name: string, provider: InjectedProvider): Promise<ConnectedWallet> {
  const res = await provider.connect();
  const address = res.publicKey.toBase58();
  return {
    name,
    address,
    open: (unsigned) => signInjected(provider, unsigned)
  };
}

export async function connectStandard(wallet: StandardWallet): Promise<ConnectedWallet> {
  const connect = wallet.features["standard:connect"]?.connect;
  const sign = wallet.features["solana:signTransaction"]?.signTransaction;
  if (!connect || !sign) throw new Error(`${wallet.name} cannot sign a Solana transaction.`);
  const connected = await connect();
  const account = connected.accounts[0] ?? wallet.accounts[0];
  if (!account) throw new Error(`${wallet.name} returned no account.`);
  return {
    name: wallet.name,
    address: account.address,
    open: async (unsigned) => {
      const signed = await sign({ transaction: unsigned, account });
      const first = Array.isArray(signed) ? signed[0] : signed;
      const bytes = first?.signedTransaction;
      if (!bytes) throw new Error(`${wallet.name} returned no signed transaction.`);
      return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    }
  };
}

async function signInjected(provider: InjectedProvider, unsigned: Uint8Array): Promise<Uint8Array> {
  if (!provider.signTransaction) throw new Error("This wallet does not expose signTransaction.");
  await ensureBuffer();
  const { Transaction } = await import("@solana/web3.js");
  const tx = Transaction.from(globalThis.Buffer.from(unsigned));
  const signed = await provider.signTransaction(tx);
  const raw = signed.serialize();
  return raw instanceof Uint8Array ? raw : new Uint8Array(raw);
}

async function ensureBuffer(): Promise<void> {
  if (globalThis.Buffer) return;
  const mod = await import("buffer");
  (globalThis as { Buffer?: typeof mod.Buffer }).Buffer = mod.Buffer;
}
