/** Tiny cookie-keeping HTTP client. */
export class Client {
  cookies = new Map<string, string>();
  constructor(readonly base: string) {}
  private cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  async req(method: string, path: string, opts: { form?: Record<string, string | string[]>; json?: unknown; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (this.cookies.size) headers.cookie = this.cookieHeader();
    let body: string | undefined;
    if (opts.form) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.form)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
      body = p.toString();
      headers["content-type"] = "application/x-www-form-urlencoded";
    } else if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      headers["content-type"] = "application/json";
      headers.accept = headers.accept ?? "application/json";
    }
    const res = await fetch(this.base + path, { method, headers, body, redirect: "manual" });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const [k, ...rest] = pair.split("=");
      const v = rest.join("=");
      if (v === "" || /Expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(k.trim());
      else this.cookies.set(k.trim(), v);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* html */
    }
    return { status: res.status, location: res.headers.get("location"), text, json, headers: res.headers };
  }
  get(p: string, headers?: Record<string, string>) {
    return this.req("GET", p, { headers });
  }
  post(p: string, form?: Record<string, string | string[]>) {
    return this.req("POST", p, { form: form ?? {} });
  }
  postJson(p: string, json: unknown, headers?: Record<string, string>) {
    return this.req("POST", p, { json, headers });
  }
}
