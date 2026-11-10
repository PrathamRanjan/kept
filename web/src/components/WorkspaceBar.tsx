import { useEffect, useState } from "react";
import { RotateCcw, Smartphone } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, ApiError } from "@/lib/api";
import { fmtRelative } from "@/lib/format";
import { getSession } from "@/lib/session";
import type { DemoStatus } from "@/lib/types";

/** Loads the visitor's demo workspace; polls while real subscriptions are still being claimed from the pool. */
export function useDemoStatus() {
  const [st, setSt] = useState<DemoStatus | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    api.get<DemoStatus>("/demo/status").then((s) => live && setSt(s), () => live && setSt(null));
    return () => {
      live = false;
    };
  }, [tick]);
  useEffect(() => {
    if (st?.pool?.state !== "claiming") return;
    const t = setTimeout(() => setTick((n) => n + 1), 2500);
    return () => clearTimeout(t);
  }, [st]);
  return { st, reload: () => setTick((n) => n + 1) };
}

export async function resetDemo(): Promise<boolean> {
  try {
    await api.post("/demo/reset");
    await getSession(true);
    toast.success("Your demo shop was reset. Real subscriptions it held came with it.");
    return true;
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : "Couldn't reset the demo.");
    return false;
  }
}

/** The line every owner page shows inside a private demo workspace. */
export function WorkspaceBar() {
  const { st } = useDemoStatus();
  const [busy, setBusy] = useState(false);
  if (!st?.workspace) return null;
  return (
    <section aria-label="Your private demo shop" className="mb-5 rounded-lg border border-rule bg-stamp-wash p-4 text-sm">
      <p className="m-0">
        <b>Your private demo shop.</b> Only you see it; it is removed {st.workspace.idleHours} hours after your last visit (now {fmtRelative(st.workspace.expiresAt)}).{" "}
        {st.pool?.line}
      </p>
      {st.sampleNote && <p className="m-0 mt-1 text-ink-2">{st.sampleNote}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            if (await resetDemo()) window.location.reload();
            setBusy(false);
          }}
        >
          <RotateCcw aria-hidden="true" />
          Reset my demo
        </Button>
        {st.joinQr && (
          <details className="rounded-md border border-rule bg-card px-3 py-1.5">
            <summary className="flex cursor-pointer items-center gap-1.5">
              <Smartphone className="size-4" aria-hidden="true" />
              Open on your phone
            </summary>
            <div className="mt-2 w-[168px]" role="img" aria-label="QR code that opens this demo shop on a second device" dangerouslySetInnerHTML={{ __html: st.joinQr }} />
            <p className="m-0 mt-1 max-w-[40ch] break-all text-xs text-ink-2">{st.joinUrl}</p>
          </details>
        )}
      </div>
    </section>
  );
}
