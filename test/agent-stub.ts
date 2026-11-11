import { config } from "../src/config.js";
import { setProviderFetch } from "../src/ai/provider.js";

/**
 * A stand-in for OpenAI in tests that exercise the agent loop: the first turn asks for a tool, the second
 * answers citing the first fact. Decisions questions all come back unlikely. Real request bodies are recorded.
 */
export const agentRequests: any[] = [];
export function stubAgent(opts: { tool?: string; args?: Record<string, unknown>; text?: string } = {}) {
  const saved = { provider: config.ai.provider, key: config.ai.openaiKey };
  (config.ai as any).provider = "openai";
  (config.ai as any).openaiKey = "sk-test";
  setProviderFetch((async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    agentRequests.push({ url, body });
    if (String(url).endsWith("/v1/decisions")) return new Response(JSON.stringify({ model: "gpt-6-luna", answers: body.questions.map((q: any) => ({ type: "predicate", name: q.name, probability: 0.01 })), usage: { input_tokens: 100, output_tokens: 0 } }), { status: 200 });
    const hasOutput = (body.input ?? []).some((i: any) => i.type === "function_call_output");
    if (body.tools?.length && !hasOutput) return new Response(JSON.stringify({ model: body.model, status: "completed", usage: { input_tokens: 50, output_tokens: 10 }, output: [{ type: "function_call", call_id: "call_1", name: opts.tool ?? "shop_overview", arguments: JSON.stringify(opts.args ?? {}) }] }), { status: 200 });
    const text = JSON.stringify({ sentences: [{ text: opts.text ?? "Most reasons members gave were about cost.", facts: ["F1"] }] });
    return new Response(JSON.stringify({ model: body.model, status: "completed", usage: { input_tokens: 80, output_tokens: 20 }, output: [{ type: "message", content: [{ type: "output_text", text }] }] }), { status: 200 });
  }) as unknown as typeof fetch);
  return () => {
    setProviderFetch(null);
    (config.ai as any).provider = saved.provider;
    (config.ai as any).openaiKey = saved.key;
  };
}
