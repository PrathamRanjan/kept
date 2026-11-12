/**
 * Kept per-app item 1: the member's assistant and the shop's agent talk before a cancel, at most two moves each,
 * with a code referee. Section 0.2 holds throughout:
 *   - which offers exist is the shop's rules (eligibleOffers), never a model;
 *   - the member's limit ("under $10 a month") is read from their words by code, never by a model;
 *   - whether the member's side accepts is the referee's check of the offer's terms against that limit;
 *   - a model may read what kind of thing the member wants (a cheaper price, a break, fewer deliveries) and may
 *     word the lines in the member's language; every number in a model line must be one of the move's own numbers.
 * The talk only ever proposes. An agreed offer becomes the ordinary offer card, which the member must take with a
 * click; no deal leaves the subscription as it is until the member presses Cancel.
 */
import type { EligibleOffer } from "../policy/eligibility.js";
import { fmtMoneyIn, type Lang } from "../i18n.js";

export type Stance = "cheaper" | "break" | "fewer" | "any" | "nothing";
export const MAX_MOVES_EACH = 2;

const NUM = String.raw`(\d+(?:[.,]\d{1,2})?)`;
const SYM = String.raw`(?:US\$|R\$|S\$|A\$|Rp\.?|₹|\$|€|£)?\s*`;
const LIMIT = [
  new RegExp(String.raw`(?:under|below|less than|at most|max(?:imum)?|no more than|up to|cheaper than)\s*${SYM}${NUM}`, "i"),
  new RegExp(String.raw`${SYM}${NUM}\s*(?:or less|or under|max|tops)\b`, "i"),
  new RegExp(String.raw`(?:menos de|abaixo de|no máximo|até|mais barato que)\s*${SYM}${NUM}`, "i"),
  new RegExp(String.raw`(?:di bawah|kurang dari|paling banyak|maksimal|maks\.?|tidak lebih dari)\s*${SYM}${NUM}`, "i"),
  new RegExp(String.raw`${SYM}${NUM}\s*(?:से कम|तक|से ज़्यादा नहीं|से ज्यादा नहीं|se kam|tak)`, "i"),
];

/** The most the member will pay per cycle, read by code from their own words. Null when they named no limit. */
export function maxPriceFrom(text: string): number | null {
  for (const r of LIMIT) {
    const m = text.match(r);
    if (m) {
      const n = Number(m[1].replace(",", "."));
      if (Number.isFinite(n) && n > 0 && n < 100000) return n;
    }
  }
  return null;
}

const WORDS: [Stance, RegExp][] = [
  ["nothing", /\b(no offers?|nothing|just cancel|no deals?|sem ofertas?|nada|só cancel\w*|tanpa penawaran|tidak ada|langsung batal\w*)\b|कुछ नहीं|कोई ऑफ़र नहीं|कोई ऑफर नहीं/i],
  ["break", /\b(pause|break|time off|away|travel\w*|holiday|vacation|jeda|libur|cuti|pausa|pausar|férias|viagem|viajando)\b|ब्रेक|रोक|छुट्टी|बाहर जा/i],
  ["fewer", /\b(less often|fewer|too much|piling|smaller|lighter|lebih jarang|terlalu banyak|menumpuk|lebih ringan|menos|acumul\w*|mais leve|demais)\b|कम बार|बहुत ज़्यादा|हल्का/i],
  ["cheaper", /\b(cheap\w*|price|expensive|discount|money|afford|budget|cost\w*|mahal|murah|diskon|harga|uang|caro|barato|desconto|preço|dinheiro)\b|सस्ता|महंगा|छूट|पैसे|क़ीमत|कीमत/i],
];

/** Code's reading of the member's words. A named limit means "cheaper" unless they asked for a break. */
export function stanceFromWords(text: string): Stance {
  const t = text.trim();
  if (!t) return "any";
  for (const [s, r] of WORDS) if (r.test(t)) return s;
  return maxPriceFrom(t) !== null ? "cheaper" : "any";
}

/** The strictest of the two readings wins: "nothing" from either side means no offer is accepted. */
export function combineStance(code: Stance, model: Stance | null): Stance {
  if (code === "nothing" || model === "nothing") return "nothing";
  if (!model) return code;
  if (code !== "any") return code;
  return model;
}

export interface Ask { stance: Stance; maxPrice: number | null }

/**
 * The referee's acceptance check: does this offer give the member what they said they would stay for?
 * Pure code over the offer's own terms.
 */
export function acceptable(o: EligibleOffer, ask: Ask, currentPrice: number): { ok: boolean; why: string } {
  if (ask.stance === "nothing") return { ok: false, why: "the member asked for no offers" };
  const price = o.type === "discount" || o.type === "switch_plan" ? o.terms.newPrice ?? currentPrice : currentPrice;
  if (ask.maxPrice !== null && ask.stance !== "break" && price > ask.maxPrice + 1e-9) return { ok: false, why: `the price after it (${price.toFixed(2)}) is above the member's limit of ${ask.maxPrice.toFixed(2)}` };
  if (ask.stance === "cheaper" && !((o.type === "discount" || o.type === "switch_plan") && price < currentPrice)) return { ok: false, why: "the member wants a lower price and this does not lower it" };
  if (ask.stance === "break" && !(o.type === "pause" || o.type === "skip")) return { ok: false, why: "the member wants a break and this is not one" };
  if (ask.stance === "fewer" && !(o.type === "skip" || (o.type === "switch_plan" && price < currentPrice))) return { ok: false, why: "the member wants less and this does not give less" };
  return { ok: true, why: ask.maxPrice !== null && ask.stance !== "break" ? `within the member's limit of ${ask.maxPrice.toFixed(2)}` : `it matches what the member asked for (${ask.stance})` };
}

/** The shop agent's second move: an eligible offer it has not made yet, preferring one the member would accept. */
export function secondOffer(eligible: EligibleOffer[], first: EligibleOffer | null, ask: Ask, currentPrice: number): EligibleOffer | null {
  const rest = eligible.filter((o) => o.key !== first?.key);
  return rest.find((o) => acceptable(o, ask, currentPrice).ok) ?? null;
}

export type Speaker = "member" | "shop" | "referee";
export interface Line { who: Speaker; move: number | null; kind: string; text: string; offer?: string | null; numbers: string[] }

/** The words of each move, in the member's language. Numbers come only from the move's terms. */
export function lineText(kind: string, lang: Lang, v: { shop: string; offer?: EligibleOffer | null; ask?: Ask; currency: string; why?: string }): string {
  const o = v.offer;
  const money = (n: number | undefined) => fmtMoneyIn(n ?? 0, v.currency, lang);
  const what = (() => {
    if (!o) return "";
    const n = o.terms.cycles ?? 1;
    const T = {
      en: { pause: `a pause for ${n} billing cycle${n === 1 ? "" : "s"}`, skip: "skipping just the next renewal", switch_plan: `${o.terms.toPlanName} at ${money(o.terms.newPrice)} a cycle`, discount: `${o.terms.percent}% off for ${n} cycle${n === 1 ? "" : "s"} (${money(o.terms.newPrice)} each)` },
      "hi-IN": { pause: `${n} बिलिंग चक्र का ठहराव`, skip: "सिर्फ़ अगला नवीनीकरण छोड़ना", switch_plan: `हर चक्र ${money(o.terms.newPrice)} पर ${o.terms.toPlanName}`, discount: `${n} चक्र के लिए ${o.terms.percent}% छूट (हर बार ${money(o.terms.newPrice)})` },
      "id-ID": { pause: `jeda selama ${n} siklus tagihan`, skip: "melewati perpanjangan berikutnya saja", switch_plan: `${o.terms.toPlanName} seharga ${money(o.terms.newPrice)} per siklus`, discount: `diskon ${o.terms.percent}% selama ${n} siklus (${money(o.terms.newPrice)} per siklus)` },
      "pt-BR": { pause: `uma pausa de ${n} ciclo${n === 1 ? "" : "s"} de cobrança`, skip: "pular só a próxima renovação", switch_plan: `${o.terms.toPlanName} por ${money(o.terms.newPrice)} por ciclo`, discount: `${o.terms.percent}% de desconto por ${n} ciclo${n === 1 ? "" : "s"} (${money(o.terms.newPrice)} cada)` },
    }[lang];
    return T[o.type];
  })();
  const askWords = (() => {
    const a = v.ask;
    if (!a) return "";
    const lim = a.maxPrice !== null ? money(a.maxPrice) : null;
    return {
      en: { cheaper: lim ? `a price under ${lim} a cycle` : "a lower price", break: "a break", fewer: "getting less, less often", any: "something reasonable", nothing: "no offer at all" },
      "hi-IN": { cheaper: lim ? `हर चक्र ${lim} से कम क़ीमत` : "कम क़ीमत", break: "एक ब्रेक", fewer: "कम और कम बार", any: "कुछ ठीक-ठाक", nothing: "कोई ऑफ़र नहीं" },
      "id-ID": { cheaper: lim ? `harga di bawah ${lim} per siklus` : "harga lebih murah", break: "jeda", fewer: "lebih sedikit, lebih jarang", any: "sesuatu yang masuk akal", nothing: "tanpa penawaran sama sekali" },
      "pt-BR": { cheaper: lim ? `um preço abaixo de ${lim} por ciclo` : "um preço menor", break: "uma pausa", fewer: "receber menos, com menos frequência", any: "algo razoável", nothing: "nenhuma oferta" },
    }[lang][a.stance];
  })();
  const L: Record<string, Record<Lang, string>> = {
    open: { en: `My member wants to cancel. They would stay for ${askWords}.`, "hi-IN": `मेरे सदस्य रद्द करना चाहते हैं। वे ${askWords} पर रुकेंगे।`, "id-ID": `Anggota saya ingin membatalkan. Mereka mau bertahan dengan ${askWords}.`, "pt-BR": `Meu assinante quer cancelar. Ficaria por ${askWords}.` },
    open_nothing: { en: "My member wants to cancel and asked for no offers.", "hi-IN": "मेरे सदस्य रद्द करना चाहते हैं और उन्होंने कोई ऑफ़र नहीं माँगा।", "id-ID": "Anggota saya ingin membatalkan dan meminta tanpa penawaran.", "pt-BR": "Meu assinante quer cancelar e pediu nenhuma oferta." },
    offer: { en: `${v.shop} can offer ${what}.`, "hi-IN": `${v.shop} ${what} दे सकता है।`, "id-ID": `${v.shop} bisa menawarkan ${what}.`, "pt-BR": `${v.shop} pode oferecer ${what}.` },
    none: { en: `${v.shop}'s rules allow no offer for this member right now. Cancelling goes ahead whenever they say.`, "hi-IN": `${v.shop} के नियम अभी इस सदस्य के लिए कोई ऑफ़र नहीं देते। वे जब कहें, रद्द हो जाएगा।`, "id-ID": `Aturan ${v.shop} tidak mengizinkan penawaran untuk anggota ini sekarang. Pembatalan berjalan kapan pun mereka mau.`, "pt-BR": `As regras de ${v.shop} não permitem oferta para este assinante agora. O cancelamento segue quando ele quiser.` },
    none_more: { en: "There is nothing else within the shop's rules.", "hi-IN": "दुकान के नियमों में इसके अलावा कुछ नहीं है।", "id-ID": "Tidak ada lagi yang sesuai aturan toko.", "pt-BR": "Não há mais nada dentro das regras da loja." },
    respect: { en: "Understood. No offer. Cancelling goes ahead whenever they say.", "hi-IN": "समझ गए। कोई ऑफ़र नहीं। वे जब कहें, रद्द हो जाएगा।", "id-ID": "Mengerti. Tanpa penawaran. Pembatalan berjalan kapan pun mereka mau.", "pt-BR": "Entendido. Sem oferta. O cancelamento segue quando ele quiser." },
    accept: { en: `That works for my member. I'll ask them to confirm.`, "hi-IN": "यह मेरे सदस्य के लिए ठीक है। मैं उनसे पुष्टि करवाऊँगा।", "id-ID": "Itu cocok untuk anggota saya. Saya akan minta mereka mengonfirmasi.", "pt-BR": "Isso serve para meu assinante. Vou pedir que ele confirme." },
    counter: { en: `Not that. They would stay for ${askWords}.`, "hi-IN": `वह नहीं। वे ${askWords} पर रुकेंगे।`, "id-ID": `Bukan itu. Mereka mau bertahan dengan ${askWords}.`, "pt-BR": `Isso não. Ficaria por ${askWords}.` },
    decline: { en: "No deal, then. My member will cancel when they choose.", "hi-IN": "तो कोई सौदा नहीं। मेरे सदस्य जब चाहें रद्द करेंगे।", "id-ID": "Kalau begitu tidak ada kesepakatan. Anggota saya akan membatalkan saat mereka mau.", "pt-BR": "Então, sem acordo. Meu assinante cancela quando quiser." },
    ref_ok: { en: `Checked: allowed by ${v.shop}'s rules for this member.`, "hi-IN": `जाँचा गया: इस सदस्य के लिए ${v.shop} के नियमों में अनुमति है।`, "id-ID": `Diperiksa: diizinkan aturan ${v.shop} untuk anggota ini.`, "pt-BR": `Conferido: permitido pelas regras de ${v.shop} para este assinante.` },
    ref_accept: { en: `Checked: ${v.why ?? ""}.`, "hi-IN": "जाँचा गया: यह सदस्य की कही बात से मेल खाता है।", "id-ID": "Diperiksa: sesuai dengan yang diminta anggota.", "pt-BR": "Conferido: corresponde ao que o assinante pediu." },
    ref_reject: { en: `Checked: not acceptable, because ${v.why ?? ""}.`, "hi-IN": "जाँचा गया: स्वीकार नहीं, यह सदस्य की कही बात से मेल नहीं खाता।", "id-ID": "Diperiksa: tidak dapat diterima, tidak sesuai dengan yang diminta anggota.", "pt-BR": "Conferido: não aceitável, não corresponde ao que o assinante pediu." },
    ref_end: { en: "Talk over: nothing has changed. The member decides next.", "hi-IN": "बातचीत ख़त्म: कुछ नहीं बदला। आगे का फ़ैसला सदस्य का है।", "id-ID": "Pembicaraan selesai: tidak ada yang berubah. Anggota yang memutuskan berikutnya.", "pt-BR": "Fim da conversa: nada mudou. O assinante decide o próximo passo." },
  };
  return L[kind][lang];
}

/** Every number a line may state: the offer's own terms, the member's limit, and the referee's figures. */
export function allowedNumbers(o: EligibleOffer | null | undefined, ask: Ask | null): Set<string> {
  const out = new Set<string>();
  const add = (v: number | undefined | null) => {
    if (v === undefined || v === null) return;
    out.add(String(v));
    out.add(Number(v).toFixed(2));
    out.add(String(Math.round(Number(v))));
  };
  if (o) [o.terms.cycles, o.terms.percent, o.terms.newPrice].forEach(add);
  if (ask) add(ask.maxPrice);
  return out;
}
export function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(",", "."));
}
