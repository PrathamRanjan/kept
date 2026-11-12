import { useEffect, useState } from "react";
import { Check, Circle, Copy, ExternalLink, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { PublicFooter, PublicHeader } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/api";
import { resetDemo } from "@/components/WorkspaceBar";
import { cn } from "@/lib/utils";
import { getBcp, getLang, translate, useT } from "@/i18n";

interface Step { text: string; button: { label: string; href: string } | null; done: boolean; at: string | null }
interface Path { id: string; title: string; minutes: number; paypalLogin: boolean; needs: string | null; steps: Step[] }
interface JudgeData {
  live: string;
  workspace: null | { id: string; shop: { name: string; slug: string }; counts: { samples: number; real: number; realActive: number }; pool: { line: string }; memberRef: string | null; memberIsSample: boolean | null; joinUrl: string; joinQr: string | null; idleHours: number };
  accounts: { label: string; email: string | null; password: string | null; note: string }[];
  paths: Path[];
  liveTable: { area: string; thing: string; state: string; detail: string; last_used: string | null }[];
  pages: { href: string; label: string }[];
  lookAt: string[];
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useT();
  return (
    <Button size="sm" variant="outline" onClick={() => navigator.clipboard?.writeText(value).then(() => toast.success(t("jd.copied", { label })), () => toast.error(t("jd.copyFail")))} aria-label={t("jd.copyAria", { label })}>
      <Copy aria-hidden="true" /> {t("jd.copy")}
    </Button>
  );
}

/** English keeps the browser's own date format, as before; other languages use their own. */
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(getLang() === "en" || getLang() === "qps" ? undefined : getBcp(), { dateStyle: "medium", timeStyle: "short" }) : translate(getLang(), "jd.notYet"));

export default function Judge() {
  const { t, lang } = useT();
  const [d, setD] = useState<JudgeData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get<JudgeData>("/api/public/judge").then((x) => (setD(x), setErr(null)), (e) => setErr(e instanceof ApiError ? e.message : translate(getLang(), "jd.loadFail")));
  useEffect(() => {
    load();
    // Steps tick themselves: re-read every few seconds and whenever this tab comes back into view.
    const t = setInterval(load, 5000);
    const f = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", f);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", f);
    };
  }, []);

  async function start() {
    setBusy(true);
    try {
      await api.post("/demo/start");
      toast.success(t("jd.ready"));
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("demo.startFail"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PublicHeader />
      <main id="main" className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-4xl font-bold">{t("jd.h")}</h1>
        <p className="mt-3 max-w-[62ch] text-lg text-ink-2">{t("jd.b")}</p>
        {lang !== "en" && <p className="mt-2 text-sm text-ink-2">{t("jd.recorded")}</p>}
        {err && <p role="alert" className="mt-4 text-fail">{err}</p>}
        {!d ? (
          <Skeleton className="mt-8 h-64" />
        ) : (
          <>
            <section aria-labelledby="ws" className="mt-8 grid gap-4 rounded-xl border border-rule bg-card p-5 md:grid-cols-[1fr_auto]">
              <div>
                <h2 id="ws" className="m-0 text-xl font-semibold">{t("ws.label")}</h2>
                {d.workspace ? (
                  <>
                    <p className="mt-2 mb-0">{t(d.workspace.counts.realActive === 1 ? "jd.ws1" : "jd.wsN", { shop: d.workspace.shop.name, real: d.workspace.counts.realActive, samples: d.workspace.counts.samples, h: d.workspace.idleHours })}</p>
                    <p className="mt-1 mb-0 text-sm text-ink-2">{d.workspace.pool.line}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span className="text-sm text-ink-2">{t("jd.phone")}</span>
                      <CopyButton value={d.workspace.joinUrl} label={t("jd.phoneLink")} />
                      <Button size="sm" variant="ghost" disabled={busy} onClick={async () => { setBusy(true); if (await resetDemo()) await load(); setBusy(false); }}>
                        <RotateCcw aria-hidden="true" /> {t("jd.over")}
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="mt-2 mb-0">{t("jd.startB")}</p>
                    <Button className="mt-3" onClick={start} disabled={busy}>{busy ? t("jd.starting") : t("demo.start")}</Button>
                  </>
                )}
              </div>
              {d.workspace?.joinQr && <div className="size-[168px] rounded-lg bg-white p-1" role="img" aria-label={t("jd.qr")} dangerouslySetInnerHTML={{ __html: d.workspace.joinQr }} />}
            </section>

            <section aria-labelledby="acc" className="mt-6 rounded-xl border border-rule bg-card p-5">
              <h2 id="acc" className="m-0 text-xl font-semibold">{t("jd.accounts")}</h2>
              <ul className="mt-2 mb-0 list-none space-y-2 p-0">
                <li>{t("jd.noSignIn")}</li>
                {d.accounts.map((a) => (
                  <li key={a.label}>
                    <span className="font-medium">{a.label}:</span>{" "}
                    {a.email ? (
                      <span className="inline-flex flex-wrap items-center gap-2"><span className="font-mono">{a.email}</span><CopyButton value={a.email} label={t("jd.email")} />{a.password && <><span className="font-mono">{a.password}</span><CopyButton value={a.password} label={t("jd.password")} /></>}</span>
                    ) : null}{" "}
                    <span className="text-ink-2">{a.note}</span>
                  </li>
                ))}
              </ul>
            </section>

            <h2 className="mt-10 text-2xl font-bold">{t("jd.three")}</h2>
            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              {d.paths.map((p) => {
                const n = p.steps.filter((s) => s.done).length;
                return (
                  <section key={p.id} aria-labelledby={`p-${p.id}`} className={cn("rounded-xl border bg-card p-5", n === p.steps.length ? "border-paid" : "border-rule")}>
                    <h3 id={`p-${p.id}`} className="m-0 text-lg font-semibold">{p.title}</h3>
                    <p className="mt-1 mb-0 text-sm text-ink-2">{p.minutes === 1 ? t("jd.min1") : t("jd.minN", { n: p.minutes })} · {p.paypalLogin ? t("jd.login") : t("jd.noLogin")} · {t("jd.done", { n, m: p.steps.length })}</p>
                    {p.needs && d.workspace && <p className="mt-2 mb-0 rounded-md bg-pause-wash p-2 text-sm">{t("jd.needs", { x: p.needs })}</p>}
                    <ol className="mt-3 mb-0 list-none space-y-3 p-0">
                      {p.steps.map((s, i) => (
                        <li key={i} className="flex gap-2">
                          {s.done ? <Check className="mt-0.5 size-5 shrink-0 text-paid" aria-label={t("jd.doneAria")} /> : <Circle className="mt-0.5 size-5 shrink-0 text-ink-2" aria-label={t("jd.notDoneAria")} />}
                          <div>
                            <p className="m-0"><span className="font-semibold">{i + 1}.</span> {s.text}</p>
                            {s.done && <p className="m-0 text-xs text-ink-2">{t("jd.ticked", { when: when(s.at) })}</p>}
                            {s.button && d.workspace && (
                              <Button size="sm" variant={s.done ? "ghost" : "outline"} asChild className="mt-1 h-auto min-h-9 whitespace-normal text-left">
                                <a href={s.button.href}>{s.button.label}</a>
                              </Button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ol>
                    {!d.workspace && <p className="mt-3 mb-0 text-sm text-ink-2">{t("jd.startFirst")}</p>}
                  </section>
                );
              })}
            </div>

            <section aria-labelledby="look" className="mt-10">
              <h2 id="look" className="text-2xl font-bold">{t("jd.look")}</h2>
              <ol className="mt-2">{d.lookAt.map((x) => <li key={x}>{x}</li>)}</ol>
            </section>

            <section aria-labelledby="pages" className="mt-8">
              <h2 id="pages" className="text-2xl font-bold">{t("jd.pages")}</h2>
              <ul className="mt-2 grid list-none gap-2 p-0 sm:grid-cols-2">
                {d.pages.map((p) => (
                  <li key={p.href}><a href={p.href} className="inline-flex min-h-11 items-center gap-1 underline">{p.label}<ExternalLink className="size-3.5" aria-hidden="true" /></a></li>
                ))}
              </ul>
            </section>

            <section aria-labelledby="live" className="mt-8">
              <h2 id="live" className="text-2xl font-bold">{t("jd.live")}</h2>
              <p className="mt-1 text-ink-2">{t("jd.liveB")}</p>
              <div className="overflow-x-auto rounded-xl border border-rule focus-visible:outline-2" tabIndex={0} role="region" aria-label={t("pub.scrolls", { label: t("jd.live") })}>
                <table className="w-full min-w-[640px] text-sm">
                  <thead className="bg-muted text-left"><tr><th className="p-2">{t("jd.area")}</th><th className="p-2">{t("jd.what")}</th><th className="p-2">{t("jd.state")}</th><th className="p-2">{t("jd.lastUsed")}</th></tr></thead>
                  <tbody>
                    {d.liveTable.map((r) => (
                      <tr key={r.thing} className="border-t border-rule align-top">
                        <td className="p-2">{r.area}</td>
                        <td className="p-2"><span className="font-medium">{r.thing}</span><br /><span className="text-ink-2">{r.detail}</span></td>
                        <td className={cn("p-2", /^live/.test(r.state) ? "text-paid" : /^(off|not|empty)/.test(r.state) ? "text-fail" : "")}>{r.state}</td>
                        <td className="p-2 text-ink-2">{when(r.last_used)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </main>
      <PublicFooter />
    </>
  );
}
