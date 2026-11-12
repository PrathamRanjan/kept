import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Bot, Compass, KeyRound, RotateCcw, Store, User } from "lucide-react";
import { toast } from "sonner";
import { PublicFooter, PublicHeader } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api";
import { getSession } from "@/lib/session";
import { startJourney } from "@/tours";
import type { Session } from "@/lib/types";
import { resetDemo, useDemoStatus } from "@/components/WorkspaceBar";
import { useT } from "@/i18n";

export default function Demo({ judge = false }: { judge?: boolean }) {
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

  const personas = [
    {
      icon: Store,
      who: t("demo.ownerWho"),
      what: t("demo.ownerWhat"),
      action: (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Button onClick={() => owner()} disabled={busy || s?.demoMode === false}>
            {t("demo.ownerStart")}
            <ArrowRight aria-hidden="true" />
          </Button>
          <Button variant="link" className="h-auto min-h-11 px-0" onClick={() => owner(false)} disabled={busy || s?.demoMode === false}>
            {t("demo.skip")}
          </Button>
        </div>
      ),
    },
    {
      icon: User,
      who: t("demo.memberWho"),
      what: t("demo.memberWhat"),
      action: (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <Button variant="outline" onClick={() => go("member", true)} disabled={busy}>
            {t("demo.memberStart")}
          </Button>
          <Button variant="link" className="h-auto min-h-11 px-0" onClick={() => go("member")} disabled={busy}>
            {s?.workspace && s.demoMemberIsSample === false ? t("demo.memberReal") : t("demo.memberGo")}
          </Button>
        </div>
      ),
    },
    {
      icon: KeyRound,
      who: t("demo.newWho"),
      what: t("demo.newWhat"),
      action: (
        <Button variant="outline" onClick={() => go("shop")} disabled={busy}>
          {t("demo.newGo")}
        </Button>
      ),
    },
    {
      icon: Bot,
      who: t("demo.aiWho"),
      what: t("demo.aiWhat"),
      action: (
        <Button variant="outline" asChild>
          <a href="/agents">{t("demo.aiGo")}</a>
        </Button>
      ),
    },
  ];

  return (
    <>
      <PublicHeader />
      <main id="main" className="mx-auto max-w-5xl px-4 py-12">
        <h1 className="text-4xl font-bold">{judge ? t("demo.judgeH") : t("demo.h")}</h1>
        <p className="mt-3 max-w-[60ch] text-lg text-ink-2">
          {judge
            ? t("demo.judgeB")
            : t("demo.b")}
        </p>
        <section aria-labelledby="jr-h" className="mt-8 rounded-2xl border-2 border-stamp/40 bg-card p-5 sm:p-7">
          <h2 id="jr-h" className="m-0 text-2xl font-bold">{t("jr.h")}</h2>
          <p className="mt-2 mb-0 max-w-[64ch] text-ink-2">{t("jr.b")}</p>
          <ul className="mt-5 grid list-none gap-3 p-0 md:grid-cols-3" aria-label={t("jr.who")}>
            {people.map((p) => (
              <li key={p.as} className="rounded-xl border border-rule p-4" style={{ borderTop: `4px solid ${p.color}` }}>
                <p className="m-0 flex items-center gap-2 font-semibold"><p.icon className="size-4 shrink-0" style={{ color: p.color }} aria-hidden="true" />{p.name}</p>
                <p className="mt-1 mb-0 text-sm text-ink-2">{p.what}</p>
              </li>
            ))}
          </ul>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button size="lg" onClick={() => journey("owner")} disabled={s?.demoMode === false}>
              {t("jr.start")}
              <ArrowRight aria-hidden="true" />
            </Button>
            <Button variant="outline" onClick={() => journey("member")} disabled={s?.demoMode === false}>{t("jr.asMember")}</Button>
            <Button variant="outline" onClick={() => journey("assistant")} disabled={s?.demoMode === false}>{t("jr.asAi")}</Button>
          </div>
          <p className="mt-3 mb-0 text-sm text-ink-2">{t("jr.note")}</p>
        </section>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button variant="outline" asChild>
            <a href="/judge">
              <Compass aria-hidden="true" />
              {t("demo.paths")}
            </a>
          </Button>
        </div>
        <section aria-label={t("ws.label")} className="mt-8 rounded-xl border border-rule bg-card p-5">
          {st?.workspace ? (
            <>
              <h2 className="m-0 text-xl font-semibold">{t("demo.readyH")}</h2>
              <p className="m-0 mt-2 text-ink-2">{t("demo.readyB", { h: st.workspace.idleHours })} {st.pool?.line}</p>
              {st.sampleNote && <p className="m-0 mt-2 text-sm text-ink-2">{st.sampleNote}</p>}
              <div className="mt-4 flex flex-wrap items-start gap-4">
                <Button variant="outline" disabled={busy} onClick={async () => { setBusy(true); if (await resetDemo()) { setS(await getSession(true)); reload(); } setBusy(false); }}>
                  <RotateCcw aria-hidden="true" />
                  {t("ws.reset")}
                </Button>
                {st.joinQr && (
                  <div className="flex items-start gap-3">
                    <div className="w-[120px] shrink-0 rounded bg-white p-1" role="img" aria-label={t("demo.qr")} dangerouslySetInnerHTML={{ __html: st.joinQr }} />
                    <p className="m-0 max-w-[36ch] text-sm text-ink-2">{t("demo.scan")}</p>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <h2 className="m-0 text-xl font-semibold">{t("demo.startH")}</h2>
              <p className="m-0 mt-2 text-ink-2">{t("demo.startB", { h: 48 })}</p>
              <Button className="mt-4" onClick={ensure} disabled={busy || s?.demoMode === false}>
                {t("demo.start")}
                <ArrowRight aria-hidden="true" />
              </Button>
            </>
          )}
        </section>
        <h2 className="mt-12 text-2xl font-bold">{t("jr.own")}</h2>
        <ul className="mt-4 grid list-none gap-4 p-0 sm:grid-cols-2">
          {personas.map((p) => (
            <li key={p.who} className="flex flex-col rounded-xl border border-rule bg-card p-6">
              <span className="grid size-11 place-items-center rounded-full bg-stamp-wash text-stamp">
                <p.icon className="size-5" aria-hidden="true" />
              </span>
              <h3 className="mt-4 text-xl font-semibold">{p.who}</h3>
              <p className="mt-1 flex-1 text-ink-2">{p.what}</p>
              <div className="mt-5">{p.action}</div>
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
