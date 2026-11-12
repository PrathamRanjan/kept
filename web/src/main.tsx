import { StrictMode, Suspense, lazy, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
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
const Judge = lazy(() => import("@/pages/Judge"));
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

/** The guided walkthrough the persona buttons on /demo start: shows the step whose page is open (story.ts). */
function StoryRunner() {
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => {
    void import("./story").then((s) => s.setStoryNavigate((p) => nav(p)));
  }, [nav]);
  useEffect(() => {
    void import("./story").then((s) => (s.storyActive() ? s.show() : undefined));
  }, [loc.pathname]);
  return null;
}

function App() {
  return (
    <BrowserRouter>
      <FocusOnNavigate />
      <StoryRunner />
      <Suspense fallback={<div className="mx-auto max-w-5xl p-6"><PageSkeleton /></div>}>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/demo" element={<Demo />} />
          <Route path="/judge" element={<Judge />} />
          <Route path="/proof" element={<Public page="proof" />} />
          <Route path="/ai" element={<Public page="ai" />} />
          <Route path="/paypal" element={<Public page="paypal" />} />
          <Route path="/who-can-move-money" element={<Public page="roles" />} />
          <Route path="/accessibility" element={<Public page="accessibility" />} />
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
