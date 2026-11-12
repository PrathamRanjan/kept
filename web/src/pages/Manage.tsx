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
import { startTour } from "@/tours";
import { AssistantPanel } from "@/components/AssistantPanel";
import { VoiceButton } from "@/components/VoiceButton";
import { NegotiatePanel } from "@/components/NegotiatePanel";
import { everyWords, serverLang, useT } from "@/i18n";

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
  member: { name: string | null; first: string | null; channel: string; agent_id: string | null; sample: boolean; started_at: string | null; cancel_requested_at: string | null; kept_state: string | null; lang?: string | null };
  billing?: string | null;
  interval?: { unit: string; count: number } | null;
  shop: { name: string; slug: string; currency: string };
  switchTo: PlanJson[];
  pauseMax: number;
  promise: string[];
  offer: { id: string; message: string; label: string | null; type: string; expires_at: string; worded_by?: "code" | "model" } | null;
  telegram: { linked: boolean; ready: boolean };
  sms: { ready: boolean; linked: string[]; pending?: string | null };
  card: CycleCardData;
  timeline: TimelineRun[];
  mcp: string;
}

const STATUS: Record<string, { word: "st.ACTIVE" | "st.SUSPENDED" | "st.CANCELLED" | "st.APPROVAL_PENDING"; cls: string }> = {
  ACTIVE: { word: "st.ACTIVE", cls: "bg-paid-wash text-paid border-paid/30" },
  SUSPENDED: { word: "st.SUSPENDED", cls: "bg-pause-wash text-pause border-pause/30" },
  CANCELLED: { word: "st.CANCELLED", cls: "bg-muted text-ink border-rule" },
  APPROVAL_PENDING: { word: "st.APPROVAL_PENDING", cls: "bg-stamp-wash text-stamp border-stamp/30" },
};

export default function Manage() {
  const { ref = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { lang, t } = useT();
  const { data, error, loading, reload } = useData<ManageData>(`/ui/manage/${ref}${serverLang() === "en" ? "" : `?lang=${serverLang()}`}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [approval, setApproval] = useState<string | null>(null);
  const [cycles, setCycles] = useState("1");
  const [planTo, setPlanTo] = useState("");
  const [reason, setReason] = useState("");
  const [hear, setHear] = useState(false);
  const [promise, setPromise] = useState("");
  // The judge page opens this page with the assistant's words already typed (?assistant=...#assistant).
  const [assistantInit] = useState(() => params.get("assistant"));
  const loaded = Boolean(data);
  useEffect(() => {
    if (!loaded || !location.hash) return;
    const t = setTimeout(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" }), 80);
    return () => clearTimeout(t);
  }, [loaded]);

  // Messages passed back from PayPal's return page (/r/:ref) or the old server forms.
  useEffect(() => {
    const ok = params.get("ok");
    const err = params.get("err");
    if (ok) toast.success(ok);
    if (err) toast.error(err);
    if (ok || err) setParams({}, { replace: true });
  }, []);
  useEffect(() => {
    if (data?.switchTo[0] && !planTo) setPlanTo(data.switchTo[0].id);
  }, [data]);

  async function act(name: string, url: string, body: Record<string, unknown> = {}) {
    setBusy(name);
    setStatus(t("m.working"));
    try {
      const out = await api.post<{ message: string; approvalUrl?: string | null }>(url, { ...body, key: newKey() });
      setStatus(out.message);
      if (out.approvalUrl) {
        setApproval(out.approvalUrl);
        toast.message(out.message, { action: { label: t("m.approvePP"), onClick: () => location.assign(out.approvalUrl!) } });
      } else toast.success(out.message);
      await reload();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : t("m.failed");
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
          <PageSkeleton label={t("m.loading")} />
        </main>
      </>
    );
  if (error || !data)
    return (
      <>
        <PublicHeader />
        <main id="main" className="mx-auto max-w-3xl px-4 py-10">
          <h1 className="sr-only">{t("m.yours")}</h1>
          <ErrorState error={error} onRetry={reload} />
        </main>
      </>
    );

  const v = data.view;
  const can = (a: string) => v.available_actions.includes(a);
  const cur = data.shop.currency;
  const st0 = STATUS[v.status];
  const st = st0 ? { word: t(st0.word), cls: st0.cls } : { word: v.status.toLowerCase(), cls: "bg-muted text-ink border-rule" };
  // The card caption and pause picker use the plan's own interval, in the member's language.
  const every = data.interval ? everyWords(t, data.interval.unit, data.interval.count) : data.card.every;
  const unitWord = (n: number) => (data.interval ? everyWords(t, data.interval.unit, n * data.interval.count) : `${n} ${data.card.every.replace(/s$/, "")}${n > 1 ? "s" : ""}`);
  const pending = Boolean(data.member.cancel_requested_at) && v.status !== "CANCELLED";
  const approveUrl = approval ?? v.approval_url ?? null;

  return (
    <>
      <PublicHeader translated />
      <main id="main" className="mx-auto max-w-5xl px-4 py-8 sm:py-10">
        <p className="m-0 text-sm font-medium text-ink-2">{data.shop.name}</p>
        <h1 className="mt-1 text-3xl font-bold sm:text-4xl">{data.member.first ? t("m.hi", { name: data.member.first }) : t("m.yours")}</h1>
        <p className="mt-2 max-w-[62ch] text-ink-2">{t("m.intro")}</p>

        <p className="sr-only" role="status" aria-live="polite">{status}</p>

        {data.member.sample && (
          <div className="mt-5 rounded-lg border border-dashed border-pause bg-pause-wash p-4 text-sm" role="note">
            <b>{t("m.sample1")}</b> {t("m.sample2")} <a className="underline" href={`/s/${data.shop.slug}`}>{t("m.sample3")}</a> {t("m.sample4")}
          </div>
        )}
        {pending && (
          <div className="mt-5 rounded-lg border border-pause/40 bg-pause-wash p-4" role="status">
            <p className="m-0 font-semibold">{t("m.cancelReq")}</p>
            <p className="m-0 mt-1 text-sm">{t("m.cancelReqBody", { when: fmtDate(data.member.cancel_requested_at, { time: true }) })}</p>
          </div>
        )}
        {approveUrl && (
          <div className="mt-5 flex flex-wrap items-center gap-3 rounded-lg border border-stamp/40 bg-stamp-wash p-4" role="status">
            <p className="m-0 min-w-0 flex-1">
              <b>{t("m.needOk")}</b> {t("m.needOkBody")}
            </p>
            <Button asChild>
              <a href={approveUrl} data-paypal-handoff>
                {t("m.approvePP")}
                <ExternalLink aria-hidden="true" />
              </a>
            </Button>
          </div>
        )}

        {v.notice && (
          <section className="mt-5 rounded-xl border-2 border-fail/50 bg-fail-wash p-5" role="alert" aria-labelledby="failed">
            <h2 id="failed" className="m-0 flex items-center gap-2 text-xl font-semibold text-fail">
              <AlertTriangle className="size-5" aria-hidden="true" />
              {t("m.payFailed")}
            </h2>
            <p className="mt-2 mb-0">{v.notice}</p>
            <p className="mt-1 mb-0 text-sm">{t("m.outstanding")} <b className="num">{fmtMoney(v.outstanding_balance, cur)}</b>. {t("m.onlyHere")}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button onClick={() => act("fixed", `/ui/manage/${ref}/payment-fixed`)} disabled={!!busy}>
                {busy === "fixed" ? t("m.collecting") : t("m.fixedRetry")}
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
                <Label htmlFor="promise">{t("m.promiseLabel")}</Label>
                <Input id="promise" type="date" required value={promise} onChange={(e) => setPromise(e.target.value)} className="h-11 w-auto" min={new Date().toISOString().slice(0, 10)} max={new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10)} />
              </div>
              <Button variant="outline" type="submit" disabled={!!busy}>{t("m.promiseBtn")}</Button>
            </form>
          </section>
        )}

        {/* Plan and the cycle card */}
        <section className="mt-6 rounded-2xl border border-rule bg-card p-5 sm:p-7" aria-labelledby="plan" data-tour="card">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="m-0 text-sm text-ink-2">{t("m.yourPlan")}</p>
              <h2 id="plan" className="m-0 text-2xl font-bold sm:text-3xl">{v.plan?.name ?? t("m.plan")}</h2>
              {v.plan && (
                <p className="m-0 mt-1 font-display text-2xl font-bold num" data-money>
                  {fmtMoney(v.plan.price, cur)} <span className="font-sans text-base font-normal text-ink-2">{data.billing ?? v.plan.billing}</span>
                </p>
              )}
            </div>
            <span className={cn("inline-flex min-h-8 items-center rounded-full border px-3 text-sm font-medium", st.cls)}>{st.word}</span>
          </div>
          <p className="mt-3 mb-0 flex items-start gap-2 text-ink">
            <CalendarClock className="mt-1 size-4 shrink-0 text-ink-2" aria-hidden="true" />
            <span>
            {v.status === "CANCELLED"
              ? t("m.ended")
              : v.status === "SUSPENDED" && v.resumes_at
                ? t("m.pausedUntil", { date: fmtDate(v.resumes_at, { year: true }), rel: fmtRelative(v.resumes_at) })
                : v.next_billing_time
                  ? t("m.next", { date: fmtDate(v.next_billing_time, { year: true }), rel: fmtRelative(v.next_billing_time) })
                  : v.status === "APPROVAL_PENDING" ? t("m.waitApprove") : t("m.noPayment")}
            </span>
          </p>
          {v.returns_to_plan && <p className="m-0 mt-1 text-sm text-ink-2">{t("m.discountUntil", { date: fmtDate(v.discount_until, { year: true }), plan: v.returns_to_plan })}</p>}
          <div className="mt-6 border-t border-dashed border-rule pt-5">
            <CycleCard card={data.card} currency={cur} size="lg" caption={t("m.caption", { every })} />
            <StampLegend className="mt-4" />
          </div>
        </section>

        {/* Change it */}
        {(can("skip_next") || can("pause") || can("resume") || can("switch_plan")) && (
          <section className="mt-8" aria-labelledby="change" data-tour="change">
            <h2 id="change" className="text-2xl font-bold">{t("m.change")}</h2>
            <p className="mt-1 text-ink-2">{t("m.changeBody", { shop: data.shop.name })}</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {can("skip_next") && (
                <div className="flex flex-col rounded-xl border border-rule bg-card p-5">
                  <SkipForward className="size-5 text-stamp" aria-hidden="true" />
                  <h3 className="mt-3 text-lg font-semibold">{t("m.skipT")}</h3>
                  <p className="mt-1 flex-1 text-sm text-ink-2">{t("m.skipB")}</p>
                  <Button variant="outline" className="mt-4" onClick={() => act("skip", `/ui/manage/${ref}/skip`)} disabled={!!busy}>
                    {busy === "skip" ? t("m.skipping") : t("m.skipBtn")}
                  </Button>
                </div>
              )}
              {can("pause") && data.pauseMax > 0 && (
                <div className="flex flex-col rounded-xl border border-rule bg-card p-5">
                  <Pause className="size-5 text-pause" aria-hidden="true" />
                  <h3 className="mt-3 text-lg font-semibold">{t("m.pauseT")}</h3>
                  <p className="mt-1 flex-1 text-sm text-ink-2">{t("m.pauseB")}</p>
                  <div className="mt-4 flex gap-2">
                    <Label htmlFor="cycles" className="sr-only">{t("m.howLong")}</Label>
                    <select id="cycles" value={cycles} onChange={(e) => setCycles(e.target.value)} className="h-11 min-w-0 flex-1 rounded-md border border-input bg-card px-3">
                      {Array.from({ length: data.pauseMax }, (_, i) => (
                        <option key={i} value={i + 1}>
                          {lang === "en" ? <>{i + 1} {data.card.every.replace(/s$/, "")}{i ? "s" : ""}</> : unitWord(i + 1)}
                        </option>
                      ))}
                    </select>
                    <Button variant="outline" onClick={() => act("pause", `/ui/manage/${ref}/pause`, { cycles: Number(cycles) })} disabled={!!busy}>
                      {busy === "pause" ? t("m.pausing") : t("m.pauseBtn")}
                    </Button>
                  </div>
                </div>
              )}
              {can("resume") && (
                <div className="flex flex-col rounded-xl border border-rule bg-card p-5">
                  <Play className="size-5 text-paid" aria-hidden="true" />
                  <h3 className="mt-3 text-lg font-semibold">{t("m.resumeT")}</h3>
                  <p className="mt-1 flex-1 text-sm text-ink-2">{t("m.resumeB")}</p>
                  <Button className="mt-4" onClick={() => act("resume", `/ui/manage/${ref}/resume`)} disabled={!!busy}>
                    {busy === "resume" ? t("m.resuming") : t("m.resumeBtn")}
                  </Button>
                </div>
              )}
              {can("switch_plan") && data.switchTo.length > 0 && (
                <div className="flex flex-col rounded-xl border border-rule bg-card p-5">
                  <Repeat className="size-5 text-stamp" aria-hidden="true" />
                  <h3 className="mt-3 text-lg font-semibold">{t("m.switchT")}</h3>
                  <p className="mt-1 flex-1 text-sm text-ink-2">{t("m.switchB")}</p>
                  <div className="mt-4 grid gap-2">
                    <Label htmlFor="planTo" className="sr-only">{t("m.newPlan")}</Label>
                    <select id="planTo" value={planTo} onChange={(e) => setPlanTo(e.target.value)} className="h-11 rounded-md border border-input bg-card px-3">
                      {data.switchTo.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}: {fmtMoney(p.price, p.currency)} {p.billing}
                        </option>
                      ))}
                    </select>
                    <Button variant="outline" onClick={() => act("switch", `/ui/manage/${ref}/switch`, { plan_id: planTo })} disabled={!!busy || !planTo}>
                      {busy === "switch" ? t("m.switching") : t("m.switchBtn")}
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
            <h2 id="offer" className="m-0 text-2xl font-bold">{t("m.offerT")}</h2>
            <p className="mt-2 text-lg">{data.offer.message}</p>
            {data.offer.worded_by === "code" && <p className="m-0 text-xs text-ink-2">{t("m.offerCode")}</p>}
            <p className="m-0 text-sm text-ink-2">
              {t("m.offerOpen", { when: fmtDate(data.offer.expires_at, { time: true }) })}
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Button onClick={() => act("accept", `/ui/offer/${data.offer!.id}/accept`)} disabled={!!busy} data-hf-confirm="true" data-hf-what={`${t("m.take")}: ${data.offer.label ?? ""}`} data-hf-amount={(data.offer as any).terms?.newPrice ? `${fmtMoney((data.offer as any).terms.newPrice, cur)} ${data.billing ?? ""}` : "—"} data-hf-to={data.shop.name}>
                {busy === "accept" ? t("m.applying") : t("m.take")}
              </Button>
              <Button variant="outline" onClick={() => act("decline", `/ui/offer/${data.offer!.id}/decline`)} disabled={!!busy} data-hf-confirm="true" data-hf-what={t("m.noThanks")} data-hf-amount={v.plan ? `${fmtMoney(v.plan.price, cur)} ${data.billing ?? v.plan.billing}` : "—"} data-hf-to={data.shop.name}>
                {busy === "decline" ? t("m.cancelling") : t("m.noThanks")}
              </Button>
            </div>
          </section>
        )}

        {/* Cancel: one step, never hidden, never red */}
        {!data.offer && can("cancel_subscription") && (
          <section className="mt-8 rounded-xl border border-rule bg-card p-6" aria-labelledby="cancel" data-tour="cancel">
            <h2 id="cancel" className="m-0 text-2xl font-bold">{t("m.cancelT")}</h2>
            <p className="mt-1 text-ink-2">{t("m.cancelB")}</p>
            <form
              className="mt-4 grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                void act("cancel", `/ui/manage/${ref}/cancel`, { reason, hear_offer: hear });
              }}
            >
              <div className="grid gap-1.5">
                <Label htmlFor="reason">{t("m.reason", { shop: data.shop.name })}</Label>
                <div className="flex items-start gap-2">
                  <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} placeholder={t("m.reasonPh")} className="flex-1" />
                  {!data.member.sample && <VoiceButton onText={(x) => setReason(x)} memberRef={ref} />}
                </div>
              </div>
              <label className="flex min-h-11 cursor-pointer items-center gap-3">
                <Checkbox checked={hear} onCheckedChange={(c) => setHear(c === true)} className="size-5" aria-labelledby="hear-offer" />
                <span id="hear-offer">{t("m.hear")}</span>
              </label>
              <div>
                <Button type="submit" variant="outline" disabled={!!busy} data-hf-confirm="true" data-hf-what={hear ? t("m.seeOffer") : t("m.cancelBtn")} data-hf-amount={v.plan ? `${fmtMoney(v.plan.price, cur)} ${data.billing ?? v.plan.billing}` : "—"} data-hf-to={data.shop.name}>
                  {busy === "cancel" ? t("m.cancelling") : hear ? t("m.seeOffer") : t("m.cancelBtn")}
                </Button>
              </div>
            </form>
          </section>
        )}
        {/* Outside the cancel card, so the transcript stays on screen when the agreed offer card appears above. */}
        {v.status !== "CANCELLED" && (can("cancel_subscription") || data.offer) && (
          <section className="mt-4 rounded-xl border border-rule bg-card px-6 pb-6" aria-label={t("n.title")}>
            <NegotiatePanel memberRef={ref!} shop={data.shop.name} sample={data.member.sample} onChanged={reload} />
          </section>
        )}
        {v.status === "CANCELLED" && (
          <section className="mt-8 rounded-xl border border-rule bg-card p-6">
            <h2 className="m-0 flex items-center gap-2 text-xl font-semibold">
              <CheckCircle2 className="size-5 text-paid" aria-hidden="true" />
              {t("m.mind")}
            </h2>
            <p className="mt-1 mb-0 text-ink-2">
              {t("m.again1")} <a className="text-stamp underline" href={`/s/${data.shop.slug}`}>{t("m.again2", { shop: data.shop.name })}</a> {t("m.again3")}
            </p>
          </section>
        )}

        <div className="mt-8 grid gap-4 md:grid-cols-2">
          <section id="telegram" data-tour="telegram" className="scroll-mt-20 rounded-xl border border-rule bg-card p-6" aria-labelledby="reminders">
            <h2 id="reminders" className="m-0 flex items-center gap-2 text-xl font-semibold">
              <MessageCircle className="size-5 text-stamp" aria-hidden="true" />
              {t("m.remind")}
            </h2>
            <p className="mt-1 text-sm text-ink-2">
              {data.telegram.ready ? t("m.remindTg") : t("m.remindSms")} {data.telegram.ready && data.telegram.linked ? t("m.tgOn") : ""}
            </p>
            {!data.member.sample && data.telegram.ready && <TelegramConnect memberRef={ref!} linked={data.telegram.linked} />}
            {!data.member.sample && <SmsOptIn memberRef={ref!} sms={data.sms ?? { ready: false, linked: [] }} onChange={reload} />}
          </section>
          <section className="rounded-xl border border-rule bg-card p-6" aria-labelledby="scam">
            <h2 id="scam" className="m-0 flex items-center gap-2 text-xl font-semibold">
              <ShieldCheck className="size-5 text-paid" aria-hidden="true" />
              {t("m.scamT")}
            </h2>
            <p className="mt-1 text-sm text-ink-2">{t("m.scamB", { shop: data.shop.name })}</p>
            <Button variant="outline" asChild className="h-auto min-h-9 max-w-full whitespace-normal py-2 text-left">
              <a href={`/manage/${ref}/check${lang === "en" || lang === "qps" ? "" : `?lang=${lang}`}`}>{t("m.scamBtn")}</a>
            </Button>
          </section>
        </div>

        <AssistantPanel memberRef={ref!} sample={data.member.sample} initial={assistantInit} onChanged={reload} />

        <section className="mt-8" aria-labelledby="history" data-tour="history">
          <h2 id="history" className="text-2xl font-bold">{t("m.history")}</h2>
          <p className="mt-1 mb-4 text-ink-2">{t("m.historyB")}{lang !== "en" && lang !== "qps" ? ` ${t("m.historyEn")}` : ""}</p>
          <Timeline runs={data.timeline} empty={t("m.historyEmpty")} />
        </section>

        <details className="mt-8 rounded-xl border border-rule bg-card p-5">
          <summary className="flex min-h-11 cursor-pointer items-center gap-2 font-medium">
            <Bot className="size-5 text-stamp" aria-hidden="true" />
            {t("m.letAi")}
          </summary>
          <p className="mt-2 text-sm text-ink-2">{t("m.letAiB")}</p>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-paper p-3 font-mono text-sm">{`subscription_ref: ${ref}\nendpoint: ${data.mcp}`}</pre>
        </details>
        <Button variant="ghost" className="mt-6" onClick={() => startTour("member", { force: true })}>{t("m.tour")}</Button>
      </main>
      <PublicFooter />
    </>
  );
}

/** Connect Telegram: one tap on a phone, or a QR code to scan from a desktop. The link works once, for 15 minutes. */
function TelegramConnect({ memberRef, linked }: { memberRef: string; linked: boolean }) {
  const { t } = useT();
  const [link, setLink] = useState<{ url: string; qr: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function open() {
    setBusy(true);
    try {
      setLink(await api.post<{ url: string; qr: string }>(`/ui/manage/${memberRef}/telegram`));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("m.tgFail"));
    } finally {
      setBusy(false);
    }
  }
  if (!link)
    return (
      <Button onClick={open} disabled={busy} variant={linked ? "outline" : "default"}>
        {linked ? t("m.tgAnother") : t("m.tgGet")}
      </Button>
    );
  return (
    <div className="mt-2 flex flex-wrap items-start gap-4">
      <div className="w-[132px] shrink-0 rounded-lg bg-white p-1" role="img" aria-label={t("m.tgQr")} dangerouslySetInnerHTML={{ __html: link.qr }} />
      <div className="min-w-[12rem] flex-1">
        <Button asChild>
          <a href={link.url} target="_blank" rel="noopener">{t("m.tgOpen")}</a>
        </Button>
        <p className="mt-2 mb-0 text-sm text-ink-2">{t("m.tgScan")}</p>
      </div>
    </div>
  );
}
