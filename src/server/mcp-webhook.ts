import nacl from "tweetnacl";
import bs58 from "bs58";

export const MAX_TIMESTAMP_DRIFT_MS = 60_000; // 60 seconds replay protection

export interface McpAuthResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Verifies Ed25519 signature + 60s timestamp drift for MCP JSON-RPC transport (Resolves SEC-01).
 */
export function verifyMcpRequest(params: {
  rawPayload: string;
  publicKeyStr: string | null | undefined;
  signatureStr: string | null | undefined;
  timestampStr: string | null | undefined;
  nowMs?: number;
}): McpAuthResult {
  const {
    rawPayload,
    publicKeyStr,
    signatureStr,
    timestampStr,
    nowMs = Date.now(),
  } = params;

  if (!publicKeyStr || !signatureStr || !timestampStr) {
    return {
      status: 401,
      body: {
        jsonrpc: "2.0",
        error: { code: -32600, message: "Missing cryptographic authentication headers." },
        id: null,
      },
    };
  }

  const reqTime = Number(timestampStr);
  if (Number.isNaN(reqTime) || Math.abs(nowMs - reqTime) > MAX_TIMESTAMP_DRIFT_MS) {
    return {
      status: 403,
      body: {
        jsonrpc: "2.0",
        error: { code: -32003, message: "Request timestamp expired or invalid." },
        id: null,
      },
    };
  }

  try {
    const signedPayload = `${timestampStr}.${rawPayload}`;
    const messageBytes = new TextEncoder().encode(signedPayload);
    const signatureBytes = bs58.decode(signatureStr);
    const pubKeyBytes = bs58.decode(publicKeyStr);

    if (
      signatureBytes.length !== nacl.sign.signatureLength ||
      pubKeyBytes.length !== nacl.sign.publicKeyLength
    ) {
      return {
        status: 400,
        body: {
          jsonrpc: "2.0",
          error: { code: -32002, message: "Malformed base58 signature or public key." },
          id: null,
        },
      };
    }

    const isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, pubKeyBytes);
    if (!isValid) {
      return {
        status: 403,
        body: {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Invalid Ed25519 wallet signature." },
          id: null,
        },
      };
    }
  } catch {
    return {
      status: 400,
      body: {
        jsonrpc: "2.0",
        error: { code: -32002, message: "Malformed base58 signature or public key." },
        id: null,
      },
    };
  }

  return {
    status: 200,
    body: {
      jsonrpc: "2.0",
      result: { status: "authenticated", wallet: publicKeyStr },
      id: 1,
    },
  };
}

const serverProcessedSignatures = new Set<string>();

export function resetServerWebhookSignatures(): void {
  serverProcessedSignatures.clear();
}

export function processIdempotentSolanaWebhook(params: {
  authHeader: string | null | undefined;
  expectedSecret: string | undefined;
  events: unknown;
}): { status: number; body: Record<string, unknown> } {
  const { authHeader, expectedSecret, events } = params;
  if (!expectedSecret || authHeader !== `Bearer ${expectedSecret}`) {
    return { status: 401, body: { error: "Unauthorized webhook caller" } };
  }

  if (!Array.isArray(events)) {
    return { status: 400, body: { error: "Invalid payload format" } };
  }

  const newlyProcessed: string[] = [];
  for (const event of events) {
    const signature: string | undefined =
      event && typeof event === "object" && typeof (event as { signature?: unknown }).signature === "string"
        ? (event as { signature: string }).signature
        : undefined;
    if (!signature || serverProcessedSignatures.has(signature)) {
      continue;
    }

    serverProcessedSignatures.add(signature);
    if (serverProcessedSignatures.size > 10_000) {
      const oldest = serverProcessedSignatures.values().next().value;
      if (oldest) serverProcessedSignatures.delete(oldest);
    }

    newlyProcessed.push(signature);
  }

  return {
    status: 200,
    body: {
      status: "ok",
      processedCount: newlyProcessed.length,
      signatures: newlyProcessed,
    },
  };
}
