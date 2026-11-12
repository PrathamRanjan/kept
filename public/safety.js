// /safety page: score a pasted message with the server rules and, in this browser, the fine-tuned text model.
// The model (23 MB, int8 ONNX) downloads once and is cached by the browser; the text is never sent anywhere for the score.
import { loadGuard } from "/static/safety/guard-client.js";

const $ = (id) => document.getElementById(id);
const form = $("scan-form"), text = $("scan-text"), out = $("scan-result"), status = $("scan-status"), btn = $("scan-btn");
// Part B: the member's check page can carry its words in another language (a JSON block the server writes). With
// no block, as on the owner's page, everything below stays in English. Levels and tactics are codes either way.
const L = (() => { try { return JSON.parse($("scan-words")?.textContent || "null"); } catch { return null; } })();
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => (v[k] === undefined ? m : String(v[k])));
const w = (en, key, v = {}) => fill(L?.[key] ?? en, v);
const WORDS = {
  impersonation: "claims to be an authority, a bank or your boss", urgency_secrecy: "pushes you to act fast or keep it quiet", changed_details: "asks you to pay to new bank or PayPal details",
  off_platform: "asks to pay outside PayPal or move the chat elsewhere", gift_cards_crypto: "asks for gift cards or crypto", fee_to_release: "asks for a fee to release money or goods",
  otp_or_link: "asks for a code or sends a link to click", overpay_refund: "says they overpaid and want the difference back", too_good: "promises a prize or guaranteed profit",
};
if (L) for (const k of Object.keys(WORDS)) if (L[k]) WORDS[k] = L[k];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const LEVEL = { hold: ["bad", w("Hold: do not pay yet", "hold")], caution: ["warn", w("Caution: check before you pay", "caution")], clear: ["good", w("No scam signals found", "clear")] };

let guardPromise = null;
function guard() {
  if (!guardPromise) {
    // The runtime loads from the CDN in parallel (async) so a slow CDN never leaves the check button dead; wait for
    // it here, a little, and if it never comes the server's checks still run and the page says the model did not load.
    if (!window.ort) return new Promise((ok, bad) => { let n = 0; const t = setInterval(() => { if (window.ort) { clearInterval(t); guardPromise = null; guard().then(ok, bad); } else if (++n > 50) { clearInterval(t); guardPromise = null; bad(new Error("onnxruntime-web did not load")); } }, 200); });
    window.ort.env.wasm.wasmPaths = "https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.22.0/";
    guardPromise = loadGuard({ modelUrl: "/static/safety/model/model_quantized.onnx", tokenizerUrl: "/static/safety/model/tokenizer.json", headsUrl: "/static/safety/model/heads.json", ort: window.ort });
  }
  return guardPromise;
}

$("scan-demo")?.addEventListener("click", () => { text.value = JSON.parse($("demo-bec").textContent).text; text.focus(); });

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const t = text.value.trim();
  if (!t) { text.focus(); return; }
  btn.disabled = true; status.textContent = w("Checking…", "checking");
  out.innerHTML = "";
  let rules = null, model = null, modelErr = null, ms = 0;
  try { rules = await fetch(location.pathname.replace(/\/$/, "") + "/scan", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ text: t }) }).then((r) => r.json()); } catch (err) { rules = { error: err.message }; }
  try {
    status.textContent = guardPromise ? w("Scoring in your browser…", "scoring") : w("Loading the model into your browser (23 MB, once)…", "loading");
    const g = await guard(); const t0 = performance.now(); model = await g.score(t); ms = performance.now() - t0;
  } catch (err) { modelErr = err.message; }
  btn.disabled = false; status.textContent = "";
  // Strictest wins (spec A6.1). The server has already combined its rules, the Decisions questions and the code
  // reader, and refuses green when the message names somewhere to send money (A6.2). The on-device model can only
  // raise the level. Its caution alone, with no tactic it is at least 50% sure of, is a weak signal and is shown
  // as a note instead of raising the level; that is the one softening, and it is stated on screen.
  const modelOnly = model?.level === "caution" && rules?.level === "clear" && !Object.values(model?.tactics ?? {}).some((p) => p >= 0.5);
  const lv = [rules?.level, modelOnly ? "clear" : model?.level];
  const level = rules?.error || !rules?.level ? "caution" : lv.includes("hold") ? "hold" : lv.includes("caution") ? "caution" : "clear";
  const [cls] = LEVEL[level];
  const title = !L && level === rules?.level && rules?.title ? rules.title : LEVEL[level][1];
  const tactics = new Set([...(rules?.tactics ?? []), ...Object.entries(model?.tactics ?? {}).filter(([, p]) => p >= 0.5).map(([k]) => k)]);
  const top = Object.entries(model?.tactics ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 2);
  const dec = rules?.readers?.decisions, code = rules?.readers?.code;
  const decHint = !dec ? w("not run", "notRun") : dec.status === "unavailable" ? w("could not run just now", "unavailable") : `${w("{n} of 9 tactics", "tacticsOf", { n: dec.fired.length })} · ${dec.model} · ${Math.round(dec.latencyMs)} ms`;
  const dests = code?.destinations ?? [];
  out.innerHTML = `<div class="banner ${cls}" role="status"><b>${esc(title)}</b>${rules?.neverGreen ? `<br>${esc(L?.neverGreen || rules.neverGreen)}` : ""}</div>
  <div class="stat-grid">
    <div class="kpi"><div class="label">${esc(w("1 · On this device", "k1"))}</div><div class="value">${model ? Math.round(model.p_scam * 100) + "%" : "—"}</div><div class="hint">${model ? esc(w("scam probability · {ms} ms · nothing left your browser", "k1hint", { ms: ms.toFixed(0) })) : esc(modelErr || w("not run", "notRun"))}</div></div>
    <div class="kpi"><div class="label">${esc(w("2 · Model questions (server)", "k2"))}</div><div class="value">${dec ? esc(dec.status === "ran" ? dec.level : "—") : "—"}</div><div class="hint">${esc(decHint)}</div></div>
    <div class="kpi"><div class="label">${esc(w("3 · Code: where money would go", "k3"))}</div><div class="value">${code ? esc(code.level) : "—"}</div><div class="hint">${dests.length ? esc(dests.map((d) => d.why).join(", ")) : esc(w("no address, account or link found", "k3none"))}</div></div>
    <div class="kpi"><div class="label">${esc(w("Rules and risk model", "k4"))}</div><div class="value">${rules?.readers?.rules ? esc(rules.readers.rules.level) : "—"}</div><div class="hint">${rules?.risk !== undefined ? esc(w("risk {p}% · synthetic training data", "k4hint", { p: Math.round(rules.risk * 100) })) : esc(rules?.error || rules?.message || "")}</div></div>
  </div>
  ${tactics.size || top.length || dec?.fired?.length ? `<h3>${esc(w("What this message does", "does"))}</h3><ul>${[...tactics].map((k) => `<li>${esc(WORDS[k] || k)}</li>`).join("")}${(dec?.fired ?? []).map((f) => `<li>${esc(f.words)} (${esc(w("model questions {p}%", "modelQ", { p: Math.round(f.p * 100) }))})</li>`).join("")}${top.filter(([k]) => !tactics.has(k) && k in WORDS).map(([k, p]) => `<li class="muted">${esc(WORDS[k])} (${esc(w("device model {p}%", "deviceQ", { p: Math.round(p * 100) }))})</li>`).join("")}</ul>` : ""}
  ${rules?.reasons?.length ? `<h3>${esc(w("Why", "why"))}</h3><ul>${rules.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
  <p class="small muted">${esc(w("What to do: pay only to details you confirmed by phone with a number you already had. Never share codes. If in doubt, put the payment on hold and ask a second person.", "todo"))} ${modelOnly ? `${esc(w("The device model was a little unsure ({p}%) but found no scam tactic it was sure of, so on its own it does not raise the level.", "unsure", { p: Math.round(model.p_scam * 100) }))} ` : ""}${level === "clear" ? esc(w("A clear result is not a guarantee.", "notGuarantee")) : ""}</p>`;
});

// The button ships disabled so a click before this script runs cannot fall through to a plain page reload.
if (btn) { btn.disabled = false; status.textContent = ""; }
