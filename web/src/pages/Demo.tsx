import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Bot, LayoutDashboard, RotateCcw, ShoppingBag, Smartphone, Store, User } from "lucide-react";
import { toast } from "sonner";
import { PublicFooter, PublicHeader } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api";
import { getSession } from "@/lib/session";
import { startJourney } from "@/tours";
import type { Session } from "@/lib/types";
import { resetDemo, useDemoStatus } from "@/components/WorkspaceBar";
import { useT } from "@/i18n";

export default function Demo() {
  const { t } = useT();
  const [s, setS] = useState<Session | null>(null);
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const { st, reload } = useDemoStatus();
  useEffect(() => {
    getSession().then(setS, () => setS(null));
  }, []);

  /** Every persona works inside the visitor's own copy of the demo shop, created on first use. */
  async function ensure(): Promise<Session | null> {
    if (s?.workspace) return s;
    setBusy(true);
    try {
      await api.post("/demo/start");
      const fresh = await getSession(true);
      setS(fresh);
      reload();
      return fresh;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("demo.startFail"));
      return null;
    } finally {
      setBusy(false);
    }
  }

  /** The guided journey (public/journey.js): one story across the owner, a member and the member's AI assistant. */
  function journey(as: "owner" | "member" | "assistant") {
    if (!startJourney(as)) toast.error(t("jr.fail"));
  }
  async function owner(guided = true) {
    if (guided) return journey("owner");
    setBusy(true);
    try {
      await api.post("/ui/demo/owner");
      await getSession(true);
      nav("/dashboard");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t("demo.openFail"));
    } finally {
      setBusy(false);
    }
  }
  async function go(kind: "member" | "shop", guided = false) {
    const fresh = await ensure();
    if (!fresh) return;
    if (kind === "member" && guided) journey("member");
    else if (kind === "shop") nav(`/s/${fresh.demoShop}`);
    else if (fresh.demoMemberRef) nav(`/manage/${fresh.demoMemberRef}`);
    else toast.error(t("demo.noMember"));
  }

  const people = [
    { as: "owner", icon: Store, color: "var(--kj-owner, #2443c4)", name: t("jr.owner"), what: t("jr.ownerB") },
    { as: "member", icon: User, color: "var(--kj-member, #1d7348)", name: t("jr.member"), what: t("jr.memberB") },
    { as: "assistant", icon: Bot, color: "var(--kj-assistant, #6b3fd4)", name: t("jr.ai"), what: t("jr.aiB") },
  ];

  const tiles = [
    { icon: LayoutDashboard, color: "var(--kj-owner, #2443c4)", who: t("demo.ownerWho"), what: t("demo.ownerWhat"), label: t("demo.skip"), run: () => owner(false) },
    { icon: User, color: "var(--kj-member, #1d7348)", who: t("demo.memberWho"), what: t("demo.memberWhat"), label: s?.workspace && s.demoMemberIsSample === false ? t("demo.memberReal") : t("demo.memberGo"), run: () => go("member") },
    { icon: ShoppingBag, color: "#0070e0", who: t("demo.newWho"), what: t("demo.newWhat"), label: t("demo.newGo"), run: () => go("shop") },
  ];
  const off = s?.demoMode === false;

  return (
    <>
      <PublicHeader />
      <main id="main" className="mx-auto max-w-6xl px-4 pb-16">
        <section className="pt-10 pb-6 sm:pt-14">
          <p className="m-0 inline-flex items-center gap-2 rounded-full border border-rule bg-card px-3 py-1 text-sm font-medium text-ink-2">
            <span className="size-2 rounded-full bg-paid" aria-hidden="true" />
            {t("demo.live")}
          </p>
          <h1 className="mt-4 mb-0 text-4xl font-bold tracking-tight sm:text-5xl">{t("demo.h")}</h1>
          <p className="mt-3 mb-0 max-w-[60ch] text-lg text-ink-2">{t("demo.b")}</p>
        </section>

        <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
          <section aria-labelledby="jr-h" className="relative overflow-hidden rounded-3xl border border-rule bg-card p-6 sm:p-8">
            <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-1.5" style={{ background: "linear-gradient(90deg, var(--kj-owner, #2443c4), var(--kj-member, #1d7348), var(--kj-assistant, #6b3fd4))" }} />
            <h2 id="jr-h" className="m-0 text-2xl font-bold sm:text-3xl">{t("jr.h")}</h2>
            <p className="mt-2 mb-0 max-w-[58ch] text-ink-2">{t("jr.b")}</p>
            <ol className="mt-6 grid list-none gap-3 p-0 sm:grid-cols-3" aria-label={t("jr.who")}>
              {people.map((p, i) => (
                <li key={p.as} className="rounded-2xl p-4" style={{ background: `color-mix(in srgb, ${p.color} 9%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${p.color} 28%, transparent)` }}>
                  <p className="m-0 flex items-center gap-2 font-semibold">
                    <span className="grid size-8 shrink-0 place-items-center rounded-full text-white" style={{ background: p.color }}>
                      <p.icon className="size-4" aria-hidden="true" />
                    </span>
                    <span><span className="sr-only">{i + 1}. </span>{p.name}</span>
                  </p>
                  <p className="mt-2 mb-0 text-sm text-ink-2">{p.what}</p>
                </li>
              ))}
            </ol>
            <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
              <Button size="lg" className="h-12 px-6 text-base" onClick={() => journey("owner")} disabled={off}>
                {t("jr.start")}
                <ArrowRight aria-hidden="true" />
              </Button>
              <span className="text-sm text-ink-2">
                {t("jr.or")}{" "}
                <button type="button" className="min-h-11 font-medium text-ink underline underline-offset-4" onClick={() => journey("member")} disabled={off}>{t("jr.asMember")}</button>
                {" · "}
                <button type="button" className="min-h-11 font-medium text-ink underline underline-offset-4" onClick={() => journey("assistant")} disabled={off}>{t("jr.asAi")}</button>
              </span>
            </div>
            <p className="mt-4 mb-0 text-sm text-ink-2">{t("jr.note")}</p>
          </section>

          <section aria-label={t("ws.label")} className="flex flex-col rounded-3xl border border-rule bg-card p-6">
            {st?.workspace ? (
              <>
                <h2 className="m-0 text-xl font-semibold">{t("demo.readyH")}</h2>
                <p className="m-0 mt-2 text-sm text-ink-2">{st.pool?.line}</p>
                {st.sampleNote && <p className="m-0 mt-2 text-sm text-ink-2">{st.sampleNote}</p>}
                {st.joinQr && (
                  <div className="mt-4 flex items-center gap-4 rounded-2xl bg-muted p-3">
                    <div className="w-[112px] shrink-0 rounded-lg bg-white p-1" role="img" aria-label={t("demo.qr")} dangerouslySetInnerHTML={{ __html: st.joinQr }} />
                    <p className="m-0 flex items-start gap-2 text-sm text-ink-2"><Smartphone className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{t("demo.scan")}</p>
                  </div>
                )}
                <div className="mt-auto pt-4">
                  <Button variant="outline" disabled={busy} onClick={async () => { setBusy(true); if (await resetDemo()) { setS(await getSession(true)); reload(); } setBusy(false); }}>
                    <RotateCcw aria-hidden="true" />
                    {t("ws.reset")}
                  </Button>
                  <p className="mt-2 mb-0 text-xs text-ink-2">{t("demo.readyB", { h: st.workspace.idleHours })}</p>
                </div>
              </>
            ) : (
              <>
                <h2 className="m-0 text-xl font-semibold">{t("demo.startH")}</h2>
                <p className="m-0 mt-2 text-sm text-ink-2">{t("demo.startB", { h: 48 })}</p>
                <ul className="mt-5 mb-0 grid list-none gap-3 p-0 text-sm">
                  {([[User, "demo.get1"], [Smartphone, "demo.get2"], [Store, "demo.get3"]] as const).map(([Icon, k]) => (
                    <li key={k} className="flex items-start gap-3">
                      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-paper text-stamp ring-1 ring-rule"><Icon className="size-4" aria-hidden="true" /></span>
                      <span className="pt-1.5">{t(k)}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-auto pt-6">
                  <Button variant="outline" onClick={ensure} disabled={busy || off}>
                    {t("demo.start")}
                    <ArrowRight aria-hidden="true" />
                  </Button>
                </div>
              </>
            )}
          </section>
        </div>

        <h2 className="mt-14 mb-0 text-2xl font-bold">{t("jr.own")}</h2>
        <ul className="mt-5 grid list-none gap-4 p-0 md:grid-cols-3">
          {tiles.map((p) => (
            <li key={p.who} className="flex flex-col rounded-2xl border border-rule bg-card p-5">
              <span className="grid size-10 place-items-center rounded-xl text-white" style={{ background: p.color }}>
                <p.icon className="size-5" aria-hidden="true" />
              </span>
              <h3 className="mt-4 mb-0 text-lg font-semibold">{p.who}</h3>
              <p className="mt-1 mb-0 flex-1 text-sm text-ink-2">{p.what}</p>
              <Button variant="outline" className="mt-4 self-start" onClick={p.run} disabled={busy || off}>
                {p.label}
                <ArrowRight aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
        <p className="mt-8 text-sm text-ink-2">
          {t("demo.key1")} <a className="text-stamp underline" href="/login">{t("demo.key2")}</a>. {t("demo.shop1")} <a className="text-stamp underline" href="/onboard">{t("demo.shop2")}</a> {t("demo.shop3")}
        </p>
      </main>
      <PublicFooter />
    </>
  );
}
