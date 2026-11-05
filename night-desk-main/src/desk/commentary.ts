import type { PipelineCounts, PositionView } from "../types.js";

export interface CommentaryInput {
  mode: "paper" | "live";
  killReasons: Record<string, number>;
  positions: PositionView[];
  pipeline: PipelineCounts;
}

/**
 * Rule-based tape notes. Used when no model key is set, and as the fallback
 * when a model call fails. Never returns an order.
 */
export function ruleNotes(input: CommentaryInput): string[] {
  const notes: string[] = [];
  const kills = Object.entries(input.killReasons).sort((a, b) => b[1] - a[1]);
  const totalKills = kills.reduce((sum, [, count]) => sum + count, 0);
  if (totalKills >= 4 && kills[0]) {
    const [code, count] = kills[0];
    const pct = Math.round((count / totalKills) * 100);
    notes.push(
      `Kills are mostly ${code} (${count} of ${totalKills}, ${pct}%). Filter lines are unchanged. Commentary does not place trades.`
    );
  } else if (totalKills === 0 && input.pipeline.scouted === 0) {
    notes.push("Tape is quiet. No sightings yet.");
  }

  for (const pos of input.positions.slice(0, 4)) {
    const pnl = signedPct(pos.pnlPct);
    const hint =
      pos.trailHintPrice != null
        ? ` Peak ${fmtPx(pos.peakPrice)} is a hint (old trail line ${fmtPx(pos.trailHintPrice)}), not a sell.`
        : "";
    notes.push(
      `${pos.symbol} is ${pnl}. Hard stop ${fmtPx(pos.stopPrice)} is the only automatic exit.${hint} Take profit with a manual close.`
    );
  }

  if (input.positions.length === 0 && totalKills > 0) {
    notes.push(`Flat book. ${input.pipeline.filteredPass} filter passes, ${input.pipeline.analystTrade} analyst trades, ${totalKills} kill reasons logged.`);
  }
  return notes.slice(0, 5);
}

/** Optional wording pass. The stats lines stay if the model is missing, fails, or claims it placed an order. */
export async function phraseAdvice(
  lines: string[],
  opts: { apiKey?: string; model?: string; fetchImpl?: typeof fetch } = {}
): Promise<string[]> {
  if (!opts.apiKey || lines.length === 0) return lines;
  try {
    const text = await askModel(lines, opts.apiKey, opts.model || "gpt-4o-mini", opts.fetchImpl ?? fetch);
    const parsed = text
      .split(/\n+/)
      .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
      .filter((line) => line.length > 0 && acceptAdviceLine(line));
    return parsed.length ? parsed.slice(0, lines.length) : lines;
  } catch {
    return lines;
  }
}

export function acceptAdviceLine(line: string): boolean {
  return !/\b(placed|placing|executed|filled an order|bought|sold)\b/i.test(line);
}

async function askModel(lines: string[], apiKey: string, model: string, fetchImpl: typeof fetch): Promise<string> {
  const res = await fetchImpl("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 220,
      messages: [
        {
          role: "system",
          content:
            "Rewrite each advisory line in one sentence. Keep the stance (consider selling, skip, hold, hard stop distance). You are not connected to an exchange. Never say you placed, bought, or sold anything."
        },
        { role: "user", content: lines.join("\n") }
      ]
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`openai HTTP ${res.status}`);
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("openai empty");
  return text;
}

function signedPct(n: number): string {
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}${(Math.abs(n) * 100).toFixed(1)}%`;
}

function fmtPx(n: number): string {
  if (!(n > 0)) return "—";
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(6);
  return n.toFixed(8);
}
