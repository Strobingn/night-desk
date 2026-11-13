/** A holding the desk has already marked as liquidity gone or no sell route. */
export function isDeadHolding(pos: { liquidityNote?: string | null }): boolean {
  return typeof pos.liquidityNote === "string" && pos.liquidityNote.trim().length > 0;
}

export function splitHoldings<T extends { liquidityNote?: string | null }>(rows: readonly T[]): { open: T[]; dead: T[] } {
  const open: T[] = [];
  const dead: T[] = [];
  for (const row of rows) (isDeadHolding(row) ? dead : open).push(row);
  return { open, dead };
}
