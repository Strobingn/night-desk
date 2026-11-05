export function usd(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function compactUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return usd(n);
}

export function signedUsd(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${usd(Math.abs(n))}`;
}

export function signedPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${Math.abs(n * 100).toFixed(2)}%`;
}

export function px(n: number | null | undefined): string {
  if (n == null || !(n > 0) || !Number.isFinite(n)) return "—";
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(6);
  return tinyPx(n);
}

const SUB = "₀₁₂₃₄₅₆₇₈₉";

/**
 * v13.8 a sub-cent price with 4 significant digits. Four or more zeros after the point are
 * folded into a subscript count: 0.00000000004143 → "0.0₁₀4143" (never "0.00000000").
 */
export function tinyPx(n: number): string {
  if (!(n > 0) || !Number.isFinite(n)) return "—";
  let exp = Math.floor(Math.log10(n));
  let digits = Math.round(n / 10 ** (exp - 3));
  if (digits >= 10_000) {
    digits = Math.round(digits / 10);
    exp += 1;
  }
  const zeros = -exp - 1;
  if (zeros < 0) return n.toPrecision(4);
  if (zeros < 4) return n.toFixed(zeros + 4);
  const sub = String(zeros).split("").map((d) => SUB[Number(d)]).join("");
  return `0.0${sub}${String(digits).replace(/0+$/, "") || "0"}`;
}

export function markAge(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1_000) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export function age(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Look-only links. They open the mint in a browser and never send a desk order. */
export function chartLinks(mint: string): { label: string; href: string }[] {
  return [
    { label: "DexScreener", href: `https://dexscreener.com/solana/${mint}` },
    // v13.2: Birdeye retired /token/<mint>?chain=solana (404). /solana/token/<mint> redirects to Birdeye Terminal.
    { label: "Birdeye", href: `https://birdeye.so/solana/token/${mint}` },
    { label: "Jupiter", href: `https://jup.ag/tokens/${mint}` }
  ];
}

/** v13.8 "Stop −3.0% · 1.8% away": the stop level from entry, then the mark's distance to it. */
export function stopLabel(fromEntry: number | null, toStop: number | null): string {
  const level = fromEntry != null && Number.isFinite(fromEntry) ? `${fromEntry > 0 ? "+" : fromEntry < 0 ? "−" : ""}${Math.abs(fromEntry * 100).toFixed(1)}%` : "—";
  const away = toStop == null || !Number.isFinite(toStop) ? "" : toStop < 0 ? ` · ${Math.abs(toStop * 100).toFixed(1)}% away` : " · at the stop";
  return `Stop ${level}${away}`;
}
