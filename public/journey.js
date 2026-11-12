/*
 * The guided journey's corner card (src/demo/journey.ts has the steps). It runs on every page, the React ones and
 * the server-rendered ones, and asks the server where the journey is, so the place is the same in any browser that
 * opens the demo shop. It never covers the page: no overlay, the page stays clickable, and the card shrinks to a bar.
 *
 * Until a journey is started (the readable `kept_journey` cookie), this file does nothing but define
 * window.keptJourney.start(), which the demo page's buttons call.
 */
(() => {
  "use strict";
  const KEY_MIN = "kj-min";
  const SPA = /^\/($|demo\/?$|judge\/?$|proof\/?$|ai\/?$|paypal\/?$|who-can-move-money\/?$|accessibility\/?$|s\/[^/]+\/?$|manage\/[^/]+\/?$|dashboard\/?$|dashboard\/(members|approvals)\/?$)/;
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.a11yMotion === "off";
  const store = (k, v) => {
    try {
      if (v === undefined) return sessionStorage.getItem(k);
      if (v === null) sessionStorage.removeItem(k);
      else sessionStorage.setItem(k, v);
    } catch (e) {
      /* private mode: the card just forgets that it was shrunk */
    }
    return null;
  };
  const flagged = () => /(?:^|;\s*)kept_journey=1/.test(document.cookie);
  const lang = () => {
    const l = document.documentElement.lang || "en";
    return ["hi-IN", "id-ID", "pt-BR"].includes(l) ? l : "en";
  };
  const fill = (s, v) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m));
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  let data = null;
  let box = null;
  let lit = null;
  let litKey = "";
  let scrolledKey = "";
  let lastLoc = "";
  let switching = false;
  let collapsed = store(KEY_MIN) === "1";
  let arrivedAt = Date.now();
  let shownMissing = false;
  let lastSig = "";

  function ensureCss() {
    if (document.getElementById("kj-css")) return;
    const l = document.createElement("link");
    l.id = "kj-css";
    l.rel = "stylesheet";
    l.href = "/static/journey.css";
    document.head.append(l);
  }
  /** True when the step's part of the page should be here but still isn't, after a few seconds. */
  const missing = (s) => Boolean(s && s.target && here(s) && !lit && Date.now() - arrivedAt > 3000);

  async function api(method, body) {
    const r = await fetch(`/ui/journey?lang=${encodeURIComponent(lang())}`, {
      method,
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || "The guide couldn't reach Kept.");
    return j;
  }

  const step = () => (data && data.on ? data.steps[data.i] : null);
  const here = (s) => Boolean(s && s.match && new RegExp(s.match).test(location.pathname));

  /** Client-side route change for the React pages (React Router listens to popstate); a page load otherwise. */
  function navigate(href) {
    const path = href.split(/[?#]/)[0];
    if (document.getElementById("root") && SPA.test(path)) {
      history.pushState(null, "", href);
      dispatchEvent(new PopStateEvent("popstate"));
      tick();
    } else location.assign(href);
  }

  function unlight() {
    if (lit) {
      lit.classList.remove("kj-lit");
      lit.style.removeProperty("--kj-c");
    }
    lit = null;
    litKey = "";
  }
  const visible = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  function findTarget(sel) {
    for (const one of sel.split(",")) {
      const hit = [...document.querySelectorAll(one.trim())].find(visible);
      if (hit) return hit;
    }
    return null;
  }
  /** Outlines the step's part of the page (no overlay) and scrolls to it once per step. React pages render late, so it retries. */
  function light(s) {
    if (!s || !s.target || !here(s)) {
      const had = Boolean(lit);
      unlight();
      return had;
    }
    const key = `${s.i}|${location.pathname}`;
    if (litKey === key && lit && lit.isConnected) return false;
    const t = findTarget(s.target);
    if (!t) return false;
    unlight();
    lit = t;
    litKey = key;
    t.classList.add("kj-lit");
    t.style.setProperty("--kj-c", `var(--kj-${s.role})`);
    if (scrolledKey !== key) {
      scrolledKey = key;
      // Near the top, under the sticky header: the card sits at the bottom, so the part it is about stays clear of it.
      t.style.scrollMarginTop = "88px";
      t.scrollIntoView({ block: "start", behavior: reduced() ? "auto" : "smooth" });
    }
    return true;
  }

  function pad() {
    if (!box) return (document.body.style.paddingBottom = "");
    // Room under the page at every width, so anything the card sits over can be scrolled clear of it.
    document.body.style.paddingBottom = `${box.offsetHeight + 24}px`;
  }

  function render() {
    const s = step();
    if (!s) {
      box?.remove();
      box = null;
      unlight();
      pad();
      return;
    }
    ensureCss();
    light(s);
    const w = data.words;
    const focused = box && box.contains(document.activeElement) ? document.activeElement.dataset.a : null;
    if (!box) {
      box = el("aside", "kj");
      box.id = "kept-journey";
      document.body.append(box);
    }
    box.setAttribute("aria-label", w.region);
    box.dataset.role = s.role;
    box.dataset.min = collapsed ? "1" : "0";
    box.replaceChildren();

    const head = el("div", "kj-head");
    const who = el("p", "kj-who");
    who.append(el("span", "kj-dot"), el("span", "", s.who));
    const count = el("span", "kj-n", fill(w.step, { i: data.i + 1, n: data.n }));
    const min = el("button", "kj-icon", collapsed ? "+" : "–");
    min.type = "button";
    min.dataset.a = "min";
    min.setAttribute("aria-label", collapsed ? w.open : w.min);
    min.setAttribute("aria-expanded", String(!collapsed));
    const end = el("button", "kj-icon", "×");
    end.type = "button";
    end.dataset.a = "end";
    end.setAttribute("aria-label", w.end);
    head.append(who, count, min, end);
    const bar = el("div", "kj-bar");
    const fillBar = el("span");
    fillBar.style.width = `${Math.round(((data.i + 1) / data.n) * 100)}%`;
    bar.append(fillBar);
    box.append(head, bar);

    if (collapsed) {
      const t = el("p", "kj-t kj-t-min", s.title);
      box.append(t);
    } else {
      const main = el("div", "kj-main");
      main.setAttribute("aria-live", "polite");
      main.append(el("p", "kj-t", s.title), el("p", "kj-b", s.body));
      if (s.do) {
        const d = el("p", "kj-do");
        d.append(el("b", "", `${w.doThis} `), document.createTextNode(s.do));
        main.append(d);
      }
      if (s.done) main.append(el("p", "kj-ok", `✓ ${w.done}`));
      if (s.sample) main.append(el("p", "kj-warn", s.sample));
      if (!here(s)) main.append(el("p", "kj-away", w.away));
      else if ((shownMissing = missing(s))) main.append(el("p", "kj-away", w.missing));
      if (s.why) {
        const y = el("div", "kj-why");
        y.append(el("b", "", w.why), el("span", "", ` ${s.why.fact} `));
        const a = el("a", "", `${w.source}: ${s.why.src}`);
        a.href = s.why.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        y.append(a);
        main.append(y);
      }
      if (w.note) main.append(el("p", "kj-note", w.note));
      box.append(main);

      const act = el("div", "kj-act");
      const back = el("button", "kj-btn", w.back);
      back.type = "button";
      back.dataset.a = "back";
      back.disabled = data.i === 0;
      act.append(back);
      if (s.fill && here(s)) {
        const f = el("button", "kj-btn", w.fill);
        f.type = "button";
        f.dataset.a = "fill";
        act.append(f);
      }
      const last = data.i === data.n - 1;
      const primary = el("button", "kj-btn kj-primary", here(s) || !s.href ? (last ? w.finish : w.next) : w.go);
      primary.type = "button";
      primary.dataset.a = here(s) || !s.href ? (last ? "end" : "next") : "go";
      act.append(primary);
      box.append(act);
    }
    if (focused) box.querySelector(`[data-a="${focused}"]`)?.focus();
    lastSig = sig();
    pad();
  }

  /** The hand-over between people: a short full-screen card in the next person's colour, then their page. */
  function handOver(from, next, then) {
    if (!from || from.role === next.role) return then();
    switching = true;
    const w = data.words;
    const card = el("div", "kj-switch");
    card.dataset.role = next.role;
    card.setAttribute("role", "status");
    const inner = el("div", "kj-switch-in");
    inner.append(el("p", "kj-switch-k", `${w.switching} ${next.roleName}`), el("p", "kj-switch-t", next.who));
    card.append(inner);
    document.body.append(card);
    requestAnimationFrame(() => card.classList.add("on"));
    setTimeout(() => {
      then();
      setTimeout(() => {
        card.classList.remove("on");
        setTimeout(() => {
          card.remove();
          switching = false;
        }, reduced() ? 0 : 300);
      }, reduced() ? 0 : 350);
    }, reduced() ? 250 : 1100);
  }

  async function goTo(i) {
    const before = step();
    data = await api("POST", { action: "go", i });
    arrivedAt = Date.now();
    const s = step();
    const move = () => {
      if (s.href && !here(s)) navigate(s.href);
      render();
    };
    if (before && s && before.role !== s.role) handOver(before, s, move);
    else move();
  }

  async function act(a) {
    const s = step();
    if (!s) return;
    try {
      if (a === "min") {
        collapsed = !collapsed;
        store(KEY_MIN, collapsed ? "1" : null);
        return render();
      }
      if (a === "end") {
        data = await api("POST", { action: "stop" });
        return render();
      }
      if (a === "go" && s.href) return navigate(s.href);
      if (a === "next") return await goTo(data.i + 1);
      if (a === "back") return await goTo(data.i - 1);
      if (a === "fill" && s.fill) {
        const f = document.querySelector(s.fill.sel);
        if (!f) return;
        // React keeps its own copy of an input's value: set it the way a typing person would.
        const proto = f instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(f, s.fill.value);
        f.dispatchEvent(new Event("input", { bubbles: true }));
        f.focus();
      }
    } catch (e) {
      const s2 = box?.querySelector(".kj-main") ?? box;
      s2?.append(el("p", "kj-warn", e.message));
    }
  }

  document.addEventListener("click", (e) => {
    const b = e.target instanceof Element ? e.target.closest("#kept-journey [data-a]") : null;
    if (b) {
      e.preventDefault();
      void act(b.dataset.a);
    }
  });

  /** What the card shows; a poll that changes nothing doesn't redraw it (and so isn't read out again). */
  const sig = () => {
    const s = step();
    return s ? JSON.stringify([data.i, s.done, s.sample, data.words.step, collapsed, here(s)]) : "";
  };
  async function refresh() {
    try {
      data = await api("GET");
    } catch (e) {
      return;
    }
    if (sig() !== lastSig || !box) render();
  }

  /** Route changes in the React pages, and late-rendered targets. */
  function tick() {
    const loc = location.pathname + location.search;
    if (loc !== lastLoc) {
      lastLoc = loc;
      arrivedAt = Date.now();
      unlight();
      render();
    } else if (step()) {
      const s = step();
      if (light(s) || missing(s) !== shownMissing) render();
    }
  }

  let polling = null;
  function startLoops() {
    if (polling) return;
    polling = [
      setInterval(tick, 400),
      // Ticks come from the server when the visitor does a step; ask again every few seconds while it's waiting.
      setInterval(() => {
        const s = step();
        if (!s || switching || document.visibilityState !== "visible") return;
        if (s.watches && s.watches.length && !s.done) void refresh();
      }, 3000),
    ];
    addEventListener("resize", pad);
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && step() && refresh());
    // The page's language picker changes <html lang>; the card's buttons follow it.
    new MutationObserver(() => step() && refresh()).observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
  }

  window.keptJourney = {
    /** Called by the demo page: starts (or restarts) the journey as one of the three people. */
    async start(as) {
      data = await api("POST", { action: "start", as });
      collapsed = false;
      store(KEY_MIN, null);
      startLoops();
      const s = step();
      if (s && s.href && !here(s)) navigate(s.href);
      render();
      return data;
    },
    async stop() {
      data = await api("POST", { action: "stop" });
      render();
    },
    active: () => Boolean(step()),
  };

  if (flagged()) {
    startLoops();
    void refresh();
  }
})();
