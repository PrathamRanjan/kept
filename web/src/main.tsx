import { StrictMode, Suspense, lazy, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PageSkeleton } from "@/components/States";
import Landing from "@/pages/Landing";
import { endTour } from "./tours";
import { I18nProvider } from "@/i18n";
import { HandsFreeRoot } from "@/handsfree/HandsFree";
import "./index.css";

const Demo = lazy(() => import("@/pages/Demo"));
const Shop = lazy(() => import("@/pages/Shop"));
const Manage = lazy(() => import("@/pages/Manage"));
const Owner = lazy(() => import("@/pages/Owner"));
const NotFound = lazy(() => import("@/pages/NotFound"));
const Public = lazy(() => import("@/pages/Public"));

/** Move focus to the new page's heading on navigation, for keyboard and screen-reader users. */
function FocusOnNavigate() {
  const loc = useLocation();
  useEffect(() => {
    endTour();
    const t = setTimeout(() => {
      const h = document.querySelector<HTMLElement>("main h1");
      if (h && loc.key !== "default") {
        h.setAttribute("tabindex", "-1");
        h.focus({ preventScroll: false });
      }
    }, 60);
    return () => clearTimeout(t);
  }, [loc.pathname]);
  return null;
}

function App() {
  return (
    <BrowserRouter>
      <FocusOnNavigate />
      <Suspense fallback={<div className="mx-auto max-w-5xl p-6"><PageSkeleton /></div>}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/demo" element={<Demo />} />
          <Route path="/judge" element={<Navigate to="/demo" replace />} />
          <Route path="/proof" element={<Public key="proof" page="proof" />} />
          <Route path="/ai" element={<Public key="ai" page="ai" />} />
          <Route path="/paypal" element={<Public key="paypal" page="paypal" />} />
          <Route path="/who-can-move-money" element={<Public key="roles" page="roles" />} />
          <Route path="/accessibility" element={<Public key="accessibility" page="accessibility" />} />
          <Route path="/s/:slug" element={<Shop />} />
          <Route path="/manage/:ref" element={<Manage />} />
          <Route path="/dashboard/*" element={<Owner />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <TooltipProvider delayDuration={300}>
        <App />
        <HandsFreeRoot />
        <Toaster position="top-center" richColors={false} closeButton />
      </TooltipProvider>
    </I18nProvider>
  </StrictMode>,
);
