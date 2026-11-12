import { useEffect } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Bot, Check, Compass, FileText, Scale } from "lucide-react";
import { PublicFooter, PublicHeader } from "@/components/Shell";
import { CycleCard, StampLegend } from "@/components/CycleCard";
import { TrustStrip } from "@/components/Timeline";
import { Button } from "@/components/ui/button";
import { Marquee } from "@/components/ui/marquee";
import { TryScam } from "@/components/TryScam";
import { Skeleton } from "@/components/ui/skeleton";
import { useData } from "@/lib/useData";
import { fmtMoney } from "@/lib/format";
import { getSession } from "@/lib/session";
import type { CycleCardData, PlanJson } from "@/lib/types";
import { useT } from "@/i18n";
import type { Key } from "@/i18n/en";

interface Preview {
  shop: { name: string; slug: string; tagline: string; currency: string } | null;
  plans?: PlanJson[];
  promise?: string[];
  example?: { name: string | null; sample: boolean; card: CycleCardData; plan: string | null } | null;
}

/** Illustrative only: shown so the business model is concrete, clearly marked as not on sale. Tier names are names. */
const PRICING: { name: string; price: Key | string; note: Key; items: Key[] }[] = [
  { name: "Starter", price: "land.free", note: "land.p1note", items: ["land.p1a", "land.p1b", "land.p1c"] },
  { name: "Shop", price: "$19", note: "land.p2note", items: ["land.p2a", "land.p2b", "land.p2c"] },
  { name: "Growing", price: "$49", note: "land.p3note", items: ["land.p3a", "land.p3b", "land.p3c"] },
];

const FAQ = [1, 2, 3, 4, 5, 6].map((n) => [`land.q${n}`, `land.a${n}`] as [Key, Key]);

const SHOPS = Array.from({ length: 12 }, (_, i) => `land.k${i + 1}` as Key);

export default function Landing() {
  const { t } = useT();
  const { data, loading } = useData<Preview>("/ui/preview");
  useEffect(() => {
    void getSession();
  }, []);

  const ex = data?.example;
  const cur = data?.shop?.currency ?? "USD";

  return (
    <>
      <PublicHeader
        right={
          <Button variant="ghost" asChild className="hidden sm:inline-flex">
            <Link to="/demo">{t("land.signIn")}</Link>
          </Button>
        }
      />
      <main id="main">
        {/* Hero */}
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pt-12 pb-16 md:grid-cols-[1.1fr_1fr] md:pt-20">
          <div>
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-rule bg-card px-3 py-1 text-sm text-ink-2">
              <span className="size-2 rounded-full bg-paid" aria-hidden="true" />
              {t("land.for")}
            </p>
            <h1 className="text-[2.5rem] font-bold leading-[1.05] sm:text-5xl lg:text-[3.5rem]">
              {t("land.h1")}
            </h1>
            <p className="mt-5 max-w-[58ch] text-lg text-ink-2">
              {t("land.lede")}
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button size="lg" asChild>
                <Link to="/demo">
                  {t("land.try")}
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link to="/judge">
                  <Compass aria-hidden="true" />
                  {t("land.judges")}
                </Link>
              </Button>
            </div>
            <p className="mt-4 text-sm text-ink-2">
              {t("land.a11y")} <Link to="/accessibility" className="underline">{t("land.a11yLink")}</Link>.
            </p>
          </div>

          {/* The signature: a member's stamp card, from the demo shop's real data. */}
          <div data-tour="hero-card" className="relative">
            <div className="rotate-[-1.5deg] rounded-2xl border border-rule bg-card p-5 shadow-[0_1px_0_var(--rule),0_18px_40px_-18px_rgb(22_24_27/0.25)] sm:p-7">
              <div className="flex items-start justify-between gap-4 border-b border-dashed border-rule pb-4">
                <div>
                  <p className="m-0 font-display text-xl font-bold">{data?.shop?.name ?? t("land.yourShop")}</p>
                  <p className="m-0 text-sm text-ink-2">
                    {ex ? `${ex.name ?? t("land.aMember")} · ${ex.plan ?? ""}` : t("land.memberCard")}
                    {ex?.sample && <span className="ml-2 rounded border border-rule px-1.5 py-0.5 text-[0.6875rem] uppercase tracking-wide">{t("land.sample")}</span>}
                  </p>
                </div>
                <span className="hidden font-mono text-[0.6875rem] uppercase tracking-widest text-ink-2 sm:block">{t("land.stamp")}</span>
              </div>
              <div className="pt-5">
                {loading ? (
                  <Skeleton className="h-16" />
                ) : ex ? (
                  <CycleCard card={ex.card} currency={cur} size="lg" animate caption={t("land.built")} />
                ) : (
                  <CycleCard
                    card={{ every: "month", end: null, stamps: ["paid", "paid", "skipped", "paid", "upcoming", "upcoming"].map((k, i) => ({ kind: k as any, date: new Date(Date.now() + (i - 3) * 30 * 864e5).toISOString(), amount: null, next: i === 4 || undefined })) }}
                    size="lg"
                    animate
                    caption={t("land.example")}
                  />
                )}
              </div>
            </div>
            <StampLegend className="mt-5 justify-center" />
          </div>
        </section>

        <div className="border-y border-rule bg-card py-3">
          <Marquee pauseOnHover className="[--duration:48s] [--gap:2.5rem]" aria-label={t("land.kinds")}>
            {SHOPS.map((s) => (
              <span key={s} className="font-display text-lg font-semibold text-ink-2">
                {t(s)}
              </span>
            ))}
          </Marquee>
        </div>

        {/* How it works */}
        <section className="mx-auto max-w-6xl px-4 py-20" aria-labelledby="how">
          <h2 id="how" className="text-3xl font-bold sm:text-4xl">{t("land.how")}</h2>
          <ol className="mt-10 grid list-none gap-6 p-0 md:grid-cols-3">
            {[
              { icon: FileText, t: t("land.s1t"), d: t("land.s1d") },
              { icon: Bot, t: t("land.s2t"), d: t("land.s2d") },
              { icon: Scale, t: t("land.s3t"), d: t("land.s3d") },
            ].map((s, i) => (
              <li key={s.t} className="rounded-xl border border-rule bg-card p-6">
                <div className="flex items-center gap-3">
                  <span className="grid size-9 place-items-center rounded-full bg-ink font-display font-bold text-paper num">{i + 1}</span>
                  <s.icon className="size-5 text-stamp" aria-hidden="true" />
                </div>
                <h3 className="mt-4 text-xl font-semibold">{s.t}</h3>
                <p className="mt-2 text-ink-2">{s.d}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Trust pattern */}
        <section className="border-y border-rule bg-sidebar" aria-labelledby="trust">
          <div className="mx-auto max-w-6xl px-4 py-20">
            <h2 id="trust" className="text-3xl font-bold sm:text-4xl">{t("land.trustH")}</h2>
            <p className="mt-3 max-w-[62ch] text-lg text-ink-2">{t("land.trustB")}</p>
            <div data-tour="trust" className="mt-8">
              <TrustStrip />
            </div>
            <div className="mt-8 max-w-3xl">
              <TryScam />
            </div>
          </div>
        </section>

        {/* Live product preview */}
        <section className="mx-auto max-w-6xl px-4 py-20" aria-labelledby="preview">
          <h2 id="preview" className="text-3xl font-bold sm:text-4xl">{t("land.previewH")}</h2>
          <p className="mt-3 max-w-[62ch] text-lg text-ink-2">{t("land.previewB")}</p>
          {loading ? (
            <Skeleton className="mt-8 h-48" />
          ) : data?.shop ? (
            <div className="mt-8 grid gap-6 lg:grid-cols-[1.2fr_1fr]">
              <div className="rounded-xl border border-rule bg-card p-6">
                <p className="m-0 font-display text-2xl font-bold">{data.shop.name}</p>
                <p className="m-0 text-ink-2">{data.shop.tagline}</p>
                <ul className="mt-5 list-none divide-y divide-rule p-0">
                  {data.plans?.map((p) => (
                    <li key={p.id} className="flex items-baseline justify-between gap-4 py-3">
                      <span>
                        <span className="font-medium">{p.name}</span>
                        {p.description && p.description !== p.name && <span className="text-ink-2"> · {p.description}</span>}
                      </span>
                      <span className="num shrink-0 font-semibold">
                        {fmtMoney(p.price, p.currency)} <span className="font-normal text-ink-2">{p.billing}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                <Button asChild variant="outline" className="mt-4">
                  <Link to={`/s/${data.shop.slug}`}>{t("land.openShop")}</Link>
                </Button>
              </div>
              <div className="rounded-xl border border-rule bg-card p-6">
                <p className="m-0 font-semibold">{t("land.promise")}</p>
                <ul className="mt-3 list-none space-y-2 p-0">
                  {data.promise?.map((l) => (
                    <li key={l} className="flex gap-2">
                      <Check className="mt-1 size-4 shrink-0 text-paid" aria-hidden="true" />
                      <span>{l}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <p className="mt-8 text-ink-2">{t("land.noShop")}</p>
          )}
        </section>

        {/* Pricing, illustrative */}
        <section className="mx-auto max-w-6xl px-4 pb-20" aria-labelledby="pricing">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 id="pricing" className="text-3xl font-bold sm:text-4xl">{t("land.pricing")}</h2>
            <p className="m-0 rounded-md border border-dashed border-pause px-2 py-1 text-sm text-pause">{t("land.illustrative")}</p>
          </div>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {PRICING.map((p) => (
              <div key={p.name} className="rounded-xl border border-rule bg-card p-6">
                <p className="m-0 font-semibold">{p.name}</p>
                <p className="m-0 mt-2 font-display text-3xl font-bold num">{p.price.startsWith("land.") ? t(p.price as Key) : t("land.perMonth", { p: p.price })}</p>
                <p className="m-0 text-sm text-ink-2">{t(p.note)}</p>
                <ul className="mt-4 list-none space-y-2 p-0 text-[0.9375rem]">
                  {p.items.map((i) => (
                    <li key={i} className="flex gap-2">
                      <Check className="mt-1 size-4 shrink-0 text-stamp" aria-hidden="true" />
                      {t(i)}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="mt-3 text-sm text-ink-2">{t("land.fees")}</p>
        </section>

        {/* FAQ */}
        <section className="mx-auto max-w-3xl px-4 pb-8" aria-labelledby="faq">
          <h2 id="faq" className="text-3xl font-bold sm:text-4xl">{t("land.faq")}</h2>
          <div className="mt-6 divide-y divide-rule border-y border-rule">
            {FAQ.map(([q, a]) => (
              <details key={q} className="group py-1">
                <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 font-medium [&::-webkit-details-marker]:hidden">
                  {t(q)}
                  <span aria-hidden="true" className="text-xl text-ink-2 transition-transform group-open:rotate-45">+</span>
                </summary>
                <p className="mt-0 pb-4 text-ink-2">{t(a)}</p>
              </details>
            ))}
          </div>
          <div className="mt-12 rounded-2xl bg-ink p-8 text-paper">
            <p className="m-0 font-display text-2xl font-bold">{t("land.endH")}</p>
            <p className="mt-2 text-paper/80">{t("land.endB")}</p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Button size="lg" variant="stamp" asChild>
                <Link to="/demo">{t("land.try")}</Link>
              </Button>
              <Button size="lg" variant="ghost" className="text-paper hover:bg-paper/10 hover:text-paper" asChild>
                <Link to="/judge">{t("land.forJudges")}</Link>
              </Button>
            </div>
          </div>
        </section>
      </main>
      <PublicFooter />
    </>
  );
}
