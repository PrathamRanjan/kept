/**
 * Part A6: what a spoken phrase means, decided in code in all four languages. "Stop" never reaches a model; nor do
 * "yes", "click" or "this one". Anything that is not a fixed command is a free request for the member's assistant,
 * which acts through the shop's MCP tools under a signed mandate. Which actions need a confirm card is also code.
 */
export type Verb = "cancel" | "delete" | "pay" | "refund" | "send" | "dispute" | "approve" | "decline" | "subscribe" | "take";
export type Intent =
  | { kind: "stop" }
  | { kind: "yes" }
  | { kind: "click" }
  | { kind: "act"; verb: Verb }
  | { kind: "scroll"; dir: "up" | "down" }
  | { kind: "back" }
  | { kind: "calibrate" }
  | { kind: "topup" }
  | { kind: "recentre" }
  | { kind: "free"; text: string }
  | { kind: "none" };

const norm = (s: string) => s.toLowerCase().normalize("NFC").replace(/[.,!?¿¡।"“”'’]/g, " ").replace(/\s+/g, " ").trim();

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** The wake word is the app's name, heard loosely: "kept", "kapt", "kemped"... but never "keep" (a reminder button). */
const WAKE_DEVANAGARI = /केप्ट|केप्त|कैप्ट|केप्ड/;
export function stripWake(text: string): { woke: boolean; rest: string } {
  const t = norm(text);
  if (WAKE_DEVANAGARI.test(t)) return { woke: true, rest: t.replace(WAKE_DEVANAGARI, "").trim() };
  const words = t.split(" ");
  const i = words.findIndex((w) => w !== "keep" && w !== "kepp" && w.length >= 3 && w.length <= 6 && lev(w, "kept") <= 1);
  if (i < 0 || i > 2) return { woke: false, rest: t };
  return { woke: true, rest: words.slice(i + 1).join(" ") };
}

const STOP = /^(stop|stop it|wait|never mind|nevermind|cancel that|ruko|ruk jao|bas|रुको|रुकिए|रुक जाओ|बस|berhenti|tunggu|stop dulu|pare|parar|para|espera|chega)$|\b(stop|ruko|berhenti|pare|parar)\b|रुको|रुकिए/;
const YES = /^(yes|yeah|yep|yup|confirm|do it|ok do it|haan|haan ji|ji haan|हाँ|हां|हाँ जी|जी हाँ|ठीक है|ya|iya|ya betul|betul|konfirmasi|lakukan|sim|confirmo|confirmar|pode|pode sim|isso mesmo)$/;
const CLICK = /^(click|click it|click this|click that|press|press it|press this|tap|tap it|select|select it|choose|this one|that one|klik|klik ini|tekan|tekan ini|pilih|yang ini|ini|clique|clica|clicar|aperte|aperta|toque|escolha|este|esse|isso|este aqui|क्लिक|क्लिक करो|दबाओ|दबाइए|यह वाला|ये वाला|इसे|ये|यह|click karo|dabao|yeh wala|ye wala)$/;
const THIS = /\b(this|that|it|this one|that one|ini|itu|yang ini|este|esse|isso|isto|isko|ise|ye|yeh)\b|इसे|इस|यह|ये/;
const VERBS: [Verb, RegExp][] = [
  ["cancel", /\b(cancel\w*|batal\w*|cancela\w*|radd|band)\b|रद्द|बंद/],
  ["delete", /\b(delete|remove|hapus|excluir|apagar|remover|hatao)\b|हटाओ|हटाएँ|मिटाओ/],
  ["refund", /\b(refund\w*|kembalikan dana|reembols\w*)\b|रिफ़ंड|रिफंड|पैसे वापस/],
  ["pay", /\b(pay|pay for|bayar|pagar|pague|payment)\b|भुगतान|पे करो/],
  ["send", /\b(send|kirim|enviar|envie|bhejo)\b|भेजो|भेजें/],
  ["dispute", /\b(dispute|sengketa|contestar|disputa)\b|विवाद/],
  ["approve", /\b(approve|setujui|aprovar|aprove|manzoor)\b|मंज़ूर|मंजूर|स्वीकृत/],
  ["decline", /\b(decline|deny|reject|tolak|recusar|recuse|negar)\b|अस्वीकार|मना/],
  ["subscribe", /\b(subscribe|berlangganan|assinar|assine)\b|सदस्यता लो|सदस्यता लें/],
  ["take", /\b(take (the|this|that)? ?offer|accept|ambil|terima|aceitar|aceito)\b|ऑफ़र लो|ऑफर लो|स्वीकार/],
];

/** What the words ask for. `confirming` is true while a confirm card is open: then only "yes" means yes. */
export function parse(text: string, confirming = false): Intent {
  const t = norm(text);
  if (!t) return { kind: "none" };
  if (STOP.test(t)) return { kind: "stop" };
  if (confirming) return YES.test(t) ? { kind: "yes" } : { kind: "none" };
  if (YES.test(t)) return { kind: "none" };
  if (CLICK.test(t)) return { kind: "click" };
  if (/^(scroll down|down|go down|turun|gulir ke bawah|rolar para baixo|desce|descer|नीचे|नीचे जाओ|neeche)$/.test(t)) return { kind: "scroll", dir: "down" };
  if (/^(scroll up|up|go up|naik|gulir ke atas|rolar para cima|sobe|subir|ऊपर|ऊपर जाओ|upar)$/.test(t)) return { kind: "scroll", dir: "up" };
  if (/^(go back|back|kembali|voltar|volta|पीछे|वापस|wapas)$/.test(t)) return { kind: "back" };
  if (/^(recalibrate|calibrate|kalibrasi|kalibrasi ulang|calibrar|recalibrar|कैलिब्रेट)$/.test(t)) return { kind: "calibrate" };
  if (/^(quick calibrate|top up|kalibrasi cepat|calibração rápida|ajuste rápido|जल्दी कैलिब्रेट)$/.test(t)) return { kind: "topup" };
  if (/^(re ?cent(er|re)|center|centre|tengah|centralizar|बीच में)$/.test(t)) return { kind: "recentre" };
  // "Cancel this", "delete that", "pay for this": a verb aimed at whatever is outlined.
  if (THIS.test(t) && t.split(" ").length <= 5) for (const [verb, r] of VERBS) if (r.test(t)) return { kind: "act", verb };
  return { kind: "free", text: text.trim().slice(0, 400) };
}

/** Words on a control that mean it moves money, ends something or sends something: a confirm card first. */
export const DESTRUCTIVE = /\b(cancel\w*|delete|remove|refund\w*|pay\b|payment|subscribe|approve|decline|send|dispute|take the offer|batal\w*|hapus|bayar|berlangganan|setujui|tolak|kirim|ambil penawaran|cancela\w*|excluir|reembols\w*|pagar|assinar|aprovar|recusar|enviar|aceitar a oferta)\b|रद्द|हटाएँ|भुगतान|सदस्यता लें|मंज़ूरी|मंज़ूर|भेजें|ऑफ़र लें|अस्वीकार/i;

/** A free request that could end or change money in the assistant's hands: confirm before sending it on. */
export function freeNeedsConfirm(text: string): boolean {
  const t = norm(text);
  return VERBS.some(([v, r]) => ["cancel", "refund", "pay", "dispute", "delete", "send", "take"].includes(v) && r.test(t));
}

/** A free request that is longer than one action would need more than the 10-step cap. */
export const MAX_STEPS = 10;
export function stepsIn(text: string): number {
  return norm(text).split(/\b(?:and then|then|and|after that|lalu|kemudian|dan|e depois|depois|e|फिर|और|aur|phir)\b/).filter((x) => x.trim().length > 2).length;
}
