import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Bot, Check, Cpu, Eye, Globe2, LayoutGrid, MessageCircle, RefreshCw, Scale, ShieldCheck, Sparkles, Store, User, Waypoints, XCircle } from "lucide-react";
import { toast } from "sonner";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource-variable/geist/wght.css";
import "./landing.css";
import { PublicFooter, PublicHeader } from "@/components/Shell";
import { Marquee } from "@/components/ui/marquee";
import { getSession } from "@/lib/session";
import { startJourney } from "@/tours";
import { useT } from "@/i18n";
import type { Key } from "@/i18n/en";

/*
 * The landing page. Its own look (Instrument Serif headlines, Geist text, a night-blue and signal-orange palette)
 * in landing.css, scoped under .lp. Every claim on it is something Kept does on the live site; the hero's phone is
 * an illustration and says so, and the pricing is planned pricing and says so.
 */

/** The small PayPal two-P mark, in PayPal's blues, for tags about PayPal. */
function PayPalMark({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path fill="#003087" d="M8.3 21H4.6c-.3 0-.5-.3-.4-.6L7 3.6c.1-.4.4-.6.8-.6h6.4c3.4 0 5.4 1.8 4.9 4.8-.6 3.6-3 5.3-6.6 5.3H10.4c-.4 0-.7.3-.8.7L8.3 21z" />
      <path fill="#009cde" d="M19.6 8.2c.6 3.3-1.6 6.1-5.6 6.1h-1.6c-.4 0-.7.3-.8.7l-1 5.4c0 .3-.3.6-.7.6H7.8l.2-1.3 1-6 .1-.5c.1-.4.4-.7.8-.7h2.1c3.6 0 6-1.7 6.6-5.3 0-.2.1-.4.1-.6.5.4.8 1 .9 1.6z" />
    </svg>
  );
}

type TagKind = "paypal" | "ai" | "device" | "tool";
function Tag({ kind, children }: { kind: TagKind; children: React.ReactNode }) {
  return (
    <span className={`lp-tag lp-tag-${kind}`}>
      <span className="lp-tag-ic" aria-hidden="true">
        {kind === "paypal" ? <PayPalMark size={12} /> : kind === "ai" ? <Sparkles className="size-3" /> : kind === "device" ? <Cpu className="size-3" /> : <LayoutGrid className="size-3" />}
      </span>
      {children}
    </span>
  );
}

/** Product names: the same in every language. */
const BUILT: { name: string; kind: TagKind }[] = [
  { name: "PayPal Subscriptions", kind: "paypal" },
  { name: "PayPal MCP server", kind: "paypal" },
  { name: "PayPal webhooks", kind: "paypal" },
  { name: "OpenAI", kind: "ai" },
  { name: "Model Context Protocol", kind: "ai" },
  { name: "ONNX Runtime Web", kind: "device" },
  { name: "MediaPipe", kind: "device" },
  { name: "AG Grid", kind: "tool" },
  { name: "Bryntum Calendar", kind: "tool" },
  { name: "Telegram Bot API", kind: "tool" },
  { name: "Render", kind: "tool" },
];

const STATS: { n: string; body: Key; src: Key; url: string }[] = [
  { n: "76%", body: "lp.s1", src: "lp.s1src", url: "https://www.ftc.gov/news-events/news/press-releases/2024/07/ftc-icpen-gpen-announce-results-review-use-dark-patterns-affecting-subscription-services-privacy" },
  { n: "lp.s2n", body: "lp.s2", src: "lp.s2src", url: "https://www.ftc.gov/news-events/news/press-releases/2024/10/federal-trade-commission-announces-final-click-cancel-rule-making-it-easier-consumers-end-recurring" },
  { n: "$219", body: "lp.s3", src: "lp.s3src", url: "https://www.crresearch.com/blog/subscription-service-statistics-and-costs" },
  { n: "+693%", body: "lp.s4", src: "lp.s4src", url: "https://news.adobe.com/news/2026/01/adobe-holiday-shopping-season" },
];

const PEOPLE: { title: Key; lines: Key[]; icon: typeof Store; color: string; calls: { kind: TagKind; name: string }[] }[] = [
  { title: "lp.ownerT", lines: ["lp.owner1", "lp.owner2", "lp.owner3"], icon: Store, color: "var(--lp-owner)", calls: [{ kind: "paypal", name: "PayPal MCP" }, { kind: "ai", name: "OpenAI agent" }] },
  { title: "lp.memberT", lines: ["lp.member1", "lp.member2", "lp.member3"], icon: User, color: "var(--lp-member)", calls: [{ kind: "paypal", name: "Subscriptions API" }, { kind: "tool", name: "Telegram" }] },
  { title: "lp.aiT", lines: ["lp.ai1", "lp.ai2", "lp.ai3"], icon: Bot, color: "var(--lp-ai)", calls: [{ kind: "ai", name: "Kept MCP" }, { kind: "paypal", name: "Subscriptions API" }] },
];

const FEATURES: { t: Key; b: Key; icon: typeof Store; tags: { kind: TagKind; name: string }[]; wide?: boolean }[] = [
  { t: "lp.f1t", b: "lp.f1", icon: XCircle, tags: [{ kind: "paypal", name: "Subscriptions: cancel" }], wide: true },
  { t: "lp.f2t", b: "lp.f2", icon: RefreshCw, tags: [{ kind: "paypal", name: "Subscriptions API" }] },
  { t: "lp.f3t", b: "lp.f3", icon: Scale, tags: [{ kind: "tool", name: "ROSCA" }, { kind: "tool", name: "Cal. B&P §17602" }] },
  { t: "lp.f4t", b: "lp.f4", icon: Waypoints, tags: [{ kind: "ai", name: "MCP" }, { kind: "ai", name: "OpenAI" }], wide: true },
  { t: "lp.f5t", b: "lp.f5", icon: Sparkles, tags: [{ kind: "paypal", name: "PayPal MCP" }, { kind: "ai", name: "gpt-6.1-sol" }] },
  { t: "lp.f6t", b: "lp.f6", icon: ShieldCheck, tags: [{ kind: "device", name: "MiniLM · ONNX" }, { kind: "ai", name: "Decisions API" }] },
  { t: "lp.f7t", b: "lp.f7", icon: MessageCircle, tags: [{ kind: "tool", name: "Telegram" }] },
  { t: "lp.f8t", b: "lp.f8", icon: Eye, tags: [{ kind: "device", name: "MediaPipe" }, { kind: "tool", name: "WCAG 2.2 AA" }] },
  { t: "lp.f9t", b: "lp.f9", icon: LayoutGrid, tags: [{ kind: "tool", name: "AG Grid" }, { kind: "tool", name: "Bryntum" }, { kind: "device", name: "LightGBM" }] },
];

/** What Kept calls and runs. Technical names, the same in every language. */
const TECH: { group: Key; kind: TagKind; items: string[] }[] = [
  { group: "lp.gPaypal", kind: "paypal", items: ["Subscriptions: create, get, suspend, activate, revise, cancel, capture", "Billing plans and catalog products", "Subscription transactions for the daily reconcile", "Webhooks, with signature verification", "PayPal's MCP server (sandbox) for the owner's agent", "JavaScript SDK subscription buttons"] },
  { group: "lp.gAi", kind: "ai", items: ["OpenAI gpt-6.1-sol: the owner's agent and the member's assistant", "OpenAI Decisions API: yes/no checks and the scam check", "gpt-live-1: push-to-talk dictation", "Kept's own MCP server: 14 member tools for any agent"] },
  { group: "lp.gDevice", kind: "device", items: ["Fine-tuned MiniLM scam model, ONNX Runtime Web, 23 MB int8", "LightGBM payment-risk model in the browser", "MediaPipe Face Landmarker for hands-free control", "Speech input and read-aloud in the browser"] },
  { group: "lp.gInfra", kind: "tool", items: ["Render: web service, worker, daily cron and Postgres from render.yaml", "AG Grid members grid and Bryntum renewal calendar", "Telegram bot with inline Skip and Keep buttons", "Server and browser tests, axe accessibility checks, and a robot judge that walks the live site"] },
];

const CRITERIA: { t: Key; pts: Key[]; tone: string }[] = [
  { t: "lp.cTech", pts: ["lp.cTech1", "lp.cTech2", "lp.cTech3"], tone: "tech" },
  { t: "lp.cDesign", pts: ["lp.cDesign1", "lp.cDesign2", "lp.cDesign3"], tone: "design" },
  { t: "lp.cImpact", pts: ["lp.cImpact1", "lp.cImpact2", "lp.cImpact3"], tone: "impact" },
  { t: "lp.cInnov", pts: ["lp.cInnov1", "lp.cInnov2", "lp.cInnov3"], tone: "innov" },
];

const TRACKS: { name: string; why: Key; kind: TagKind }[] = [
  { name: "Best Use of PayPal + AI", why: "lp.tPaypalAi", kind: "paypal" },
  { name: "Best Use of Agentic Commerce", why: "lp.tAgentic", kind: "ai" },
  { name: "Most Impactful", why: "lp.tImpact", kind: "tool" },
  { name: "Most Creative", why: "lp.tCreative", kind: "device" },
  { name: "Best Use of AG Grid", why: "lp.tAgGrid", kind: "tool" },
  { name: "Best Use of Bryntum", why: "lp.tBryntum", kind: "tool" },
  { name: "Best Use of Render", why: "lp.tRender", kind: "tool" },
];

const PRICING: { name: string; price: string; n: Key; items: Key[]; pop?: boolean }[] = [
  { name: "Starter", price: "lp.free", n: "lp.p1n", items: ["lp.p1a", "lp.p1b", "lp.p1c"] },
  { name: "Shop", price: "$19", n: "lp.p2n", items: ["lp.p2a", "lp.p2b", "lp.p2c"], pop: true },
  { name: "Growing", price: "$49", n: "lp.p3n", items: ["lp.p3a", "lp.p3b", "lp.p3c"] },
];

const reduced = () => typeof matchMedia === "function" && (matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.a11yMotion === "off");

/** The hero's phone: press Skip and watch what Kept does with PayPal. An illustration, labelled as one. */
function PhoneDemo() {
  const { t } = useT();
  const [stage, setStage] = useState(0);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  function play() {
    timers.current.forEach(clearTimeout);
    if (reduced()) return setStage(4);
    setStage(1);
    timers.current = [900, 1900, 2800].map((ms, i) => window.setTimeout(() => setStage(i + 2), ms));
  }
  const stamps = ["Aug", "Sep", "Oct", "Nov", "Dec", "Jan"];
  return (
    <figure className="lp-phone-wrap m-0">
      <div className="lp-phone">
        <div className="lp-phone-notch" aria-hidden="true" />
        <p className="lp-phone-shop">Ember &amp; Oak Coffee Club</p>
        <p className="lp-phone-plan">{t("lp.mockPlan")}</p>
        <ol className="lp-stamps" aria-hidden="true">
          {stamps.map((m, i) => (
            <li key={m} className={i < 3 ? "paid" : i === 3 ? (stage >= 3 ? "skipped" : "next") : ""}>
              <span />
              {m}
            </li>
          ))}
        </ol>
        <p className="lp-phone-next">{t("lp.mockNext")}</p>
        <div className="lp-phone-btns">
          <button type="button" className="lp-phone-skip" onClick={play} disabled={stage > 0 && stage < 4}>{t("lp.mockSkip")}</button>
          <span className="lp-phone-ghost" aria-hidden="true">{t("lp.mockPause")}</span>
          <span className="lp-phone-ghost" aria-hidden="true">{t("lp.mockCancel")}</span>
        </div>
        <ol className="lp-log" aria-live="polite">
          {stage >= 1 && <li className="lp-log-out"><PayPalMark size={13} />{t("lp.mockS1")}</li>}
          {stage >= 2 && <li className="lp-log-in"><PayPalMark size={13} />{t("lp.mockS2")}</li>}
          {stage >= 3 && <li className="lp-log-ok"><Check className="size-3.5" aria-hidden="true" />{t("lp.mockS3")}</li>}
        </ol>
        {stage >= 4 && (
          <p className="lp-tg"><MessageCircle className="size-3.5" aria-hidden="true" />{t("lp.mockTg")}</p>
        )}
        {stage === 0 && <p className="lp-phone-hint">{t("lp.mockPress")}</p>}
        {stage >= 4 && <button type="button" className="lp-phone-again" onClick={() => setStage(0)}>{t("lp.mockAgain")}</button>}
      </div>
      <figcaption className="lp-phone-cap">{t("lp.mockLabel")}</figcaption>
    </figure>
  );
}

export default function Landing() {
  const { t } = useT();
  useEffect(() => {
    void getSession();
  }, []);
  const start = () => {
    if (!startJourney("owner")) toast.error(t("lp.fail"));
  };
  const tx = (k: string) => (k.startsWith("lp.") ? t(k as Key) : k);
  const nav: [string, Key][] = [
    ["#how", "lp.navHow"],
    ["#features", "lp.navFeat"],
    ["#tech", "lp.navTech"],
    ["#win", "lp.navWin"],
    ["#pricing", "lp.navPrice"],
  ];

  return (
    <div className="lp">
      <PublicHeader
        right={
          <nav aria-label="Page sections" className="hidden items-center gap-1 xl:flex">
            {nav.map(([href, k]) => (
              <a key={href} href={href} className="lp-nav">{t(k)}</a>
            ))}
          </nav>
        }
      />
      <main id="main">
        {/* Hero */}
        <section className="lp-hero" aria-labelledby="lp-h1">
          <div className="lp-hero-grid" aria-hidden="true" />
          <div className="lp-wrap lp-hero-in">
            <div>
              <p className="lp-eyebrow"><span className="lp-live" aria-hidden="true" />{t("lp.eyebrow")}</p>
              <h1 id="lp-h1" className="lp-h1">
                {t("lp.h1a")} <em>{t("lp.h1em")}</em> {t("lp.h1b")}
              </h1>
              <p className="lp-sub">{t("lp.sub")}</p>
              <div className="lp-ctas">
                <button type="button" className="lp-btn lp-btn-main" onClick={start}>
                  {t("lp.cta")}
                  <ArrowRight className="size-4" aria-hidden="true" />
                </button>
                <a href="#how" className="lp-btn lp-btn-ghost">{t("lp.cta2")}</a>
              </div>
              <p className="lp-cta-note">{t("lp.ctaNote")}</p>
              <div className="lp-hero-tags">
                <Tag kind="paypal">PayPal Subscriptions</Tag>
                <Tag kind="paypal">PayPal MCP</Tag>
                <Tag kind="ai">OpenAI agents</Tag>
                <Tag kind="device">On-device AI</Tag>
              </div>
            </div>
            <PhoneDemo />
          </div>
        </section>

        {/* Built on */}
        <section className="lp-built" aria-labelledby="lp-built-k">
          <p id="lp-built-k" className="lp-built-k">{t("lp.builtOn")}</p>
          <Marquee pauseOnHover className="[--duration:42s] [--gap:0.75rem]" aria-label={t("lp.builtOn")}>
            {BUILT.map((b) => (
              <Tag key={b.name} kind={b.kind}>{b.name}</Tag>
            ))}
          </Marquee>
        </section>

        {/* The problem */}
        <section className="lp-sec" aria-labelledby="why">
          <div className="lp-wrap">
            <p className="lp-k">{t("lp.whyK")}</p>
            <h2 id="why" className="lp-h2">{t("lp.whyH")}</h2>
            <p className="lp-lead">{t("lp.whyB")}</p>
            <ul className="lp-stats">
              {STATS.map((s) => (
                <li key={s.body}>
                  <p className="lp-stat-n">{tx(s.n)}</p>
                  <p className="lp-stat-b">{t(s.body)}</p>
                  <a className="lp-stat-src" href={s.url} target="_blank" rel="noopener noreferrer">{t("lp.source")}: {t(s.src)}</a>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="lp-sec lp-sec-tint" aria-labelledby="how-h">
          <div className="lp-wrap">
            <p className="lp-k">{t("lp.howK")}</p>
            <h2 id="how-h" className="lp-h2">{t("lp.howH")}</h2>
            <p className="lp-lead">{t("lp.howB")}</p>
            <ol className="lp-people">
              {PEOPLE.map((p, i) => (
                <li key={p.title} style={{ ["--c" as string]: p.color }}>
                  <span className="lp-people-n" aria-hidden="true">0{i + 1}</span>
                  <span className="lp-people-ic"><p.icon className="size-5" aria-hidden="true" /></span>
                  <h3>{t(p.title)}</h3>
                  <ul>
                    {p.lines.map((l) => (
                      <li key={l}><Check className="size-4 shrink-0" aria-hidden="true" />{t(l)}</li>
                    ))}
                  </ul>
                  <div className="lp-people-calls">
                    {p.calls.map((c) => <Tag key={c.name} kind={c.kind}>{c.name}</Tag>)}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Features */}
        <section id="features" className="lp-sec" aria-labelledby="feat-h">
          <div className="lp-wrap">
            <p className="lp-k">{t("lp.featK")}</p>
            <h2 id="feat-h" className="lp-h2">{t("lp.featH")}</h2>
            <ul className="lp-bento">
              {FEATURES.map((f) => (
                <li key={f.t} className={f.wide ? "wide" : ""}>
                  <span className="lp-bento-ic"><f.icon className="size-5" aria-hidden="true" /></span>
                  <h3>{t(f.t)}</h3>
                  <p>{t(f.b)}</p>
                  <div className="lp-bento-tags">{f.tags.map((g) => <Tag key={g.name} kind={g.kind}>{g.name}</Tag>)}</div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Under the hood */}
        <section id="tech" className="lp-sec lp-night" aria-labelledby="tech-h">
          <div className="lp-wrap">
            <p className="lp-k">{t("lp.techK")}</p>
            <h2 id="tech-h" className="lp-h2">{t("lp.techH")}</h2>
            <p className="lp-lead">{t("lp.techB")}</p>
            <div className="lp-tech">
              {TECH.map((g) => (
                <div key={g.group}>
                  <h3><Tag kind={g.kind}>{t(g.group)}</Tag></h3>
                  <ul>
                    {g.items.map((it) => <li key={it}>{it}</li>)}
                  </ul>
                </div>
              ))}
            </div>
            <p className="lp-tech-links">
              <a href="/paypal">/paypal</a>
              <a href="/ai">/ai</a>
              <a href="/proof">/proof</a>
              <a href="/openapi.yaml">openapi.yaml</a>
            </p>
          </div>
        </section>

        {/* Why it wins */}
        <section id="win" className="lp-sec" aria-labelledby="win-h">
          <div className="lp-wrap">
            <p className="lp-k">{t("lp.winK")}</p>
            <h2 id="win-h" className="lp-h2">{t("lp.winH")}</h2>
            <p className="lp-lead">{t("lp.winB")}</p>
            <ul className="lp-crit">
              {CRITERIA.map((c) => (
                <li key={c.t} className={`lp-crit-${c.tone}`}>
                  <h3>{t(c.t)}</h3>
                  <ul>
                    {c.pts.map((p) => <li key={p}>{t(p)}</li>)}
                  </ul>
                </li>
              ))}
            </ul>
            <h3 className="lp-h3">{t("lp.tracksH")}</h3>
            <ul className="lp-tracks">
              {TRACKS.map((tr) => (
                <li key={tr.name}>
                  <Tag kind={tr.kind}>{tr.name}</Tag>
                  <p>{t(tr.why)}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="lp-sec lp-sec-tint" aria-labelledby="price-h">
          <div className="lp-wrap">
            <p className="lp-k">{t("lp.priceK")}</p>
            <h2 id="price-h" className="lp-h2">{t("lp.priceH")}</h2>
            <p className="lp-lead">{t("lp.priceB")}</p>
            <ul className="lp-price">
              {PRICING.map((p) => (
                <li key={p.name} className={p.pop ? "pop" : ""}>
                  {p.pop && <span className="lp-pop">{t("lp.popular")}</span>}
                  <h3>{p.name}</h3>
                  <p className="lp-price-n">
                    {tx(p.price)}
                    {p.price !== "lp.free" && <span> {t("lp.month")}</span>}
                  </p>
                  <p className="lp-price-m">{t(p.n)}</p>
                  <ul>
                    {p.items.map((i) => <li key={i}><Check className="size-4 shrink-0" aria-hidden="true" />{t(i)}</li>)}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Final call */}
        <section className="lp-end" aria-labelledby="end-h">
          <div className="lp-wrap lp-end-in">
            <h2 id="end-h" className="lp-h2">{t("lp.endH")}</h2>
            <p className="lp-lead">{t("lp.endB")}</p>
            <div className="lp-ctas">
              <button type="button" className="lp-btn lp-btn-main" onClick={start}>
                {t("lp.cta")}
                <ArrowRight className="size-4" aria-hidden="true" />
              </button>
              <Link to="/demo" className="lp-btn lp-btn-ghost"><Globe2 className="size-4" aria-hidden="true" />{t("shell.judges")}</Link>
            </div>
          </div>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
