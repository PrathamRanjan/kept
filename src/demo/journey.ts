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
import { merchantById } from "../store.js";
import { ticksOf, type Tick } from "./checklist.js";
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

export const STEPS: StepDef[] = [
  // ---------------------------------------------------------------- the owner
  {
    id: "today", role: "owner", path: "/dashboard", match: "^/dashboard/?$", target: "[data-tour='kpis']",
    title: "You run {shop}",
    body: "This is the owner's Today page, in your own private copy of the shop. Members pay through PayPal Subscriptions on the PayPal sandbox: PayPal's test system, with real API calls and test money. These numbers are read from those subscriptions. Rows marked \"sample\" are labelled demo members that never touch PayPal.",
    do: "Look over the four numbers, then press Next.",
  },
  {
    id: "held", role: "owner", path: "/dashboard", match: "^/dashboard/?$", target: "[data-tour='needs']", done: ["approval_decided"],
    title: "Kept held a move for you",
    body: "The shop's offer step wanted to give a member 25% off for 3 payments. You let Kept give at most 15% on its own, so code held this one here instead of doing it. Nothing has moved. No AI model makes this call: code compares the offer with your limit.",
    do: "Press Approve or Decline on the card. Either is fine.",
  },
  {
    id: "ask", role: "owner", path: "/dashboard", match: "^/dashboard/?$", target: "[data-tour='ask']", done: ["owner_asked"], fill: { sel: "#q", value: "Why are people cancelling?" },
    title: "Ask your shop a question",
    body: "Ask in plain words. A real AI model answers, but it can only read: it calls read-only tools, one of them PayPal's own MCP server, and every sentence has to cite a fact that code checked. The AI work panel beside the answer shows each tool call as it happens.",
    do: "Press \"Fill it in for me\" (or type your own question), then press Ask.",
  },
  {
    id: "rules", role: "owner", path: `/dashboard/guard?text=${encodeURIComponent("Show three retention offers before cancel. One skip per quarter.")}#policy`, match: "^/dashboard/guard/?$", target: "#policy", done: ["rule_refused"],
    title: "Try to write a dark pattern",
    body: "Owners write their rules in plain words. This box already says \"Show three retention offers before cancel.\" Kept refuses that line and cites the law it breaks, and cancelling stays one step whatever the owner writes. The other line, one skip per quarter, is accepted.",
    do: "Read the notes under the box. To try your own words, edit them and press Draft and backtest.",
    why: WHY.darkPatterns,
  },
  {
    id: "scam", role: "owner", path: `/dashboard/safety?text=${encodeURIComponent(NOV10)}#check`, match: "^/dashboard/safety/?$", target: "#check", done: ["scam_checked"],
    title: "A scam message arrives",
    body: "A member forwarded this: \"we've moved banks, send this month's payment to our new PayPal.\" Three separate readers check it: fixed rules, an AI model answering yes-or-no questions, and code that looks at where the money would go. The strictest one wins, and a message that sends money somewhere new is never shown as safe.",
    do: "Press Check this message and read the three results.",
    why: WHY.bec,
  },
  {
    id: "members", role: "owner", path: "/dashboard/members", match: "^/dashboard/members/?$", target: "[data-tour='grid'], [data-tour='grid-m']",
    title: "Every member, stamp by stamp",
    body: "Each subscription is a row of stamps, one per billing cycle: paid, skipped, paused, discounted or failed. {memberLine}",
    do: "Press Next to switch to the member's side.",
  },
  // ---------------------------------------------------------------- the member
  {
    id: "card", role: "member", path: MEMBER, match: MEMBER_RE, target: "[data-tour='card']",
    title: "Now you're {first}, a member",
    body: "This is the page a member opens from any reminder: no app to install and no password. The stamps are this subscription's history, and the highlighted one is the next payment.",
    do: "Press Next.",
    why: WHY.forget,
  },
  {
    id: "change", role: "member", path: MEMBER, match: MEMBER_RE, target: "[data-tour='change']", real: true, done: ["member_changed"],
    title: "Change it yourself",
    body: "Skip, pause or switch, within the owner's rules. Kept makes the change in PayPal, then reads the subscription back from PayPal, and only that read-back updates this page.",
    do: "Press Skip next payment, or choose 1 and press Pause.",
  },
  // ---------------------------------------------------------------- the member's assistant
  {
    id: "assistant", role: "assistant", path: `${MEMBER}#assistant`, match: MEMBER_RE, target: "[data-tour='assistant']", real: true, done: ["assistant_acted"], fill: { sel: "#assistant-msg", value: "Pause my coffee for a month" },
    title: "Or let your AI handle it",
    body: "Now watch from the assistant's side. {first} tells their assistant what they want. Before the assistant runs, code writes a signed permission from those words: it covers only what was asked and lasts 15 minutes. The assistant then calls Kept's MCP tools, the same ones Claude or ChatGPT would use, and code reads PayPal back after the change.",
    do: "Press \"Fill it in for me\", then Send. Each step appears in the panel as it happens.",
    why: WHY.aiShoppers,
  },
  {
    id: "undo", role: "assistant", path: `${MEMBER}#assistant`, match: MEMBER_RE, target: "[data-tour='assistant']", real: true, fill: { sel: "#assistant-msg", value: "Resume it please" },
    title: "Ask it to undo that",
    body: "The permission from the last request doesn't cover a new one, so code writes a fresh one from these words. Every line in the panel says who acted: the model, a rule, or PayPal.",
    do: "Fill it in, press Send, and check that the status at the top goes back to Active.",
  },
  {
    id: "history", role: "member", path: `${MEMBER}#history`, match: MEMBER_RE, target: "[data-tour='history']",
    title: "Who did what, and the money trail",
    body: "Every change is listed with who did it: {first}, the assistant, a rule, or PayPal. PayPal's lines carry PayPal's own request ids, so each change can be matched in PayPal's records.",
    do: "Press Next.",
  },
  {
    id: "language", role: "member", path: MEMBER, match: MEMBER_RE, target: "[data-testid='lang-picker']",
    title: "In the member's own language",
    body: "Members can switch the whole flow to Hindi, Indonesian or Portuguese: the pages, the AI's replies, the reminders and the scam check. PayPal's own page then opens in the matching language.",
    do: "Optional: pick a language, look around, then switch back to English.",
    why: WHY.language,
  },
  {
    id: "cancel", role: "member", path: `${MEMBER}#cancel`, match: MEMBER_RE, target: "[data-tour='cancel']", real: true, done: ["offer_shown", "cancel_answered"],
    title: "Cancel in one step",
    body: "No survey and no phone call. Tick \"show me one offer\" only if you want one: code picks it from the owner's rules (a quality complaint never gets a discount), and the AI only words it. Saying no, or ignoring it, cancels on PayPal at once.",
    do: "Tick the box and press the button, then take the offer or say no. Saying no really cancels this test subscription, which uses up one from the demo pool.",
    why: WHY.complaints,
  },
  // ---------------------------------------------------------------- back to the owner
  {
    id: "back", role: "owner", path: "/dashboard", match: "^/dashboard/?$", target: "[data-tour='activity']",
    title: "Back to the owner: what changed",
    body: "Everything {first} and the assistant did is already on the owner's page: in Activity at the bottom, in the counts at the top, and in the member's row. Check against PayPal re-reads every live subscription from PayPal and corrects anything that drifted.",
    do: "Open Activity, or press Check against PayPal at the top.",
  },
  {
    id: "byo", role: "assistant", path: "/agents", match: "^/agents/?$", target: "#main .card", done: ["agents_opened"],
    title: "Bring your own assistant",
    body: "The assistant you watched uses Kept's MCP endpoint, and so can any other: Claude, ChatGPT or your own agent. A member's assistant gets 14 tools. A new subscriber's assistant can find the shop, quote a plan and start a subscription; the person then approves on PayPal's own page.",
    do: "Copy the address into Claude (Settings, Connectors, Add custom connector) or run the Claude Code line.",
  },
  // ---------------------------------------------------------------- the proof
  {
    id: "paypal", role: "proof", path: "/paypal", match: "^/paypal/?$", target: "main h1", done: ["paypal_opened"],
    title: "Every PayPal call, with real ids",
    body: "Every PayPal API Kept uses, when it last used each one, and the latest PayPal sandbox id. Only one part of Kept calls PayPal, the executor, and only after code has checked the rules; it reads PayPal back after every change.",
    do: "Scroll the list, then press Next.",
  },
  {
    id: "roles", role: "proof", path: "/who-can-move-money", match: "^/who-can-move-money/?$", target: "main h1",
    title: "No AI can move money",
    body: "Every actor (the owner, the member, the member's assistant, the shop's agent and the background worker) and exactly what each one may do. Models read, choose between options code gave them, and word things. Code decides. PayPal does it.",
    do: "Press Next.",
  },
  {
    id: "a11y", role: "proof", path: "/accessibility", match: "^/accessibility/?$", target: "[data-testid='hf-sim-run'], main h1",
    title: "Everyone can use it",
    body: "Every page works by keyboard, at 200% text and by voice. Hands-free mode lets people point with their eyes or head and click by saying \"click\"; anything that moves money needs a spoken yes. The simulation here shows it working without a camera.",
    do: "Press the simulation's Run button.",
    why: WHY.disability,
  },
  {
    id: "proof", role: "proof", path: "/proof", match: "^/proof/?$", target: "main h1", done: ["proof_opened"],
    title: "Every test case, in the open",
    body: "The evaluation sets behind each claim, case by case: the scam check, unfair offers, hostile agent moves, cancel reasons, and the robot judge that walks this site. That's the journey. Keep exploring; this card stays until you end it.",
  },
];

export const START: Record<StartAs, number> = {
  owner: 0,
  member: STEPS.findIndex((s) => s.id === "card"),
  assistant: STEPS.findIndex((s) => s.id === "assistant"),
};

export const ROLES: Record<Role, { name: string; who: string }> = {
  owner: { name: "The owner", who: "You are the owner of {shop}" },
  member: { name: "The member", who: "You are {first}, a member" },
  assistant: { name: "The member's AI assistant", who: "Watching {first}'s AI assistant" },
  proof: { name: "The proof", who: "How you can check all of it" },
};

/** The card's own words. Steps are English; these follow the visitor's language. */
const WORDS: Record<Lang, Record<string, string>> = {
  en: { region: "Guided journey", step: "Step {i} of {n}", next: "Next", back: "Back", finish: "Finish", end: "End the journey", min: "Shrink the guide", open: "Open the guide", go: "Take me there", fill: "Fill it in for me", doThis: "Do this:", done: "Done. Kept saw you do it.", why: "Why this exists", source: "Source", away: "This step is on another page.", switching: "Switching to", note: "", sample: "{first} is a labelled sample member, so these buttons only show what they do and nothing reaches PayPal. Real members come from a pool of PayPal sandbox subscriptions approved in advance. {pool}", poolEmpty: "The pool is empty right now, so this demo has no real member to change.", poolReady: "The pool has {n} ready: press Start over on the demo page to get one.", missing: "That part isn't on this page right now." },
  "hi-IN": { region: "गाइडेड यात्रा", step: "चरण {i} / {n}", next: "आगे", back: "पीछे", finish: "समाप्त", end: "यात्रा खत्म करें", min: "गाइड छोटा करें", open: "गाइड खोलें", go: "मुझे वहाँ ले चलें", fill: "मेरे लिए भर दें", doThis: "यह करें:", done: "हो गया। Kept ने इसे देखा।", why: "यह क्यों है", source: "स्रोत", away: "यह चरण दूसरे पेज पर है।", switching: "बदल रहे हैं:", note: "चरणों का पाठ अंग्रेज़ी में है।", sample: "{first} एक चिह्नित नमूना सदस्य है, इसलिए ये बटन सिर्फ़ दिखाते हैं कि वे क्या करते हैं, PayPal तक कुछ नहीं जाता। असली सदस्य पहले से स्वीकृत PayPal सैंडबॉक्स सदस्यताओं के पूल से आते हैं। {pool}", poolEmpty: "पूल अभी खाली है, इसलिए इस डेमो में बदलने के लिए कोई असली सदस्य नहीं है।", poolReady: "पूल में {n} तैयार हैं: एक पाने के लिए डेमो पेज पर फिर से शुरू करें दबाएँ।", missing: "वह हिस्सा अभी इस पेज पर नहीं है।" },
  "id-ID": { region: "Perjalanan terpandu", step: "Langkah {i} dari {n}", next: "Lanjut", back: "Kembali", finish: "Selesai", end: "Akhiri perjalanan", min: "Kecilkan panduan", open: "Buka panduan", go: "Bawa saya ke sana", fill: "Isikan untuk saya", doThis: "Lakukan ini:", done: "Selesai. Kept melihat Anda melakukannya.", why: "Mengapa ini ada", source: "Sumber", away: "Langkah ini ada di halaman lain.", switching: "Beralih ke", note: "Teks langkah ditulis dalam bahasa Inggris.", sample: "{first} adalah anggota contoh berlabel, jadi tombol ini hanya menunjukkan fungsinya dan tidak ada yang sampai ke PayPal. Anggota asli berasal dari kumpulan langganan sandbox PayPal yang sudah disetujui. {pool}", poolEmpty: "Kumpulan itu sedang kosong, jadi demo ini tidak punya anggota asli untuk diubah.", poolReady: "Kumpulan itu punya {n} yang siap: tekan Mulai lagi di halaman demo untuk mendapatkannya.", missing: "Bagian itu sedang tidak ada di halaman ini." },
  "pt-BR": { region: "Jornada guiada", step: "Passo {i} de {n}", next: "Próximo", back: "Voltar", finish: "Concluir", end: "Encerrar a jornada", min: "Recolher o guia", open: "Abrir o guia", go: "Leve-me até lá", fill: "Preencher para mim", doThis: "Faça isto:", done: "Feito. O Kept viu você fazer.", why: "Por que isto existe", source: "Fonte", away: "Este passo está em outra página.", switching: "Mudando para", note: "O texto dos passos está em inglês.", sample: "{first} é um membro de exemplo identificado, então estes botões só mostram o que fazem e nada chega ao PayPal. Membros reais vêm de um conjunto de assinaturas sandbox do PayPal aprovadas antes. {pool}", poolEmpty: "O conjunto está vazio agora, então esta demonstração não tem um membro real para alterar.", poolReady: "O conjunto tem {n} prontas: toque em Começar de novo na página da demonstração para receber uma.", missing: "Essa parte não está nesta página agora." },
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
    memberLine: real ? `${first} is a real PayPal sandbox subscription in your shop. Next, you become ${first}.` : `Next, you become ${first}, one of the labelled sample members.`,
  };
  const ticks = ticksOf(ws.checklist);
  const steps = STEPS.map((s, i) => ({
    i,
    id: s.id,
    role: s.role,
    who: fill(ROLES[s.role].who, v),
    roleName: ROLES[s.role].name,
    href: ref || !s.path.includes("{member}") ? fill(s.path, v) : null,
    match: ref || !s.match.includes("{member}") ? s.match.replace("{member}", reEscape(ref ?? "")) : null,
    target: s.target ?? null,
    title: fill(s.title, v),
    body: fill(s.body, v),
    do: s.do ? fill(s.do, v) : null,
    fill: s.fill ?? null,
    why: s.why ?? null,
    watches: s.done ?? [],
    done: (s.done ?? []).some((k) => Boolean(ticks[k])),
    sample: s.real && !real ? fill(words.sample, { first, pool: pc.ready > 0 ? fill(words.poolReady, { n: String(pc.ready) }) : words.poolEmpty }) : null,
  }));
  const i = Math.max(0, Math.min(j.i, steps.length - 1));
  return { on: true as const, i, n: steps.length, steps, member: { ref, first, real, status: row?.status ?? null }, words, lang };
}
