import { useState } from "react";
import { FlaskConical, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useT } from "@/i18n";

/** Small and honest: what runs live on the PayPal sandbox and what is not live yet, plus the reset. */
export function DemoRibbon() {
  const { t } = useT();
  const [hidden, setHidden] = useState(() => {
    try {
      return sessionStorage.getItem("kept-ribbon") === "off";
    } catch {
      return false;
    }
  });
  if (hidden) return null;
  return (
    <div className="border-b border-rule bg-pause-wash text-[0.8125rem] text-ink" role="region" aria-label={t("rb.label")}>
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-1.5">
        <FlaskConical className="size-4 shrink-0 text-pause" aria-hidden="true" />
        <p className="m-0 min-w-0 flex-1 truncate">
          <b>{t("rb.title")}</b> {t("rb.line")}
        </p>
        <Popover>
          <PopoverTrigger className="min-h-9 shrink-0 rounded-md px-2 font-medium underline underline-offset-2">{t("rb.what")}</PopoverTrigger>
          <PopoverContent align="end" className="w-[min(92vw,360px)] text-sm">
            <p className="m-0 mb-2 font-semibold">{t("rb.liveH")}</p>
            <ul className="m-0 mb-3 list-disc space-y-1 pl-5 text-ink-2">
              <li>{t("rb.l1")}</li>
              <li>{t("rb.l2")}</li>
              <li>{t("rb.l3")}</li>
              <li>{t("rb.l4")}</li>
              <li>{t("rb.l5")}</li>
            </ul>
            <p className="m-0 mb-2 font-semibold">{t("rb.notH")}</p>
            <ul className="m-0 mb-3 list-disc space-y-1 pl-5 text-ink-2">
              <li>{t("rb.n1")}</li>
              <li>{t("rb.n2")}</li>
              <li>{t("rb.n3")}</li>
            </ul>
            <p className="m-0 mb-3 text-ink-2">{t("rb.sample")}</p>
            <div className="flex flex-wrap gap-3">
              <a className="font-medium text-stamp underline" href="/dashboard/evidence">{t("rb.evidence")}</a>
              <a className="font-medium text-stamp underline" href="/demo">{t("rb.over")}</a>
            </div>
          </PopoverContent>
        </Popover>
        <button
          type="button"
          className="grid size-9 shrink-0 place-items-center rounded-md hover:bg-black/5"
          aria-label={t("rb.hide")}
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
