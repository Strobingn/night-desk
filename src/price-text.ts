const SUB = "₀₁₂₃₄₅₆₇₈₉";

/**
 * v13.8 a sub-cent price with 4 significant digits. Four or more zeros after the point are
 * folded into a subscript count: 0.00000000004143 → "0.0₁₀4143" (never "0.00000000").
 * Same rule as web/src/format.ts and the Android app.
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
