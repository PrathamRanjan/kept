/**
 * Guided tours with Driver.js (MIT). Two kinds:
 *  - a first-run tour per persona (owner, member, shop), started once, skippable, with "Don't show again";
 *  - Judge Mode: one story across pages and personas, including the live PayPal sandbox step, ~3 minutes.
 * Tour state lives in localStorage so it survives page loads; `?tour=judge` starts Judge Mode from a link.
 */
import type { DriveStep, Driver } from "driver.js";

/** Driver.js and its CSS load only when a tour actually starts, keeping them off every first page load. */
let lib: Promise<typeof import("driver.js")> | null = null;
const loadDriver = () => (lib ??= Promise.all([import("driver.js"), import("driver.js/dist/driver.css")]).then(([m]) => m));

export type TourName = "owner" | "member" | "shop" | "judge";

interface PageSteps {
  /** Matches location.pathname. */
  match: (path: string) => boolean;
  steps: DriveStep[];
  /** Where Judge Mode goes after this page; may sign in the demo owner first. */
  next?: { href: () => Promise<string> | string; label: string };
}

const KEY = "kept-tour";
const SEEN = (t: TourName) => `kept-tour-seen-${t}`;
const store = {
  get(): { name: TourName; page: number } | null {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "null");
    } catch {
      return null;
    }
  },
  set(v: { name: TourName; page: number } | null) {
    try {
      if (v) localStorage.setItem(KEY, JSON.stringify(v));
      else localStorage.removeItem(KEY);
    } catch {}
  },
};
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.a11yMotion === "off";

let session: { demoShop: string; demoMemberRef: string | null } = { demoShop: "ember-oak-coffee-club", demoMemberRef: null };
export function setTourContext(s: Partial<typeof session>) {
  session = { ...session, ...s };
}

/**
 * Each tour page is a fresh page load, so read the demo shop and member from the server when moving on. Judge
 * Mode runs in the visitor's own private demo shop, started here on first use.
 */
async function ctx() {
  if (!session.demoMemberRef) {
    try {
      let s = await (await fetch("/ui/session", { credentials: "same-origin" })).json();
      if (!s.workspace && s.demoMode !== false) {
        await fetch("/demo/start", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: "{}" });
        s = await (await fetch("/ui/session", { credentials: "same-origin" })).json();
      }
      setTourContext({ demoShop: s.demoShop ?? session.demoShop, demoMemberRef: s.demoMemberRef ?? null });
    } catch {}
  }
  return session;
}

async function signInDemoOwner() {
  await fetch("/ui/demo/owner", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
}

const ownerSteps: DriveStep[] = [
  { popover: { title: "Today at your shop", description: "This page answers three things: what happened, what needs you, and what happens next. Every member is a real PayPal sandbox subscription." } },
  { element: "[data-tour='kpis']", popover: { title: "Live numbers first", description: "Members and monthly revenue billed through PayPal, read from the subscriptions themselves." } },
  { element: "[data-tour='needs']", popover: { title: "What needs you", description: "Moves Kept held because they're above the limits you set, failed renewals, and offers waiting on a member. Approve or decline in place." } },
  { element: "[data-tour='ask']", popover: { title: "Ask about your shop", description: "Plain questions, answered by the AI from your shop's live numbers. It reads; it can't act." } },
  { element: "[data-tour='nav-members']", popover: { title: "Every member's card", description: "Each subscription is a row of stamps, one per billing cycle: paid, skipped, paused, discounted, failed, and the next one." } },
  { element: "[data-tour='tour-button']", popover: { title: "Come back any time", description: "The tour lives here. Judge Mode, the full story across every persona, starts from the home page." } },
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

/** Judge Mode: about three minutes, landing → shop → member → owner → approvals → members. */
const judgePages: PageSteps[] = [
  {
    match: (p) => p === "/",
    steps: [
      { popover: { title: "Judge Mode · 1 of 6", description: "Kept is for small subscription shops on PayPal: members, and their AI assistants, can change or cancel in one step, and the shop keeps the ones who'd rather pause. About three minutes." } },
      { element: "[data-tour='hero-card']", popover: { title: "The cycle card", description: "Kept's signature: a subscription drawn as a loyalty card, one stamp per billing cycle. This one is built from the demo shop's real data." } },
      { element: "[data-tour='trust']", popover: { title: "AI proposes, code decides, PayPal moves money", description: "You'll see these three labels on every timeline in the app." } },
    ],
    next: { href: async () => `/s/${(await ctx()).demoShop}`, label: "Open the shop" },
  },
  {
    match: (p) => p.startsWith("/s/"),
    steps: [
      { element: "[data-tour='plans']", popover: { title: "Live sandbox step · 2 of 6", description: "Subscribe to the $1 daily plan with any PayPal sandbox personal account. You approve on PayPal's page and land on your own member page. Or press Next to use an existing member." } },
      { element: "[data-tour='agent']", popover: { title: "Built for AI assistants too", description: "The same shop is an MCP endpoint: find_shops, start_subscription, skip_next, cancel_subscription and more." } },
    ],
    next: {
      href: async () => {
        const c = await ctx();
        return c.demoMemberRef ? `/manage/${c.demoMemberRef}` : "/demo";
      },
      label: "See a member's page",
    },
  },
  {
    match: (p) => p.startsWith("/manage/"),
    steps: [
      { element: "[data-tour='card']", popover: { title: "The member's view · 3 of 6", description: "Their own stamp card. Skips and pauses show as different stamps; a cancel ends the card cleanly." } },
      { element: "[data-tour='cancel']", popover: { title: "One-step cancel, one optional offer", description: "Tick 'show me one offer' and code picks what the owner's rules allow; the AI only words it. Decline and PayPal cancels at once." } },
      { element: "[data-tour='history']", popover: { title: "The trace", description: "Each change lists who did what: AI, Rule, PayPal, with PayPal's ids." } },
    ],
    next: {
      href: async () => {
        await signInDemoOwner();
        return "/dashboard";
      },
      label: "Switch to the owner",
    },
  },
  {
    match: (p) => p === "/dashboard",
    steps: [
      { element: "[data-tour='kpis']", popover: { title: "The owner's morning · 4 of 6", description: "Live members and revenue, billed through PayPal." } },
      { element: "[data-tour='needs']", popover: { title: "Only what needs them", description: "Held offers and collections, failed renewals, open offers. Approve or decline right here." } },
      { element: "[data-tour='calendar']", popover: { title: "Renewal calendar", description: "Bryntum Calendar: renewals, pauses with resume dates, discount ends and payment follow-ups." } },
    ],
    next: { href: () => "/dashboard/approvals", label: "Open approvals" },
  },
  {
    match: (p) => p === "/dashboard/approvals",
    steps: [
      { element: "[data-tour='approvals']", popover: { title: "Every approval says four things · 5 of 6", description: "What will move, to whom, why it was held, and how to undo it. Above the passkey limit, the owner's passkey signs the exact amount." } },
      { element: "[data-tour='autonomy']", popover: { title: "Earned autonomy", description: "The owner sets what Kept may do alone. The backtest page shows what a change would have done over 90 days." } },
    ],
    next: { href: () => "/dashboard/members", label: "Open members" },
  },
  {
    match: (p) => p === "/dashboard/members",
    steps: [
      { element: "[data-tour='grid']", popover: { title: "Every member at a glance · 6 of 6", description: "AG Grid with the cycle card as a column: filter by status, sort by next payment, open anyone's page." } },
      { popover: { title: "That's Kept", description: "Try a rule the law forbids on Retention rules (\"three offers before cancel\") to see it refused with a citation, or read What's real for what is live and what is not. Thanks for judging." } },
    ],
  },
];

let active: Driver | null = null;

async function build(steps: DriveStep[], opts: { name: TourName; last?: { label: string; go: () => void }; onClose: () => void; showNever?: boolean }) {
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
    doneBtnText: opts.last ? opts.last.label : "Done",
    // Driver.js marks the highlighted element as a popup trigger, which is wrong for a plain section.
    onHighlighted: (el) => ["aria-haspopup", "aria-expanded", "aria-controls"].forEach((a) => el?.removeAttribute(a)),
    onPopoverRender: (popover) => {
      if (!opts.showNever) return;
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "Don't show again";
      b.style.marginRight = "auto";
      b.onclick = () => {
        try {
          localStorage.setItem(SEEN(opts.name), "never");
        } catch {}
        d.destroy();
      };
      popover.footerButtons.prepend(b);
    },
    onNextClick: () => {
      if (d.isLastStep() && opts.last) {
        // go() marks the tour as advancing before destroy() runs onClose, so the next page can resume it.
        opts.last.go();
        d.destroy();
        return;
      }
      if (d.isLastStep()) {
        opts.onClose(); // finished: clear tour state now, not only when Driver reports it destroyed
        d.destroy();
        return;
      }
      d.moveNext();
    },
    onDestroyed: () => {
      if (active === d) active = null;
      opts.onClose();
    },
  });
  active = d;
  return d;
}

/** Start a tour now. First-run tours only auto-start once per browser unless forced. */
export function startTour(name: TourName, o: { force?: boolean } = {}) {
  if (name === "judge") {
    store.set({ name: "judge", page: 0 });
    if (location.pathname !== "/") {
      location.assign("/?tour=judge");
      return;
    }
    resumeTour(location.pathname);
    return;
  }
  let seen: string | null = null;
  try {
    seen = localStorage.getItem(SEEN(name));
  } catch {}
  if (!o.force && seen) return;
  try {
    localStorage.setItem(SEEN(name), seen === "never" ? "never" : "once");
  } catch {}
  const steps = name === "owner" ? ownerSteps : name === "member" ? memberSteps : shopSteps;
  // Wait a frame so the page's targets exist.
  requestAnimationFrame(() => void build(steps.filter((s) => !s.element || document.querySelector(String(s.element))), { name, onClose: () => undefined, showNever: !o.force }).then((d) => d.drive()));
}

/** Continue Judge Mode on this page if it is running. Returns true if a tour is showing. */
export function resumeTour(path: string): boolean {
  const st = store.get();
  if (!st || st.name !== "judge") return false;
  const idx = judgePages.findIndex((p, i) => i >= st.page && p.match(path));
  if (idx < 0) return false;
  const pg = judgePages[idx];
  store.set({ name: "judge", page: idx });
  const steps = pg.steps.filter((s) => !s.element || document.querySelector(String(s.element)));
  let advancing = false;
  void build(steps.length ? steps : [{ popover: { title: "Judge Mode", description: "This step's panel isn't on screen; press Next to continue." } }], {
    name: "judge",
    last: pg.next
      ? {
          label: pg.next.label,
          go: async () => {
            advancing = true;
            store.set({ name: "judge", page: idx + 1 });
            location.assign(await pg.next!.href());
          },
        }
      : undefined,
    onClose: () => {
      if (!advancing) store.set(null);
    },
  }).then((d) => d.drive());
  return true;
}

export function judgeRunning() {
  return store.get()?.name === "judge";
}
