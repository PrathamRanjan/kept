// Accessibility kit (SAFETY_ACCESSIBILITY_SPEC §5). Profile lives in localStorage on this device; each toggle is a
// data-* attribute on <html> that a11y.css reads. Voice and read-aloud are additions: typing and buttons always work.
(() => {
  const KEY = "a11y";
  const DEF = { textScale: 1, contrast: "default", font: "default", readAloud: false, voiceInput: false, simpleWords: false, reducedMotion: "system", extraTime: false, bigTargets: false, seen: false };
  let p = { ...DEF };
  try { p = { ...DEF, ...(JSON.parse(localStorage.getItem(KEY) || "{}")) }; } catch (_) {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (_) {} };
  const root = document.documentElement;
  let live;
  const announce = (t) => { if (!live) { live = document.createElement("div"); live.className = "a11y-live"; live.setAttribute("aria-live", "polite"); document.body.appendChild(live); } live.textContent = ""; setTimeout(() => (live.textContent = t), 30); };

  function apply() {
    root.dataset.a11yText = String(p.textScale);
    root.dataset.a11yContrast = p.contrast;
    root.dataset.a11yFont = p.font;
    root.dataset.a11yMotion = p.reducedMotion === true ? "off" : "system";
    root.dataset.a11yTargets = p.bigTargets ? "big" : "default";
    root.dataset.a11ySimple = p.simpleWords ? "on" : "off";
    root.dataset.a11yExtraTime = p.extraTime ? "on" : "off";
    if (p.font === "hyperlegible" && !document.getElementById("a11y-font")) {
      const l = document.createElement("link"); l.id = "a11y-font"; l.rel = "stylesheet"; l.href = "https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&display=swap"; document.head.appendChild(l);
    }
    if (p.extraTime) document.querySelectorAll('meta[http-equiv="refresh"]').forEach((m) => m.remove());
    readAloudButtons(); voiceButtons();
  }

  // Read aloud: one button per page reads the main content; payment status banners are announced as they appear.
  let speaking = false;
  function readAloudButtons() {
    const existing = document.getElementById("a11y-read");
    if (!p.readAloud || !("speechSynthesis" in window)) { existing?.remove(); return; }
    if (existing) return;
    const b = document.createElement("button"); b.id = "a11y-read"; b.type = "button"; b.className = "btn small"; b.textContent = "Read this page";
    b.style.cssText = "position:fixed;left:16px;bottom:16px;z-index:50;min-height:44px";
    b.addEventListener("click", () => {
      if (speaking) { speechSynthesis.cancel(); speaking = false; b.textContent = "Read this page"; return; }
      const main = document.getElementById("main") || document.body;
      const text = main.innerText.replace(/\s+/g, " ").slice(0, 6000);
      const u = new SpeechSynthesisUtterance(text); u.rate = 0.95; u.onend = () => { speaking = false; b.textContent = "Read this page"; };
      speechSynthesis.cancel(); speechSynthesis.speak(u); speaking = true; b.textContent = "Stop reading";
    });
    document.body.appendChild(b);
    const banner = document.querySelector(".banner[role=status], .banner[role=alert]");
    if (banner) { const u = new SpeechSynthesisUtterance(banner.innerText); speechSynthesis.speak(u); }
  }

  // Voice input: a microphone button beside every text field; Web Speech, on-device when the browser supports it.
  function voiceButtons() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    document.querySelectorAll(".a11y-mic").forEach((m) => { if (!p.voiceInput) m.remove(); });
    if (!p.voiceInput || !SR) return;
    document.querySelectorAll('input[type=text], input:not([type]), textarea').forEach((el) => {
      if (el.dataset.a11yMic || el.classList.contains("a11y-skip")) return;
      el.dataset.a11yMic = "1";
      const m = document.createElement("button"); m.type = "button"; m.className = "a11y-mic"; m.setAttribute("aria-pressed", "false"); m.setAttribute("aria-label", "Speak into this field"); m.textContent = "🎤";
      m.addEventListener("click", () => {
        const r = new SR(); r.lang = document.documentElement.lang || "en"; r.interimResults = false;
        if ("processLocally" in r) { try { r.processLocally = true; } catch (_) {} }
        m.setAttribute("aria-pressed", "true"); announce(("processLocally" in r) ? "Listening, on this device" : "Listening, using the browser's speech service");
        r.onresult = (e) => { const t = e.results[0][0].transcript; el.value = (el.value ? el.value + " " : "") + t; el.dispatchEvent(new Event("input", { bubbles: true })); announce("Heard: " + t); };
        r.onend = () => m.setAttribute("aria-pressed", "false"); r.onerror = () => { m.setAttribute("aria-pressed", "false"); announce("Could not hear you. You can type instead."); };
        r.start();
      });
      el.insertAdjacentElement("afterend", m);
    });
  }

  // Panel
  function panel() {
    if (document.getElementById("a11y-panel")) { document.getElementById("a11y-panel").remove(); return; }
    const d = document.createElement("div"); d.id = "a11y-panel"; d.className = "a11y-panel"; d.setAttribute("role", "dialog"); d.setAttribute("aria-label", "Display and help");
    const seg = (name, opts, cur) => `<div class="seg" role="group" aria-label="${name}">${opts.map(([v, l]) => `<button type="button" class="btn small" data-set="${name}" data-val="${v}" aria-pressed="${String(cur) === String(v)}">${l}</button>`).join("")}</div>`;
    const tog = (name, label, hint) => `<label class="tog"><input type="checkbox" data-tog="${name}" ${p[name] === true ? "checked" : ""}><span>${label}${hint ? `<br><span class="small muted">${hint}</span>` : ""}</span></label>`;
    d.innerHTML = `<div class="spread"><h2>Display and help</h2><button type="button" class="btn small" id="a11y-close" aria-label="Close">Close</button></div><p class="sub small muted">Changes apply at once and stay on this device.</p>
<fieldset><legend>Text size</legend>${seg("textScale", [[1, "A"], [1.25, "A+"], [1.5, "A++"], [2, "A+++"]], p.textScale)}</fieldset>
<fieldset><legend>Contrast and font</legend>${seg("contrast", [["default", "Normal"], ["high", "High contrast"]], p.contrast)}<div style="height:6px"></div>${seg("font", [["default", "Default font"], ["hyperlegible", "Clearer font"]], p.font)}</fieldset>
<fieldset><legend>Help</legend>${tog("readAloud", "Read pages aloud", "A button reads the page; payment updates are spoken.")}${tog("voiceInput", "Speak instead of typing", "A microphone appears beside text boxes.")}${tog("simpleWords", "Plain words", "Shorter sentences for the important messages.")}${tog("bigTargets", "Bigger buttons", "44 px targets and more space.")}${tog("extraTime", "More time", "No auto-refresh, no countdowns.")}<label class="tog"><input type="checkbox" data-tog="reducedMotion" ${p.reducedMotion === true ? "checked" : ""}><span>Stop all motion</span></label></fieldset>
<p class="small muted">Head-movement pointer and voice chat are listed in the project roadmap; this app offers keyboard, voice input and read-aloud today.</p>`;
    d.addEventListener("click", (e) => {
      const b = e.target.closest("[data-set]"); if (!b) return;
      const v = b.dataset.val; p[b.dataset.set] = isNaN(Number(v)) ? v : Number(v); save(); apply();
      d.querySelectorAll(`[data-set="${b.dataset.set}"]`).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      announce(`${b.dataset.set} set to ${b.textContent}`);
    });
    d.addEventListener("change", (e) => { const c = e.target.closest("[data-tog]"); if (!c) return; p[c.dataset.tog] = c.checked; save(); apply(); announce(`${c.parentElement.textContent.trim().split("\n")[0]} ${c.checked ? "on" : "off"}`); });
    d.querySelector("#a11y-close").addEventListener("click", () => { d.remove(); fab.focus(); });
    document.body.appendChild(d); d.querySelector("button").focus();
    d.addEventListener("keydown", (e) => { if (e.key === "Escape") { d.remove(); fab.focus(); } });
  }

  const fab = document.createElement("button"); fab.type = "button"; fab.className = "a11y-fab"; fab.textContent = "Display and help"; fab.setAttribute("aria-haspopup", "dialog");
  fab.addEventListener("click", panel);
  document.addEventListener("click", (e) => { if (e.target.closest("[data-a11y-open]")) panel(); });

  // First visit: one screen, big toggles, skippable.
  function firstVisit() {
    if (p.seen) return;
    const w = document.createElement("div"); w.className = "a11y-first"; w.setAttribute("role", "dialog"); w.setAttribute("aria-modal", "true"); w.setAttribute("aria-label", "How do you want to use this?");
    w.innerHTML = `<div class="card"><h2>How do you want to use this?</h2><p class="muted">Pick anything that helps. You can change it any time from the <b>Display and help</b> button.</p>
<div class="big-toggles"><button type="button" class="btn" data-q="textScale:1.5">Bigger text</button><button type="button" class="btn" data-q="contrast:high">High contrast</button><button type="button" class="btn" data-q="readAloud:true">Read aloud</button><button type="button" class="btn" data-q="voiceInput:true">Speak to type</button><button type="button" class="btn" data-q="simpleWords:true">Plain words</button><button type="button" class="btn" data-q="bigTargets:true">Bigger buttons</button></div>
<div class="row"><button type="button" class="btn primary" id="a11y-first-done">Done</button><button type="button" class="btn" id="a11y-first-skip">Skip, it looks fine</button></div></div>`;
    w.addEventListener("click", (e) => {
      const b = e.target.closest("[data-q]"); if (!b) return;
      const [k, v] = b.dataset.q.split(":"); const val = v === "true" ? true : isNaN(Number(v)) ? v : Number(v);
      const on = b.getAttribute("aria-pressed") !== "true"; b.setAttribute("aria-pressed", String(on)); p[k] = on ? val : DEF[k]; save(); apply();
    });
    const done = () => { p.seen = true; save(); w.remove(); fab.focus(); };
    w.querySelector("#a11y-first-done").addEventListener("click", done); w.querySelector("#a11y-first-skip").addEventListener("click", done);
    document.body.appendChild(w); w.querySelector("button").focus();
  }

  apply();
  const boot = () => { document.body.appendChild(fab); apply(); if (!/\/(login|c\/|judge)/.test(location.pathname)) firstVisit(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
