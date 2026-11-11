import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Bot, Check, Copy, Lock } from "lucide-react";
import { toast } from "sonner";
import { PublicFooter, PublicHeader } from "@/components/Shell";
import { ErrorState, PageSkeleton, Empty } from "@/components/States";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError, newKey } from "@/lib/api";
import { fmtMoney } from "@/lib/format";
import { useData } from "@/lib/useData";
import type { PlanJson } from "@/lib/types";
import { startTour } from "@/tours";

interface ShopData {
  showcase?: boolean;
  shop: { name: string; slug: string; tagline: string | null; currency: string };
  plans: PlanJson[];
  promise: string[];
  mcp: string;
  llms: string;
  paypalClientId: string | null;
}

declare global {
  interface Window {
    paypal?: any;
  }
}

let sdk: Promise<void> | null = null;
function loadPayPal(clientId: string, currency: string): Promise<void> {
  if (window.paypal) return Promise.resolve();
  if (!sdk)
    sdk = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&vault=true&intent=subscription&currency=${encodeURIComponent(currency)}`;
      s.dataset.sdkIntegrationSource = "button-factory";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("PayPal's button didn't load"));
      document.head.appendChild(s);
    });
  return sdk;
}

function PlanCard({ plan, shop, clientId }: { plan: PlanJson; shop: ShopData["shop"]; clientId: string | null }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const btn = useRef<HTMLDivElement>(null);
  const vals = useRef({ name, email });
  vals.current = { name, email };
  const daily = /day/.test(plan.billing);

  // PayPal's own button, created only when the card is near the screen. The subscription is created on Kept's
  // server first (so Kept records it), then PayPal's window collects the person's approval.
  useEffect(() => {
    if (!clientId || !btn.current) return;
    const el = btn.current;
    let ref: string | null = null;
    let done = false;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting) || done) return;
      done = true;
      io.disconnect();
      loadPayPal(clientId, shop.currency)
        .then(() =>
          window.paypal
            .Buttons({
              style: { shape: "rect", layout: "vertical", label: "subscribe", height: 44, color: "gold" },
              createSubscription: async () => {
                setErr(null);
                const out = await api.post<{ ref: string; paypal_subscription_id: string }>(`/ui/shop/${shop.slug}/subscribe`, { plan_id: plan.id, ...vals.current, key: newKey() });
                ref = out.ref;
                return out.paypal_subscription_id;
              },
              onApprove: () => location.assign(`/r/${ref}`),
              onCancel: () => {
                if (ref) location.assign(`/r/${ref}?cancelled=1`);
              },
              onError: (e: unknown) => setErr(e instanceof ApiError ? e.message : "PayPal couldn't complete that. Nothing was charged."),
            })
            .render(el),
        )
        .catch(() => {
          el.hidden = true;
        });
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [clientId, plan.id, shop.slug, shop.currency]);

  async function redirect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const out = await api.post<{ ref: string; approval_url: string | null }>(`/ui/shop/${shop.slug}/subscribe`, { plan_id: plan.id, name, email, key: newKey() });
      location.assign(out.approval_url ?? `/manage/${out.ref}`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "That didn't work. Nothing was charged.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={redirect} className="flex flex-col rounded-xl border border-rule bg-card p-6" aria-labelledby={`p-${plan.id}`}>
      <div className="flex items-start justify-between gap-3">
        <h2 id={`p-${plan.id}`} className="m-0 text-2xl font-bold">{plan.name}</h2>
        {plan.kind === "lite" && <span className="rounded-full border border-rule px-2 py-0.5 text-xs text-ink-2">lighter</span>}
        {daily && <span className="rounded-full border border-dashed border-pause px-2 py-0.5 text-xs text-pause">demo: renews daily</span>}
      </div>
      <p className="m-0 mt-2 font-display text-4xl font-bold num" data-money>
        {fmtMoney(plan.price, plan.currency)} <span className="font-sans text-base font-normal text-ink-2">{plan.billing}</span>
      </p>
      {plan.description && plan.description !== plan.name && <p className="m-0 mt-1 text-ink-2">{plan.description}</p>}
      <div className="mt-5 grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`n-${plan.id}`}>Your name</Label>
          <Input id={`n-${plan.id}`} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} className="h-11" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`e-${plan.id}`}>Email (optional)</Label>
          <Input id={`e-${plan.id}`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" maxLength={120} className="h-11" />
        </div>
      </div>
      <div className="mt-5 grid gap-2">
        {clientId && <div ref={btn} role="group" className="min-h-11" aria-label={`Subscribe to ${plan.name} with PayPal`} />}
        <Button type="submit" variant={clientId ? "outline" : "default"} disabled={busy}>
          <Lock aria-hidden="true" />
          {busy ? "Opening PayPal…" : clientId ? "Or continue on PayPal's page" : "Subscribe with PayPal"}
        </Button>
      </div>
      <p role="alert" aria-live="assertive" className="m-0 mt-2 min-h-5 text-sm text-fail">{err}</p>
    </form>
  );
}

export default function Shop() {
  const { slug = "" } = useParams();
  const { data, error, loading, reload } = useData<ShopData>(`/ui/shop/${slug}`);
  const [copied, setCopied] = useState(false);

  return (
    <>
      <PublicHeader />
      <main id="main" className="mx-auto max-w-6xl px-4 py-10">
        {loading && !data ? (
          <PageSkeleton label="Loading the shop" />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : data ? (
          <>
            <p className="m-0 text-sm font-medium uppercase tracking-wider text-ink-2">Subscribe</p>
            <h1 className="mt-1 text-4xl font-bold sm:text-5xl">{data.shop.name}</h1>
            {data.shop.tagline && <p className="mt-2 max-w-[60ch] text-lg text-ink-2">{data.shop.tagline}</p>}
            {new URLSearchParams(location.search).has("rejoin") && (
              <p role="status" className="mt-4 rounded-lg bg-paid-wash p-3">Welcome back. These are the ordinary prices; pick a plan and PayPal asks you to approve it, the same as the first time.</p>
            )}
            {data.showcase && (
              <div role="note" className="mt-5 rounded-lg border border-rule bg-stamp-wash p-4">
                This is the read-only showcase. To subscribe for real on the PayPal sandbox, <a className="font-medium text-stamp underline" href="/demo">start your own private demo shop</a>: its shop page works the same way, on the same plans.
              </div>
            )}
            <div data-tour="plans" className="mt-8 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              {data.plans.length ? data.plans.map((p) => <PlanCard key={p.id} plan={p} shop={data.shop} clientId={data.paypalClientId} />) : <Empty title="No plans yet">This shop hasn't published plans.</Empty>}
            </div>
            <p className="mt-3 flex items-center gap-2 text-sm text-ink-2">
              <Lock className="size-4" aria-hidden="true" />
              You approve on PayPal's own page. {data.shop.name} never sees your card.
            </p>
            <div className="mt-10 grid gap-5 md:grid-cols-2">
              <section data-tour="promise" className="rounded-xl border border-rule bg-card p-6" aria-labelledby="promise">
                <h2 id="promise" className="m-0 text-xl font-semibold">Our promise</h2>
                <ul className="mt-3 list-none space-y-2 p-0">
                  {data.promise.map((l) => (
                    <li key={l} className="flex gap-2">
                      <Check className="mt-1 size-4 shrink-0 text-paid" aria-hidden="true" />
                      {l}
                    </li>
                  ))}
                </ul>
              </section>
              <section data-tour="agent" className="rounded-xl border border-rule bg-card p-6" aria-labelledby="agent">
                <h2 id="agent" className="m-0 flex items-center gap-2 text-xl font-semibold">
                  <Bot className="size-5 text-stamp" aria-hidden="true" />
                  Use an AI assistant?
                </h2>
                <p className="mt-2 text-ink-2">It can subscribe and manage this for you through our agent endpoint (MCP). You still approve payments on PayPal.</p>
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-rule bg-paper p-2 pl-3">
                  <code className="min-w-0 flex-1 truncate font-mono text-sm">{data.mcp}</code>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="Copy the agent endpoint"
                    onClick={() => {
                      navigator.clipboard?.writeText(data.mcp).then(() => {
                        setCopied(true);
                        toast.success("Endpoint copied");
                        setTimeout(() => setCopied(false), 2000);
                      });
                    }}
                  >
                    {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  </Button>
                </div>
                <p className="mt-3 text-sm">
                  <a className="text-stamp underline" href={data.llms}>llms.txt</a> · <a className="text-stamp underline" href="/agents">Setup guide</a>
                </p>
              </section>
            </div>
          </>
        ) : null}
      </main>
      <PublicFooter />
    </>
  );
}
