/**
 * Lightweight Web-Fetch compatible NextRequest / NextResponse runtime & type shim
 * so Next.js App Router route handlers (`app/[transport]/route.ts`, `app/api/webhooks/solana/route.ts`)
 * execute natively in Node 22+ and Vitest without requiring the full Next.js framework runtime.
 */

export class NextRequest extends Request {
  readonly nextUrl: URL;

  constructor(input: string | URL | Request, init?: RequestInit) {
    super(input, init);
    this.nextUrl = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  }
}

export class NextResponse<Body = unknown> extends Response {
  static override json<JsonBody>(body: JsonBody, init?: ResponseInit): NextResponse<JsonBody> {
    const headers = new Headers(init?.headers);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json; charset=utf-8");
    }
    return new NextResponse<JsonBody>(JSON.stringify(body), {
      ...init,
      headers,
    });
  }
}
