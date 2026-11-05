import { NextRequest, NextResponse } from "next/server";
import nacl from "tweetnacl";
import bs58 from "bs58";

const MAX_TIMESTAMP_DRIFT_MS = 60_000; // 60 seconds replay protection

export async function POST(req: NextRequest) {
  const rawPayload = await req.text();
  const publicKeyStr = req.headers.get("x-wallet-pubkey");
  const signatureStr = req.headers.get("x-wallet-signature");
  const timestampStr = req.headers.get("x-request-timestamp");

  if (!publicKeyStr || !signatureStr || !timestampStr) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        error: { code: -32600, message: "Missing cryptographic authentication headers." },
        id: null,
      },
      { status: 401 }
    );
  }

  const reqTime = Number(timestampStr);
  if (Number.isNaN(reqTime) || Math.abs(Date.now() - reqTime) > MAX_TIMESTAMP_DRIFT_MS) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        error: { code: -32003, message: "Request timestamp expired or invalid." },
        id: null,
      },
      { status: 403 }
    );
  }

  try {
    const signedPayload = `${timestampStr}.${rawPayload}`;
    const messageBytes = new TextEncoder().encode(signedPayload);
    const signatureBytes = bs58.decode(signatureStr);
    const pubKeyBytes = bs58.decode(publicKeyStr);

    if (signatureBytes.length !== nacl.sign.signatureLength || pubKeyBytes.length !== nacl.sign.publicKeyLength) {
      return NextResponse.json(
        {
          jsonrpc: "2.0",
          error: { code: -32002, message: "Malformed base58 signature or public key." },
          id: null,
        },
        { status: 400 }
      );
    }

    const isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, pubKeyBytes);
    if (!isValid) {
      return NextResponse.json(
        {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Invalid Ed25519 wallet signature." },
          id: null,
        },
        { status: 403 }
      );
    }
  } catch {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        error: { code: -32002, message: "Malformed base58 signature or public key." },
        id: null,
      },
      { status: 400 }
    );
  }

  return NextResponse.json({
    jsonrpc: "2.0",
    result: { status: "authenticated", wallet: publicKeyStr },
    id: 1,
  });
}
