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
import { startTour } from "@/tours";

export default function Demo({ judge = false }: { judge?: boolean }) {
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
      toast.error(e instanceof ApiError ? e.message : "Couldn't start your demo shop.");
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
      toast.error(e instanceof ApiError ? e.message : "Couldn't open your demo shop.");
    } finally {
      setBusy(false);
    }
  }
  async function go(kind: "member" | "shop") {
    const fresh = await ensure();
    if (!fresh) return;
    if (kind === "shop") nav(`/s/${fresh.demoShop}`);
    else if (fresh.demoMemberRef) nav(`/manage/${fresh.demoMemberRef}`);
    else toast.error("Your demo shop has no member yet.");
  }

  const personas = [
    {
      icon: Store,
      who: "The shop owner",
      what: "Your own copy of Ember & Oak Coffee Club. See what needs you, approve held offers, read why people leave.",
      action: (
        <Button onClick={owner} disabled={busy || s?.demoMode === false}>
          Continue as the owner
          <ArrowRight aria-hidden="true" />
        </Button>
      ),
    },
    {
      icon: User,
      who: "A member",
      what: "A coffee subscriber's own page: their stamp card, skip, pause, switch, and one-step cancel.",
      action: (
        <Button variant="outline" onClick={() => go("member")} disabled={busy}>
          {s?.workspace && s.demoMemberIsSample === false ? "Open a real member's page" : "Open a member's page"}
        </Button>
      ),
    },
    {
      icon: KeyRound,
      who: "A new subscriber",
      what: "Subscribe with a PayPal sandbox personal account. The $1 daily plan renews within a day.",
      action: (
        <Button variant="outline" onClick={() => go("shop")} disabled={busy}>
          Open the shop
        </Button>
      ),
    },
    {
      icon: Bot,
      who: "A member's AI assistant",
      what: "Connect Claude or any MCP client to the shop and manage a subscription by conversation.",
      action: (
        <Button variant="outline" asChild>
          <a href="/agents">Connect an assistant</a>
        </Button>
      ),
    },
  ];

  return (
    <>
      <PublicHeader />
      <main id="main" className="mx-auto max-w-5xl px-4 py-12">
        <h1 className="text-4xl font-bold">{judge ? "Judge mode" : "Try the live demo"}</h1>
        <p className="mt-3 max-w-[60ch] text-lg text-ink-2">
          {judge
            ? "One guided story across every persona, about three minutes, including a live PayPal sandbox step. Or pick a persona and explore."
            : "Pick who to be. Everything runs on the PayPal sandbox: real PayPal calls, no real money."}
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button size="lg" variant={judge ? "default" : "outline"} onClick={() => startTour("judge")}>
            <Compass aria-hidden="true" />
            Start Judge Mode
          </Button>
          {judge && (
            <Button size="lg" variant="ghost" asChild>
              <a href="/judge/reset">Reset my judge session</a>
            </Button>
          )}
        </div>
        <section aria-label="Your private demo shop" className="mt-8 rounded-xl border border-rule bg-card p-5">
          {st?.workspace ? (
            <>
              <h2 className="m-0 text-xl font-semibold">Your private demo shop is ready</h2>
              <p className="m-0 mt-2 text-ink-2">Nobody else sees what you do in it. It is removed {st.workspace.idleHours} hours after your last visit. {st.pool?.line}</p>
              {st.sampleNote && <p className="m-0 mt-2 text-sm text-ink-2">{st.sampleNote}</p>}
              <div className="mt-4 flex flex-wrap items-start gap-4">
                <Button variant="outline" disabled={busy} onClick={async () => { setBusy(true); if (await resetDemo()) { setS(await getSession(true)); reload(); } setBusy(false); }}>
                  <RotateCcw aria-hidden="true" />
                  Reset my demo
                </Button>
                {st.joinQr && (
                  <div className="flex items-start gap-3">
                    <div className="w-[120px] shrink-0 rounded bg-white p-1" role="img" aria-label="QR code that opens your demo shop on your phone" dangerouslySetInnerHTML={{ __html: st.joinQr }} />
                    <p className="m-0 max-w-[36ch] text-sm text-ink-2">Scan to open the same shop on your phone, for example a member's page.</p>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <h2 className="m-0 text-xl font-semibold">Start your own private demo shop</h2>
              <p className="m-0 mt-2 text-ink-2">A copy of the demo shop just for you, on the same PayPal sandbox plans: labelled sample members, plus real sandbox subscriptions when the pre-approved pool has them. It is removed {48} hours after your last visit.</p>
              <Button className="mt-4" onClick={ensure} disabled={busy || s?.demoMode === false}>
                Start my demo shop
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
          Have your own owner key? <a className="text-stamp underline" href="/login">Sign in with it</a>. Want your own shop? <a className="text-stamp underline" href="/onboard">Set one up</a> on the sandbox in two minutes.
        </p>
      </main>
      <PublicFooter />
    </>
  );
}
