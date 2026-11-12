import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { PublicFooter, PublicHeader } from "@/components/Shell";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { HandsFreeSim } from "@/handsfree/Sim";
import { getBcp, getLang, translate, useT } from "@/i18n";
import type { Key } from "@/i18n/en";

type PageId = "proof" | "ai" | "paypal" | "roles" | "accessibility";
const TITLES: Record<PageId, [Key, Key]> = {
  proof: ["pub.proofT", "pub.proofB"],
  ai: ["pub.aiT", "pub.aiB"],
  paypal: ["pub.paypalT", "pub.paypalB"],
  roles: ["pub.rolesT", "pub.rolesB"],
  accessibility: ["pub.a11yT", "pub.a11yB"],
};
const API: Record<PageId, string> = { proof: "proof", ai: "ai", paypal: "paypal", roles: "roles", accessibility: "accessibility" };
/** English keeps the browser's own date format, as before; other languages use their own. */
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(getLang() === "en" || getLang() === "qps" ? undefined : getBcp(), { dateStyle: "medium", timeStyle: "short" }) : translate(getLang(), "pub.never"));
const Pass = ({ ok }: { ok: boolean }) => {
  const { t } = useT();
  return ok ? <span className="inline-flex items-center gap-1 text-paid"><Check className="size-4" aria-hidden="true" />{t("pub.pass")}</span> : <span className="inline-flex items-center gap-1 text-fail"><X className="size-4" aria-hidden="true" />{t("pub.fail")}</span>;
};

function Table({ head, rows, min = 640, label }: { head: string[]; rows: React.ReactNode[][]; min?: number; label?: string }) {
  const { t } = useT();
  return (
    // Focusable so keyboard users can scroll it sideways on a narrow screen.
    <div className="overflow-x-auto rounded-xl border border-rule focus-visible:outline-2" tabIndex={0} role="region" aria-label={t("pub.scrolls", { label: label ?? t("pub.table") })}>
      <table className="w-full text-sm" style={{ minWidth: min }}>
        <thead className="bg-muted text-left"><tr>{head.map((h) => <th key={h} className="p-2">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-rule align-top">{r.map((c, k) => <td key={k} className="p-2">{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** Each result file has its own shape; this reads the common parts: cases with input, expected, actual, pass. */
function cases(s: any): { id: string; split?: string; input: string; expected: string; actual: string; pass: boolean; note?: string }[] {
  const list: any[] = s.cases ?? s.results ?? [];
  return list.map((c) => ({ id: String(c.id ?? c.case_id ?? ""), split: c.split, input: String(c.input ?? c.text ?? ""), expected: String(c.expected ?? ""), actual: String(c.actual ?? c.level ?? c.outcome ?? ""), pass: Boolean(c.pass ?? c.correct), note: c.top_reason ?? c.note ?? undefined }));
}

/** The hands-free block shared by /proof and /accessibility: published limits, code versus model, credits. */
function HandsFreeFacts({ h, mine }: { h: any; mine?: boolean }) {
  const { t } = useT();
  if (!h) return null;
  let local: { eyesPx?: number; headPx?: number; n?: number; at?: string } | null = null;
  try {
    local = mine ? JSON.parse(localStorage.getItem("kept-hf-cal") ?? "null") : null;
  } catch { /* storage blocked */ }
  return (
    <section className="mt-10" aria-labelledby="hf-facts">
      <h2 id="hf-facts" className="text-2xl font-bold">{t("pub.hf")}</h2>
      <p className="max-w-[70ch] text-ink-2">{h.what}</p>
      <h3 className="mt-4 text-lg font-semibold">{t("pub.accuracy")}</h3>
      <ul>{h.published.map((x: string) => <li key={x}>{x}</li>)}</ul>
      <p className="rounded-lg bg-pause-wash p-3 text-sm">{h.measured ?? h.measuredNote}</p>
      {mine && <p className="text-sm" data-testid="hf-local">{local?.eyesPx !== undefined ? t("pub.device", { eyes: local.eyesPx, head: String(local.headPx), n: String(local.n), when: when(local.at) }) : t("pub.noCal")}</p>}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div><h3 className="m-0 text-lg font-semibold">{t("pub.inCode")}</h3><ul>{h.inCode.map((x: string) => <li key={x}>{x}</li>)}</ul></div>
        <div><h3 className="m-0 text-lg font-semibold">{t("pub.byModel")}</h3><ul>{h.byModel.map((x: string) => <li key={x}>{x}</li>)}</ul></div>
      </div>
      <h3 className="mt-2 text-lg font-semibold">{t("pub.credits")}</h3>
      <ul className="text-sm">{h.credits.map((x: string) => <li key={x}>{x}</li>)}</ul>
    </section>
  );
}

function Proof({ d }: { d: any }) {
  const { t } = useT();
  return (
    <>
      {!d.nightly && <p className="rounded-lg bg-pause-wash p-3 text-sm">{t("pub.noNightly")}</p>}
      {[...(d.nightly ? [{ suite: "nightly", title: t("pub.nightlyT"), model: Object.values(d.nightly.models ?? {}).join(", "), run_at: d.nightly.run_at, runner: d.nightly.runner, file: "nightly_runs table", about: t("pub.nightlyAbout"), cases: d.nightly.cases }] : []), ...d.suites].map((s: any) => {
        const cs = cases(s);
        const passed = cs.filter((c) => c.pass).length;
        return (
          <section key={s.file} className="mt-8" aria-labelledby={`s-${s.suite}`}>
            <h2 id={`s-${s.suite}`} className="m-0 text-2xl font-bold">{s.title ?? s.suite}</h2>
            <p className="mt-1 text-ink-2">{t("pub.passed", { p: passed, n: cs.length })} · {t("pub.model", { m: s.model ?? t("pub.none") })} · {t("pub.run", { when: when(s.run_at ?? s.file_date) })}{s.runner ? ` · ${s.runner}` : ""} · {t("pub.file")} <span className="font-mono">{s.file}</span></p>
            {s.about && <p className="mt-1 text-sm text-ink-2">{s.about}</p>}
            {s.summary && typeof s.summary === "object" && !Array.isArray(s.summary) && s.summary.held && (
              <p className="text-sm">{t("pub.held", { hp: s.summary.held.passed, hn: s.summary.held.cases, v1: s.summary.all.v1_passed, n: s.summary.all.cases, snc: s.summary.all.scams_not_cleared, s: s.summary.all.scams, v1snc: s.summary.all.v1_scams_not_cleared, gh: s.summary.all.genuine_held, ga: s.summary.all.genuine_amber })}</p>
            )}
            <Table label={t("pub.cases", { t: s.title ?? s.suite })} head={[t("pub.case"), t("pub.input"), t("pub.expected"), t("pub.result"), ""]} rows={cs.map((c) => [<span className="font-mono text-xs">{c.id}{c.split ? ` · ${c.split}` : ""}</span>, <span className="break-words">{c.input}</span>, c.expected, <span>{c.actual}{c.note ? <><br /><span className="text-xs text-ink-2">{c.note}</span></> : null}</span>, <Pass ok={c.pass} />])} min={760} />
            {s.not_measured?.length > 0 && <ul className="mt-2 text-sm text-ink-2">{s.not_measured.map((x: string) => <li key={x}>{t("pub.notMeasuredX", { x })}</li>)}</ul>}
          </section>
        );
      })}
      <section className="mt-10" aria-labelledby="th">
        <h2 id="th" className="text-2xl font-bold">{t("pub.thH")}</h2>
        <p className="text-ink-2">{t("pub.thB")}</p>
        <Table label={t("pub.thLabel")} head={[t("pub.question"), t("pub.clearBelow"), t("pub.holdAt"), t("pub.source"), t("pub.calibrated"), t("pub.precision"), t("pub.recall")]} rows={d.thresholds.map((x: any) => [x.name.replace(/_/g, " "), x.clear_below, x.hold_above, x.source, `${x.calibrated_on}${x.n ? ` (${t("pub.nCases", { n: x.n })})` : ""}`, x.precision_at_hold ?? "—", x.recall_at_hold ?? "—"])} />
      </section>
      <section className="mt-10" aria-labelledby="mc">
        <h2 id="mc" className="text-2xl font-bold">{t("pub.mcH")}</h2>
        <p className="text-ink-2">{t("pub.from", { src: d.modelCard.source })} {d.modelCard.risk}</p>
        <Table label={t("pub.mcLabel")} head={[t("pub.testSet"), t("pub.messages"), "AUC", t("pub.caught"), t("pub.whatItIs")]} rows={d.modelCard.text.map((r: any) => [r.set, r.n.toLocaleString(), r.auc ?? "—", r.caught_at_1pct, r.what])} />
      </section>
      <HandsFreeFacts h={d.handsfree} />
      <section className="mt-10" aria-labelledby="nm">
        <h2 id="nm" className="text-2xl font-bold">{t("pub.nmH")}</h2>
        <ul>{d.notMeasured.map((x: string) => <li key={x}>{x}</li>)}</ul>
      </section>
    </>
  );
}

function Ai({ d }: { d: any }) {
  const { t } = useT();
  return (
    <>
      {d.note && <p className="rounded-lg bg-pause-wash p-3">{d.note}</p>}
      <ol className="mt-4 list-none space-y-3 p-0">
        {d.calls.map((c: any) => (
          <li key={c.id} className="rounded-xl border border-rule bg-card p-4 text-sm">
            <p className="m-0 font-semibold">{c.purpose.replace(/_/g, " ")} · {c.model} · {c.ok ? t("pub.answered") : t("pub.failed")}</p>
            <p className="m-0 text-ink-2">{when(c.at)} · {c.latency_ms} ms · {t("pub.about", { c: `$${c.cost_usd.toFixed(4)}` })}</p>
            {c.input && <p className="mt-1 mb-0">{t("pub.in", { x: c.input })}</p>}
            {c.tools?.length > 0 && <ul className="mt-1 mb-0">{c.tools.map((x: string, i: number) => <li key={i} className="font-mono text-xs">{x}</li>)}</ul>}
            {c.output && <pre className="mt-1 mb-0 overflow-x-auto rounded bg-paper p-2 text-xs">{JSON.stringify(c.output, null, 1).slice(0, 600)}</pre>}
            {c.error && <p className="mt-1 mb-0 text-fail">{c.error}</p>}
          </li>
        ))}
      </ol>
      <h2 className="mt-8 text-2xl font-bold">{t("pub.last7")}</h2>
      <Table label={t("pub.last7")} head={[t("pub.job"), t("pub.calls"), t("pub.ok"), t("pub.median"), t("pub.cost")]} rows={d.last7days.map((r: any) => [r.purpose.replace(/_/g, " "), r.n, r.ok, `${r.p50} ms`, `$${r.cost.toFixed(3)}`])} min={480} />
    </>
  );
}

function PayPal({ d }: { d: any }) {
  const { t } = useT();
  return <Table label={t("pub.ppLabel")} head={["API", t("pub.when"), t("pub.lastUsed"), t("pub.latestId"), t("pub.fromCol")]} rows={d.apis.map((a: any) => [<span className="font-medium">{a.api}</span>, a.when, when(a.last), <span className="font-mono text-xs break-all">{a.id ?? t("pub.noneYet")}</span>, a.from ?? "—"])} min={760} />;
}

function Roles({ d }: { d: any }) {
  const { t } = useT();
  return <Table label={t("pub.rolesLabel")} head={[t("pub.who"), t("pub.can"), t("pub.cannot")]} rows={d.roles.map((r: any) => [<span className="font-medium">{r.who}</span>, <ul className="m-0 pl-4">{r.can.map((x: string) => <li key={x}>{x}</li>)}</ul>, <ul className="m-0 pl-4">{r.cannot.map((x: string) => <li key={x}>{x}</li>)}</ul>])} />;
}

function A11y({ d }: { d: any }) {
  const { t } = useT();
  return (
    <>
      {d.updated && <p className="text-ink-2">{t("pub.updated", { when: when(d.updated) })}</p>}
      <Table label={t("pub.a11yLabel")} head={[t("pub.check"), t("pub.how"), t("pub.where"), t("pub.whenCol"), t("pub.result")]} rows={(d.checks ?? []).map((c: any) => [<span className="font-medium">{c.check}</span>, c.how, c.where, c.date, <span className={cn(c.ok ? "text-paid" : "text-fail")}>{c.result}</span>])} min={760} />
      <h2 className="mt-8 text-2xl font-bold">{t("pub.notTested")}</h2>
      <ul>{(d.notTested ?? []).map((x: string) => <li key={x}>{x}</li>)}</ul>
      {d.features && (<><h2 className="mt-8 text-2xl font-bold">{t("pub.built")}</h2><ul>{d.features.map((x: string) => <li key={x}>{x}</li>)}</ul></>)}
      <HandsFreeSim />
      {d.handsfree?.recording && (
        <figure className="mt-6">
          <video src={d.handsfree.recording} controls muted playsInline preload="metadata" className="w-full max-w-2xl rounded-xl border border-rule" aria-describedby="hf-rec-cap" />
          <figcaption id="hf-rec-cap" className="mt-1 text-sm text-ink-2">{t("pub.recCap")}</figcaption>
        </figure>
      )}
      <HandsFreeFacts h={d.handsfree} mine />
    </>
  );
}

export default function Public({ page }: { page: PageId }) {
  const { t, lang } = useT();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setD(null);
    api.get(`/api/public/${API[page]}`).then(setD, (e) => setErr(e instanceof ApiError ? e.message : translate(getLang(), "pub.loadFail")));
  }, [page]);
  const [title, intro] = TITLES[page];
  return (
    <>
      <PublicHeader />
      <main id="main" className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-4xl font-bold">{t(title)}</h1>
        <p className="mt-3 max-w-[66ch] text-lg text-ink-2">{t(intro)}</p>
        {lang !== "en" && <p className="rounded-lg bg-muted p-3 text-sm" data-testid="pub-recorded">{t("pub.recorded")}</p>}
        <p className="text-sm"><a href="/judge" className="underline">{t("pub.back")}</a></p>
        {err && <p role="alert" className="text-fail">{err}</p>}
        {!d && !err ? <Skeleton className="mt-6 h-64" /> : d && (page === "proof" ? <Proof d={d} /> : page === "ai" ? <Ai d={d} /> : page === "paypal" ? <PayPal d={d} /> : page === "roles" ? <Roles d={d} /> : <A11y d={d} />)}
      </main>
      <PublicFooter />
    </>
  );
}
