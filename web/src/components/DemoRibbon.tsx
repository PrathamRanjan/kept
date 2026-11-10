import { useState } from "react";
import { FlaskConical, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** Small and honest: which parts are live sandbox and which are simulated, plus the reset. */
export function DemoRibbon() {
  const [hidden, setHidden] = useState(() => {
    try {
      return sessionStorage.getItem("kept-ribbon") === "off";
    } catch {
      return false;
    }
  });
  if (hidden) return null;
  return (
    <div className="border-b border-rule bg-pause-wash text-[0.8125rem] text-ink" role="region" aria-label="Demo notice">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-1.5">
        <FlaskConical className="size-4 shrink-0 text-pause" aria-hidden="true" />
        <p className="m-0 min-w-0 flex-1 truncate">
          <b>Hackathon demo.</b> Real PayPal sandbox; no real money moves.
        </p>
        <Popover>
          <PopoverTrigger className="min-h-9 shrink-0 rounded-md px-2 font-medium underline underline-offset-2">What's real?</PopoverTrigger>
          <PopoverContent align="end" className="w-[min(92vw,360px)] text-sm">
            <p className="m-0 mb-2 font-semibold">Live on the PayPal sandbox</p>
            <ul className="m-0 mb-3 list-disc space-y-1 pl-5 text-ink-2">
              <li>Plans, subscriptions, skip, pause, switch, cancel, capture</li>
              <li>Signature-verified webhooks, transaction search</li>
              <li>AI drafting and reason labels (OpenAI), with a rules fallback</li>
              <li>MCP endpoints for AI assistants</li>
            </ul>
            <p className="m-0 mb-2 font-semibold">Simulated or sample</p>
            <ul className="m-0 mb-3 list-disc space-y-1 pl-5 text-ink-2">
              <li>Rows marked "sample" (no PayPal subscription behind them)</li>
              <li>"Simulate failed renewal" (no PayPal call)</li>
              <li>The 90-day backtest history and the dark-pattern baseline</li>
            </ul>
            <div className="flex flex-wrap gap-3">
              <a className="font-medium text-stamp underline" href="/dashboard/evidence">Evidence page</a>
              <a className="font-medium text-stamp underline" href="/judge/reset">Reset judge session</a>
            </div>
          </PopoverContent>
        </Popover>
        <button
          type="button"
          className="grid size-9 shrink-0 place-items-center rounded-md hover:bg-black/5"
          aria-label="Hide demo notice"
          onClick={() => {
            try {
              sessionStorage.setItem("kept-ribbon", "off");
            } catch {}
            setHidden(true);
          }}
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
