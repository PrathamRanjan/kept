import { Link } from "react-router-dom";
import { PublicHeader } from "@/components/Shell";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";

export default function NotFound() {
  const { t } = useT();
  return (
    <>
      <PublicHeader />
      <main id="main" className="mx-auto max-w-2xl px-4 py-20">
        <h1 className="text-4xl font-bold">{t("nf.h")}</h1>
        <p className="mt-3 text-ink-2">{t("nf.b")}</p>
        <Button asChild className="mt-6">
          <Link to="/">{t("nf.home")}</Link>
        </Button>
      </main>
    </>
  );
}
