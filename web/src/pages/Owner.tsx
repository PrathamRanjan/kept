import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { AlertTriangle, ArrowRight, Check, Clock, RefreshCw, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { OwnerShell } from "@/components/Shell";
import { WorkspaceBar } from "@/components/WorkspaceBar";
import { TrustStrip, WhoChip } from "@/components/Timeline";
import { Empty, ErrorState, PageSkeleton } from "@/components/States";
import { Button } from "@/components/ui/button";
import { VoiceButton } from "@/components/VoiceButton";
import { Input } from "@/components/ui/input";
import { api, ApiError, streamPost } from "@/lib/api";
import { CitedAnswer, WorkRail, type Fact, type RailStep, type Sentence } from "@/components/WorkRail";
import { fmtDate, fmtMoney, fmtRelative } from "@/lib/format";
import { useData } from "@/lib/useData";
import type { CycleCardData, PlanJson } from "@/lib/types";
import { cn } from "@/lib/utils";
import { startTour } from "@/tours";

const Members = lazy(() => import("./Members"));

export interface Member {
  ref: string; name: string; email: string | null; sample: boolean; channel: string; agent_id: string | null; status: string; kept_state: string | null;
  plan: string | null; price: number | null; next_billing_time: string | null; resume_at: string | null; promo_until: string | null; outstanding: number; started_at: string | null; paypal_subscription_id: string | null; card: CycleCardData;
}
interface Approval { id: string; action: string; created_at: string; member: { name: string; ref: string; sample: boolean } | null; amount: string | null; offer: { type: string; percent?: number; cycles?: number; label?: string } | null; why: string[]; scam: boolean; needsPasskey: boolean; undo: string }
export interface Today {
  shop: { name: string; slug: string; currency: string; paypal_env: string; product: string | null };
  stats: any;
  killed: boolean;
  autonomy: { auto_discount_max_pct: number; auto_pause_max_cycles: number; approve_capture_above_cents: number };
  approvals: Approval[];
  failed: { ref: string; name: string; sample: boolean; outstanding: string }[];
  openOffers: { id: string; member: string; ref: string; sample: boolean; label: string; expires_at: string }[];
  offers: { id: string; member: string; ref: string; sample: boolean; label: string; type: string; status: string; reason: string | null; created_at: string }[];
  members: Member[];
  events: { id: number; created_at: string; source: string; type: string; summary: string; is_sample: boolean }[];
  rules: { version: number; lines: string[]; source: string } | null;
  plans: PlanJson[];
  connections: { widget: string; buyerMcp: string; ownerMcp: string; webhookOk: boolean; ai: string; telegram: boolean };
  demoMode: boolean;
}

const REASON: Record<string, string> = { price: "Cost", too_much: "Too much product", away: "Away or travelling", quality: "Quality", competitor: "Switching elsewhere", no_need: "No longer needed", payment: "Payment problems", other: "Other or none given" };

export function Sample() {
  return <span className="ml-1.5 inline-flex h-5 items-center rounded border border-rule px-1.5 align-middle text-[0.6875rem] font-medium uppercase tracking-wide text-ink-2">sample</span>;
}

/** Spec A3.3: tours start only from a button, so this hook no longer starts anything. Kept for callers. */
function useTour(_ready: boolean, _first: "owner" | null) {}

/* ------------------------------------------------------------------ approvals */
function ApprovalCard({ a, currency, onDone }: { a: Approval; currency: string; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const what = a.offer
    ? a.offer.type === "discount"
      ? `${a.offer.percent ?? ""}% off for ${a.offer.cycles ?? ""} payments`
      : a.offer.type === "pause"
        ? `A ${a.offer.cycles ?? ""}-cycle pause`
        : a.offer.label ?? a.offer.type.replace(/_/g, " ")
    : `${a.action.replace(/_/g, " ")}${a.amount ? ` of ${fmtMoney(a.amount, currency)}` : ""}`;
  async function decide(choice: "approve" | "decline") {
    setBusy(choice);
    try {
      const out = await api.post<{ message: string }>(`/ui/owner/approvals/${a.id}/${choice}`);
      toast.success(out.message);
      onDone();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "That didn't work.");
    } finally {
      setBusy(null);
    }
  }
  return (
    <article className={cn("rounded-xl border bg-card p-5", a.scam ? "border-fail/60" : "border-rule")} aria-labelledby={`a-${a.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id={`a-${a.id}`} className="m-0 text-lg font-semibold first-letter:uppercase">
          {what}
          {a.member && (
            <span className="font-normal text-ink-2">
              {" "}for <Link className="text-ink underline" to={`/manage/${a.member.ref}`}>{a.member.name}</Link>
              {a.member.sample && <Sample />}
            </span>
          )}
        </h3>
        <time className="text-sm text-ink-2" dateTime={a.created_at}>{fmtRelative(a.created_at)}</time>
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="font-medium text-ink-2">What moves</dt>
        <dd className="m-0">{a.amount ? <span className="num font-semibold">{fmtMoney(a.amount, currency)}</span> : "No money now"} {a.offer ? "· changes the member's PayPal plan if they accept" : ""}</dd>
        <dt className="font-medium text-ink-2">Why it waited</dt>
        <dd className="m-0 flex flex-wrap items-center gap-1.5"><WhoChip who="Rule" />{a.why.join(" · ") || "Above what you let Kept do on its own."}</dd>
        <dt className="font-medium text-ink-2">How to undo</dt>
        <dd className="m-0">{a.undo}</dd>
      </dl>
      {a.scam && (
        <p className="mt-3 mb-0 flex items-start gap-2 rounded-lg bg-fail-wash p-3 text-sm text-fail">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          This matches a scam pattern. Approve only if you've confirmed it with the member directly.
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {a.needsPasskey ? (
          <Button asChild>
            <a href="/dashboard/guard#approvals">Approve with your passkey</a>
          </Button>
        ) : (
          <Button onClick={() => decide("approve")} disabled={!!busy} data-hf-confirm="true" data-hf-what={`Approve: ${what}`} data-hf-amount={a.amount ? fmtMoney(a.amount, currency) : "No money now"} data-hf-to={a.member?.name ?? "this shop"}>
            <Check aria-hidden="true" />
            {busy === "approve" ? "Approving…" : "Approve"}
          </Button>
        )}
        <Button variant="outline" onClick={() => decide("decline")} disabled={!!busy} data-hf-confirm="true" data-hf-what={`Decline: ${what}`} data-hf-amount="Nothing moves" data-hf-to={a.member?.name ?? "this shop"}>
          <X aria-hidden="true" />
          {busy === "decline" ? "Declining…" : "Decline, nothing moves"}
        </Button>
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ Bryntum calendar */
const BRYNTUM = "https://cdn.jsdelivr.net/npm/@bryntum/calendar-trial@7.3.8";
function RenewalCalendar() {
  const el = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    if (!el.current) return;
    let cal: any = null;
    let cancelled = false;
    const io = new IntersectionObserver(async (entries) => {
      if (!entries.some((e) => e.isIntersecting) || state !== "idle") return;
      io.disconnect();
      setState("loading");
      try {
        const dark = document.documentElement.classList.contains("dark");
        for (const [id, href] of [["bryntum-css", `${BRYNTUM}/calendar.css`], ["bryntum-theme", `${BRYNTUM}/${dark ? "svalbard-dark" : "svalbard-light"}.css`]]) {
          if (!document.getElementById(id)) {
            const l = document.createElement("link");
            l.id = id;
            l.rel = "stylesheet";
            l.href = href;
            document.head.appendChild(l);
          }
        }
        const [{ Calendar }, data] = await Promise.all([import(/* @vite-ignore */ `${BRYNTUM}/calendar.module.js`), api.get<any>("/dashboard/calendar.json")]);
        if (cancelled || !el.current) return;
        cal = new Calendar({
          appendTo: el.current,
          date: new Date(),
          mode: "month",
          readOnly: true,
          sidebar: { collapsed: true },
          resources: data.resources,
          events: data.events.map((e: any) => ({ ...e, name: e.sample ? `${e.name} (sample)` : e.name })),
          modes: { year: null, agenda: { title: "List" } },
          listeners: { eventClick({ eventRecord }: any) { if (eventRecord?.subscriberRef) location.assign(`/manage/${eventRecord.subscriberRef}`); } },
        });
        setState("ready");
      } catch (e) {
        setMsg(String((e as Error)?.message ?? e));
        setState("error");
      }
    }, { rootMargin: "300px" });
    io.observe(el.current);
    return () => {
      cancelled = true;
      io.disconnect();
      cal?.destroy?.();
    };
  }, []);
  return (
    <div>
      {state === "error" && <p className="text-sm text-ink-2">The calendar couldn't load ({msg}). The Members page has the same dates.</p>}
      {state === "loading" && <p className="text-sm text-ink-2" role="status">Loading the calendar…</p>}
      <div ref={el} className="h-[560px] overflow-hidden rounded-lg border border-rule" />
    </div>
  );
}

/* ------------------------------------------------------------------ Today */
/** Shows the owner's key for the read-only owner MCP on request; it is never in the page data. */
function OwnerKey() {
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function show() {
    setBusy(true);
    try {
      setKey((await api.post<{ key: string }>("/ui/owner/key")).key);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't load your key.");
    } finally {
      setBusy(false);
    }
  }
  if (!key)
    return (
      <Button type="button" variant="outline" size="sm" className="mt-1" onClick={show} disabled={busy}>
        {busy ? "Loading…" : "Show owner key"}
      </Button>
    );
  return (
    <span className="mt-1 block">
      <span className="block break-all font-mono text-xs">Authorization: Bearer {key}</span>
      <span className="block text-xs text-ink-2">Read-only: summaries, Ask, members, events, transactions. It cannot move money or change rules. Anyone with this key can read this shop.</span>
    </span>
  );
}

function TodayPage({ d, reload }: { d: Today; reload: () => void }) {
  // The judge page opens the dashboard with a question already typed (?ask=...#ask).
  const [q, setQ] = useState(() => new URLSearchParams(location.search).get("ask") ?? "");
  useEffect(() => {
    if (location.hash === "#ask") setTimeout(() => document.getElementById("q")?.scrollIntoView({ block: "center" }), 120);
  }, []);
  const [answer, setAnswer] = useState<{ text: string; by: string | null; model: string | null; failed: boolean; sentences?: Sentence[]; facts?: Fact[]; ms?: number } | null>(null);
  const [steps, setSteps] = useState<RailStep[]>([]);
  const [asking, setAsking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  useTour(true, "owner");
  const s = d.stats;
  const cur = d.shop.currency;
  const needs = d.approvals.length + d.failed.length + d.openOffers.length;
  const reasons = [...(s.reasons ?? [])].sort((a: any, b: any) => b.count - a.count);
  const reasonTotal = reasons.reduce((a: number, r: any) => a + r.count, 0) || 1;

  async function ask(e?: React.FormEvent) {
    e?.preventDefault();
    if (!q.trim()) return;
    setAsking(true);
    setAnswer(null);
    setSteps([]);
    try {
      let done = false;
      await streamPost("/ui/owner/ask/stream", { question: q }, (ev, data) => {
        if (ev === "step") setSteps((x) => [...x, data]);
        if (ev === "answer") {
          done = true;
          setAnswer({ text: data.answer, by: data.by, model: data.model, failed: false, sentences: data.sentences, facts: data.facts, ms: data.ms });
        }
        if (ev === "failed") {
          done = true;
          setAnswer({ text: data.message, by: null, model: null, failed: true });
        }
      });
      if (!done) setAnswer({ text: "The answer stopped part way. Nothing was changed; try again.", by: null, model: null, failed: true });
    } catch (err) {
      setAnswer({ text: err instanceof ApiError ? err.message : "Couldn't answer that right now. Nothing was changed.", by: null, model: null, failed: true });
    } finally {
      setAsking(false);
    }
  }
  async function reconcile() {
    setSyncing(true);
    try {
      toast.success((await api.post<{ message: string }>("/ui/owner/reconcile")).message);
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't reach PayPal.");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <>
      <WorkspaceBar />
      {d.killed && (
        <div className="mb-5 rounded-lg border-2 border-fail bg-fail-wash p-4 text-fail" role="alert">
          <b>Everything is stopped.</b> A kill switch is on: Kept makes no PayPal changes except cancels. <a className="underline" href="/dashboard/guard">Review it</a>.
        </div>
      )}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="m-0 text-3xl font-bold sm:text-4xl">Today at {d.shop.name}</h1>
          <p className="mt-2 mb-0 text-lg text-ink-2">
            {needs ? <><b className="text-ink">{needs} {needs === 1 ? "thing needs" : "things need"} you.</b> Everything else is handled within your rules.</> : "Nothing needs you. Kept is handling renewals, skips and cancels within your rules."}
          </p>
        </div>
        <Button variant="outline" onClick={reconcile} disabled={syncing}>
          <RefreshCw className={cn(syncing && "animate-spin")} aria-hidden="true" />
          {syncing ? "Checking…" : "Check against PayPal"}
        </Button>
      </div>

      <section data-tour="kpis" aria-label="Key numbers" className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { l: "Live members", v: String(s.live?.active ?? s.active), h: s.sampleRows ? `+${s.active - (s.live?.active ?? 0)} sample · ${s.live?.suspended ?? 0} paused` : `${s.suspended} paused` },
          { l: "Billed monthly", v: fmtMoney(s.live?.mrr ?? s.mrr, cur), h: s.sampleRows ? `${fmtMoney(s.mrr, cur)} incl. sample` : "monthly equivalent" },
          { l: "Kept by fair offers", v: fmtMoney(s.live?.revenueKept3 ?? s.revenueKept3, cur), h: s.sampleRows ? `${s.live?.offersAccepted ?? 0} of ${s.live?.offersMade ?? 0} real offers taken · ${fmtMoney(s.revenueKept3, cur)} incl. sample` : `${s.offersAccepted} of ${s.offersMade} offers taken` },
          { l: "One-step cancels", v: String(s.live?.cancelsHonoured ?? s.cancelsHonoured), h: s.sampleRows ? `+${s.cancelsHonoured - (s.live?.cancelsHonoured ?? 0)} sample · ${s.agentShare}% of changes via AI assistants incl. sample` : `${s.agentShare}% of changes via AI assistants` },
        ].map((k) => (
          <div key={k.l} className="rounded-xl border border-rule bg-card p-4">
            <p className="m-0 text-sm text-ink-2">{k.l}</p>
            <p className="m-0 mt-1 font-display text-2xl font-bold num sm:text-3xl" data-money>{k.v}</p>
            <p className="m-0 mt-1 text-xs text-ink-2 num">{k.h}</p>
          </div>
        ))}
      </section>

      <section data-tour="needs" className="mt-10" aria-labelledby="needs">
        <h2 id="needs" className="m-0 text-2xl font-bold">Needs you</h2>
        <div className="mt-4 space-y-3">
          {d.approvals.slice(0, 3).map((a) => <ApprovalCard key={a.id} a={a} currency={cur} onDone={reload} />)}
          {d.approvals.length > 3 && (
            <Button variant="outline" asChild>
              <Link to="/dashboard/approvals">See all {d.approvals.length} approvals <ArrowRight aria-hidden="true" /></Link>
            </Button>
          )}
          {d.failed.length > 0 && (
            <ul className="m-0 list-none divide-y divide-rule rounded-xl border border-rule bg-card p-0">
              {d.failed.map((f) => (
                <li key={f.ref}>
                  <Link to={`/manage/${f.ref}`} className="flex min-h-14 items-center gap-3 px-4 py-3 text-ink no-underline hover:bg-muted">
                    <AlertTriangle className="size-5 shrink-0 text-fail" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{f.name}</span>
                      {f.sample && <Sample />}
                      <span className="block text-sm text-ink-2">Renewal failed. Their page shows how to fix it; Kept collects once they do.</span>
                    </span>
                    <span className="num shrink-0 font-semibold">{fmtMoney(f.outstanding, cur)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {d.openOffers.length > 0 && (
            <ul className="m-0 list-none divide-y divide-rule rounded-xl border border-rule bg-card p-0">
              {d.openOffers.map((o) => (
                <li key={o.id} className="flex min-h-14 items-center gap-3 px-4 py-3">
                  <Clock className="size-5 shrink-0 text-stamp" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{o.member}</span>
                    {o.sample && <Sample />}
                    <span className="block text-sm text-ink-2">Thinking about: {o.label}. If they don't answer, they're cancelled as they asked.</span>
                  </span>
                  <span className="shrink-0 text-sm text-ink-2">ends {fmtRelative(o.expires_at)}</span>
                </li>
              ))}
            </ul>
          )}
          {!needs && <Empty title="All clear">Held offers, failed renewals and open offers show up here.</Empty>}
        </div>
      </section>

      <section data-tour="ask" className="mt-10 rounded-xl border border-rule bg-card p-5" aria-labelledby="ask">
        <h2 id="ask" className="m-0 flex items-center gap-2 text-xl font-semibold">
          <Sparkles className="size-5 text-stamp" aria-hidden="true" />
          Ask about your shop
        </h2>
        <form onSubmit={ask} className="mt-3 flex flex-col gap-2 sm:flex-row">
          <label htmlFor="q" className="sr-only">Your question</label>
          <Input id="q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Why are people cancelling?" className="h-11 flex-1" maxLength={500} />
          <VoiceButton onText={(t) => setQ(t)} label="Ask by voice" />
          <Button type="submit" disabled={asking || !q.trim()}>{asking ? "Thinking…" : "Ask"}</Button>
        </form>
        <div className="mt-2 flex flex-wrap gap-2">
          {["Why are people cancelling?", "Who has a failed payment?", "How much did offers keep?"].map((x) => (
            <button key={x} type="button" className="min-h-9 rounded-full border border-rule px-3 text-sm text-ink-2 hover:bg-muted" onClick={() => setQ(x)}>
              {x}
            </button>
          ))}
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_minmax(280px,360px)]">
          <div aria-live="polite">
            {!answer && !asking && <p className="m-0 text-sm text-ink-2">The model reads your shop through read-only tools (and PayPal's own MCP server for a real member) and cites a fact for every sentence. It can read; it can't act.</p>}
            {asking && !answer && <p className="m-0 text-sm text-ink-2">Working… each step shows in the AI work panel.</p>}
            {answer && !answer.failed && (
              <div className="rounded-lg bg-stamp-wash p-4">
                <WhoChip who="AI" />
                <div className="mt-2">{answer.sentences?.length ? <CitedAnswer sentences={answer.sentences} facts={answer.facts ?? []} /> : <p className="m-0">{answer.text}</p>}</div>
                <p className="mt-2 mb-0 text-xs text-ink-2">
                  Answered by {answer.model ?? "the model"}{answer.ms ? ` in ${(answer.ms / 1000).toFixed(1)} s` : ""}, using the tools listed alongside. Every number comes from a tool; code checked each citation. The AI can read; it can't act.
                </p>
              </div>
            )}
            {answer && answer.failed && (
              <div role="alert" className="rounded-lg border border-rule bg-card p-4">
                <p className="m-0 font-semibold">No answer this time</p>
                <p className="mt-1 mb-0">{answer.text}</p>
                <Button type="button" variant="outline" className="mt-3" onClick={() => ask()} disabled={asking}>
                  {asking ? "Trying…" : "Try again"}
                </Button>
              </div>
            )}
          </div>
          <WorkRail steps={steps} running={asking} />
        </div>
      </section>

      <section data-tour="calendar" className="mt-10" aria-labelledby="cal">
        <h2 id="cal" className="m-0 text-2xl font-bold">Renewal calendar</h2>
        <p className="mt-1 mb-4 text-ink-2">Renewals, pauses with their resume dates, discount ends and payment follow-ups. Click one to open the member.</p>
        <RenewalCalendar />
      </section>

      <div className="mt-10 grid gap-5 lg:grid-cols-2">
        <section className="rounded-xl border border-rule bg-card p-5" aria-labelledby="why">
          <h2 id="why" className="m-0 text-xl font-semibold">Why people leave</h2>
          <p className="mt-1 text-sm text-ink-2 num">{s.reasonsTotal} reasons given, labelled by the AI.</p>
          {reasons.length ? (
            <ul className="mt-3 list-none space-y-2.5 p-0">
              {reasons.map((r: any) => (
                <li key={r.category} className="grid grid-cols-[9rem_1fr_2rem] items-center gap-3 text-sm" title={r.examples?.[0] ? `“${r.examples[0]}”` : undefined}>
                  <span>{REASON[r.category] ?? r.category}</span>
                  <span className="h-2.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <span className="block h-full rounded-full bg-ink" style={{ width: `${Math.round((100 * r.count) / reasonTotal)}%` }} />
                  </span>
                  <span className="num text-right">{r.count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No reasons yet" />
          )}
        </section>
        <section className="rounded-xl border border-rule bg-card p-5" aria-labelledby="offers">
          <h2 id="offers" className="m-0 text-xl font-semibold">Recent offers</h2>
          {d.offers.length ? (
            <ul className="mt-3 list-none divide-y divide-rule p-0">
              {d.offers.slice(0, 8).map((o) => (
                <li key={o.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="min-w-0">
                    <Link className="inline-flex min-h-6 items-center font-medium text-ink" to={`/manage/${o.ref}`}>{o.member}</Link>
                    {o.sample && <Sample />}
                    <span className="block truncate text-ink-2">{o.label}</span>
                  </span>
                  <span className={cn("shrink-0 rounded-full border px-2 py-0.5 text-xs", o.status === "accepted" ? "border-paid/40 text-paid" : o.status === "open" ? "border-stamp/40 text-stamp" : "border-rule text-ink-2")}>{o.status}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No offers yet" />
          )}
        </section>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <section className="rounded-xl border border-rule bg-card p-5" aria-labelledby="rules">
          <h2 id="rules" className="m-0 text-xl font-semibold">Your rules {d.rules && <span className="font-normal text-ink-2">v{d.rules.version}</span>}</h2>
          {d.rules ? (
            <ul className="mt-3 list-none space-y-1.5 p-0 text-sm">
              {d.rules.lines.map((l) => (
                <li key={l} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-paid" aria-hidden="true" />{l}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-2">No rules yet: cancels go through with no offer.</p>
          )}
          <Button variant="outline" className="mt-4" asChild><a href="/onboard/rules">Edit rules</a></Button>
        </section>
        <section className="rounded-xl border border-rule bg-card p-5" aria-labelledby="conn">
          <h2 id="conn" className="m-0 text-xl font-semibold">Connections</h2>
          <dl className="mt-3 grid gap-2 text-sm">
            <div>
              <dt className="text-ink-2">Cancel widget for your own site</dt>
              <dd className="m-0"><code className="block truncate font-mono text-xs">{d.connections.widget}</code>
                <Button size="sm" variant="outline" className="mt-1" onClick={() => navigator.clipboard?.writeText(d.connections.widget).then(() => toast.success("Widget code copied"), () => toast.error("Couldn't copy"))}>Copy the script tag</Button>
                <span className="ml-2 text-xs text-ink-2">One button that opens the member's page: skip, pause, switch or cancel in one step.</span></dd>
            </div>
            <div><dt className="text-ink-2">AI assistants (MCP)</dt><dd className="m-0 truncate font-mono">{d.connections.buyerMcp}</dd></div>
            <div>
              <dt className="text-ink-2">Your own agent (read-only owner MCP)</dt>
              <dd className="m-0"><span className="block truncate font-mono">{d.connections.ownerMcp}</span><OwnerKey /></dd>
            </div>
            <div><dt className="text-ink-2">PayPal webhooks</dt><dd className="m-0">{d.connections.webhookOk ? "Registered; every event is signature-verified before Kept acts." : "Not registered yet; Kept still reconciles by reading PayPal."}</dd></div>
            <div><dt className="text-ink-2">AI model</dt><dd className="m-0">{d.connections.ai}</dd></div>
            <div><dt className="text-ink-2">PayPal</dt><dd className="m-0">{d.shop.paypal_env} · product <span className="font-mono">{d.shop.product ?? "not created yet"}</span></dd></div>
          </dl>
        </section>
      </div>

      <details className="mt-5 rounded-xl border border-rule bg-card p-5">
        <summary className="flex min-h-11 cursor-pointer items-center font-semibold">Activity: every request, offer, PayPal call and webhook</summary>
        <ol className="mt-3 list-none divide-y divide-rule p-0 text-sm">
          {d.events.map((e) => (
            <li key={e.id} className="grid grid-cols-[6.5rem_5.5rem_1fr] gap-2 py-2">
              <time className="text-ink-2 num" dateTime={e.created_at}>{fmtDate(e.created_at, { time: true })}</time>
              <span><WhoChip who={e.source === "executor" || e.source === "webhook" ? "PayPal" : e.source === "agent" ? "Agent" : e.source === "guard" || e.source === "scheduler" ? "Rule" : "Person"} /></span>
              <span className="min-w-0">{e.summary}{e.is_sample && <Sample />}</span>
            </li>
          ))}
        </ol>
      </details>
    </>
  );
}

function ApprovalsPage({ d, reload }: { d: Today; reload: () => void }) {
  useTour(true, null);
  return (
    <>
      <h1 className="m-0 text-3xl font-bold sm:text-4xl">Approvals</h1>
      <p className="mt-2 max-w-[62ch] text-lg text-ink-2">Money moves above the limits you set wait here. Each one says what will move, to whom, why it waited, and how to undo it.</p>
      <TrustStrip className="mt-6" />
      <section data-tour="approvals" className="mt-8 space-y-3" aria-label="Waiting for you">
        {d.approvals.length ? d.approvals.map((a) => <ApprovalCard key={a.id} a={a} currency={d.shop.currency} onDone={reload} />) : <Empty title="Nothing is waiting">When an offer or a collection is above your limits, it waits here instead of happening.</Empty>}
      </section>
      <section data-tour="autonomy" className="mt-8 rounded-xl border border-rule bg-card p-5" aria-labelledby="limits">
        <h2 id="limits" className="m-0 text-xl font-semibold">What Kept may do on its own</h2>
        <ul className="mt-3 list-none space-y-1.5 p-0 num">
          <li>Discounts up to <b>{d.autonomy.auto_discount_max_pct}%</b></li>
          <li>Pauses up to <b>{d.autonomy.auto_pause_max_cycles} cycles</b></li>
          <li>Collections up to <b>{fmtMoney(d.autonomy.approve_capture_above_cents / 100, d.shop.currency)}</b></li>
          <li>Cancels: <b>always</b>, in one step. No limit can hold a cancel.</li>
        </ul>
        <Button variant="outline" className="mt-4" asChild><a href="/dashboard/guard">Change limits, see the 90-day backtest</a></Button>
      </section>
    </>
  );
}

export default function Owner() {
  const { data, error, loading, reload } = useData<Today>("/ui/owner/today");
  return (
    <OwnerShell shopName={data?.shop.name} shopSlug={data?.shop.slug}>
      {loading && !data ? (
        <PageSkeleton label="Loading your shop" />
      ) : error && !data ? (
        <>
          <h1 className="sr-only">Owner</h1>
          <ErrorState error={error} onRetry={reload} />
        </>
      ) : data ? (
        <Suspense fallback={<PageSkeleton />}>
          <Routes>
            <Route index element={<TodayPage d={data} reload={reload} />} />
            <Route path="members" element={<Members d={data} reload={reload} />} />
            <Route path="approvals" element={<ApprovalsPage d={data} reload={reload} />} />
          </Routes>
        </Suspense>
      ) : null}
    </OwnerShell>
  );
}

export { useTour };
