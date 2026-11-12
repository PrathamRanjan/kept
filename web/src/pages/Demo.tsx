import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Bot, Compass, KeyRound, RotateCcw, Store, User } from "lucide-react";
import { toast } from "sonner";
import { PublicFooter, PublicHeader } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api";
import { getSession } from "@/lib/session";
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

  async function owner() {
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
  async function go(kind: "member" | "shop") {
    const fresh = await ensure();
    if (!fresh) return;
    if (kind === "shop") nav(`/s/${fresh.demoShop}`);
    else if (fresh.demoMemberRef) nav(`/manage/${fresh.demoMemberRef}`);
    else toast.error(t("demo.noMember"));
  }

  const personas = [
    {
      icon: Store,
      who: t("demo.ownerWho"),
      what: t("demo.ownerWhat"),
      action: (
        <Button onClick={owner} disabled={busy || s?.demoMode === false}>
          {t("demo.ownerGo")}
          <ArrowRight aria-hidden="true" />
        </Button>
      ),
    },
    {
      icon: User,
      who: t("demo.memberWho"),
      what: t("demo.memberWhat"),
      action: (
        <Button variant="outline" onClick={() => go("member")} disabled={busy}>
          {s?.workspace && s.demoMemberIsSample === false ? t("demo.memberReal") : t("demo.memberGo")}
        </Button>
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
        <div className="mt-6 flex flex-wrap gap-3">
          <Button size="lg" variant="outline" asChild>
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
        <ul className="mt-10 grid list-none gap-4 p-0 sm:grid-cols-2">
          {personas.map((p) => (
            <li key={p.who} className="flex flex-col rounded-xl border border-rule bg-card p-6">
              <span className="grid size-11 place-items-center rounded-full bg-stamp-wash text-stamp">
                <p.icon className="size-5" aria-hidden="true" />
              </span>
              <h2 className="mt-4 text-xl font-semibold">{p.who}</h2>
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
