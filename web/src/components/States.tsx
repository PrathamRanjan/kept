import { AlertTriangle, RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";

export function PageSkeleton({ label = "Loading" }: { label?: string }) {
  return (
    <div className="space-y-4" role="status" aria-live="polite">
      <span className="sr-only">{label}…</span>
      <Skeleton className="h-9 w-2/3 max-w-md" />
      <Skeleton className="h-5 w-1/2 max-w-sm" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const e = error instanceof ApiError ? error : null;
  const offline = e?.code === "offline";
  const Icon = offline ? WifiOff : AlertTriangle;
  return (
    <div className="rounded-xl border border-rule bg-card p-6" role="alert">
      <Icon className="size-6 text-fail" aria-hidden="true" />
      <h2 className="mt-3 text-xl font-semibold">{offline ? "You're offline" : e?.status === 404 ? "Not found" : e?.status === 401 ? "Sign in first" : "That didn't load"}</h2>
      <p className="mt-1 text-ink-2">{e?.message ?? "Something went wrong. Nothing was changed."}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {onRetry && (
          <Button onClick={onRetry}>
            <RefreshCw aria-hidden="true" />
            Try again
          </Button>
        )}
        {e?.status === 401 && (
          <Button variant="outline" asChild>
            <a href="/demo">Choose who to be</a>
          </Button>
        )}
      </div>
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-rule p-6 text-center">
      <svg width="64" height="28" viewBox="0 0 64 28" aria-hidden="true" className="mx-auto mb-3">
        {[0, 1, 2].map((i) => (
          <circle key={i} cx={10 + i * 22} cy="14" r="9" fill="none" stroke="var(--rule)" strokeWidth="2" strokeDasharray={i === 2 ? "3 3" : undefined} />
        ))}
      </svg>
      <p className="m-0 font-medium">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-prose text-sm text-ink-2">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
