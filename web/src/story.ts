import type { Driver } from "driver.js";
import { getLang, translate } from "@/i18n";
import type { Key } from "@/i18n/en";
import { getSession } from "@/lib/session";

/**
 * The guided walkthrough (the "story") that the persona buttons on /demo start: a card that says who you are, then a
 * few steps across pages that show the product working. Unlike the one-page tours in tours.ts, a story moves between
 * pages: its place is kept in sessionStorage, and the StoryRunner in main.tsx shows the step whose page is open.
 * Leaving the story's pages ends it. Steps where the visitor does something (cancel, ask the assistant) let go of the
 * page on their first click inside the highlighted part, and a small "Next step" button stays in the corner.
 * Only the single-page app's pages can hold a step; the server-rendered owner pages (Guard, Scam protection) are named
 * on the last card instead.
 */
export type StoryKind = "owner" | "member";
export interface StoryCtx { shop: string; slug: string; member: string | null }
interface Step {
  path: (c: StoryCtx) => string | null;
  el?: string[];
  title: Key;
  body: Key;
  act?: boolean;
  next?: Key;
  /** The page shows this part only when the member can do it (a sample member can't): skipped when it's missing. */
  optional?: boolean;
}

const manage = (c: StoryCtx) => (c.member ? `/manage/${c.member}` : null);
const MEMBER_STEPS: Step[] = [
  { path: manage, el: ["card"], title: "story.cardT", body: "story.cardB" },
  { path: manage, el: ["change"], act: true, optional: true, title: "story.changeT", body: "story.changeB" },
  { path: manage, el: ["assistant"], act: true, optional: true, title: "story.assistT", body: "story.assistB" },
  { path: manage, el: ["cancel"], act: true, optional: true, title: "story.cancelT", body: "story.cancelB" },
  { path: manage, el: ["history"], title: "story.historyT", body: "story.historyB" },
];

const STORIES: Record<StoryKind, Step[]> = {
  owner: [
    { path: () => "/dashboard", title: "story.ownerT", body: "story.ownerB", next: "story.start" },
    { path: () => "/dashboard", el: ["kpis"], title: "story.kpisT", body: "story.kpisB" },
    { path: () => "/dashboard", el: ["needs"], act: true, title: "story.needsT", body: "story.needsB" },
    { path: () => "/dashboard", el: ["ask"], act: true, title: "story.askT", body: "story.askB" },
    { path: () => "/dashboard/members", el: ["grid"], title: "story.gridT", body: "story.gridB" },
    { path: manage, el: ["card"], title: "story.becomeT", body: "story.becomeB" },
    ...MEMBER_STEPS.slice(1),
    { path: (c) => `/s/${c.slug}`, el: ["plans"], act: true, title: "story.plansT", body: "story.plansB" },
    { path: (c) => `/s/${c.slug}`, el: ["promise"], title: "story.promiseT", body: "story.promiseB" },
    { path: (c) => `/s/${c.slug}`, title: "story.ownerEndT", body: "story.ownerEndB", next: "story.finish" },
  ],
  member: [
    { path: manage, title: "story.memberT", body: "story.memberB", next: "story.start" },
    ...MEMBER_STEPS,
    { path: manage, title: "story.memberEndT", body: "story.memberEndB", next: "story.finish" },
  ],
};

const KEY = "kept-story";
interface State { kind: StoryKind; i: number; ctx: StoryCtx }

let mem: State | null = null;
function load(): State | null {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as State | null;
    return s && STORIES[s.kind] ? s : null;
  } catch {
    return null;
  }
}
function save(s: State | null) {
  try {
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
    else sessionStorage.removeItem(KEY);
  } catch { /* private mode: the story then lasts one page */ }
  mem = s;
}
const current = () => load() ?? mem;
const tr = (k: Key, v?: Record<string, string | number>) => translate(getLang(), k, v);

let lib: Promise<typeof import("driver.js")> | null = null;
const loadDriver = () => (lib ??= Promise.all([import("driver.js"), import("driver.js/dist/driver.css")]).then(([m]) => m));
let drv: Driver | null = null;
let pill: HTMLElement | null = null;
let token = 0;
/** The way the visitor last moved, so a missing optional step is skipped in that direction. */
let dir: 1 | -1 = 1;
let go: (path: string) => void = (p) => window.location.assign(p);

export const storyActive = () => Boolean(current());
/** The router's navigate, so moving between steps is a client-side route change. */
export function setStoryNavigate(fn: (path: string) => void) {
  go = fn;
}

function clearUi() {
  drv?.destroy();
  drv = null;
  pill?.remove();
  pill = null;
}

export function endStory() {
  token++;
  save(null);
  clearUi();
}

/** Who the story is about: the visitor's own demo shop and its member (a real sandbox one when the pool has one). */
export async function storyContext(): Promise<StoryCtx> {
  const s = await getSession(true);
  return { shop: s.owner?.name ?? "Ember & Oak Coffee Club", slug: s.owner?.slug ?? s.demoShop, member: s.demoMemberRef };
}

/** Starts a story: saves its place and opens the page of its first step. */
export function startStory(kind: StoryKind, ctx: StoryCtx) {
  clearUi();
  token++;
  const steps = STORIES[kind];
  let i = 0;
  while (i < steps.length && !steps[i].path(ctx)) i++;
  if (i >= steps.length) return;
  save({ kind, i, ctx });
  const p = steps[i].path(ctx)!;
  if (window.location.pathname === p) void show();
  else go(p);
}

const visible = (e: Element) => (e as HTMLElement).offsetParent !== null || getComputedStyle(e).position === "fixed";
function find(keys: string[]): Element | null {
  for (const k of keys) {
    const e = [...document.querySelectorAll(`[data-tour="${k}"], [data-tour="${k}-m"]`)].find(visible);
    if (e) return e;
  }
  return null;
}
async function waitFor(keys: string[], ms = 8000): Promise<Element | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const e = find(keys);
    if (e) return e;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

/** Moves to step i: on this page it shows straight away; on another page it navigates and the runner shows it. */
function moveTo(i: number) {
  const s = current();
  if (!s) return;
  const steps = STORIES[s.kind];
  dir = i < s.i ? -1 : 1;
  if (i < 0) i = 0;
  // A step whose page can't be built (no member in this demo) is skipped.
  while (i < steps.length && !steps[i].path(s.ctx)) i++;
  if (i >= steps.length) return endStory();
  save({ ...s, i });
  clearUi();
  const p = steps[i].path(s.ctx)!;
  if (window.location.pathname === p) void show();
  else go(p);
}

function showPill(i: number, n: number) {
  pill?.remove();
  const box = document.createElement("div");
  box.className = "kept-story-pill";
  box.setAttribute("role", "region");
  box.setAttribute("aria-label", tr("story.region"));
  const label = document.createElement("span");
  label.textContent = tr("story.stepOf", { i: i + 1, n });
  const next = document.createElement("button");
  next.type = "button";
  next.className = "kept-story-next";
  next.textContent = tr("story.nextStep");
  next.onclick = () => moveTo(i + 1);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "kept-story-close";
  close.setAttribute("aria-label", tr("story.end"));
  close.textContent = "×";
  close.onclick = () => endStory();
  box.append(label, next, close);
  document.body.append(box);
  pill = box;
}

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.a11yMotion === "off";

/** Shows the saved step if this page is its page. Called by the runner on every route change. */
export async function show(): Promise<void> {
  const s = current();
  if (!s) return;
  const steps = STORIES[s.kind];
  const step = steps[s.i];
  const p = step ? step.path(s.ctx) : null;
  if (!step || !p) return endStory();
  if (window.location.pathname !== p) {
    // The visitor went somewhere else: the walkthrough is over, the demo stays theirs.
    if (!steps.some((x) => x.path(s.ctx) === window.location.pathname)) endStory();
    return;
  }
  const t = ++token;
  const [{ driver }, el] = await Promise.all([loadDriver(), step.el ? waitFor(step.el, step.optional ? 2500 : 8000) : Promise.resolve(null)]);
  if (t !== token) return;
  if (step.optional && !el) return moveTo(Math.max(0, s.i + dir));
  clearUi();
  const i = s.i;
  const last = i === steps.length - 1;
  const v = { shop: s.ctx.shop };
  const nextText = step.next ? tr(step.next) : last ? tr("story.finish") : tr("story.next");
  drv = driver({
    popoverClass: step.el ? "kept-tour" : "kept-tour kept-story-card",
    animate: !reduced(),
    smoothScroll: !reduced(),
    allowClose: true,
    overlayClickBehavior: "none",
    overlayOpacity: step.el ? 0.45 : 0.6,
    stagePadding: 6,
    stageRadius: 10,
    showProgress: true,
    progressText: tr("story.progress", { i: i + 1, n: steps.length }),
    showButtons: i === 0 ? ["next", "close"] : ["next", "previous", "close"],
    nextBtnText: nextText,
    prevBtnText: tr("story.back"),
    doneBtnText: nextText,
    onHighlighted: (e) => ["aria-haspopup", "aria-expanded", "aria-controls"].forEach((a) => e?.removeAttribute(a)),
    onNextClick: () => (last ? endStory() : moveTo(i + 1)),
    onPrevClick: () => moveTo(i - 1),
    onCloseClick: () => endStory(),
    steps: [{ element: el ?? undefined, popover: { title: tr(step.title, v), description: tr(step.body, v), side: "bottom", align: "start" } }],
  });
  drv.drive();
  if (el) (el as HTMLElement).scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  if (step.act && el) {
    // The first click inside the highlighted part hands the page back; the corner button carries on.
    const free = () => {
      if (t !== token) return;
      drv?.destroy();
      drv = null;
      showPill(i, steps.length);
    };
    el.addEventListener("pointerdown", free, { once: true, capture: true });
    el.addEventListener("keydown", free, { once: true, capture: true });
  }
}
