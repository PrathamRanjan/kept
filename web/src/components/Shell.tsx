import { CalendarDays, CircleHelp, Gauge, Inbox, LayoutList, LogOut, Menu, MessageSquare, Scale, ShieldCheck, Store, Users, FileCheck2, Workflow, Accessibility } from "lucide-react";
import { NavLink, Link, useLocation } from "react-router-dom";
import { useState } from "react";
import { Logo } from "./Logo";
import { DemoRibbon } from "./DemoRibbon";
import { ThemeToggle } from "./ThemeToggle";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { startTour } from "@/tours";
import { LangPicker, useT } from "@/i18n";
import { HandsFreeToggle } from "@/handsfree/HandsFree";

const APP = [
  { to: "/dashboard", label: "Today", icon: Inbox, end: true },
  { to: "/dashboard/members", label: "Members", icon: Users },
  { to: "/dashboard/approvals", label: "Approvals", icon: Scale },
];
/** Deeper owner tools stay server-rendered pages (same look, same tokens). */
const TOOLS = [
  { href: "/dashboard/guard", label: "Limits and backtest", icon: Gauge },
  { href: "/onboard/rules", label: "Retention rules", icon: LayoutList },
  { href: "/dashboard/money", label: "Money", icon: CalendarDays },
  { href: "/dashboard/channels", label: "Messages", icon: MessageSquare },
  { href: "/dashboard/safety", label: "Scam protection", icon: ShieldCheck },
  { href: "/dashboard/compliance", label: "Compliance", icon: FileCheck2 },
  { href: "/dashboard/traces", label: "Agent runs", icon: Workflow },
  { href: "/dashboard/evidence", label: "What's real", icon: CircleHelp },
];

function NavItems({ onPick, shopSlug }: { onPick?: () => void; shopSlug?: string }) {
  return (
    <nav aria-label="Owner" className="flex flex-col gap-1">
      {APP.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.end}
          onClick={onPick}
          data-tour={`nav-${n.label.toLowerCase()}`}
          className={({ isActive }) => cn("flex min-h-11 items-center gap-3 rounded-lg px-3 font-medium no-underline", isActive ? "bg-ink text-paper" : "text-ink hover:bg-muted")}
        >
          <n.icon className="size-[18px]" aria-hidden="true" />
          {n.label}
        </NavLink>
      ))}
      {shopSlug && (
        <Link to={`/s/${shopSlug}`} onClick={onPick} className="flex min-h-11 items-center gap-3 rounded-lg px-3 font-medium text-ink no-underline hover:bg-muted">
          <Store className="size-[18px]" aria-hidden="true" />
          Shop page
        </Link>
      )}
      <p className="mt-4 mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-ink-2">Tools</p>
      {TOOLS.map((n) => (
        <a key={n.href} href={n.href} className="flex min-h-10 items-center gap-3 rounded-lg px-3 text-[0.9375rem] text-ink no-underline hover:bg-muted">
          <n.icon className="size-4 text-ink-2" aria-hidden="true" />
          {n.label}
        </a>
      ))}
    </nav>
  );
}

export function OwnerShell({ shopName, shopSlug, children }: { shopName?: string; shopSlug?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const { lang, t } = useT();
  const loc = useLocation();
  return (
    <div className="min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-ink focus:px-4 focus:py-2 focus:text-paper">Skip to content</a>
      <DemoRibbon />
      <header className="sticky top-0 z-30 border-b border-rule bg-paper/95 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-2 px-4">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu">
                <Menu aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[300px] bg-sidebar p-4">
              <SheetHeader className="p-0">
                <SheetTitle className="text-left">{shopName ?? "Your shop"}</SheetTitle>
              </SheetHeader>
              <NavItems onPick={() => setOpen(false)} shopSlug={shopSlug} />
            </SheetContent>
          </Sheet>
          <Logo to="/dashboard" sub={shopName} />
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" className="min-w-11" aria-label="Take the tour" onClick={() => startTour("owner", { force: true })} data-tour="tour-button">
              <CircleHelp aria-hidden="true" />
              <span className="hidden sm:inline">Take the tour</span>
            </Button>
            <LangPicker className="hidden sm:block" />
            <HandsFreeToggle />
            <Button variant="ghost" size="icon" data-a11y-open aria-label="Display and help">
              <Accessibility aria-hidden="true" />
            </Button>
            <ThemeToggle />
            <form method="post" action="/logout" className="hidden sm:block">
              <Button variant="ghost" size="icon" type="submit" aria-label="Sign out">
                <LogOut aria-hidden="true" />
              </Button>
            </form>
          </div>
        </div>
      </header>
      <div className="mx-auto flex max-w-7xl gap-8 px-4">
        <aside className="sticky top-16 hidden h-[calc(100dvh-4rem)] w-60 shrink-0 overflow-y-auto py-6 lg:block">
          <NavItems shopSlug={shopSlug} />
        </aside>
        <main id="main" key={loc.pathname} className="min-w-0 flex-1 pb-28 pt-6 lg:pb-16" tabIndex={-1}>
          {lang !== "en" && lang !== "qps" && <p role="note" className="mb-4 rounded-lg bg-muted p-2 text-sm text-ink-2" lang={lang}>{t("shell.ownerEnglish")}</p>}
          {children}
        </main>
      </div>
      <nav aria-label="Owner, bottom" className="fixed inset-x-0 bottom-0 z-30 border-t border-rule bg-paper/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm lg:hidden">
        <div className="mx-auto grid max-w-md grid-cols-3">
          {APP.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => cn("flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-medium no-underline", isActive ? "text-stamp" : "text-ink-2")}>
              <n.icon className="size-5" aria-hidden="true" />
              {n.label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}

export function PublicHeader({ right, translated = false }: { right?: React.ReactNode; translated?: boolean }) {
  const { lang, t } = useT();
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-ink focus:px-4 focus:py-2 focus:text-paper">{t("shell.skip")}</a>
      <DemoRibbon />
      <header className="border-b border-rule">
        <div className="mx-auto flex min-h-16 max-w-6xl flex-wrap items-center gap-2 px-4 py-2">
          <Logo />
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
            <Button variant="ghost" size="sm" asChild className="min-h-11">
              <a href="/demo">{t("shell.judges")}</a>
            </Button>
            {right}
            <LangPicker />
            <HandsFreeToggle />
            <Button variant="ghost" size="icon" data-a11y-open aria-label={t("shell.display")}>
              <Accessibility aria-hidden="true" />
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </header>
      {translated && lang !== "en" && lang !== "qps" && <p role="note" className="m-0 border-b border-rule bg-muted px-4 py-2 text-center text-sm text-ink-2">{t("shell.mt")}</p>}
    </>
  );
}

export function PublicFooter() {
  const { t } = useT();
  return (
    <footer className="mt-20 border-t border-rule">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-8 text-sm text-ink-2">
        <span>{t("shell.footer")}</span>
        <a href="/agents" className="inline-flex min-h-11 items-center text-ink-2 underline">{t("shell.agents")}</a>
        <a href="/llms.txt" className="inline-flex min-h-11 items-center text-ink-2 underline">llms.txt</a>
        <a href="/skill.md" className="inline-flex min-h-11 items-center text-ink-2 underline">skill.md</a>
        <a href="/openapi.yaml" className="inline-flex min-h-11 items-center text-ink-2 underline">OpenAPI</a>
        <a href="https://github.com/PrathamRanjan/kept" className="inline-flex min-h-11 items-center text-ink-2 underline">{t("shell.source")}</a>
      </div>
    </footer>
  );
}
