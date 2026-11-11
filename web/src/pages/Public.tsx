import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { PublicFooter, PublicHeader } from "@/components/Shell";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

type PageId = "proof" | "ai" | "paypal" | "roles" | "accessibility";
const TITLES: Record<PageId, [string, string]> = {
  proof: ["Proof", "Every evaluation case Kept runs, with the input, what was expected, what happened and whether it passed. Nothing here is typed by hand: it is read from the result files the scripts write."],
  ai: ["What the AI did", "The last 20 model calls in the showcase shop: what went in, which tools ran, what came out, how long it took and what it cost."],
  paypal: ["PayPal in Kept", "Every PayPal API Kept uses, the moment it is used, and the latest live sandbox id for each."],
  roles: ["Who can move money", "What each person, model and agent can and cannot do. No model can call PayPal."],
  accessibility: ["Accessibility", "What was tested, how, when, and what was not."],
};
const API: Record<PageId, string> = { proof: "proof", ai: "ai", paypal: "paypal", roles: "roles", accessibility: "accessibility" };
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never");
const Pass = ({ ok }: { ok: boolean }) => (ok ? <span className="inline-flex items-center gap-1 text-paid"><Check className="size-4" aria-hidden="true" />pass</span> : <span className="inline-flex items-center gap-1 text-fail"><X className="size-4" aria-hidden="true" />fail</span>);

function Table({ head, rows, min = 640, label = "Table" }: { head: string[]; rows: React.ReactNode[][]; min?: number; label?: string }) {
  return (
    // Focusable so keyboard users can scroll it sideways on a narrow screen.
    <div className="overflow-x-auto rounded-xl border border-rule focus-visible:outline-2" tabIndex={0} role="region" aria-label={`${label} (scrolls sideways)`}>
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

function Proof({ d }: { d: any }) {
  return (
    <>
      {!d.nightly && <p className="rounded-lg bg-pause-wash p-3 text-sm">No daily showcase run is recorded on this server yet. It runs at 04:30 UTC; the files below are from the last run of the scripts.</p>}
      {[...(d.nightly ? [{ suite: "nightly", title: "Daily showcase run (live, on this server)", model: Object.values(d.nightly.models ?? {}).join(", "), run_at: d.nightly.run_at, runner: d.nightly.runner, file: "nightly_runs table", about: "Real model calls in the showcase shop, checked by code. Nothing in this run moves money.", cases: d.nightly.cases }] : []), ...d.suites].map((s: any) => {
        const cs = cases(s);
        const passed = cs.filter((c) => c.pass).length;
        return (
          <section key={s.file} className="mt-8" aria-labelledby={`s-${s.suite}`}>
            <h2 id={`s-${s.suite}`} className="m-0 text-2xl font-bold">{s.title ?? s.suite}</h2>
            <p className="mt-1 text-ink-2">{passed} of {cs.length} passed · model {s.model ?? "none"} · run {when(s.run_at ?? s.file_date)}{s.runner ? ` · ${s.runner}` : ""} · file <span className="font-mono">{s.file}</span></p>
            {s.about && <p className="mt-1 text-sm text-ink-2">{s.about}</p>}
            {s.summary && typeof s.summary === "object" && !Array.isArray(s.summary) && s.summary.held && (
              <p className="text-sm">Held-out half: {s.summary.held.passed} of {s.summary.held.cases} passed. Before version 2 (rules only): {s.summary.all.v1_passed} of {s.summary.all.cases}. Scams not cleared: {s.summary.all.scams_not_cleared} of {s.summary.all.scams} (rules only: {s.summary.all.v1_scams_not_cleared}). Genuine messages held: {s.summary.all.genuine_held}; shown amber: {s.summary.all.genuine_amber}.</p>
            )}
            <Table label={`${s.title ?? s.suite} cases`} head={["Case", "Input", "Expected", "Result", ""]} rows={cs.map((c) => [<span className="font-mono text-xs">{c.id}{c.split ? ` · ${c.split}` : ""}</span>, <span className="break-words">{c.input}</span>, c.expected, <span>{c.actual}{c.note ? <><br /><span className="text-xs text-ink-2">{c.note}</span></> : null}</span>, <Pass ok={c.pass} />])} min={760} />
            {s.not_measured?.length > 0 && <ul className="mt-2 text-sm text-ink-2">{s.not_measured.map((x: string) => <li key={x}>Not measured: {x}</li>)}</ul>}
          </section>
        );
      })}
      <section className="mt-10" aria-labelledby="th">
        <h2 id="th" className="text-2xl font-bold">Scam-check thresholds</h2>
        <p className="text-ink-2">Thresholds live in code and data, not in the model. Below the first line is clear; at or above the second is a hold.</p>
        <Table label="Thresholds" head={["Question", "Clear below", "Hold at", "Source", "Calibrated on", "Precision at hold", "Recall at hold"]} rows={d.thresholds.map((t: any) => [t.name.replace(/_/g, " "), t.clear_below, t.hold_above, t.source, `${t.calibrated_on}${t.n ? ` (${t.n} cases)` : ""}`, t.precision_at_hold ?? "—", t.recall_at_hold ?? "—"])} />
      </section>
      <section className="mt-10" aria-labelledby="mc">
        <h2 id="mc" className="text-2xl font-bold">The on-device scam model</h2>
        <p className="text-ink-2">From {d.modelCard.source}. {d.modelCard.risk}</p>
        <Table label="Model card" head={["Test set", "Messages", "AUC", "Caught at 1% genuine held", "What it is"]} rows={d.modelCard.text.map((r: any) => [r.set, r.n.toLocaleString(), r.auc ?? "—", r.caught_at_1pct, r.what])} />
      </section>
      <section className="mt-10" aria-labelledby="nm">
        <h2 id="nm" className="text-2xl font-bold">Not measured</h2>
        <ul>{d.notMeasured.map((x: string) => <li key={x}>{x}</li>)}</ul>
      </section>
    </>
  );
}

function Ai({ d }: { d: any }) {
  return (
    <>
      {d.note && <p className="rounded-lg bg-pause-wash p-3">{d.note}</p>}
      <ol className="mt-4 list-none space-y-3 p-0">
        {d.calls.map((c: any) => (
          <li key={c.id} className="rounded-xl border border-rule bg-card p-4 text-sm">
            <p className="m-0 font-semibold">{c.purpose.replace(/_/g, " ")} · {c.model} · {c.ok ? "answered" : "failed"}</p>
            <p className="m-0 text-ink-2">{when(c.at)} · {c.latency_ms} ms · about ${c.cost_usd.toFixed(4)}</p>
            {c.input && <p className="mt-1 mb-0">In: {c.input}</p>}
            {c.tools?.length > 0 && <ul className="mt-1 mb-0">{c.tools.map((t: string, i: number) => <li key={i} className="font-mono text-xs">{t}</li>)}</ul>}
            {c.output && <pre className="mt-1 mb-0 overflow-x-auto rounded bg-paper p-2 text-xs">{JSON.stringify(c.output, null, 1).slice(0, 600)}</pre>}
            {c.error && <p className="mt-1 mb-0 text-fail">{c.error}</p>}
          </li>
        ))}
      </ol>
      <h2 className="mt-8 text-2xl font-bold">Last 7 days, every shop</h2>
      <Table label="Last 7 days" head={["Job", "Calls", "Answered", "Median time", "Cost"]} rows={d.last7days.map((r: any) => [r.purpose.replace(/_/g, " "), r.n, r.ok, `${r.p50} ms`, `$${r.cost.toFixed(3)}`])} min={480} />
    </>
  );
}

function PayPal({ d }: { d: any }) {
  return <Table label="PayPal APIs" head={["API", "When Kept uses it", "Last used", "Latest id", "From"]} rows={d.apis.map((a: any) => [<span className="font-medium">{a.api}</span>, a.when, when(a.last), <span className="font-mono text-xs break-all">{a.id ?? "none yet"}</span>, a.from ?? "—"])} min={760} />;
}

function Roles({ d }: { d: any }) {
  return <Table label="Roles" head={["Who", "Can", "Cannot"]} rows={d.roles.map((r: any) => [<span className="font-medium">{r.who}</span>, <ul className="m-0 pl-4">{r.can.map((x: string) => <li key={x}>{x}</li>)}</ul>, <ul className="m-0 pl-4">{r.cannot.map((x: string) => <li key={x}>{x}</li>)}</ul>])} />;
}

function A11y({ d }: { d: any }) {
  return (
    <>
      {d.updated && <p className="text-ink-2">Last updated {when(d.updated)}.</p>}
      <Table label="Accessibility checks" head={["Check", "How", "Where", "When", "Result"]} rows={(d.checks ?? []).map((c: any) => [<span className="font-medium">{c.check}</span>, c.how, c.where, c.date, <span className={cn(c.ok ? "text-paid" : "text-fail")}>{c.result}</span>])} min={760} />
      <h2 className="mt-8 text-2xl font-bold">Not tested</h2>
      <ul>{(d.notTested ?? []).map((x: string) => <li key={x}>{x}</li>)}</ul>
      {d.features && (<><h2 className="mt-8 text-2xl font-bold">What is built</h2><ul>{d.features.map((x: string) => <li key={x}>{x}</li>)}</ul></>)}
    </>
  );
}

export default function Public({ page }: { page: PageId }) {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setD(null);
    api.get(`/api/public/${API[page]}`).then(setD, (e) => setErr(e instanceof ApiError ? e.message : "Couldn't load this page."));
  }, [page]);
  const [title, intro] = TITLES[page];
  return (
    <>
      <PublicHeader />
      <main id="main" className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-4xl font-bold">{title}</h1>
        <p className="mt-3 max-w-[66ch] text-lg text-ink-2">{intro}</p>
        <p className="text-sm"><a href="/judge" className="underline">Back to the judge page</a></p>
        {err && <p role="alert" className="text-fail">{err}</p>}
        {!d && !err ? <Skeleton className="mt-6 h-64" /> : d && (page === "proof" ? <Proof d={d} /> : page === "ai" ? <Ai d={d} /> : page === "paypal" ? <PayPal d={d} /> : page === "roles" ? <Roles d={d} /> : <A11y d={d} />)}
      </main>
      <PublicFooter />
    </>
  );
}
