const deskToken = rememberDeskToken();

export function rememberDeskToken(): string {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("token");
  if (fromUrl) {
    sessionStorage.setItem("night-desk-token", fromUrl);
    params.delete("token");
    const query = params.toString();
    history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
    return fromUrl;
  }
  return sessionStorage.getItem("night-desk-token") ?? "";
}

export function withToken(path: string): string {
  const url = new URL(path, location.origin);
  if (deskToken && !url.searchParams.has("token")) url.searchParams.set("token", deskToken);
  return `${url.pathname}${url.search}`;
}

export function authHeaders(): Record<string, string> {
  return deskToken ? { "X-Desk-Token": deskToken } : {};
}

export interface ApiResult<T> {
  status: number;
  ok: boolean;
  body: T & { ok?: boolean; error?: string; code?: string };
}

/** JSON call. Never throws on an HTTP error; a 401 or network failure becomes ok:false with a message. */
export async function api<T = Record<string, unknown>>(path: string, init?: { method?: string; body?: unknown }): Promise<ApiResult<T>> {
  try {
    const res = await fetch(withToken(path), {
      method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
      headers: { ...authHeaders(), ...(init?.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined
    });
    const raw = await res.text();
    let body = {} as ApiResult<T>["body"];
    if (raw) {
      try {
        body = JSON.parse(raw) as ApiResult<T>["body"];
      } catch {
        body = { error: `HTTP ${res.status}` } as ApiResult<T>["body"];
      }
    }
    if (res.status === 401) body = { ...body, ok: false, error: "Desk token missing or wrong." };
    if (!res.ok && !body.error) body = { ...body, error: `HTTP ${res.status}` };
    return { status: res.status, ok: res.ok && body.ok !== false, body };
  } catch (err) {
    return { status: 0, ok: false, body: { ok: false, error: err instanceof Error ? err.message : "Network error" } as ApiResult<T>["body"] };
  }
}
