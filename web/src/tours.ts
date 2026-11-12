/**
 * Guided tours with Driver.js (MIT), one per page: owner, member, shop (spec A3.3).
 *  - A tour starts only from a button ("Take the tour"); nothing starts by itself.
 *  - A running tour ends on any route change (main.tsx calls endTour) and never navigates.
 * The cross-page Judge Mode tour is gone: the judge page (/judge) has paths with buttons that open each screen,
 * and its steps tick themselves from what the server records.
 */
import type { DriveStep, Driver } from "driver.js";

/** Driver.js and its CSS load only when a tour actually starts, keeping them off every first page load. */
let lib: Promise<typeof import("driver.js")> | null = null;
const loadDriver = () => (lib ??= Promise.all([import("driver.js"), import("driver.js/dist/driver.css")]).then(([m]) => m));

export type TourName = "owner" | "member" | "shop";
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.a11yMotion === "off";

const ownerSteps: DriveStep[] = [
  { popover: { title: "Today at your shop", description: "This page answers three things: what happened, what needs you, and what happens next. Every member is a real PayPal sandbox subscription." } },
  { element: "[data-tour='kpis']", popover: { title: "Live numbers first", description: "Members and monthly revenue billed through PayPal, read from the subscriptions themselves." } },
  { element: "[data-tour='needs']", popover: { title: "What needs you", description: "Moves Kept held because they're above the limits you set, failed renewals, and offers waiting on a member. Approve or decline in place." } },
  { element: "[data-tour='ask']", popover: { title: "Ask about your shop", description: "Plain questions, answered by the AI from your shop's live numbers. It reads; it can't act." } },
  { element: "[data-tour='nav-members']", popover: { title: "Every member's card", description: "Each subscription is a row of stamps, one per billing cycle: paid, skipped, paused, discounted, failed, and the next one." } },
  { element: "[data-tour='tour-button']", popover: { title: "Come back any time", description: "The tour lives here. For a guided path with ticks, open For judges in the header." } },
];

const memberSteps: DriveStep[] = [
  { element: "[data-tour='card']", popover: { title: "Your subscription, stamp by stamp", description: "Each stamp is a billing cycle. The highlighted one is your next payment." } },
  { element: "[data-tour='change']", popover: { title: "Change it yourself", description: "Skip, pause or switch, within the shop's rules. Every change is made in PayPal and read back before we confirm it." } },
  { element: "[data-tour='cancel']", popover: { title: "Cancel in one step", description: "No survey, no maze. If you ask, the shop can show you one offer; say no and it cancels straight away." } },
  { element: "[data-tour='history']", popover: { title: "What happened, and who did it", description: "AI proposed, a rule decided, PayPal did it. Every step is listed." } },
];

const shopSteps: DriveStep[] = [
  { element: "[data-tour='plans']", popover: { title: "Pick a plan", description: "You'll approve on PayPal's own page. Kept never sees your card." } },
  { element: "[data-tour='promise']", popover: { title: "The shop's promise", description: "Written by the owner in plain words, checked by Kept. Cancelling always works in one step." } },
  { element: "[data-tour='agent']", popover: { title: "Use an AI assistant?", description: "Assistants like Claude can subscribe and manage this for you through the shop's MCP endpoint." } },
];

let active: Driver | null = null;

async function build(steps: DriveStep[], opts: { name: TourName; onClose: () => void }) {
  const { driver } = await loadDriver();
  active?.destroy();
  const d = driver({
    steps,
    animate: !reduced(),
    smoothScroll: !reduced(),
    allowClose: true,
    showProgress: true,
    popoverClass: "kept-tour",
    overlayOpacity: 0.55,
    stagePadding: 6,
    stageRadius: 10,
    nextBtnText: "Next",
    prevBtnText: "Back",
    doneBtnText: "Done",
    // Driver.js marks the highlighted element as a popup trigger, which is wrong for a plain section.
    onHighlighted: (el) => ["aria-haspopup", "aria-expanded", "aria-controls"].forEach((a) => el?.removeAttribute(a)),
    onNextClick: () => {
      if (d.isLastStep()) d.destroy();
      else d.moveNext();
    },
    onDestroyed: () => {
      if (active === d) active = null;
      opts.onClose();
    },
  });
  active = d;
  return d;
}

/** Start a page's tour. Only ever called from a button. */
export function startTour(name: TourName, _o: { force?: boolean } = {}) {
  void import("./story").then((s) => s.endStory());
  const steps = name === "owner" ? ownerSteps : name === "member" ? memberSteps : shopSteps;
  // Wait a frame so the page's targets exist.
  requestAnimationFrame(() => void build(steps.filter((s) => !s.element || document.querySelector(String(s.element))), { name, onClose: () => undefined }).then((d) => d.drive()));
}

/** End any running tour (called on every route change). */
export function endTour() {
  active?.destroy();
  active = null;
}
