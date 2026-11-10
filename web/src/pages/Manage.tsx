import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { AlertTriangle, Bot, CalendarClock, CheckCircle2, ExternalLink, MessageCircle, Pause, Play, Repeat, ShieldCheck, SkipForward } from "lucide-react";
import { toast } from "sonner";
import { PublicFooter, PublicHeader } from "@/components/Shell";
import { CycleCard, StampLegend } from "@/components/CycleCard";
import { Timeline } from "@/components/Timeline";
import { SmsOptIn } from "@/components/SmsOptIn";
import { ErrorState, PageSkeleton } from "@/components/States";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError, newKey } from "@/lib/api";
import { fmtDate, fmtMoney, fmtRelative } from "@/lib/format";
import { useData } from "@/lib/useData";
import type { CycleCardData, PlanJson, TimelineRun } from "@/lib/types";
import { cn } from "@/lib/utils";
import { resumeTour, startTour } from "@/tours";

interface ManageData {
  view: {
    subscription_ref: string;
    status: string;
    plan: { plan_id: string; name: string; price: string; currency: string; billing: string; is_discount: boolean } | null;
    returns_to_plan?: string;
    discount_until?: string;
    next_billing_time: string | null;
    resumes_at: string | null;
    outstanding_balance: string;
    approval_url?: string;
    notice: string | null;
    available_actions: string[];
    is_sample?: boolean;
  };
  member: { name: string | null; first: string | null; channel: string; agent_id: string | null; sample: boolean; started_at: string | null; cancel_requested_at: string | null; kept_state: string | null };
  shop: { name: string; slug: string; currency: string };
  switchTo: PlanJson[];
  pauseMax: number;
  promise: string[];
  offer: { id: string; message: string; label: string | null; type: string; expires_at: string } | null;
  telegram: { linked: boolean; ready: boolean };
  sms: { ready: boolean; linked: string[] };
  card: CycleCardData;
  timeline: TimelineRun[];
  mcp: string;
}

const STATUS: Record<string, { word: string; cls: string }> = {
  ACTIVE: { word: "Active", cls: "bg-paid-wash text-paid border-paid/30" },
  SUSPENDED: { word: "Paused", cls: "bg-pause-wash text-pause border-pause/30" },
  CANCELLED: { word: "Ended", cls: "bg-muted text-ink border-rule" },
  APPROVAL_PENDING: { word: "Waiting for PayPal approval", cls: "bg-stamp-wash text-stamp border-stamp/30" },
};

export default function Manage() {
  const { ref = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { data, error, loading, reload } = useData<ManageData>(`/ui/manage/${ref}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [approval, setApproval] = useState<string | null>(null);
  const [cycles, setCycles] = useState("1");
  const [planTo, setPlanTo] = useState("");
  const [reason, setReason] = useState("");
  const [hear, setHear] = useState(false);
  const [promise, setPromise] = useState("");

  // Messages passed back from PayPal's return page (/r/:ref) or the old server forms.
  useEffect(() => {
    const ok = params.get("ok");
    const err = params.get("err");
    if (ok) toast.success(ok);
    if (err) toast.error(err);
    if (ok || err) setParams({}, { replace: true });
  }, []);
  useEffect(() => {
    if (!data) return;
    const t = setTimeout(() => {
      if (!resumeTour(location.pathname)) startTour("member");
    }, 400);
    return () => clearTimeout(t);
  }, [Boolean(data)]);
  useEffect(() => {
    if (data?.switchTo[0] && !planTo) setPlanTo(data.switchTo[0].id);
  }, [data]);

  async function act(name: string, url: string, body: Record<string, unknown> = {}) {
    setBusy(name);
    setStatus("Working… Kept is asking PayPal and will confirm when PayPal reads it back.");
    try {
      const out = await api.post<{ message: string; approvalUrl?: string | null }>(url, { ...body, key: newKey() });
      setStatus(out.message);
      if (out.approvalUrl) {
        setApproval(out.approvalUrl);
        toast.message(out.message, { action: { label: "Approve on PayPal", onClick: () => location.assign(out.approvalUrl!) } });
      } else toast.success(out.message);
      await reload();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "That didn't work. Nothing was changed.";
      setStatus(msg);
      toast.error(msg);
    } finally {
      setBusy(null);
    }
  }

  if (loading && !data)
    return (
      <>
        <PublicHeader />
        <main id="main" className="mx-auto max-w-5xl px-4 py-10">
          <PageSkeleton label="Loading your subscription" />
        </main>
      </>
    );
  if (error || !data)
    return (
      <>
        <PublicHeader />
        <main id="main" className="mx-auto max-w-3xl px-4 py-10">
          <h1 className="sr-only">Your subscription</h1>
          <ErrorState error={error} onRetry={reload} />
        </main>
      </>
    );

  const v = data.view;
  const can = (a: string) => v.available_actions.includes(a);
  const cur = data.shop.currency;
  const st = STATUS[v.status] ?? { word: v.status.toLowerCase(), cls: "bg-muted text-ink border-rule" };
  const pending = Boolean(data.member.cancel_requested_at) && v.status !== "CANCELLED";
  const approveUrl = approval ?? v.approval_url ?? null;

  return (
    <>
      <PublicHeader />
      <main id="main" className="mx-auto max-w-5xl px-4 py-8 sm:py-10">
        <p className="m-0 text-sm font-medium text-ink-2">{data.shop.name}</p>
        <h1 className="mt-1 text-3xl font-bold sm:text-4xl">{data.member.first ? `Hi ${data.member.first}, here's your subscription` : "Your subscription"}</h1>
        <p className="mt-2 max-w-[62ch] text-ink-2">Skip, pause, switch or cancel here, any time. Every change is made in PayPal and checked before we confirm it.</p>

        <p className="sr-only" role="status" aria-live="polite">{status}</p>

        {data.member.sample && (
          <div className="mt-5 rounded-lg border border-dashed border-pause bg-pause-wash p-4 text-sm" role="note">
            <b>Sample member.</b> This labelled demo row has no PayPal subscription behind it, so the buttons are view-only. Subscribe on the <a className="underline" href={`/s/${data.shop.slug}`}>shop page</a> to try a live one.
          </div>
        )}
        {pending && (
          <div className="mt-5 rounded-lg border border-pause/40 bg-pause-wash p-4" role="status">
            <p className="m-0 font-semibold">Cancellation requested</p>
            <p className="m-0 mt-1 text-sm">You asked to cancel {fmtDate(data.member.cancel_requested_at, { time: true })}. PayPal hasn't confirmed it yet; Kept keeps retrying and will show it here. You won't be charged for a renewal you asked to stop.</p>
          </div>
        )}
        {approveUrl && (
          <div className="mt-5 flex flex-wrap items-center gap-3 rounded-lg border border-stamp/40 bg-stamp-wash p-4" role="status">
            <p className="m-0 min-w-0 flex-1">
              <b>PayPal needs your OK.</b> Approve the change on PayPal's page; nothing changes until you do.
            </p>
            <Button asChild>
              <a href={approveUrl}>
                Approve on PayPal
                <ExternalLink aria-hidden="true" />
              </a>
            </Button>
          </div>
        )}

        {v.notice && (
          <section className="mt-5 rounded-xl border-2 border-fail/50 bg-fail-wash p-5" role="alert" aria-labelledby="failed">
            <h2 id="failed" className="m-0 flex items-center gap-2 text-xl font-semibold text-fail">
              <AlertTriangle className="size-5" aria-hidden="true" />
              Your last payment didn't go through
            </h2>
            <p className="mt-2 mb-0">{v.notice}</p>
            <p className="mt-1 mb-0 text-sm">Outstanding: <b className="num">{fmtMoney(v.outstanding_balance, cur)}</b>. We only ever show this here, never by a text or email with a "pay here" link.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={() => act("fixed", `/ui/manage/${ref}/payment-fixed`)} disabled={!!busy}>
                {busy === "fixed" ? "Collecting…" : "I've updated my payment method, retry now"}
              </Button>
            </div>
            <form
              className="mt-4 flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void act("promise", `/ui/manage/${ref}/promise`, { date: promise });
              }}
            >
              <div className="grid gap-1.5">
                <Label htmlFor="promise">Can't fix it today? I'll sort it by</Label>
                <Input id="promise" type="date" required value={promise} onChange={(e) => setPromise(e.target.value)} className="h-11 w-auto" min={new Date().toISOString().slice(0, 10)} max={new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10)} />
              </div>
              <Button variant="outline" type="submit" disabled={!!busy}>Pause reminders until then</Button>
            </form>
          </section>
        )}

        {/* Plan and the cycle card */}
        <section className="mt-6 rounded-2xl border border-rule bg-card p-5 sm:p-7" aria-labelledby="plan" data-tour="card">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="m-0 text-sm text-ink-2">Your plan</p>
              <h2 id="plan" className="m-0 text-2xl font-bold sm:text-3xl">{v.plan?.name ?? "Plan"}</h2>
              {v.plan && (
                <p className="m-0 mt-1 font-display text-2xl font-bold num" data-money>
                  {fmtMoney(v.plan.price, cur)} <span className="font-sans text-base font-normal text-ink-2">{v.plan.billing}</span>
                </p>
              )}
            </div>
            <span className={cn("inline-flex min-h-8 items-center rounded-full border px-3 text-sm font-medium", st.cls)}>{st.word}</span>
          </div>
          <p className="mt-3 mb-0 flex items-start gap-2 text-ink">
            <CalendarClock className="mt-1 size-4 shrink-0 text-ink-2" aria-hidden="true" />
            <span>
            {v.status === "CANCELLED"
              ? "Ended. You won't be charged again."
              : v.status === "SUSPENDED" && v.resumes_at
                ? <>Paused. Starts again <time dateTime={v.resumes_at}>{fmtDate(v.resumes_at, { year: true })}</time> ({fmtRelative(v.resumes_at)}).</>
                : v.next_billing_time
                  ? <>Next payment <time dateTime={v.next_billing_time}>{fmtDate(v.next_billing_time, { year: true })}</time> ({fmtRelative(v.next_billing_time)}).</>
                  : v.status === "APPROVAL_PENDING" ? "Waiting for you to approve on PayPal." : "No payment scheduled."}
            </span>
          </p>
          {v.returns_to_plan && <p className="m-0 mt-1 text-sm text-ink-2">Discount until {fmtDate(v.discount_until, { year: true })}, then back to {v.returns_to_plan}.</p>}
          <div className="mt-6 border-t border-dashed border-rule pt-5">
            <CycleCard card={data.card} currency={cur} size="lg" caption={`One stamp per billing cycle, every ${data.card.every}.`} />
            <StampLegend className="mt-4" />
          </div>
        </section>

        {/* Change it */}
        {(can("skip_next") || can("pause") || can("resume") || can("switch_plan")) && (
          <section className="mt-8" aria-labelledby="change" data-tour="change">
            <h2 id="change" className="text-2xl font-bold">Change it</h2>
            <p className="mt-1 text-ink-2">Within {data.shop.name}'s rules. Nothing here charges you extra.</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {can("skip_next") && (
                <div className="flex flex-col rounded-xl border border-rule bg-card p-5">
                  <SkipForward className="size-5 text-stamp" aria-hidden="true" />
                  <h3 className="mt-3 text-lg font-semibold">Skip the next one</h3>
                  <p className="mt-1 flex-1 text-sm text-ink-2">Away, or still have plenty? Skip one payment; it carries on after.</p>
                  <Button variant="outline" className="mt-4" onClick={() => act("skip", `/ui/manage/${ref}/skip`)} disabled={!!busy}>
                    {busy === "skip" ? "Skipping…" : "Skip next payment"}
                  </Button>
                </div>
              )}
              {can("pause") && data.pauseMax > 0 && (
                <div className="flex flex-col rounded-xl border border-rule bg-card p-5">
                  <Pause className="size-5 text-pause" aria-hidden="true" />
                  <h3 className="mt-3 text-lg font-semibold">Pause for a while</h3>
                  <p className="mt-1 flex-1 text-sm text-ink-2">Nothing ships or bills until it starts again on its own.</p>
                  <div className="mt-4 flex gap-2">
                    <Label htmlFor="cycles" className="sr-only">How long</Label>
                    <select id="cycles" value={cycles} onChange={(e) => setCycles(e.target.value)} className="h-11 min-w-0 flex-1 rounded-md border border-input bg-card px-3">
                      {Array.from({ length: data.pauseMax }, (_, i) => (
                        <option key={i} value={i + 1}>
                          {i + 1} {data.card.every.replace(/s$/, "")}{i ? "s" : ""}
                        </option>
                      ))}
                    </select>
                    <Button variant="outline" onClick={() => act("pause", `/ui/manage/${ref}/pause`, { cycles: Number(cycles) })} disabled={!!busy}>
                      {busy === "pause" ? "Pausing…" : "Pause"}
                    </Button>
                  </div>
                </div>
              )}
              {can("resume") && (
                <div className="flex flex-col rounded-xl border border-rule bg-card p-5">
                  <Play className="size-5 text-paid" aria-hidden="true" />
                  <h3 className="mt-3 text-lg font-semibold">Start again now</h3>
                  <p className="mt-1 flex-1 text-sm text-ink-2">Don't wait for the date; payments start again from today.</p>
                  <Button className="mt-4" onClick={() => act("resume", `/ui/manage/${ref}/resume`)} disabled={!!busy}>
                    {busy === "resume" ? "Resuming…" : "Resume now"}
                  </Button>
                </div>
              )}
              {can("switch_plan") && data.switchTo.length > 0 && (
                <div className="flex flex-col rounded-xl border border-rule bg-card p-5">
                  <Repeat className="size-5 text-stamp" aria-hidden="true" />
                  <h3 className="mt-3 text-lg font-semibold">Switch plan</h3>
                  <p className="mt-1 flex-1 text-sm text-ink-2">More or less, from your next payment. PayPal may ask you to approve a new price.</p>
                  <div className="mt-4 grid gap-2">
                    <Label htmlFor="planTo" className="sr-only">New plan</Label>
                    <select id="planTo" value={planTo} onChange={(e) => setPlanTo(e.target.value)} className="h-11 rounded-md border border-input bg-card px-3">
                      {data.switchTo.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}: {fmtMoney(p.price, p.currency)} {p.billing}
                        </option>
                      ))}
                    </select>
                    <Button variant="outline" onClick={() => act("switch", `/ui/manage/${ref}/switch`, { plan_id: planTo })} disabled={!!busy || !planTo}>
                      {busy === "switch" ? "Switching…" : "Switch plan"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {/* The one offer, if they asked for it */}
        {data.offer && (
          <section className="mt-8 rounded-2xl border-2 border-stamp/50 bg-stamp-wash p-6" aria-labelledby="offer">
            <h2 id="offer" className="m-0 text-2xl font-bold">One offer before you go</h2>
            <p className="mt-2 text-lg">{data.offer.message}</p>
            <p className="m-0 text-sm text-ink-2">
              Open until {fmtDate(data.offer.expires_at, { time: true })}. If you don't answer, your subscription is cancelled as you asked. No timer, no second offer.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Button onClick={() => act("accept", `/ui/offer/${data.offer!.id}/accept`)} disabled={!!busy}>
                {busy === "accept" ? "Applying…" : "Take the offer"}
              </Button>
              <Button variant="outline" onClick={() => act("decline", `/ui/offer/${data.offer!.id}/decline`)} disabled={!!busy}>
                {busy === "decline" ? "Cancelling…" : "No thanks, cancel now"}
              </Button>
            </div>
          </section>
        )}

        {/* Cancel: one step, never hidden, never red */}
        {!data.offer && can("cancel_subscription") && (
          <section className="mt-8 rounded-xl border border-rule bg-card p-6" aria-labelledby="cancel" data-tour="cancel">
            <h2 id="cancel" className="m-0 text-2xl font-bold">Cancel your subscription</h2>
            <p className="mt-1 text-ink-2">One step. No reason needed. You won't be asked twice.</p>
            <form
              className="mt-4 grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void act("cancel", `/ui/manage/${ref}/cancel`, { reason, hear_offer: hear });
              }}
            >
              <div className="grid gap-1.5">
                <Label htmlFor="reason">Anything you'd like {data.shop.name} to know? (optional)</Label>
                <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} placeholder="For example: too much coffee piling up" />
              </div>
              <label className="flex min-h-11 cursor-pointer items-center gap-3">
                <Checkbox checked={hear} onCheckedChange={(c) => setHear(c === true)} className="size-5" aria-labelledby="hear-offer" />
                <span id="hear-offer">Show me one offer before cancelling (optional)</span>
              </label>
              <div>
                <Button type="submit" variant="outline" disabled={!!busy}>
                  {busy === "cancel" ? "Cancelling…" : hear ? "See one offer, or cancel" : "Cancel subscription"}
                </Button>
              </div>
            </form>
          </section>
        )}
        {v.status === "CANCELLED" && (
          <section className="mt-8 rounded-xl border border-rule bg-card p-6">
            <h2 className="m-0 flex items-center gap-2 text-xl font-semibold">
              <CheckCircle2 className="size-5 text-paid" aria-hidden="true" />
              Changed your mind?
            </h2>
            <p className="mt-1 mb-0 text-ink-2">
              You can subscribe again on <a className="text-stamp underline" href={`/s/${data.shop.slug}`}>{data.shop.name}'s page</a> whenever you like.
            </p>
          </section>
        )}

        <div className="mt-8 grid gap-4 md:grid-cols-2">
          <section className="rounded-xl border border-rule bg-card p-6" aria-labelledby="reminders">
            <h2 id="reminders" className="m-0 flex items-center gap-2 text-xl font-semibold">
              <MessageCircle className="size-5 text-stamp" aria-hidden="true" />
              Reminders on your phone
            </h2>
            <p className="mt-1 text-sm text-ink-2">A note before each payment: in Telegram with Skip and Keep buttons, or by text with a link back here. {data.telegram.linked ? "Connected." : ""}</p>
            {!data.member.sample && (
              <form method="post" action={`/manage/${ref}/connect/telegram`} target="_blank">
                <Button type="submit" variant={data.telegram.linked ? "outline" : "default"}>
                  {data.telegram.linked ? "Connect another chat" : "Get reminders on Telegram"}
                </Button>
              </form>
            )}
            {!data.member.sample && <SmsOptIn memberRef={ref!} sms={data.sms ?? { ready: false, linked: [] }} onChange={reload} />}
          </section>
          <section className="rounded-xl border border-rule bg-card p-6" aria-labelledby="scam">
            <h2 id="scam" className="m-0 flex items-center gap-2 text-xl font-semibold">
              <ShieldCheck className="size-5 text-paid" aria-hidden="true" />
              Got a message about this?
            </h2>
            <p className="mt-1 text-sm text-ink-2">{data.shop.name} bills only through PayPal and never sends a "pay here" link or asks for a card number or a code.</p>
            <Button variant="outline" asChild>
              <a href={`/manage/${ref}/check`}>Check a message for scam signs</a>
            </Button>
          </section>
        </div>

        <section className="mt-8" aria-labelledby="history" data-tour="history">
          <h2 id="history" className="text-2xl font-bold">What happened</h2>
          <p className="mt-1 mb-4 text-ink-2">Every change, and who did each step: AI, Rule or PayPal.</p>
          <Timeline runs={data.timeline} empty="No changes yet. Anything you do here will be listed, step by step." />
        </section>

        <details className="mt-8 rounded-xl border border-rule bg-card p-5">
          <summary className="flex min-h-11 cursor-pointer items-center gap-2 font-medium">
            <Bot className="size-5 text-stamp" aria-hidden="true" />
            Let your AI assistant manage this
          </summary>
          <p className="mt-2 text-sm text-ink-2">Give Claude, or any MCP client, this reference and the shop's endpoint. It can skip, pause, switch or cancel for you, with the same rules.</p>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-paper p-3 font-mono text-sm">{`subscription_ref: ${ref}\nendpoint: ${data.mcp}`}</pre>
        </details>
        <Button variant="ghost" className="mt-6" onClick={() => startTour("member", { force: true })}>Take the tour</Button>
      </main>
      <PublicFooter />
    </>
  );
}
