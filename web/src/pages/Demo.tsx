import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Bot, Compass, KeyRound, Store, User } from "lucide-react";
import { toast } from "sonner";
import { PublicFooter, PublicHeader } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";
import { startTour } from "@/tours";

export default function Demo({ judge = false }: { judge?: boolean }) {
  const s = useSession();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);

  async function owner() {
    setBusy(true);
    try {
      await api.post("/ui/demo/owner");
      nav("/dashboard");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't sign in as the demo owner.");
    } finally {
      setBusy(false);
    }
  }

  const personas = [
    {
      icon: Store,
      who: "The shop owner",
      what: "Ember & Oak Coffee Club. See what needs you, approve held offers, read why people leave.",
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
      action: s?.demoMemberRef ? (
        <Button variant="outline" asChild>
          <Link to={`/manage/${s.demoMemberRef}`}>Open a member's page</Link>
        </Button>
      ) : (
        <Button variant="outline" disabled>
          No member yet
        </Button>
      ),
    },
    {
      icon: KeyRound,
      who: "A new subscriber",
      what: "Subscribe with a PayPal sandbox personal account. The $1 daily plan renews within a day.",
      action: (
        <Button variant="outline" asChild>
          <Link to={`/s/${s?.demoShop ?? "ember-oak-coffee-club"}`}>Open the shop</Link>
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
