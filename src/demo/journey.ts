/**
 * The guided journey: one story across the three people in the demo (the owner, a member, and the member's AI
 * assistant), told by a small card in the corner of every page (public/journey.js). Its place is kept on the
 * server, in the visitor's own workspace (`checklist.journey`), so it is the same on any browser or device that
 * opens the workspace, and on the server-rendered owner pages as well as the React ones.
 *
 * Nothing here moves money or changes the shop. A step can only point at a part of a page, say what to do there,
 * and notice (through the workspace's ticks) that the visitor did it. The step words are English; the card's own
 * buttons follow the visitor's language and say that the steps are in English.
 *
 * Every "why" figure names its source. Figures are quoted as the source states them, nothing is rounded up.
 */
import type { Queryable } from "../db.js";
import { getDb } from "../db.js";
import type { Lang } from "../i18n.js";
import { telegramReady } from "../channels/index.js";
import { merchantById } from "../store.js";
import { lastTicksOf, type Tick } from "./checklist.js";
import { poolCounts } from "./pool.js";
import type { Workspace } from "./workspaces.js";

/** The 10 Nov scam message the judge paths and the journey both use. */
export const NOV10 = "Hi, we've moved banks. Please send this month's payment to our new PayPal, accounts.emberoak@outlook.com. Thanks so much!";

export type Role = "owner" | "member" | "assistant" | "proof";
export type StartAs = "owner" | "member" | "assistant";

interface Why { fact: string; src: string; url: string }
interface StepDef {
  id: string;
  role: Role;
  /** Where the step lives. {member} and {first} are filled from the journey's member. */
  path: string;
  /** A regular expression for location.pathname that counts as "on this step's page". */
  match: string;
  /** CSS selectors, comma separated: the first one that is visible gets the outline. */
  target?: string;
  title: string;
  body: string;
  do?: string;
  /** Ticks that mean the visitor did this step. */
  done?: Tick[];
  /** The step needs a real (PayPal sandbox) member; a sample member's buttons are view-only. */
  real?: boolean;
  /** "Fill it in for me" types these words into this field. Nothing is sent until the visitor presses the button. */
  fill?: { sel: string; value: string };
  why?: Why;
  /** What the card says once the step's tick arrives. */
  doneText?: string;
  /** What the step uses, shown as tags. */
  tags?: TagId[];
  /** The judging criterion this step shows best, in one line. */
  crit?: { k: Crit; line: string };
  /** Shown only when this server has it switched on. */
  needs?: "telegram";
}

const WHY = {
  darkPatterns: { fact: "In 2024 the FTC and international consumer protection networks reviewed 642 websites and apps that sell subscriptions. Nearly 76% used at least one possible dark pattern.", src: "FTC, July 2024", url: "https://www.ftc.gov/news-events/news/press-releases/2024/07/ftc-icpen-gpen-announce-results-review-use-dark-patterns-affecting-subscription-services-privacy" },
  complaints: { fact: "Complaints to the FTC about subscriptions that are hard to cancel rose from 42 a day in 2021 to nearly 70 a day in 2024.", src: "FTC, October 2024", url: "https://www.ftc.gov/news-events/news/press-releases/2024/10/federal-trade-commission-announces-final-click-cancel-rule-making-it-easier-consumers-end-recurring" },
  aiShoppers: { fact: "People are starting to shop through AI assistants: Adobe measured traffic to US retail sites from generative AI tools up 693% in the 2025 holiday season, year on year.", src: "Adobe, January 2026", url: "https://news.adobe.com/news/2026/01/adobe-holiday-shopping-season" },
  bec: { fact: "A message asking for this month's payment to go to a new account is business email compromise. The FBI recorded $2.77 billion in reported losses to it in 2024.", src: "FBI IC3 Internet Crime Report 2024", url: "https://www.ic3.gov/AnnualReport/Reports/2024_IC3Report.pdf" },
  forget: { fact: "People lose track of subscriptions: in one survey, people guessed they spent $86 a month on them, and their itemised total was $219.", src: "C+R Research subscription survey", url: "https://www.crresearch.com/blog/subscription-service-statistics-and-costs" },
  language: { fact: "76% of online shoppers prefer to buy products with information in their own language (a survey of 8,709 people in 29 countries).", src: "CSA Research, Can't Read, Won't Buy, 2020", url: "https://csa-research.com/Blogs-Events/CSA-in-the-Media/Press-Releases/Consumers-Prefer-their-Own-Language" },
  disability: { fact: "An estimated 1.3 billion people, 16% of the world, live with a significant disability.", src: "World Health Organization", url: "https://www.who.int/news-room/fact-sheets/detail/disability-and-health" },
} satisfies Record<string, Why>;

const MEMBER = "/manage/{member}";
const MEMBER_RE = "^/manage/{member}/?$";

/** What a step shows it uses, as small tags on the card. Only things Kept really calls or runs. */
export const TAGS = {
  subs: { label: "PayPal Subscriptions API", kind: "paypal" },
  checkout: { label: "PayPal approval page", kind: "paypal" },
  webhooks: { label: "PayPal webhooks", kind: "paypal" },
  ppmcp: { label: "PayPal MCP server", kind: "paypal" },
  openai: { label: "OpenAI agent", kind: "ai" },
  decisions: { label: "OpenAI Decisions", kind: "ai" },
  keptmcp: { label: "Kept MCP server", kind: "ai" },
  onnx: { label: "Scam model in your browser", kind: "device" },
  mediapipe: { label: "MediaPipe, on device", kind: "device" },
  code: { label: "Rules enforced by code", kind: "tool" },
  aggrid: { label: "AG Grid", kind: "tool" },
  bryntum: { label: "Bryntum Calendar", kind: "tool" },
  telegram: { label: "Telegram bot", kind: "tool" },
  langs: { label: "4 languages", kind: "tool" },
} as const;
export type TagId = keyof typeof TAGS;
export type Crit = "tech" | "impact" | "innovation";

export const STEPS: StepDef[] = [
  // ---------------------------------------------------------------- the owner
  {
    id: "shop", role: "owner", path: "/dashboard", match: "^/dashboard/?$", target: "[data-tour='kpis']",
    title: "Your shop, running on PayPal",
    body: "Ember & Oak sells coffee by subscription. Members pay through PayPal subscriptions (the PayPal sandbox: real calls, test money), and these numbers are read from PayPal itself.",
    do: "Glance at the four numbers, then press Next.",
    tags: ["subs", "webhooks"],
    crit: { k: "tech", line: "Live data from PayPal's Subscriptions API, not numbers typed into a database." },
  },
  {
    id: "held", role: "owner", path: "/dashboard", match: "^/dashboard/?$", target: "[data-tour='approval'], [data-tour='needs']", done: ["approval_decided"],
    title: "Kept stopped a discount and asked you",
    body: "A member was about to get 25% off. Your rule says 15% at most, so code held it for you. The AI can't change that.",
    do: "Press Approve or Decline on the highlighted card.",
    doneText: "You decided. Declined means nothing moved in PayPal.",
    tags: ["code"],
    crit: { k: "tech", line: "Money decisions run through code the owner controls, never through the AI." },
  },
  {
    id: "ask", role: "owner", path: "/dashboard", match: "^/dashboard/?$", target: "[data-tour='ask']", done: ["owner_asked"], fill: { sel: "#q", value: "Why are people cancelling?" },
    title: "Ask your shop a question",
    body: "Plain words in, an answer with sources out. An AI agent reads your shop and your PayPal account (through PayPal's own MCP server). It can read, not act.",
    do: "Press \"Fill it in for me\", then Ask.",
    doneText: "Answered. Every number in it links to where it came from.",
    tags: ["openai", "ppmcp"],
    crit: { k: "innovation", line: "An AI agent that reads PayPal through PayPal's MCP server, with every figure cited." },
  },
  {
    id: "rules", role: "owner", path: "/dashboard/guard#policy", match: "^/dashboard/guard/?$", target: "#policy", done: ["rule_refused"],
    fill: { sel: "#policy textarea[name='text']", value: "Show three retention offers before letting anyone cancel." },
    title: "Try to sneak in a dark pattern",
    body: "Owners write their shop's rules in plain English and Kept turns them into limits. A rule that breaks consumer law is refused, with the law it breaks.",
    do: "Press \"Fill it in for me\", then Check these rules.",
    doneText: "Refused, quoting the law it breaks.",
    tags: ["code", "openai"],
    why: WHY.darkPatterns,
    crit: { k: "impact", line: "Fair by default: the tricks behind most cancel complaints can't be switched on." },
  },
  {
    id: "scam", role: "owner", path: "/dashboard/safety#check", match: "^/dashboard/safety/?$", target: "#check", done: ["scam_checked"],
    fill: { sel: "#scan-text", value: NOV10 },
    title: "A fake \"new PayPal account\" message",
    body: "Scammers write to small shops asking for payments to go to a new account. Kept checks the message three ways, starting with a scam model that runs inside this browser.",
    do: "Press \"Fill it in for me\", then Check.",
    doneText: "Held: all three checks flagged it.",
    tags: ["onnx", "decisions"],
    why: WHY.bec,
    crit: { k: "innovation", line: "A fine-tuned MiniLM model runs on the device: the message never leaves it." },
  },
  {
    id: "members", role: "owner", path: "/dashboard/members", match: "^/dashboard/members/?$", target: "[data-tour='grid'], [data-tour='grid-m']",
    title: "Every member at a glance",
    body: "Each row is one PayPal subscription: plan, next payment, pauses and offers. {memberLine}",
    do: "Press Next to become {first}.",
    tags: ["aggrid", "bryntum"],
  },
  // ---------------------------------------------------------------- the member
  {
    id: "join", role: "member", path: "/s/{slug}", match: "^/s/{slug}/?$", target: "[data-tour='plans']",
    title: "How a customer joins",
    body: "You're {first} now. Customers pick a plan here and approve it on PayPal's own page; Kept never sees a card number.",
    do: "Look at the Subscribe with PayPal buttons. No need to subscribe: {first} already has. Press Next.",
    tags: ["checkout", "subs"],
    crit: { k: "tech", line: "Real PayPal subscription checkout, in sandbox mode." },
  },
  {
    id: "card", role: "member", path: MEMBER, match: MEMBER_RE, target: "[data-tour='card']",
    title: "{first}'s subscription",
    body: "No app and no password: the link in every reminder opens this page. Each circle is one PayPal payment, and the ringed one is the next.",
    do: "Press Next.",
    tags: ["subs"],
    why: WHY.forget,
  },
  {
    id: "change", role: "member", path: MEMBER, match: MEMBER_RE, target: "[data-tour='change']", real: true, done: ["member_changed"],
    title: "Skip next month in one tap",
    body: "Kept asks PayPal to change the subscription, then reads it back from PayPal before it says done.",
    do: "Press Skip next payment (or Pause).",
    doneText: "PayPal confirmed it. It's in History at the bottom.",
    tags: ["subs"],
    crit: { k: "tech", line: "Every change is read back from PayPal before Kept confirms it." },
  },
  {
    id: "telegram", role: "member", path: `${MEMBER}#telegram`, match: MEMBER_RE, target: "[data-tour='telegram']", real: true, needs: "telegram",
    title: "Reminders in Telegram",
    body: "Before each payment Kept sends a Telegram message with Skip and Keep buttons. Tapping Skip there changes PayPal, the same as here.",
    do: "Press Connect Telegram, then Start in Telegram. A reminder arrives straight away.",
    tags: ["telegram", "subs"],
    crit: { k: "impact", line: "Reminders where people already are, so nobody pays for something they forgot." },
  },
  // ---------------------------------------------------------------- the member's AI assistant
  {
    id: "assistant", role: "assistant", path: `${MEMBER}#assistant`, match: MEMBER_RE, target: "[data-tour='assistant']", real: true, done: ["assistant_acted"], fill: { sel: "#assistant-msg", value: "Pause my coffee for a month" },
    title: "Or let an AI assistant do it",
    body: "{first} says what they want. Kept gives the AI a permission slip for exactly that, valid 15 minutes, and the AI makes the change through Kept's MCP tools: the same ones Claude or ChatGPT would use.",
    do: "Press \"Fill it in for me\", then Send.",
    doneText: "Done by the AI, inside its permission. PayPal confirmed it.",
    tags: ["openai", "keptmcp", "subs"],
    why: WHY.aiShoppers,
    crit: { k: "innovation", line: "Agentic commerce with a narrow, signed permission instead of handing over a login." },
  },
  // ---------------------------------------------------------------- the member again
  {
    id: "cancel", role: "member", path: `${MEMBER}#cancel`, match: MEMBER_RE, target: "[data-tour='cancel']", real: true, done: ["offer_shown", "cancel_answered"],
    title: "Cancel in one step",
    body: "No maze. If {first} asks, the shop may show one offer. Saying no cancels the subscription in PayPal right away.",
    do: "Press Cancel subscription and go through it. It's a test subscription.",
    doneText: "Done in one step.",
    tags: ["subs", "code"],
    why: WHY.complaints,
    crit: { k: "impact", line: "One-step cancel for every member, the opposite of a cancel maze." },
  },
  // ---------------------------------------------------------------- back to the owner
  {
    id: "back", role: "owner", path: "/dashboard", match: "^/dashboard/?$", target: "[data-tour='activity']",
    title: "Back to the owner: it's all here",
    body: "What {first} and the AI did is on the owner's page: who did it, what PayPal said, and the money in and out.",
    do: "Open Activity to see it, then press Next.",
    tags: ["webhooks", "subs"],
    crit: { k: "tech", line: "PayPal webhooks and a daily re-read keep Kept and PayPal in step." },
  },
  // ---------------------------------------------------------------- the proof
  {
    id: "paypal", role: "proof", path: "/paypal", match: "^/paypal/?$", target: "main h1", done: ["paypal_opened"],
    title: "Every PayPal call, live",
    body: "The real PayPal sandbox calls behind this demo, newest first, each with PayPal's own id.",
    tags: ["subs", "ppmcp", "webhooks"],
    crit: { k: "tech", line: "Subscriptions, transactions, webhooks and PayPal's MCP server, all in use." },
  },
  {
    id: "a11y", role: "proof", path: "/accessibility", match: "^/accessibility/?$", target: "[data-testid='hf-sim-run'], main h1",
    title: "Hands-free, and in four languages",
    body: "Look and Say lets people use Kept by looking and speaking; the face tracking runs on the device. The site reads in English, Hindi, Indonesian and Portuguese.",
    tags: ["mediapipe", "langs"],
    why: WHY.disability,
    crit: { k: "impact", line: "Built for people other subscription sites leave out." },
  },
  {
    id: "proof", role: "proof", path: "/proof", match: "^/proof/?$", target: "main h1", done: ["proof_opened"],
    title: "Checked, not claimed",
    body: "The test sets behind each claim, and a robot judge that walks this live site. That's the tour: keep exploring, the card stays until you end it.",
    crit: { k: "tech", line: "Every claim on this site has a test you can open." },
  },
];

/** The steps this server can show: Telegram's step only when Kept's own bot is switched on. */
export const activeSteps = (): StepDef[] => STEPS.filter((s) => !s.needs || (s.needs === "telegram" && telegramReady()));
export const startOf = (as: StartAs): number => {
  const id = as === "member" ? "join" : as === "assistant" ? "assistant" : "shop";
  return Math.max(0, activeSteps().findIndex((s) => s.id === id));
};

export const ROLES: Record<Role, { name: string; who: string }> = {
  owner: { name: "the owner", who: "You are the owner of {shop}" },
  member: { name: "the member", who: "You are {first}, a member" },
  assistant: { name: "the AI assistant", who: "{first}'s AI assistant at work" },
  proof: { name: "the proof", who: "How you can check all of it" },
};

/** The card's own words. Steps are English; these follow the visitor's language. */
const WORDS: Record<Lang, Record<string, string>> = {
  en: { region: "Guided journey", step: "Step {i} of {n}", next: "Next", back: "Back", finish: "Finish", end: "End the journey", min: "Shrink the guide", open: "Open the guide", go: "Take me there", fill: "Fill it in for me", doThis: "Do this:", done: "Done: you did this step.", why: "Why this exists", source: "Source", away: "This step is on another page.", switching: "Switching to", note: "", sample: "{first} is a labelled sample member, so these buttons only show what they do and nothing reaches PayPal. Real members come from a pool of PayPal sandbox subscriptions approved in advance. {pool}", poolEmpty: "The pool is empty right now, so this demo has no real member to change.", poolReady: "The pool has {n} ready: press Start over on the demo page to get one.", missing: "That part isn't on this page right now.", crit_tech: "Technological implementation", crit_impact: "Potential impact", crit_innovation: "Innovation", judged: "Judging criterion" },
  "hi-IN": { region: "गाइडेड यात्रा", step: "चरण {i} / {n}", next: "आगे", back: "पीछे", finish: "समाप्त", end: "यात्रा खत्म करें", min: "गाइड छोटा करें", open: "गाइड खोलें", go: "मुझे वहाँ ले चलें", fill: "मेरे लिए भर दें", doThis: "यह करें:", done: "हो गया: आपने यह चरण कर लिया।", why: "यह क्यों है", source: "स्रोत", away: "यह चरण दूसरे पेज पर है।", switching: "बदल रहे हैं:", note: "चरणों का पाठ अंग्रेज़ी में है।", sample: "{first} एक चिह्नित नमूना सदस्य है, इसलिए ये बटन सिर्फ़ दिखाते हैं कि वे क्या करते हैं, PayPal तक कुछ नहीं जाता। असली सदस्य पहले से स्वीकृत PayPal सैंडबॉक्स सदस्यताओं के पूल से आते हैं। {pool}", poolEmpty: "पूल अभी खाली है, इसलिए इस डेमो में बदलने के लिए कोई असली सदस्य नहीं है।", poolReady: "पूल में {n} तैयार हैं: एक पाने के लिए डेमो पेज पर फिर से शुरू करें दबाएँ।", missing: "वह हिस्सा अभी इस पेज पर नहीं है।", crit_tech: "तकनीकी क्रियान्वयन", crit_impact: "संभावित प्रभाव", crit_innovation: "नवाचार", judged: "निर्णय का मानदंड" },
  "id-ID": { region: "Perjalanan terpandu", step: "Langkah {i} dari {n}", next: "Lanjut", back: "Kembali", finish: "Selesai", end: "Akhiri perjalanan", min: "Kecilkan panduan", open: "Buka panduan", go: "Bawa saya ke sana", fill: "Isikan untuk saya", doThis: "Lakukan ini:", done: "Selesai: Anda sudah melakukan langkah ini.", why: "Mengapa ini ada", source: "Sumber", away: "Langkah ini ada di halaman lain.", switching: "Beralih ke", note: "Teks langkah ditulis dalam bahasa Inggris.", sample: "{first} adalah anggota contoh berlabel, jadi tombol ini hanya menunjukkan fungsinya dan tidak ada yang sampai ke PayPal. Anggota asli berasal dari kumpulan langganan sandbox PayPal yang sudah disetujui. {pool}", poolEmpty: "Kumpulan itu sedang kosong, jadi demo ini tidak punya anggota asli untuk diubah.", poolReady: "Kumpulan itu punya {n} yang siap: tekan Mulai lagi di halaman demo untuk mendapatkannya.", missing: "Bagian itu sedang tidak ada di halaman ini.", crit_tech: "Implementasi teknologi", crit_impact: "Potensi dampak", crit_innovation: "Inovasi", judged: "Kriteria penilaian" },
  "pt-BR": { region: "Jornada guiada", step: "Passo {i} de {n}", next: "Próximo", back: "Voltar", finish: "Concluir", end: "Encerrar a jornada", min: "Recolher o guia", open: "Abrir o guia", go: "Leve-me até lá", fill: "Preencher para mim", doThis: "Faça isto:", done: "Feito: você concluiu esta etapa.", why: "Por que isto existe", source: "Fonte", away: "Este passo está em outra página.", switching: "Mudando para", note: "O texto dos passos está em inglês.", sample: "{first} é um membro de exemplo identificado, então estes botões só mostram o que fazem e nada chega ao PayPal. Membros reais vêm de um conjunto de assinaturas sandbox do PayPal aprovadas antes. {pool}", poolEmpty: "O conjunto está vazio agora, então esta demonstração não tem um membro real para alterar.", poolReady: "O conjunto tem {n} prontas: toque em Começar de novo na página da demonstração para receber uma.", missing: "Essa parte não está nesta página agora.", crit_tech: "Implementação tecnológica", crit_impact: "Impacto potencial", crit_innovation: "Inovação", judged: "Critério de avaliação" },
};
export const journeyWords = (lang: Lang) => WORDS[lang] ?? WORDS.en;

export interface JourneyState { on: boolean; i: number; member: string | null; startedAt: string }

const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The member the journey follows: the newest real member still live, else a live sample one. Fixed at start. */
export async function pickMember(merchantId: string, q?: Queryable): Promise<string | null> {
  const db = q ?? (await getDb());
  const r = (await db.query<{ ref: string }>(
    "SELECT ref FROM subscribers WHERE merchant_id = $1 AND status IN ('ACTIVE','SUSPENDED') ORDER BY is_sample, (kept_state IS NOT NULL), (status <> 'ACTIVE'), created_at DESC LIMIT 1",
    [merchantId],
  )).rows[0];
  return r?.ref ?? null;
}

export function journeyOf(ws: Workspace): JourneyState | null {
  const j = (ws.checklist as any)?.journey;
  return j && typeof j === "object" ? (j as JourneyState) : null;
}

export async function saveJourney(ws: Workspace, j: JourneyState | null, q?: Queryable) {
  const db = q ?? (await getDb());
  await db.query("UPDATE workspaces SET checklist = jsonb_set(COALESCE(checklist, '{}'::jsonb), '{journey}', $2::jsonb) WHERE id = $1", [ws.id, JSON.stringify(j)]);
  (ws.checklist as any) = { ...(ws.checklist ?? {}), journey: j };
}

/** Everything the corner card needs to draw any step, read from the database at request time. */
export async function journeyView(ws: Workspace, lang: Lang) {
  const db = await getDb();
  const j = journeyOf(ws);
  const words = journeyWords(lang);
  if (!j?.on) return { on: false as const, words };
  const m = await merchantById(db, ws.tenant_id);
  let ref = j.member;
  let row = ref ? (await db.query<{ ref: string; subscriber_name: string | null; is_sample: boolean; status: string }>("SELECT ref, subscriber_name, is_sample, status FROM subscribers WHERE ref = $1 AND merchant_id = $2", [ref, ws.tenant_id])).rows[0] : undefined;
  if (!row) {
    ref = await pickMember(ws.tenant_id, db);
    row = ref ? (await db.query<any>("SELECT ref, subscriber_name, is_sample, status FROM subscribers WHERE ref = $1", [ref])).rows[0] : undefined;
  }
  const first = (row?.subscriber_name ?? "the member").split(/\s+/)[0];
  const real = row ? !row.is_sample : false;
  const pc = await poolCounts();
  const v: Record<string, string> = {
    shop: m?.name ?? "the shop",
    first,
    member: ref ?? "",
    slug: m?.slug ?? "",
    memberLine: real ? `${first} is a real PayPal sandbox subscription.` : `${first} is one of the labelled sample members.`,
  };
  // A step counts as done only for something the visitor did after starting this journey, not earlier.
  const last = lastTicksOf(ws.checklist);
  const since = Date.parse(j.startedAt) || 0;
  const didAfter = (k: Tick) => Boolean(last[k]) && Date.parse(last[k]) >= since - 1000;
  const steps = activeSteps().map((s, i) => ({
    i,
    id: s.id,
    role: s.role,
    who: fill(ROLES[s.role].who, v),
    roleName: ROLES[s.role].name,
    href: ref || !s.path.includes("{member}") ? fill(s.path, v) : null,
    match: ref || !s.match.includes("{member}") ? s.match.replace("{member}", reEscape(ref ?? "")).replace("{slug}", reEscape(v.slug)) : null,
    target: s.target ?? null,
    title: fill(s.title, v),
    body: fill(s.body, v),
    do: s.do ? fill(s.do, v) : null,
    fill: s.fill ?? null,
    why: s.why ?? null,
    tags: (s.tags ?? []).map((t) => ({ id: t, ...TAGS[t] })),
    crit: s.crit ? { k: s.crit.k, label: words[`crit_${s.crit.k}`], line: s.crit.line } : null,
    doneText: s.doneText ?? null,
    watches: s.done ?? [],
    done: (s.done ?? []).some(didAfter),
    sample: s.real && !real ? fill(words.sample, { first, pool: pc.ready > 0 ? fill(words.poolReady, { n: String(pc.ready) }) : words.poolEmpty }) : null,
  }));
  const i = Math.max(0, Math.min(j.i, steps.length - 1));
  return { on: true as const, i, n: steps.length, steps, member: { ref, first, real, status: row?.status ?? null }, words, lang };
}
