/**
 * Holder counts from the paged token-account read (Helius `getTokenAccounts` pages,
 * the same call the desk already uses). The DAS `total` field is never read:
 * owners are counted off the pages themselves.
 */
import { isReserveHolder } from "../../market/exclusions.js";

export interface HolderAccount {
  address?: string;
  owner?: string | null;
  amount?: number | string;
  uiAmount?: number | string;
}

export interface HolderPage {
  token_accounts?: HolderAccount[];
  accounts?: HolderAccount[];
  /** Present on some DAS payloads. Ignored on purpose. */
  total?: number;
}

const PAGE_SIZE = 1_000;

/** Unique non-reserve owners across pages. `page.total` is not consulted. */
export function countOwners(pages: readonly HolderPage[]): number {
  const owners = new Set<string>();
  for (const page of pages) {
    const rows = page.token_accounts ?? page.accounts ?? [];
    for (const row of rows) {
      const amount = Number(row.amount ?? row.uiAmount ?? 0);
      if (!(amount > 0)) continue;
      if (isReserveHolder({ address: row.address, owner: row.owner ?? null })) continue;
      const who = row.owner || row.address;
      if (who) owners.add(who);
    }
  }
  return owners.size;
}

/**
 * Page `getTokenAccounts` the same way the enrich path does.
 * Returns the owner count from the rows. A DAS `total` on the JSON is discarded.
 */
export async function readPagedHolderCount(opts: {
  rpcUrl: string;
  mint: string;
  maxPages?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ holderCount: number; pagesRead: number; truncated: boolean }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxPages = opts.maxPages ?? 3;
  const pages: HolderPage[] = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await fetchImpl(opts.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: page,
        method: "getTokenAccounts",
        params: { mint: opts.mint, page, limit: PAGE_SIZE }
      })
    });
    if (!res.ok) {
      if (page === 1) break;
      truncated = true;
      break;
    }
    const json = (await res.json()) as { result?: HolderPage | null };
    const result = json.result;
    const rows = result?.token_accounts;
    if (!result || !Array.isArray(rows)) {
      if (page === 1) break;
      truncated = true;
      break;
    }
    pages.push({ token_accounts: rows });
    if (rows.length < PAGE_SIZE) break;
    if (page === maxPages) truncated = true;
  }
  return { holderCount: countOwners(pages), pagesRead: pages.length, truncated };
}
