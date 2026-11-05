/** Text the web and Android buy controls show after a manual buy. */
export interface BuyNoticeBody {
  ok?: boolean;
  error?: string;
  symbol?: string;
  sizeUsd?: number;
  mode?: string;
  clampedFrom?: number;
}

export function formatBuyNotice(body: BuyNoticeBody): string {
  if (body.ok !== true) {
    const error = body.error?.trim();
    return error ? error : "Buy refused.";
  }
  const size =
    typeof body.sizeUsd === "number" && Number.isFinite(body.sizeUsd) ? `$${body.sizeUsd.toFixed(2)}` : "the filled size";
  const symbol = body.symbol && body.symbol.trim() ? body.symbol.trim() : "the mint";
  const mode = body.mode === "live" ? "live" : "paper";
  const clamped =
    typeof body.clampedFrom === "number" &&
    Number.isFinite(body.clampedFrom) &&
    typeof body.sizeUsd === "number" &&
    body.clampedFrom > body.sizeUsd + 0.001
      ? ` Requested $${body.clampedFrom.toFixed(2)} was cut to the position cap.`
      : "";
  return `Bought ${symbol} for ${size} (${mode}).${clamped}`;
}
