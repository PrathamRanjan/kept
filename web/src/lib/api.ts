export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? { accept: "application/json" } : { "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "offline", navigator.onLine ? "Kept didn't answer. Check your connection and try again." : "You're offline. Nothing was sent; try again when you're back online.");
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? "error", data?.message ?? (res.status >= 500 ? "Something went wrong on our side. Nothing was changed." : text || "That didn't work."));
  return data as T;
}

export const api = {
  get: <T,>(url: string) => call<T>("GET", url),
  post: <T,>(url: string, body: unknown = {}) => call<T>("POST", url, body),
};

/** A per-click idempotency key so a double tap never acts twice. */
export const newKey = () => (crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** POST and read a server-sent event stream; each event is handed to onEvent as it arrives. */
export async function streamPost(url: string, body: unknown, onEvent: (event: string, data: any) => void): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "offline", "Kept didn't answer. Check your connection and try again.");
  }
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    let d: any = null;
    try {
      d = JSON.parse(t);
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, d?.error ?? "error", d?.message ?? "That didn't work.");
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.*)$/m.exec(chunk)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      if (data) onEvent(ev, JSON.parse(data));
    }
  }
}
