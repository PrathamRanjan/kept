import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Stateless Streamable HTTP: a fresh server + transport per request, as the MCP SDK recommends for horizontal scaling. */
export async function serveMcp(req: Request, res: Response, build: () => McpServer) {
  if (req.method !== "POST") {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Use POST (stateless Streamable HTTP)." }, id: null });
    return;
  }
  const server = build();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close().catch(() => undefined);
    server.close().catch(() => undefined);
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: (e as Error).message }, id: null });
  }
}

/** Agent identity for audit and rate limits: X-Agent-Id header, else the User-Agent, else "anonymous-agent". */
export function agentIdOf(req: Request): string {
  const h = (req.header("x-agent-id") || req.header("user-agent") || "anonymous-agent").replace(/[^\w .:/@()-]/g, "").slice(0, 80);
  return h || "anonymous-agent";
}
