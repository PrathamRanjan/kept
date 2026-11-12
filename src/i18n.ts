/**
 * Part B of the cross-app list: the member's flow in English, Hindi, Bahasa Indonesia and Brazilian Portuguese.
 * Server side only: words Kept itself sends (rule lines, billing words, action confirmations, offer and reminder
 * templates, payment-failure notes, negotiation lines). The web app has its own dictionaries (web/src/i18n).
 *
 * Every translation here is machine-written and not yet reviewed by a person; pages that show payment or consent
 * wording in another language say so. Logic never depends on these words: code works with codes and numbers, and
 * only the display text changes. Shop, plan and product names are never translated.
 */
import type { Rules } from "./policy/rules.js";
import type { EligibleOffer } from "./policy/eligibility.js";
import type { ReasonCategory } from "./brain/types.js";

export type Lang = "en" | "hi-IN" | "id-ID" | "pt-BR";
export const LANGS: Lang[] = ["en", "hi-IN", "id-ID", "pt-BR"];
export const LANG_NAME: Record<Lang, string> = { en: "English", "hi-IN": "Hindi", "id-ID": "Bahasa Indonesia", "pt-BR": "Brazilian Portuguese" };

/** Any tag, header or stored value to one of the four; anything else is English. */
export function normLang(x: unknown): Lang {
  const s = String(x ?? "").trim().toLowerCase().replace("_", "-");
  if (s.startsWith("hi")) return "hi-IN";
  if (s.startsWith("id") || s === "in" || s.startsWith("in-")) return "id-ID";
  if (s.startsWith("pt")) return "pt-BR";
  return "en";
}

/** The locale PayPal's approval page is opened in. PayPal has no Hindi page, so Hindi opens in Indian English. */
export const PAYPAL_LOCALE: Record<Lang, string | null> = { en: null, "hi-IN": "en-IN", "id-ID": "id-ID", "pt-BR": "pt-BR" };

const BCP: Record<Lang, string> = { en: "en-US", "hi-IN": "hi-IN", "id-ID": "id-ID", "pt-BR": "pt-BR" };
export function fmtMoneyIn(amount: number, currency: string, lang: Lang): string {
  try {
    return new Intl.NumberFormat(BCP[lang], { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}
export function fmtDateIn(d: Date | string, lang: Lang): string {
  return new Date(d).toLocaleDateString(BCP[lang], { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

type Unit = "DAY" | "WEEK" | "MONTH" | "YEAR";
const UNIT: Record<Lang, Record<Unit, [string, string]>> = {
  en: { DAY: ["day", "days"], WEEK: ["week", "weeks"], MONTH: ["month", "months"], YEAR: ["year", "years"] },
  "hi-IN": { DAY: ["दिन", "दिन"], WEEK: ["हफ़्ता", "हफ़्ते"], MONTH: ["महीना", "महीने"], YEAR: ["साल", "साल"] },
  "id-ID": { DAY: ["hari", "hari"], WEEK: ["minggu", "minggu"], MONTH: ["bulan", "bulan"], YEAR: ["tahun", "tahun"] },
  "pt-BR": { DAY: ["dia", "dias"], WEEK: ["semana", "semanas"], MONTH: ["mês", "meses"], YEAR: ["ano", "anos"] },
};

export function billingIn(p: { interval_unit: string; interval_count: number }, lang: Lang): string {
  const u = (p.interval_unit.toUpperCase() as Unit) in UNIT.en ? (p.interval_unit.toUpperCase() as Unit) : "MONTH";
  const n = p.interval_count;
  const [one, many] = UNIT[lang][u];
  if (lang === "en") return n === 1 ? `per ${one}` : `every ${n} ${many}`;
  if (lang === "hi-IN") return n === 1 ? `हर ${u === "MONTH" ? "महीने" : u === "WEEK" ? "हफ़्ते" : one}` : `हर ${n} ${many}`;
  if (lang === "id-ID") return n === 1 ? `per ${one}` : `setiap ${n} ${many}`;
  return n === 1 ? `por ${one}` : `a cada ${n} ${many}`;
}

const cyc: Record<Lang, (n: number) => string> = {
  en: (n) => `${n} billing cycle${n === 1 ? "" : "s"}`,
  "hi-IN": (n) => `${n} बिलिंग चक्र`,
  "id-ID": (n) => `${n} siklus tagihan`,
  "pt-BR": (n) => `${n} ciclo${n === 1 ? "" : "s"} de cobrança`,
};

/** The shop's promise to members, from the approved rules, in the member's language. English is describeRules. */
export function describeRulesIn(r: Rules, lang: Lang, english: () => string[]): string[] {
  if (lang === "en") return english();
  const c = cyc[lang];
  const out: string[] = [];
  const L = {
    "hi-IN": {
      skip: (n: number, d: number) => `हर ${d} दिनों में ${n} बार तक अगला नवीनीकरण छोड़ें।`,
      pause: (n: number) => `${c(n)} तक रोकें।`,
      lite: "किसी भी समय हल्के प्लान पर जाएँ।",
      refund: (x: string) => `रद्द करने पर, मौजूदा चक्र का बचा हुआ हिस्सा लौटाया जाता है, अधिकतम ${x}।`,
      discount: (p: number, n: number, t: number) => `${c(n)} के लिए ${p}% छूट${t ? `, कम से कम ${t} दिन पुराने सदस्यों के लिए।` : "।"}`,
      cooldown: (d: number, m: number) => `हर सदस्य को ${d} दिनों में अधिकतम एक ऑफ़र; ऑफ़र ${m} मिनट में समाप्त हो जाते हैं।`,
      remind: (d: number) => `हर भुगतान से ${d} दिन पहले एक याद-संदेश, जहाँ छोड़ना संभव हो वहाँ एक टैप में छोड़ें।`,
      cancel: "रद्द करना हमेशा एक ही क़दम में होता है। ऑफ़र सुनना वैकल्पिक है, कभी ज़रूरी नहीं।",
    },
    "id-ID": {
      skip: (n: number, d: number) => `Lewati hingga ${n} perpanjangan setiap ${d} hari.`,
      pause: (n: number) => `Jeda hingga ${c(n)}.`,
      lite: "Pindah ke paket yang lebih ringan kapan saja.",
      refund: (x: string) => `Jika Anda membatalkan, sisa siklus berjalan dikembalikan, paling banyak ${x}.`,
      discount: (p: number, n: number, t: number) => `Diskon ${p}% selama ${c(n)}${t ? ` untuk pelanggan minimal ${t} hari.` : "."}`,
      cooldown: (d: number, m: number) => `Paling banyak satu penawaran per pelanggan setiap ${d} hari; penawaran berakhir setelah ${m} menit.`,
      remind: (d: number) => `Pengingat ${d} hari sebelum setiap tagihan, dengan lewati sekali ketuk jika diizinkan.`,
      cancel: "Pembatalan selalu cukup satu langkah. Mendengar penawaran itu pilihan, tidak pernah wajib.",
    },
    "pt-BR": {
      skip: (n: number, d: number) => `Pule até ${n} renovaç${n === 1 ? "ão" : "ões"} a cada ${d} dias.`,
      pause: (n: number) => `Pause por até ${c(n)}.`,
      lite: "Mude para o plano mais leve quando quiser.",
      refund: (x: string) => `Se você cancelar, a parte não usada do ciclo atual é reembolsada, até ${x}.`,
      discount: (p: number, n: number, t: number) => `Desconto de ${p}% por ${c(n)}${t ? ` para assinantes há pelo menos ${t} dias.` : "."}`,
      cooldown: (d: number, m: number) => `No máximo uma oferta por assinante a cada ${d} dias; as ofertas expiram em ${m} minutos.`,
      remind: (d: number) => `Um lembrete ${d} dias antes de cada cobrança, com pular em um toque quando permitido.`,
      cancel: "Cancelar sempre leva um passo só. Ouvir uma oferta é opcional, nunca obrigatório.",
    },
  }[lang];
  if (r.skip.enabled) out.push(L.skip(r.skip.maxPerPeriod, r.skip.periodDays));
  if (r.pause.enabled) out.push(L.pause(r.pause.maxCycles));
  if (r.switchToLite.enabled) out.push(L.lite);
  if (r.refundUnused?.enabled && r.refundUnused.maxAmount > 0) out.push(L.refund(r.refundUnused.maxAmount.toFixed(2)));
  if (r.discount.enabled) out.push(L.discount(r.discount.percent, r.discount.cycles, r.minTenureDaysForDiscount ?? 0));
  out.push(L.cooldown(r.offerCooldownDays, r.offerExpiryMinutes));
  if ((r.renewalReminderDays ?? 0) > 0) out.push(L.remind(r.renewalReminderDays!));
  out.push(L.cancel);
  return out;
}

export const NO_RULES_PROMISE: Record<Lang, string> = {
  en: "Cancelling always works in one step.",
  "hi-IN": "रद्द करना हमेशा एक ही क़दम में होता है।",
  "id-ID": "Pembatalan selalu cukup satu langkah.",
  "pt-BR": "Cancelar sempre leva um passo só.",
};

/** Confirmations for the member's own buttons. Keys are codes; the English text is what Kept said before. */
const MSG = {
  skipped: { en: "Next delivery skipped.", "hi-IN": "अगली डिलीवरी छोड़ दी गई।", "id-ID": "Pengiriman berikutnya dilewati.", "pt-BR": "Próxima entrega pulada." },
  paused: { en: "Paused.", "hi-IN": "रोक दिया गया।", "id-ID": "Dijeda.", "pt-BR": "Pausada." },
  resumed: { en: "Resumed. Your next payment is back on.", "hi-IN": "फिर से शुरू। आपका अगला भुगतान वापस चालू है।", "id-ID": "Dilanjutkan. Pembayaran berikutnya aktif lagi.", "pt-BR": "Retomada. Seu próximo pagamento voltou." },
  switch_approve: { en: "PayPal needs you to approve the new price.", "hi-IN": "PayPal को नई क़ीमत के लिए आपकी मंज़ूरी चाहिए।", "id-ID": "PayPal perlu Anda menyetujui harga baru.", "pt-BR": "O PayPal precisa que você aprove o novo preço." },
  switched: { en: "Switched to {plan}.", "hi-IN": "{plan} पर बदल दिया गया।", "id-ID": "Pindah ke {plan}.", "pt-BR": "Mudou para {plan}." },
  switch_next: { en: "Switch to {plan} accepted; it starts from your next payment.", "hi-IN": "{plan} पर बदलाव स्वीकार; यह आपके अगले भुगतान से शुरू होगा।", "id-ID": "Pindah ke {plan} diterima; berlaku mulai pembayaran berikutnya.", "pt-BR": "Mudança para {plan} aceita; começa no seu próximo pagamento." },
  offer_open: { en: "Here is one offer. Take it, or cancel now.", "hi-IN": "यह एक ऑफ़र है। इसे लें, या अभी रद्द करें।", "id-ID": "Ini satu penawaran. Ambil, atau batalkan sekarang.", "pt-BR": "Aqui está uma oferta. Aceite, ou cancele agora." },
  cancel_pending: { en: "Cancellation requested. PayPal hasn't confirmed yet; Kept keeps retrying.", "hi-IN": "रद्द करने का अनुरोध भेजा गया। PayPal ने अभी पुष्टि नहीं की है; Kept कोशिश करता रहेगा।", "id-ID": "Pembatalan diminta. PayPal belum mengonfirmasi; Kept terus mencoba.", "pt-BR": "Cancelamento pedido. O PayPal ainda não confirmou; o Kept continua tentando." },
  cancelled_no_offer: { en: "No offer applies to you right now, so we cancelled as you asked. You won't be charged again.", "hi-IN": "अभी आप पर कोई ऑफ़र लागू नहीं होता, इसलिए आपके कहे अनुसार रद्द कर दिया। आपसे फिर से शुल्क नहीं लिया जाएगा।", "id-ID": "Tidak ada penawaran untuk Anda saat ini, jadi kami membatalkan sesuai permintaan. Anda tidak akan ditagih lagi.", "pt-BR": "Nenhuma oferta se aplica a você agora, então cancelamos como pediu. Você não será cobrado de novo." },
  cancelled: { en: "Cancelled. You won't be charged again.", "hi-IN": "रद्द कर दिया गया। आपसे फिर से शुल्क नहीं लिया जाएगा।", "id-ID": "Dibatalkan. Anda tidak akan ditagih lagi.", "pt-BR": "Cancelada. Você não será cobrado de novo." },
  promise: { en: "No reminders until {date}. A promise doesn't move any money.", "hi-IN": "{date} तक कोई याद-संदेश नहीं। वादे से कोई पैसा नहीं हिलता।", "id-ID": "Tidak ada pengingat sampai {date}. Janji tidak memindahkan uang.", "pt-BR": "Sem lembretes até {date}. Uma promessa não move dinheiro." },
  kept: { en: "Done. Thanks for staying.", "hi-IN": "हो गया। बने रहने के लिए धन्यवाद।", "id-ID": "Selesai. Terima kasih sudah bertahan.", "pt-BR": "Pronto. Obrigado por ficar." },
  cancel_pending_short: { en: "Cancellation requested. PayPal hasn't confirmed yet; we keep retrying.", "hi-IN": "रद्द करने का अनुरोध भेजा गया। PayPal ने अभी पुष्टि नहीं की है; हम कोशिश करते रहेंगे।", "id-ID": "Pembatalan diminta. PayPal belum mengonfirmasi; kami terus mencoba.", "pt-BR": "Cancelamento pedido. O PayPal ainda não confirmou; seguimos tentando." },
} satisfies Record<string, Record<Lang, string>>;
export type MsgCode = keyof typeof MSG;
export function msg(code: MsgCode, lang: Lang, vars: Record<string, string> = {}): string {
  return MSG[code][lang].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

/** Kept's own offer wording, used when the model does not answer or wording is checked and dropped. */
export function offerTemplate(offer: EligibleOffer, ctx: { merchantName: string; currency: string; category: ReasonCategory; subscriberName?: string | null }, lang: Lang, english: () => string): string {
  if (lang === "en") return english();
  const first = ctx.subscriberName ? ctx.subscriberName.split(" ")[0] : "";
  const n = offer.terms.cycles ?? 1;
  const price = fmtMoneyIn(offer.terms.newPrice ?? 0, ctx.currency, lang);
  const T = {
    "hi-IN": {
      lead: { price: "समझ गए, पैसा मायने रखता है।", too_much: "अगर ज़्यादा जमा हो रहा है तो ठीक है।", away: "सफ़र मंगलमय हो।", competitor: "दूसरी जगह देखना ठीक है।", no_need: "समझ गए।", other: "समझ गए।", quality: "बताने के लिए धन्यवाद।", payment: "बताने के लिए धन्यवाद।" },
      pause: `हम आपकी ${ctx.merchantName} सदस्यता को ${cyc["hi-IN"](n)} के लिए रोक सकते हैं, फिर से शुरू होने तक कोई शुल्क नहीं।`,
      skip: "हम सिर्फ़ आपका अगला नवीनीकरण छोड़ सकते हैं, उसके लिए कोई शुल्क नहीं, फिर सब पहले जैसा।",
      switch_plan: `हम आपको हर चक्र ${price} पर ${offer.terms.toPlanName} पर ले जा सकते हैं।`,
      discount: `हम अगले ${cyc["hi-IN"](n)} के लिए ${offer.terms.percent}% छूट दे सकते हैं (हर बार ${price}), फिर सामान्य क़ीमत।`,
      end: "अगर आप रद्द करना चाहें, तो ना कहें और यह तुरंत रद्द हो जाएगा।",
    },
    "id-ID": {
      lead: { price: "Mengerti, uang itu penting.", too_much: "Masuk akal kalau menumpuk.", away: "Selamat jalan.", competitor: "Wajar membandingkan.", no_need: "Mengerti.", other: "Mengerti.", quality: "Terima kasih sudah memberi tahu.", payment: "Terima kasih sudah memberi tahu." },
      pause: `kami bisa menjeda langganan ${ctx.merchantName} Anda selama ${cyc["id-ID"](n)}, tanpa tagihan sampai dimulai lagi.`,
      skip: "kami bisa melewati perpanjangan berikutnya saja, tanpa tagihan untuk itu, lalu berlanjut seperti biasa.",
      switch_plan: `kami bisa memindahkan Anda ke ${offer.terms.toPlanName} seharga ${price} per siklus.`,
      discount: `kami bisa memberi diskon ${offer.terms.percent}% untuk ${cyc["id-ID"](n)} berikutnya (${price} per siklus), lalu kembali ke harga biasa.`,
      end: "Jika Anda lebih memilih batal, jawab tidak dan langganan langsung dibatalkan.",
    },
    "pt-BR": {
      lead: { price: "Entendido, dinheiro importa.", too_much: "Faz sentido se está acumulando.", away: "Boa viagem.", competitor: "Justo comparar.", no_need: "Entendido.", other: "Entendido.", quality: "Obrigado por nos contar.", payment: "Obrigado por avisar." },
      pause: `podemos pausar sua assinatura ${ctx.merchantName} por ${cyc["pt-BR"](n)}, sem cobrança até voltar.`,
      skip: "podemos pular só a sua próxima renovação, sem cobrança por ela, e seguir depois.",
      switch_plan: `podemos mudar você para ${offer.terms.toPlanName} por ${price} por ciclo.`,
      discount: `podemos dar ${offer.terms.percent}% de desconto nos próximos ${cyc["pt-BR"](n)} (${price} cada), e depois volta ao preço normal.`,
      end: "Se preferir cancelar, diga não e a assinatura é cancelada na hora.",
    },
  }[lang];
  const hi = first ? `${first}, ` : "";
  return `${T.lead[ctx.category]} ${hi}${T[offer.type]} ${T.end}`;
}

/** A word that shows the cancel path is in the message, per language (the model-wording check). */
export const CANCEL_PATH: Record<Lang, RegExp> = { en: /cancel/i, "hi-IN": /रद्द|cancel/i, "id-ID": /batal/i, "pt-BR": /cancel/i };

export function paymentFailureTemplate(ctx: { merchantName: string; amount: number; currency: string; attempts: number; manageUrl: string }, lang: Lang, english: () => string): string {
  if (lang === "en") return english();
  const a = fmtMoneyIn(ctx.amount, ctx.currency, lang);
  // The plain amount stays in the text too, so code can check the model's wording against it.
  const raw = ctx.amount.toFixed(2);
  return {
    "hi-IN": `आपका ${ctx.merchantName} नवीनीकरण ${a} (${raw}) पूरा नहीं हुआ (प्रयास ${ctx.attempts})। आमतौर पर इसका मतलब है कि PayPal से जुड़ा कार्ड या बैंक बदल गया है या समाप्त हो गया है। अपने PayPal खाते में भुगतान का तरीका अपडेट करें, फिर दोबारा कोशिश के लिए ${ctx.manageUrl} खोलें। और कुछ नहीं बदलता; अगर आप रोकना चाहें, तो उसी पेज से रद्द कर सकते हैं।`,
    "id-ID": `Perpanjangan ${ctx.merchantName} Anda sebesar ${a} (${raw}) tidak berhasil (percobaan ${ctx.attempts}). Biasanya kartu atau bank yang terhubung ke PayPal sudah kedaluwarsa atau berubah. Perbarui metode pembayaran di akun PayPal Anda, lalu buka ${ctx.manageUrl} untuk mencoba lagi. Tidak ada yang lain berubah; jika ingin berhenti, Anda bisa membatalkan dari halaman yang sama.`,
    "pt-BR": `Sua renovação ${ctx.merchantName} de ${a} (${raw}) não foi concluída (tentativa ${ctx.attempts}). Isso costuma significar que o cartão ou banco ligado ao PayPal expirou ou mudou. Atualize a forma de pagamento na sua conta PayPal e use ${ctx.manageUrl} para tentar de novo. Nada mais muda; se preferir parar, você pode cancelar na mesma página.`,
  }[lang];
}

export function reminderIn(o: { shop: string; plan: string | null; date: Date; price: number | null; currency: string; url: string }, lang: Lang): { body: string; keep: string; skip: string; cancel: string } {
  const d = fmtDateIn(o.date, lang);
  const p = o.price !== null ? fmtMoneyIn(o.price, o.currency, lang) : null;
  if (lang === "en") return { body: `${o.shop}: your ${o.plan ?? "subscription"} renews on ${o.date.toISOString().slice(0, 10)}${p !== null ? ` for ${o.price!.toFixed(2)} ${o.currency}` : ""}. Nothing to do to keep it. Manage: ${o.url}`, keep: "Keep it", skip: "Skip this one", cancel: "Cancel" };
  if (lang === "hi-IN") return { body: `${o.shop}: आपकी ${o.plan ?? "सदस्यता"} ${d} को${p ? ` ${p} में` : ""} नवीनीकृत होगी। इसे रखने के लिए कुछ करने की ज़रूरत नहीं। प्रबंधित करें: ${o.url}`, keep: "रखें", skip: "यह वाला छोड़ें", cancel: "रद्द करें" };
  if (lang === "id-ID") return { body: `${o.shop}: ${o.plan ?? "langganan"} Anda diperpanjang pada ${d}${p ? ` sebesar ${p}` : ""}. Tidak perlu melakukan apa pun untuk mempertahankannya. Kelola: ${o.url}`, keep: "Pertahankan", skip: "Lewati yang ini", cancel: "Batalkan" };
  return { body: `${o.shop}: sua assinatura${o.plan ? ` ${o.plan}` : ""} renova em ${d}${p ? ` por ${p}` : ""}. Nada a fazer para mantê-la. Gerenciar: ${o.url}`, keep: "Manter", skip: "Pular esta", cancel: "Cancelar" };
}

/**
 * Words that mean "cancel", per language, for code checks on the member's own words (the mandate's scope, the
 * negotiation). Mixed Hindi-English ("cancel kar do") matches the English words. Devanagari has no \b in JS, so
 * those words match anywhere.
 */
export const CANCEL_WORDS_ANY = [
  /\b(cancel|cancell?ing|stop|end|quit|unsubscribe|close (it|my)|leave)\b/i,
  /रद्द|बंद कर|ख़त्म कर|खत्म कर|\b(radd|band kar)\b/i,
  /\b(batal\w*|berhenti|hentikan|stop langganan|akhiri)\b/i,
  /\b(cancel\w*|encerr\w*|parar|sair da assinatura)\b/i,
];
export const saysCancel = (text: string) => CANCEL_WORDS_ANY.some((r) => r.test(text));

/** "Don't try to keep me", per language: the member's own words win over a hear-offer flag. */
export const NO_OFFER_ANY = [
  /कोई (ऑफ़र|ऑफर|छूट) नहीं|ऑफ़र मत|ऑफर मत|रोकने की कोशिश मत/,
  /\b(tanpa penawaran|tidak usah (menawarkan|tawarkan|tawar)|jangan tawarkan|langsung batal\w*)\b/i,
  /\b(sem ofertas?|não (quero|preciso de) ofertas?|só cancel\w*|apenas cancel\w*|não tente me (manter|segurar))\b/i,
];
