/**
 * Spec A7 "voice both ways": push-to-talk on the main text boxes. The server asks OpenAI for a short-lived
 * client secret for a gpt-live-1 realtime session set up for dictation only: text out, no turn detection (the
 * person presses to start and again to stop), and no reply is ever requested. The words come from the session's
 * input transcription model (gpt-4o-transcribe), which is the only one the realtime API accepts for that today.
 * The browser connects straight to OpenAI with the secret, which expires after two minutes; Kept's own key never
 * leaves the server. With no key there is no voice: the button says so, and typing always works.
 */
import { config } from "../config.js";
import { audit, hasOpenAI, NoModelError, providerFetch } from "./provider.js";

export const VOICE_MODEL = "gpt-live-1";
export const VOICE_TRANSCRIBE = "gpt-4o-transcribe";

export async function voiceSession(merchantId: string | null): Promise<{ secret: string; expiresAt: number; model: string; transcribe: string; callsUrl: string }> {
  if (!hasOpenAI()) throw new NoModelError("AI_PROVIDER is not openai or OPENAI_API_KEY is unset");
  const t0 = Date.now();
  const res = await providerFetch()(`${config.ai.openaiBaseUrl}/v1/realtime/client_secrets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.ai.openaiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: 120 },
      session: {
        type: "realtime",
        model: VOICE_MODEL,
        output_modalities: ["text"],
        instructions: "Dictation only. Never reply to the user.",
        audio: { input: { transcription: { model: VOICE_TRANSCRIBE, language: "en" }, turn_detection: null } },
      },
    }),
  });
  const text = await res.text();
  const ok = res.ok;
  await audit({ purpose: "voice_session", model: VOICE_MODEL, via: "primary", inputHash: "", outputHash: "", tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: Date.now() - t0, ok, error: ok ? null : text.slice(0, 200), output: null, runId: null, inputSummary: "push-to-talk session", merchantId });
  if (!ok) throw new NoModelError(`Voice session failed: ${res.status} ${text.slice(0, 160)}`);
  const j = JSON.parse(text);
  return { secret: j.value, expiresAt: j.expires_at, model: j.session?.model ?? VOICE_MODEL, transcribe: VOICE_TRANSCRIBE, callsUrl: `${config.ai.openaiBaseUrl}/v1/realtime/calls?model=${encodeURIComponent(VOICE_MODEL)}` };
}
