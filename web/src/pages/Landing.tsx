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

interface Preview {
  shop: { name: string; slug: string; tagline: string; currency: string } | null;
  plans?: PlanJson[];
  promise?: string[];
  example?: { name: string | null; sample: boolean; card: CycleCardData; plan: string | null } | null;
}

/** Illustrative only: shown so the business model is concrete, clearly marked as not on sale. */
const PRICING = [
  { name: "Starter", price: "Free", note: "up to 50 members", items: ["One-step cancel and member page", "Plain-words rules", "MCP endpoint for AI assistants"] },
  { name: "Shop", price: "$19 / month", note: "up to 1,000 members", items: ["Everything in Starter", "One fair offer, failed-payment recovery", "Text reminders and browser approvals"] },
  { name: "Growing", price: "$49 / month", note: "unlimited members", items: ["Everything in Shop", "Backtests and earned autonomy", "Compliance scorecard by state"] },
];

const FAQ: [string, string][] = [
  ["Does Kept hold my money?", "No. PayPal bills your members and pays you, as it does today. Kept asks PayPal to create, pause, change or cancel subscriptions, and only believes what PayPal reads back."],
  ["Can the AI change a price or give a discount on its own?", "No. The AI reads your plain words, labels why someone is leaving and words messages. Which offers are allowed, and every amount, are computed in code from rules you approved. Anything above the limits you set waits for you."],
  ["Can I make cancelling harder?", "No, and Kept tells you why. Cancelling is one step for every member and every AI assistant. Rules like \"three offers before cancel\" or \"must call to cancel\" are refused, with the law cited (for example California's automatic renewal law)."],
  ["What about my members' AI assistants?", "Your shop gets an MCP endpoint. Assistants such as Claude can find your plans, subscribe a person (who approves on PayPal), skip, pause, switch or cancel, with the same rules a person gets."],
  ["What happens when a renewal fails?", "PayPal tells Kept through a signature-verified webhook. The member's page explains how to fix it, never by a \"pay here\" link in a text, and Kept collects the balance once they do."],
  ["Is this live?", "This is a hackathon build running on the PayPal sandbox: every PayPal call is real, no real money moves. Sample members are labelled Sample and never counted in PayPal-confirmed figures; the demo notice at the top lists what is not live yet."],
];

const SHOPS = ["Coffee clubs", "Bakery boxes", "Farm boxes", "Meal kits", "Flower subscriptions", "Tea of the month", "Newsletters", "Climbing gyms", "Pet food deliveries", "Wine clubs", "Comic shops", "Sourdough starters"];

export default function Landing() {
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
            <Link to="/demo">Sign in</Link>
          </Button>
        }
      />
      <main id="main">
        {/* Hero */}
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pt-12 pb-16 md:grid-cols-[1.1fr_1fr] md:pt-20">
          <div>
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-rule bg-card px-3 py-1 text-sm text-ink-2">
              <span className="size-2 rounded-full bg-paid" aria-hidden="true" />
              For small subscription shops on PayPal
            </p>
            <h1 className="text-[2.5rem] font-bold leading-[1.05] sm:text-5xl lg:text-[3.5rem]">
              Let members cancel in one step. Keep the ones who'd rather pause.
            </h1>
            <p className="mt-5 max-w-[58ch] text-lg text-ink-2">
              Kept runs your PayPal subscriptions so members, and their AI assistants, can skip, pause, switch or cancel themselves, within rules you write in plain words. You only hear about what needs you.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button size="lg" asChild>
                <Link to="/demo">
                  Try the live demo
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
              <Button size="lg" variant="outline" asChild>
                <Link to="/judge">
                  <Compass aria-hidden="true" />
                  For judges: 3 paths, with ticks
                </Link>
              </Button>
            </div>
            <p className="mt-4 text-sm text-ink-2">
              Works with a screen reader, at 200% text, and by voice. <Link to="/accessibility" className="underline">What was tested, and what wasn't</Link>.
            </p>
          </div>

          {/* The signature: a member's stamp card, from the demo shop's real data. */}
          <div data-tour="hero-card" className="relative">
            <div className="rotate-[-1.5deg] rounded-2xl border border-rule bg-card p-5 shadow-[0_1px_0_var(--rule),0_18px_40px_-18px_rgb(22_24_27/0.25)] sm:p-7">
              <div className="flex items-start justify-between gap-4 border-b border-dashed border-rule pb-4">
                <div>
                  <p className="m-0 font-display text-xl font-bold">{data?.shop?.name ?? "Your shop"}</p>
                  <p className="m-0 text-sm text-ink-2">
                    {ex ? `${ex.name ?? "A member"} · ${ex.plan ?? ""}` : "Member card"}
                    {ex?.sample && <span className="ml-2 rounded border border-rule px-1.5 py-0.5 text-[0.6875rem] uppercase tracking-wide">sample</span>}
                  </p>
                </div>
                <span className="hidden font-mono text-[0.6875rem] uppercase tracking-widest text-ink-2 sm:block">one stamp a cycle</span>
              </div>
              <div className="pt-5">
                {loading ? (
                  <Skeleton className="h-16" />
                ) : ex ? (
                  <CycleCard card={ex.card} currency={cur} size="lg" animate caption="Built from PayPal payments, skips, pauses and the next billing date." />
                ) : (
                  <CycleCard
                    card={{ every: "month", end: null, stamps: ["paid", "paid", "skipped", "paid", "upcoming", "upcoming"].map((k, i) => ({ kind: k as any, date: new Date(Date.now() + (i - 3) * 30 * 864e5).toISOString(), amount: null, next: i === 4 || undefined })) }}
                    size="lg"
                    animate
                    caption="Example card."
                  />
                )}
              </div>
            </div>
            <StampLegend className="mt-5 justify-center" />
          </div>
        </section>

        <div className="border-y border-rule bg-card py-3">
          <Marquee pauseOnHover className="[--duration:48s] [--gap:2.5rem]" aria-label="Kinds of shops Kept is for">
            {SHOPS.map((s) => (
              <span key={s} className="font-display text-lg font-semibold text-ink-2">
                {s}
              </span>
            ))}
          </Marquee>
        </div>

        {/* How it works */}
        <section className="mx-auto max-w-6xl px-4 py-20" aria-labelledby="how">
          <h2 id="how" className="text-3xl font-bold sm:text-4xl">How it works</h2>
          <ol className="mt-10 grid list-none gap-6 p-0 md:grid-cols-3">
            {[
              { icon: FileText, t: "Write your rules in plain words", d: "\"One skip per quarter. Pause up to two months. At most 15% off for 3 months.\" Kept shows exactly what it understood and creates the PayPal plans when you approve." },
              { icon: Bot, t: "Members change it themselves", d: "From their own page or through an AI assistant: skip, pause, switch or cancel in one step. If they ask, the shop makes one fair offer." },
              { icon: Scale, t: "Every change matches PayPal", d: "Kept writes to PayPal, reads it back, and logs who did what. Anything above your limits waits for your tap." },
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
            <h2 id="trust" className="text-3xl font-bold sm:text-4xl">AI proposes. Code decides. PayPal moves money.</h2>
            <p className="mt-3 max-w-[62ch] text-lg text-ink-2">Every step in Kept is labelled with who did it, so you can trust it with your members' money.</p>
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
          <h2 id="preview" className="text-3xl font-bold sm:text-4xl">A real shop, running now</h2>
          <p className="mt-3 max-w-[62ch] text-lg text-ink-2">These plans and promises come live from the demo shop on the PayPal sandbox.</p>
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
                  <Link to={`/s/${data.shop.slug}`}>Open the shop page</Link>
                </Button>
              </div>
              <div className="rounded-xl border border-rule bg-card p-6">
                <p className="m-0 font-semibold">The shop's promise to members</p>
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
            <p className="mt-8 text-ink-2">The demo shop isn't set up on this server yet.</p>
          )}
        </section>

        {/* Pricing, illustrative */}
        <section className="mx-auto max-w-6xl px-4 pb-20" aria-labelledby="pricing">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 id="pricing" className="text-3xl font-bold sm:text-4xl">Pricing</h2>
            <p className="m-0 rounded-md border border-dashed border-pause px-2 py-1 text-sm text-pause">Illustrative: not on sale during the hackathon</p>
          </div>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {PRICING.map((p) => (
              <div key={p.name} className="rounded-xl border border-rule bg-card p-6">
                <p className="m-0 font-semibold">{p.name}</p>
                <p className="m-0 mt-2 font-display text-3xl font-bold num">{p.price}</p>
                <p className="m-0 text-sm text-ink-2">{p.note}</p>
                <ul className="mt-4 list-none space-y-2 p-0 text-[0.9375rem]">
                  {p.items.map((i) => (
                    <li key={i} className="flex gap-2">
                      <Check className="mt-1 size-4 shrink-0 text-stamp" aria-hidden="true" />
                      {i}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="mt-3 text-sm text-ink-2">PayPal's own fees apply as usual. Kept never takes a cut of a payment.</p>
        </section>

        {/* FAQ */}
        <section className="mx-auto max-w-3xl px-4 pb-8" aria-labelledby="faq">
          <h2 id="faq" className="text-3xl font-bold sm:text-4xl">Questions owners ask</h2>
          <div className="mt-6 divide-y divide-rule border-y border-rule">
            {FAQ.map(([q, a]) => (
              <details key={q} className="group py-1">
                <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 font-medium [&::-webkit-details-marker]:hidden">
                  {q}
                  <span aria-hidden="true" className="text-xl text-ink-2 transition-transform group-open:rotate-45">+</span>
                </summary>
                <p className="mt-0 pb-4 text-ink-2">{a}</p>
              </details>
            ))}
          </div>
          <div className="mt-12 rounded-2xl bg-ink p-8 text-paper">
            <p className="m-0 font-display text-2xl font-bold">See it work end to end</p>
            <p className="mt-2 text-paper/80">Be the owner, a member, or a member's AI assistant. Everything runs on the PayPal sandbox.</p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Button size="lg" variant="stamp" asChild>
                <Link to="/demo">Try the live demo</Link>
              </Button>
              <Button size="lg" variant="ghost" className="text-paper hover:bg-paper/10 hover:text-paper" asChild>
                <Link to="/judge">For judges</Link>
              </Button>
            </div>
          </div>
        </section>
      </main>
      <PublicFooter />
    </>
  );
}
