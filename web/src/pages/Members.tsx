import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type ICellRendererParams } from "ag-grid-community";
import { AgGridReact } from "ag-grid-react";
import { Search } from "lucide-react";
import { toast } from "sonner";
import { CycleCard, StampLegend } from "@/components/CycleCard";
import { Empty } from "@/components/States";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError } from "@/lib/api";
import { fmtDate, fmtMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Sample, useTour, type Member, type Today } from "./Owner";

ModuleRegistry.registerModules([AllCommunityModule]);

// AG Grid's Quartz theme, re-tokened so it reads as part of Kept, not a default grid.
const theme = themeQuartz.withParams({
  fontFamily: "IBM Plex Sans, ui-sans-serif, sans-serif",
  fontSize: 14,
  foregroundColor: "var(--ink)",
  backgroundColor: "var(--card-stock)",
  headerBackgroundColor: "var(--paper)",
  headerTextColor: "var(--ink-2)",
  borderColor: "var(--rule)",
  rowHoverColor: "var(--stamp-wash)",
  selectedRowBackgroundColor: "var(--stamp-wash)",
  accentColor: "var(--stamp)",
  rowHeight: 56,
  headerHeight: 44,
  wrapperBorderRadius: 12,
  headerFontWeight: 500,
});

const STATUS: Record<string, [string, string]> = {
  ACTIVE: ["Active", "text-paid border-paid/40"],
  SUSPENDED: ["Paused", "text-pause border-pause/40"],
  CANCELLED: ["Ended", "text-ink-2 border-rule"],
  APPROVAL_PENDING: ["Awaiting PayPal", "text-stamp border-stamp/40"],
};
function StatusPill({ m }: { m: Member }) {
  const [w, c] = m.kept_state === "payment_failed" && m.status !== "CANCELLED" ? ["Payment failed", "text-fail border-fail/50"] : STATUS[m.status] ?? [m.status.toLowerCase(), "text-ink-2 border-rule"];
  return <span className={cn("inline-flex h-6 items-center rounded-full border px-2 text-xs font-medium", c)}>{w}</span>;
}
const nextOf = (m: Member) => (m.status === "SUSPENDED" ? m.resume_at : m.status === "ACTIVE" ? m.next_billing_time : null);

export default function Members({ d, reload }: { d: Today; reload: () => void }) {
  useTour(true, null);
  const [filter, setFilter] = useState<"all" | "live" | "attention">("all");
  const [q, setQ] = useState("");
  const cur = d.shop.currency;
  const rows = useMemo(
    () =>
      d.members.filter((m) => (filter === "live" ? !m.sample : filter === "attention" ? m.kept_state === "payment_failed" || m.status === "SUSPENDED" : true)).filter((m) => !q || `${m.name} ${m.email ?? ""} ${m.plan ?? ""}`.toLowerCase().includes(q.toLowerCase())),
    [d.members, filter, q],
  );

  async function memberAction(m: Member, what: "sync" | "simulate-failure") {
    try {
      toast.success((await api.post<{ message: string }>(`/ui/owner/member/${m.ref}/${what}`)).message);
      reload();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "That didn't work.");
    }
  }

  const cols = useMemo<ColDef<Member>[]>(
    () => [
      {
        headerName: "Member",
        field: "name",
        flex: 1.3,
        minWidth: 240,
        cellRenderer: (p: ICellRendererParams<Member>) => (
          <span className="flex h-full flex-col justify-center leading-tight">
            <Link to={`/manage/${p.data!.ref}`} className="inline-flex min-h-6 items-center font-medium text-ink">{p.data!.name}</Link>
            <span className="text-xs text-ink-2">
              {p.data!.channel === "agent" ? `via ${p.data!.agent_id ?? "AI assistant"}` : "web"}
              {p.data!.sample && <Sample />}
            </span>
          </span>
        ),
      },
      { headerName: "Status", field: "status", width: 150, cellRenderer: (p: ICellRendererParams<Member>) => <span className="flex h-full items-center"><StatusPill m={p.data!} /></span>, filter: true },
      { headerName: "Plan", field: "plan", flex: 0.8, minWidth: 130, filter: true },
      { headerName: "Price", field: "price", width: 110, type: "rightAligned", cellClass: "num", valueFormatter: (p) => (p.value == null ? "–" : fmtMoney(p.value, cur)) },
      {
        headerName: "Cycles",
        colId: "card",
        flex: 1.4,
        minWidth: 230,
        sortable: false,
        cellRenderer: (p: ICellRendererParams<Member>) => (
          <span className="flex h-full items-center">
            <CycleCard card={p.data!.card} currency={cur} size="sm" />
          </span>
        ),
      },
      { headerName: "Next", colId: "next", width: 120, valueGetter: (p) => nextOf(p.data!), valueFormatter: (p) => (p.value ? fmtDate(p.value) : "–"), cellClass: "num", sort: "asc" },
      {
        headerName: "",
        colId: "act",
        width: 140,
        sortable: false,
        cellRenderer: (p: ICellRendererParams<Member>) => {
          const m = p.data!;
          if (m.sample) return null;
          return (
            <span className="flex h-full items-center gap-1">
              {m.paypal_subscription_id && <Button size="sm" variant="ghost" onClick={() => memberAction(m, "sync")} title="Read this subscription back from PayPal">Re-read</Button>}
            </span>
          );
        },
      },
    ],
    [cur],
  );

  return (
    <>
      <h1 className="m-0 text-3xl font-bold sm:text-4xl">Members</h1>
      <p className="mt-2 mb-0 text-lg text-ink-2 num">
        {d.members.length} in all, {d.members.filter((m) => !m.sample).length} live on PayPal. Each row's stamps are its billing cycles.
      </p>
      <StampLegend className="mt-4" />
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Show" className="flex rounded-lg border border-rule bg-card p-1">
          {(["all", "live", "attention"] as const).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} className={cn("min-h-9 rounded-md px-3 text-sm font-medium", filter === f ? "bg-ink text-paper" : "text-ink-2 hover:text-ink")}>
              {f === "all" ? "All" : f === "live" ? "Live only" : "Needs attention"}
            </button>
          ))}
        </div>
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-2" aria-hidden="true" />
          <label htmlFor="msearch" className="sr-only">Search members</label>
          <Input id="msearch" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email or plan" className="h-11 pl-9" />
        </div>
      </div>

      {!rows.length ? (
        <div className="mt-6"><Empty title="No members match">Try another filter, or share your shop page to get your first member.</Empty></div>
      ) : (
        <>
          {/* Wide screens: AG Grid. */}
          <div data-tour="grid" className="mt-4 hidden h-[640px] md:block">
            <AgGridReact<Member> theme={theme} rowData={rows} columnDefs={cols} getRowId={(p) => p.data.ref} animateRows={false} suppressCellFocus={false} ensureDomOrder enableCellTextSelection />
          </div>
          {/* Phones: cards. */}
          <ul className="mt-4 grid list-none gap-3 p-0 md:hidden">
            {rows.slice(0, 60).map((m) => (
              <li key={m.ref} className="rounded-xl border border-rule bg-card p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link to={`/manage/${m.ref}`} className="inline-flex min-h-6 items-center font-medium text-ink">{m.name}</Link>
                    {m.sample && <Sample />}
                    <p className="m-0 text-sm text-ink-2">{m.plan}{m.price != null && <> · <span className="num">{fmtMoney(m.price, cur)}</span></>}</p>
                  </div>
                  <StatusPill m={m} />
                </div>
                <div className="mt-3 overflow-x-auto">
                  <CycleCard card={m.card} currency={cur} size="sm" />
                </div>
                <p className="m-0 mt-2 text-sm text-ink-2 num">{nextOf(m) ? `${m.status === "SUSPENDED" ? "Resumes" : "Next payment"} ${fmtDate(nextOf(m))}` : m.status === "CANCELLED" ? "Ended" : ""}</p>
              </li>
            ))}
          </ul>
        </>
      )}
      {d.demoMode && (
        <details className="mt-6 rounded-xl border border-dashed border-pause p-4 text-sm">
          <summary className="min-h-10 cursor-pointer font-medium">Demo tools (labelled, no PayPal call)</summary>
          <p className="text-ink-2">Record a failed renewal for a live member to see the recovery flow. The real path is PayPal's signature-verified PAYMENT.FAILED webhook.</p>
          <div className="flex flex-wrap gap-2">
            {d.members.filter((m) => !m.sample && m.status === "ACTIVE" && m.kept_state !== "payment_failed").slice(0, 4).map((m) => (
              <Button key={m.ref} size="sm" variant="outline" onClick={() => memberAction(m, "simulate-failure")}>Simulate failed renewal: {m.name}</Button>
            ))}
          </div>
        </details>
      )}
    </>
  );
}
