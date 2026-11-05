import { NextRequest, NextResponse } from "next/server";

const processedSignatures = new Set<string>();

export function resetProcessedWebhookSignatures(): void {
  processedSignatures.clear();
}

export async function POST(req: NextRequest) {
  const secret = process.env.HELIUS_WEBHOOK_SECRET;
  const authHeader = req.headers.get("authorization");
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized webhook caller" }, { status: 401 });
  }

  let events: unknown;
  try {
    events = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid payload format" }, { status: 400 });
  }

  if (!Array.isArray(events)) {
    return NextResponse.json({ error: "Invalid payload format" }, { status: 400 });
  }

  const newlyProcessed: string[] = [];

  for (const event of events) {
    const signature: string | undefined =
      event && typeof event === "object" && typeof (event as { signature?: unknown }).signature === "string"
        ? (event as { signature: string }).signature
        : undefined;
    if (!signature || processedSignatures.has(signature)) {
      continue;
    }

    processedSignatures.add(signature);
    if (processedSignatures.size > 10_000) {
      const oldest = processedSignatures.values().next().value;
      if (oldest) processedSignatures.delete(oldest);
    }

    newlyProcessed.push(signature);
  }

  return NextResponse.json({
    status: "ok",
    processedCount: newlyProcessed.length,
    signatures: newlyProcessed,
  });
}
