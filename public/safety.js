// /safety page: score a pasted message with the server rules and, in this browser, the fine-tuned text model.
// The model (23 MB, int8 ONNX) downloads once and is cached by the browser; the text is never sent anywhere for the score.
import { loadGuard } from "/static/safety/guard-client.js";

const $ = (id) => document.getElementById(id);
const form = $("scan-form"), text = $("scan-text"), out = $("scan-result"), status = $("scan-status"), btn = $("scan-btn");
const WORDS = {
  impersonation: "claims to be an authority, a bank or your boss", urgency_secrecy: "pushes you to act fast or keep it quiet", changed_details: "asks you to pay to new bank or PayPal details",
  off_platform: "asks to pay outside PayPal or move the chat elsewhere", gift_cards_crypto: "asks for gift cards or crypto", fee_to_release: "asks for a fee to release money or goods",
  otp_or_link: "asks for a code or sends a link to click", overpay_refund: "says they overpaid and want the difference back", too_good: "promises a prize or guaranteed profit",
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const LEVEL = { hold: ["bad", "Hold: do not pay yet"], caution: ["warn", "Caution: check before you pay"], clear: ["good", "No scam signals found"] };

let guardPromise = null;
function guard() {
  if (!guardPromise) {
    if (!window.ort) return Promise.reject(new Error("onnxruntime-web did not load"));
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
  btn.disabled = true; status.textContent = "Checking…";
  out.innerHTML = "";
  let rules = null, model = null, modelErr = null, ms = 0;
  try { rules = await fetch(location.pathname.replace(/\/$/, "") + "/scan", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ text: t }) }).then((r) => r.json()); } catch (err) { rules = { error: err.message }; }
  try {
    status.textContent = guardPromise ? "Scoring in your browser…" : "Loading the model into your browser (23 MB, once)…";
    const g = await guard(); const t0 = performance.now(); model = await g.score(t); ms = performance.now() - t0;
  } catch (err) { modelErr = err.message; }
  btn.disabled = false; status.textContent = "";
  const level = [rules?.level, model?.level].includes("hold") ? "hold" : [rules?.level, model?.level].includes("caution") ? "caution" : "clear";
  const [cls, title] = LEVEL[level];
  const tactics = new Set([...(rules?.tactics ?? []), ...Object.entries(model?.tactics ?? {}).filter(([, p]) => p >= 0.5).map(([k]) => k)]);
  const top = Object.entries(model?.tactics ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 2);
  out.innerHTML = `<div class="banner ${cls}" role="status"><b>${title}</b></div>
  <div class="stat-grid">
    <div class="kpi"><div class="label">Text model (this browser)</div><div class="value">${model ? Math.round(model.p_scam * 100) + "%" : "—"}</div><div class="hint">${model ? `scam probability · ${ms.toFixed(0)} ms · level ${model.level}` : esc(modelErr || "not run")}</div></div>
    <div class="kpi"><div class="label">Rules (server)</div><div class="value">${rules?.level ? esc(rules.level) : "—"}</div><div class="hint">${rules?.reasons?.length ? esc(rules.reasons.length + " reason" + (rules.reasons.length > 1 ? "s" : "")) : esc(rules?.error || "no rule fired")}</div></div>
    <div class="kpi"><div class="label">Risk model</div><div class="value">${rules?.risk !== undefined ? Math.round(rules.risk * 100) + "%" : "—"}</div><div class="hint">synthetic training data</div></div>
  </div>
  ${tactics.size || top.length ? `<h3>What this message does</h3><ul>${[...tactics].map((k) => `<li>${esc(WORDS[k] || k)}</li>`).join("")}${top.filter(([k]) => !tactics.has(k) && k in WORDS).map(([k, p]) => `<li class="muted">${esc(WORDS[k])} (model ${Math.round(p * 100)}%)</li>`).join("")}</ul>` : ""}
  ${rules?.reasons?.length ? `<h3>Why</h3><ul>${rules.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
  <p class="small muted">What to do: pay only to details you confirmed by phone with a number you already had. Never share codes. If in doubt, put the payment on hold and ask a second person. ${level === "clear" ? "A clear result is not a guarantee: the model catches about three quarters of scams at this setting." : ""}</p>`;
});
