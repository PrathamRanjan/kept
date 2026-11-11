/**
 * Spec A5.3(b) / A8: PayPal's own hosted MCP server as read tools for Kept's agents. Sandbox endpoint
 * `https://mcp.sandbox.paypal.com/sse` (SSE transport; checked 11 Nov 2026: 46 tools listed), authorised with an
 * access token minted from Kept's own client id and secret.
 *
 * Only read tools on an allowlist are ever called, and only with ids this shop owns (checked by the caller
 * against Kept's own records). The write tools PayPal's server offers (create_refund, cancel_subscription, ...) are
 * not reachable from here: `callPayPalRead` refuses any name outside READ_TOOLS, and the structural test checks it.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { config, paypalBaseUrl } from "../config.js";

export const PAYPAL_MCP_URL = config.paypal.env === "live" ? "https://mcp.paypal.com/sse" : "https://mcp.sandbox.paypal.com/sse";
export const READ_TOOLS = ["show_subscription_details", "show_subscription_plan_details"] as const;
export type PayPalReadTool = (typeof READ_TOOLS)[number];

let token: { value: string; until: number } | null = null;
async function accessToken(): Promise<string> {
  if (token && token.until > Date.now() + 60_000) return token.value;
  if (!config.paypal.clientId || !config.paypal.clientSecret) throw new Error("PayPal app credentials are not set");
  const res = await fetch(`${paypalBaseUrl()}/v1/oauth2/token`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const j = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!res.ok || !j.access_token) throw new Error(`PayPal token request failed (${res.status})`);
  token = { value: j.access_token, until: Date.now() + (j.expires_in ?? 3000) * 1000 };
  return token.value;
}

export type PayPalMcpCaller = (tool: PayPalReadTool, args: Record<string, unknown>) => Promise<unknown>;
let override: PayPalMcpCaller | null = null;
/** Tests replace the hosted server here. */
export function setPayPalMcp(f: PayPalMcpCaller | null) {
  override = f;
}

/** One read through PayPal's MCP server. Returns the parsed JSON PayPal sent back; throws on a tool error. */
export async function callPayPalRead(tool: string, args: Record<string, unknown>): Promise<unknown> {
  if (!(READ_TOOLS as readonly string[]).includes(tool)) throw new Error(`${tool} is not a PayPal read tool Kept allows`);
  if (override) return override(tool as PayPalReadTool, args);
  const headers = { Authorization: `Bearer ${await accessToken()}` };
  const transport = new SSEClientTransport(new URL(PAYPAL_MCP_URL), {
    eventSourceInit: { fetch: (u: any, i: any) => fetch(u, { ...i, headers: { ...(i?.headers ?? {}), ...headers } }) } as any,
    requestInit: { headers },
  });
  const client = new Client({ name: "kept", version: "0.1.0" });
  const timer = setTimeout(() => void client.close().catch(() => null), 20_000);
  try {
    await client.connect(transport);
    const r: any = await client.callTool({ name: tool, arguments: args });
    const text = (r.content ?? []).find((c: any) => c.type === "text")?.text ?? "";
    if (r.isError) throw new Error(`PayPal MCP ${tool}: ${String(text).slice(0, 200)}`);
    try {
      return JSON.parse(text);
    } catch {
      return { text: String(text).slice(0, 2000) };
    }
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => null);
  }
}
